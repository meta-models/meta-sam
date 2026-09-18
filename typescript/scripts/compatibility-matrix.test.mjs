/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const { MATRIX_PATH, computeCompatibilityMatrix, writeCompatibilityMatrix } = require(
  resolve(repositoryRoot, 'scripts', 'compatibility-matrix.cjs'),
);

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function copyRepositorySubset() {
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-compatibility-'));
  roots.push(root);
  for (const path of [
    'conformance',
    'protocol',
    'scripts',
    'python/pyproject.toml',
    'typescript/packages/parser/package.json',
    'typescript/package-lock.json',
    'typescript/examples/api-playground/package-lock.json',
  ]) {
    await cp(resolve(repositoryRoot, path), resolve(root, path), { recursive: true });
  }
  return root;
}

function check(root) {
  return spawnSync(process.execPath, ['scripts/check-compatibility.cjs'], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('the checked-in matrix equals the computed contract and versions', async () => {
  const checkedIn = JSON.parse(
    await readFile(resolve(repositoryRoot, MATRIX_PATH), 'utf8'),
  );
  const computed = await computeCompatibilityMatrix(repositoryRoot);
  expect(checkedIn).toEqual(computed);

  const parser = JSON.parse(
    await readFile(
      resolve(repositoryRoot, 'typescript/packages/parser/package.json'),
      'utf8',
    ),
  );
  const pyproject = await readFile(
    resolve(repositoryRoot, 'python/pyproject.toml'),
    'utf8',
  );
  expect(computed.implementations).toEqual([
    expect.objectContaining({
      language: 'typescript',
      distribution: parser.name,
      version: parser.version,
      contract_identity: computed.contract.identity,
    }),
    expect.objectContaining({
      language: 'python',
      distribution: 'meta-sam-parser',
      version: pyproject.match(/^version = "([^"]+)"$/m)[1],
      contract_identity: computed.contract.identity,
    }),
  ]);
});

test('a parser version bump fails the check until the matrix is regenerated', async () => {
  const root = await copyRepositorySubset();
  const manifestPath = resolve(root, 'typescript/packages/parser/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '99.0.0';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const stale = check(root);
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain(
    'TypeScript parser metadata does not match the matrix',
  );
  expect(stale.stderr).toContain('node scripts/sync-compatibility');

  const written = await writeCompatibilityMatrix(root);
  expect(written.implementations[0].version).toBe('99.0.0');
  const stored = JSON.parse(await readFile(resolve(root, MATRIX_PATH), 'utf8'));
  expect(stored).toEqual(written);

  // The lock metadata check still guards the workspace after the matrix agrees.
  const relocked = check(root);
  expect(relocked.status).toBe(1);
  expect(relocked.stderr).toContain('workspace lock metadata does not match');
});

test('a corpus change fails the check with the contract component named', async () => {
  const root = await copyRepositorySubset();
  await writeFile(
    resolve(root, 'conformance/cases/synthetic-video-basic.json'),
    `${await readFile(resolve(root, 'conformance/cases/synthetic-video-basic.json'), 'utf8')}\n`,
  );
  const result = check(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('contract corpus does not match');
});

test('versioning regenerates and stages the matrix outside the workspace', async () => {
  const { stageCompatibilityMatrix } = await import('./version-packages.mjs');
  const root = await copyRepositorySubset();
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  git('init', '--quiet');
  git('add', '.');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--quiet',
    '-m',
    'base',
  );

  const manifestPath = resolve(root, 'typescript/packages/parser/package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '99.0.0';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const matrix = await stageCompatibilityMatrix(resolve(root, 'typescript'));
  expect(matrix.implementations[0].version).toBe('99.0.0');
  // The Changesets action commits with `git add .` from typescript/, which
  // cannot see the matrix; it must already be staged.
  expect(git('diff', '--cached', '--name-only').trim()).toBe(MATRIX_PATH);
});
