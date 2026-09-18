/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  PACKAGE_LICENSE,
  REPOSITORY_URL,
  SAM_LICENSE_SHA256,
  assertManifestLicense,
  assertNoSymlinkAncestors,
  assertPackageInputs,
  assertPeerDependenciesMeta,
  assertPublishableManifest,
  assertReleaseOrder,
  assertSafePackageContent,
  assertSamLicense,
  resolveCanonicalPackageRoot,
  validateOutputPath,
} from './create-release-archives.mjs';
import { releasePackagesForPlan } from './release-packages.mjs';

function publishableManifest(overrides = {}) {
  return {
    name: '@meta-sam/graphics',
    version: '0.1.4',
    license: PACKAGE_LICENSE,
    repository: {
      type: 'git',
      url: REPOSITORY_URL,
      directory: 'typescript/packages/graphics',
    },
    publishConfig: { access: 'public' },
    dependencies: { '@meta-sam/parser': '0.0.6' },
    ...overrides,
  };
}

describe('public release manifests', () => {
  test('selects an ordered subset from a release plan', () => {
    expect(
      releasePackagesForPlan({
        schemaVersion: 1,
        packages: [
          { name: '@meta-sam/parser', version: '0.0.2' },
          { name: '@meta-sam/react', version: '0.0.2' },
        ],
      }).map(({ name }) => name),
    ).toEqual(['@meta-sam/parser', '@meta-sam/react']);
  });

  test('rejects a plan entry that still carries a registry alias', () => {
    expect(() =>
      releasePackagesForPlan({
        schemaVersion: 1,
        packages: [
          { canonicalName: '@meta-sam/parser', aliasName: 'x', version: '0.0.2' },
        ],
      }),
    ).toThrow(/Invalid planned package/);
  });

  test.each([
    '',
    '1',
    '1.2',
    'v1.2.3',
    '^1.2.3',
    '1.2.3 || 2.0.0',
    '1.2.3-01',
    '01.2.3',
  ])('rejects a non-exact release-plan version %j', (version) => {
    expect(() =>
      releasePackagesForPlan({
        schemaVersion: 1,
        packages: [{ name: '@meta-sam/parser', version }],
      }),
    ).toThrow(/Invalid planned package/);
  });

  test('rejects release plans outside dependency order', () => {
    expect(() =>
      releasePackagesForPlan({
        schemaVersion: 1,
        packages: [
          { name: '@meta-sam/react', version: '0.0.2' },
          { name: '@meta-sam/parser', version: '0.0.2' },
        ],
      }),
    ).toThrow(/dependency order/);
  });

  test('accepts a complete public manifest', () => {
    expect(() =>
      assertPublishableManifest(publishableManifest(), 'graphics'),
    ).not.toThrow();
  });

  test.each([
    ['a private flag', { private: true }, /marked private/],
    ['a missing repository', { repository: undefined }, /must declare repository/],
    [
      'a repository pointing elsewhere',
      { repository: { type: 'git', url: 'git+https://github.com/example/other.git' } },
      /must declare repository/,
    ],
    [
      'the wrong package directory',
      {
        repository: {
          type: 'git',
          url: REPOSITORY_URL,
          directory: 'typescript/packages/parser',
        },
      },
      /must declare repository/,
    ],
    [
      'restricted access',
      { publishConfig: { access: 'restricted' } },
      /access "public"/,
    ],
    ['no publishConfig', { publishConfig: undefined }, /access "public"/],
    ['a stale license', { license: 'M' + 'IT' }, /SEE LICENSE IN LICENSE/],
    [
      'a ranged internal dependency',
      { dependencies: { '@meta-sam/parser': '^0.0.6' } },
      /must pin an exact version/,
    ],
    [
      'an aliased internal dependency',
      { dependencies: { '@meta-sam/parser': 'npm:@example/parser@0.0.6' } },
      /must pin an exact version/,
    ],
  ])('rejects a manifest with %s', (_label, overrides, expected) => {
    expect(() =>
      assertPublishableManifest(publishableManifest(overrides), 'graphics'),
    ).toThrow(expected);
  });

  test('rejects stale manifest declarations and changed license bytes', () => {
    const legacy = 'M' + 'IT';
    expect(() => assertManifestLicense({ license: legacy }, 'fixture')).toThrow(
      PACKAGE_LICENSE,
    );
    expect(() => assertSamLicense(Buffer.from('changed'), 'fixture')).toThrow(
      SAM_LICENSE_SHA256,
    );
  });

  test.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'requires every local %s entry to appear earlier in publish order',
    (field) => {
      const manifests = new Map([
        ['@meta-sam/parser', { name: '@meta-sam/parser' }],
        [
          '@meta-sam/graphics',
          {
            name: '@meta-sam/graphics',
            [field]: { '@meta-sam/parser': '0.0.1' },
          },
        ],
      ]);
      const parser = { name: '@meta-sam/parser' };
      const graphics = { name: '@meta-sam/graphics' };

      expect(() => assertReleaseOrder([parser, graphics], manifests)).not.toThrow();
      expect(() => assertReleaseOrder([graphics, parser], manifests)).toThrow(
        /must be published after/,
      );
    },
  );

  test('rejects peer metadata without a matching peer dependency', () => {
    expect(() =>
      assertPeerDependenciesMeta({
        name: '@meta-sam/parser',
        peerDependenciesMeta: {
          react: { optional: true },
        },
      }),
    ).toThrow(/has no matching peerDependency/);
  });

  test('accepts consistent external peer dependency metadata', () => {
    expect(() =>
      assertPeerDependenciesMeta({
        name: '@meta-sam/parser',
        peerDependencies: { react: '>=18' },
        peerDependenciesMeta: { react: { optional: true } },
      }),
    ).not.toThrow();
  });

  test('allows release output only below the workspace .packs directory', () => {
    expect(validateOutputPath('.packs/release')).toMatch(/\.packs\/release$/);
    expect(() => validateOutputPath('.packs')).toThrow(/child directory/);
    expect(() => validateOutputPath('.')).toThrow(/child directory/);
    expect(() => validateOutputPath('..')).toThrow(/child directory/);
  });

  test('rejects a symlink used as the .packs base', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-output-test-'));
    const target = resolve(root, 'outside');
    const base = resolve(root, '.packs');
    await mkdir(target);
    await symlink(target, base, 'dir');
    try {
      await expect(
        assertNoSymlinkAncestors(resolve(base, 'release'), base),
      ).rejects.toThrow(/real directory/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects a symlinked package root on every release path', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-package-root-test-'));
    const sourceRoot = resolve(root, 'packages');
    const target = resolve(root, 'outside');
    await mkdir(sourceRoot);
    await mkdir(target);
    await symlink(target, resolve(sourceRoot, 'parser'), 'dir');
    try {
      await expect(resolveCanonicalPackageRoot(sourceRoot, 'parser')).rejects.toThrow(
        /must be a real directory/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('rejects a symlinked package manifest before reading it', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-package-input-test-'));
    const target = resolve(root, 'outside-package.json');
    const packageRoot = resolve(root, 'parser');
    await mkdir(resolve(packageRoot, 'dist'), { recursive: true });
    await Promise.all([
      writeFile(target, '{}'),
      writeFile(resolve(packageRoot, 'README.md'), '# package'),
      writeFile(resolve(packageRoot, 'LICENSE'), 'license'),
    ]);
    await symlink(target, resolve(packageRoot, 'package.json'));
    try {
      await expect(assertPackageInputs(packageRoot)).rejects.toThrow(/regular file/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each([
    ['internal hostname', 'https://www.internalfb.com/example'],
    [
      'pre-release README wording',
      'This package is private and has not been approved for publication.',
    ],
    ['registry-access README wording', 'The packages are currently private, so'],
    ['npm token', 'NPM_TOKEN=secret'],
    ['npm auth token', '//registry.example/:_authToken=secret'],
    ['bearer header', 'Authorization: Bearer secret'],
  ])('rejects %s from package bytes', (_label, content) => {
    expect(() => assertSafePackageContent('dist/index.js', content)).toThrow();
  });
});
