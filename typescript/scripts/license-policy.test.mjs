/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  EXPECTED_LICENSE_SHA256,
  PACKAGE_LICENSE,
  assertLicenseBytes,
  assertManifestLicense,
  checkLicensePolicy,
  findStaleLicenseDeclaration,
} = require('../../scripts/check-license.cjs');
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
}

async function cloneRepository() {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-license-test-'));
  roots.push(temporaryRoot);
  const root = resolve(temporaryRoot, 'repository');
  runGit(temporaryRoot, ['clone', '--quiet', '--no-hardlinks', repositoryRoot, root]);
  return root;
}

async function addTrackedFile(root, path, content) {
  await mkdir(dirname(resolve(root, path)), { recursive: true });
  await writeFile(resolve(root, path), content);
  runGit(root, ['add', '--', path]);
  runGit(root, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=License Policy Test',
    '-c',
    'user.email=license-policy-test@example.com',
    'commit',
    '--quiet',
    '-m',
    'Add license policy fixture',
  ]);
}

test('repository satisfies the complete SAM license policy', () => {
  expect(() => checkLicensePolicy()).not.toThrow();
});

test('license-byte audit rejects any content drift', () => {
  expect(() => assertLicenseBytes(Buffer.from('changed'), 'fixture')).toThrow(
    EXPECTED_LICENSE_SHA256,
  );
});

test('manifest audit rejects the legacy declaration', () => {
  const stale = 'M' + 'IT';
  expect(() => assertManifestLicense({ license: stale }, 'fixture')).toThrow(
    PACKAGE_LICENSE,
  );
  expect(findStaleLicenseDeclaration(`license = ${stale}`)).toBe(true);
});

test('allows a consumed pending changeset that remains tracked', async () => {
  const root = await cloneRepository();
  const path = 'typescript/.changeset/consumed-release.md';
  await addTrackedFile(root, path, '---\n"@meta-sam/parser": patch\n---\n');
  await rm(resolve(root, path));

  expect(() => checkLicensePolicy(root)).not.toThrow();
});

test('rejects a missing tracked non-changeset source file', async () => {
  const root = await cloneRepository();
  const path = 'typescript/scripts/clean.mjs';
  await rm(resolve(root, path));

  expect(() => checkLicensePolicy(root)).toThrow(
    `License policy cannot inspect ${path}: file is missing from the working tree.`,
  );
});

test('rejects a missing tracked changeset README', async () => {
  const root = await cloneRepository();
  const path = 'typescript/.changeset/README.md';
  await rm(resolve(root, path));

  expect(() => checkLicensePolicy(root)).toThrow(
    `License policy cannot inspect ${path}: file is missing from the working tree.`,
  );
});

test('rejects a missing tracked nested changeset path', async () => {
  const root = await cloneRepository();
  const path = 'typescript/.changeset/nested/not-a-pending-changeset.md';
  await addTrackedFile(root, path, 'Nested fixture.\n');
  await rm(resolve(root, path));

  expect(() => checkLicensePolicy(root)).toThrow(
    `License policy cannot inspect ${path}: file is missing from the working tree.`,
  );
});
