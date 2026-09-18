/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const pythonWorkflowPath = resolve(repositoryRoot, '.github/workflows/python.yml');
const validateWorkflowPath = resolve(repositoryRoot, '.github/workflows/validate.yml');
const pypiWorkflowPath = resolve(repositoryRoot, '.github/workflows/release-pypi.yml');
const expectedPaths = [
  '.github/workflows/python.yml',
  'README.md',
  'conformance/**',
  'protocol/**',
  'python/**',
  'scripts/check-compatibility.cjs',
  'scripts/compatibility-matrix.cjs',
  'scripts/run-process.cjs',
  'scripts/run-python.cjs',
  'scripts/run-typescript.cjs',
  'scripts/sync-compatibility',
  'scripts/validate',
  'scripts/validate-conformance',
  'typescript/package.json',
  'typescript/package-lock.json',
  'typescript/tsconfig.base.json',
  'typescript/tsconfig.json',
  'typescript/tsconfig.tests.json',
  'typescript/vitest.config.ts',
  'typescript/examples/api-playground/package-lock.json',
  'typescript/packages/graphics/package.json',
  'typescript/packages/parser/**',
  'typescript/packages/react/package.json',
  'typescript/packages/video/package.json',
  'typescript/test/conformance/**',
];

async function workflow(path) {
  return parse(await readFile(path, 'utf8'));
}

function steps(document) {
  return Object.values(document.jobs).flatMap((job) => job.steps ?? []);
}

test('Python workflow is valid, narrowly filtered, and read-only', async () => {
  const document = await workflow(pythonWorkflowPath);
  expect(Object.keys(document.jobs).sort()).toEqual([
    'build-and-quality',
    'clean-consumers',
    'cross-language-conformance',
    'supported-versions',
  ]);
  expect(document.permissions).toEqual({ contents: 'read' });
  expect(document.on.pull_request.paths).toEqual(expectedPaths);
  expect(document.on.push.paths).toEqual(expectedPaths);
  expect(document.on.push.branches).toEqual(['main']);
  expect(document.on.workflow_dispatch).toBeNull();
  expect(JSON.stringify(document)).not.toMatch(/publish|id-token|password|secret/i);
});

test('Python workflow pins every action by full commit SHA', async () => {
  const document = await workflow(pythonWorkflowPath);
  const actions = steps(document).filter((step) => step.uses !== undefined);
  expect(actions.length).toBeGreaterThan(0);
  for (const step of actions) {
    expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
  }
});

test('Python jobs build once, test supported versions, and audit consumers', async () => {
  const document = await workflow(pythonWorkflowPath);
  const supportedVersions = document.jobs['supported-versions'];
  expect(supportedVersions.strategy.matrix['python-version']).toEqual([
    '3.10',
    '3.11',
    '3.12',
    '3.13',
    '3.14',
  ]);
  const installCommand = supportedVersions.steps.find(
    (step) => step.name === 'Install tested wheel and test tools',
  )?.run;
  expect(installCommand?.trim().split(/\s+/)).toEqual([
    'python',
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    'pytest==9.0.3',
    'pytest-cov==7.0.0',
    'jsonschema==4.25.1',
    'dist/*.whl',
  ]);
  const commands = steps(document)
    .map((step) => step.run)
    .filter((command) => command !== undefined)
    .join('\n');
  expect(commands).toContain('python scripts/build_artifacts.py');
  expect(commands).toContain('python scripts/audit_distribution.py --mode artifacts');
  expect(commands).toContain('python scripts/audit_distribution.py --mode consumers');
  expect(commands).toContain('python -m pytest');
  expect(commands).toContain('jsonschema==4.25.1');
  expect(commands).toContain('node scripts/validate-conformance');
  expect(commands.match(/scripts\/build_artifacts\.py/g)).toHaveLength(1);
});

test('primary validation keeps the root entry point without duplicating Python', async () => {
  const document = await workflow(validateWorkflowPath);
  expect(document.jobs['python-compatibility']).toBeUndefined();
  expect(document.defaults.run['working-directory']).toBe('typescript');
  expect(document.on.pull_request).toBeNull();
  const validate = document.jobs.validate;
  const validateStep = validate.steps.find((step) => step.name === 'Validate');
  expect(validateStep?.run).toBe('node ../scripts/validate');
  expect(validateStep?.env).toEqual({ META_SAM_VALIDATE_TYPESCRIPT_ONLY: '1' });
  expect(
    validate.steps.some(
      (step) => step.uses?.startsWith('actions/setup-python@') ?? false,
    ),
  ).toBe(false);
});

test('PyPI release publishes only from the protected environment after every gate', async () => {
  const document = await workflow(pypiWorkflowPath);
  expect(Object.keys(document.jobs).sort()).toEqual([
    'build',
    'clean-consumers',
    'cross-language-conformance',
    'publish',
  ]);
  expect(document.permissions).toEqual({ contents: 'read' });
  expect(document.on.push).toEqual({ tags: ['meta-sam-parser@*'] });
  expect(document.on.workflow_dispatch).toBeNull();
  expect(document.on.pull_request).toBeUndefined();

  const publish = document.jobs.publish;
  expect(publish.needs).toEqual([
    'build',
    'clean-consumers',
    'cross-language-conformance',
  ]);
  expect(publish.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
  expect(publish.environment.name).toBe(
    "${{ github.event_name == 'push' && 'pypi' || 'testpypi' }}",
  );
  const uploads = publish.steps.filter((step) =>
    step.uses?.startsWith('pypa/gh-action-pypi-publish@'),
  );
  expect(uploads).toHaveLength(2);
  for (const step of uploads) {
    expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(step.with.password).toBeUndefined();
    expect(step.with['packages-dir']).toBe('dist/');
  }
  const [testPyPi, pyPi] = uploads;
  expect(testPyPi.if).toBe("github.event_name != 'push'");
  expect(testPyPi.with['repository-url']).toBe('https://test.pypi.org/legacy/');
  expect(pyPi.if).toBe("github.event_name == 'push'");
  expect(pyPi.with['repository-url']).toBeUndefined();

  // Only the publish job may mint an OIDC token, and nothing reads a secret.
  const privileged = Object.entries(document.jobs)
    .filter(([, job]) => job.permissions?.['id-token'] === 'write')
    .map(([name]) => name);
  expect(privileged).toEqual(['publish']);
  expect(JSON.stringify(document)).not.toContain('secrets.');

  // The tag must name the manifest version, and the published bytes are the
  // audited bytes: digests recorded by build are verified before upload.
  const build = document.jobs.build;
  expect(build.if).toBe(
    "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'",
  );
  expect(build.steps.find((step) => step.id === 'identity')?.run).toContain(
    'does not match pyproject version',
  );
  expect(build.steps.map((step) => step.run).filter(Boolean)).toEqual(
    expect.arrayContaining([
      'python scripts/build_artifacts.py',
      'python scripts/audit_distribution.py --mode artifacts',
      'python -m pytest',
    ]),
  );
  expect(
    publish.steps.find((step) => step.name === 'Verify artifact digests')?.run,
  ).toBe('sha256sum --check SHA256SUMS && rm SHA256SUMS');
});
