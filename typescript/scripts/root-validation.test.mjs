/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  npmExecutable,
  runTypeScriptNpmScript,
  runTypeScriptNpmScriptAndWait,
} = require('../../scripts/run-typescript.cjs');
const { pythonExecutable, runPythonCommands } = require('../../scripts/run-python.cjs');
const {
  PYTHON_CONFORMANCE_COMMANDS,
  validateConformance,
} = require('../../scripts/validate-conformance');
const { PYTHON_VALIDATION_COMMANDS, validate } = require('../../scripts/validate');

class FakeChild extends EventEmitter {
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function fakeProcess(environment = {}) {
  const value = new EventEmitter();
  value.env = environment;
  value.exitCode = undefined;
  value.pid = 42;
  value.kill = vi.fn();
  value.stderr = { write: vi.fn() };
  return value;
}

test('selects the native npm launcher', () => {
  expect(npmExecutable('linux')).toBe('npm');
  expect(npmExecutable('win32')).toBe('npm.cmd');
});

test('selects the native Python launcher and honors an override', () => {
  expect(pythonExecutable('linux', {})).toBe('python3');
  expect(pythonExecutable('win32', {})).toBe('python');
  expect(pythonExecutable('win32', { PYTHON: 'py-custom.exe' })).toBe('py-custom.exe');
});

test('waits for TypeScript validation without changing the legacy launcher', async () => {
  const child = new FakeChild();
  const processLike = fakeProcess();
  const result = runTypeScriptNpmScriptAndWait('validate', {
    repositoryRoot: '/repo',
    platform: 'win32',
    processLike,
    spawnImpl: () => child,
  });
  child.emit('exit', 7, null);
  await expect(result).resolves.toBe(7);
});

test('runs Python checks from its workspace with Windows-safe spawning', async () => {
  const child = new FakeChild();
  const processLike = fakeProcess({ PYTHON: 'py-custom.exe' });
  const spawnImpl = vi.fn(() => child);
  const result = runPythonCommands([['-m', 'pytest']], {
    repositoryRoot: '/repo',
    platform: 'win32',
    processLike,
    spawnImpl,
  });
  expect(spawnImpl).toHaveBeenCalledWith('py-custom.exe', ['-m', 'pytest'], {
    cwd: expect.stringMatching(/[\\/]repo[\\/]python$/),
    shell: true,
    stdio: 'inherit',
  });
  child.emit('exit', 0, null);
  await expect(result).resolves.toBe(0);
});

test('runs from the TypeScript workspace and propagates exit status', () => {
  const child = new FakeChild();
  const processLike = fakeProcess();
  const spawnImpl = vi.fn(() => child);
  runTypeScriptNpmScript('validate', {
    repositoryRoot: '/repo',
    platform: 'win32',
    processLike,
    spawnImpl,
  });
  expect(spawnImpl).toHaveBeenCalledWith('npm.cmd', ['run', 'validate'], {
    cwd: expect.stringMatching(/[\\/]repo[\\/]typescript$/),
    shell: true,
    stdio: 'inherit',
  });
  child.emit('exit', 7, null);
  expect(processLike.exitCode).toBe(7);
});

test('runs the complete Python release-readiness sequence after TypeScript', async () => {
  const calls = [];
  const result = await validate({
    environment: {},
    runTypeScript: async (script) => {
      calls.push(['typescript', script]);
      return 0;
    },
    runPython: async (commands) => {
      calls.push(['python', commands]);
      return 0;
    },
  });
  expect(result).toBe(0);
  expect(calls).toEqual([
    ['typescript', 'validate'],
    ['python', PYTHON_VALIDATION_COMMANDS],
  ]);
  expect(PYTHON_VALIDATION_COMMANDS).toEqual([
    ['-m', 'ruff', 'format', '--check', '.'],
    ['-m', 'ruff', 'check', '.'],
    ['-m', 'mypy'],
    ['-m', 'pytest'],
    ['scripts/build_artifacts.py'],
    ['scripts/audit_distribution.py'],
  ]);
});

test('does not run Python validation after a TypeScript failure', async () => {
  const runPython = vi.fn();
  await expect(validate({ runTypeScript: async () => 7, runPython })).resolves.toBe(7);
  expect(runPython).not.toHaveBeenCalled();
});

test('can keep the existing workflow TypeScript-only without changing the root entry point', async () => {
  const runPython = vi.fn();
  await expect(
    validate({
      environment: { META_SAM_VALIDATE_TYPESCRIPT_ONLY: '1' },
      runTypeScript: async () => 0,
      runPython,
    }),
  ).resolves.toBe(0);
  expect(runPython).not.toHaveBeenCalled();
});

test('checks compatibility before both conformance runners', async () => {
  const calls = [];
  const result = await validateConformance({
    checkCompatibility: async () => {
      calls.push(['compatibility']);
      return 0;
    },
    runTypeScript: async (script) => {
      calls.push(['typescript', script]);
      return 0;
    },
    runPython: async (commands) => {
      calls.push(['python', commands]);
      return 0;
    },
  });
  expect(result).toBe(0);
  expect(calls).toEqual([
    ['compatibility'],
    ['typescript', 'conformance:check'],
    ['python', PYTHON_CONFORMANCE_COMMANDS],
  ]);
});

test('forwards termination signals and preserves signal termination', () => {
  const child = new FakeChild();
  const processLike = fakeProcess();
  runTypeScriptNpmScript('conformance:check', {
    repositoryRoot: '/repo',
    processLike,
    spawnImpl: () => child,
  });
  processLike.emit('SIGTERM');
  expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  child.emit('exit', null, 'SIGTERM');
  expect(processLike.kill).toHaveBeenCalledWith(42, 'SIGTERM');
});
