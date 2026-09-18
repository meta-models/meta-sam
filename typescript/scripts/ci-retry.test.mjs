/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';

const retry = new URL('./ci-retry.sh', import.meta.url).pathname;
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-retry-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function flakyCommand(failuresBeforeSuccess, exitCode = 7) {
  const counter = join(dir, 'count');
  const script = join(dir, 'flaky.sh');
  writeFileSync(counter, '0');
  writeFileSync(
    script,
    `#!/usr/bin/env bash
n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
if [ "$n" -gt ${failuresBeforeSuccess} ]; then exit 0; fi
exit ${exitCode}
`,
  );
  chmodSync(script, 0o755);
  return { script, attempts: () => Number(readFileSync(counter, 'utf8')) };
}

function run(args) {
  return spawnSync(retry, args, {
    encoding: 'utf8',
    env: { ...process.env, CI_RETRY_DELAY: '0' },
  });
}

test('returns success immediately when the command succeeds', () => {
  const { script, attempts } = flakyCommand(0);
  const result = run([script]);
  expect(result.status).toBe(0);
  expect(attempts()).toBe(1);
});

test('retries a transient failure and succeeds', () => {
  const { script, attempts } = flakyCommand(1);
  const result = run([script]);
  expect(result.status).toBe(0);
  expect(attempts()).toBe(2);
  expect(result.stderr).toMatch(/attempt 1 of 3 failed \(exit 7\)/);
});

test('gives up after three attempts and preserves the last exit status', () => {
  const { script, attempts } = flakyCommand(99, 5);
  const result = run([script]);
  expect(result.status).toBe(5);
  expect(attempts()).toBe(3);
  expect(result.stderr).toMatch(/failed 3 times \(last exit 5\)/);
});

test('passes compound shell commands through sh -c unchanged', () => {
  const result = run(['sh', '-c', 'exit 3']);
  expect(result.status).toBe(3);
});
