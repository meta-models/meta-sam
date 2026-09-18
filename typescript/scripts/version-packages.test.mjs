/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { versionPackages } from './version-packages.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function manifest(root, directory) {
  return JSON.parse(
    await readFile(resolve(root, 'packages', directory, 'package.json'), 'utf8'),
  );
}

async function lockfile(root, path = 'package-lock.json') {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-changesets-test-'));
  roots.push(root);
  await mkdir(resolve(root, '.changeset'));
  for (const directory of ['parser', 'graphics', 'video', 'react']) {
    await mkdir(resolve(root, 'packages', directory), { recursive: true });
  }
  await mkdir(resolve(root, 'examples', 'api-playground'), { recursive: true });
  await writeJson(resolve(root, 'package.json'), {
    name: 'fixture',
    private: true,
    packageManager: 'npm@11.16.0',
    workspaces: ['packages/*'],
    devDependencies: { yaml: '2.8.3' },
  });
  await writeJson(resolve(root, '.changeset', 'config.json'), {
    changelog: false,
    commit: false,
    fixed: [],
    linked: [],
    access: 'public',
    baseBranch: 'main',
    updateInternalDependencies: 'patch',
    bumpVersionsWithWorkspaceProtocolOnly: false,
    ignore: [],
  });
  await writeFile(
    resolve(root, '.changeset', 'parser-fix.md'),
    `---\n"@meta-sam/parser": patch\n---\n\nFix parser behavior.\n`,
  );
  await writeJson(resolve(root, 'packages', 'parser', 'package.json'), {
    name: '@meta-sam/parser',
    version: '0.0.1',
  });
  await writeJson(resolve(root, 'packages', 'graphics', 'package.json'), {
    name: '@meta-sam/graphics',
    version: '0.0.1',
    dependencies: { '@meta-sam/parser': '0.0.1' },
  });
  await writeJson(resolve(root, 'packages', 'video', 'package.json'), {
    name: '@meta-sam/video',
    version: '0.0.1',
  });
  await writeJson(resolve(root, 'packages', 'react', 'package.json'), {
    name: '@meta-sam/react',
    version: '0.0.1',
    dependencies: {
      '@meta-sam/graphics': '0.0.1',
      '@meta-sam/parser': '0.0.1',
      '@meta-sam/video': '0.0.1',
    },
  });
  await writeJson(resolve(root, 'examples', 'api-playground', 'package.json'), {
    name: 'playground-fixture',
    version: '0.0.0',
    dependencies: {
      '@meta-sam/graphics': 'file:../../packages/graphics',
      '@meta-sam/parser': 'file:../../packages/parser',
      '@meta-sam/react': 'file:../../packages/react',
      '@meta-sam/video': 'file:../../packages/video',
    },
  });
  const install = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);
  const playgroundInstall = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--prefix',
      resolve(root, 'examples', 'api-playground'),
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  expect(
    playgroundInstall.status,
    `${playgroundInstall.stdout}${playgroundInstall.stderr}`,
  ).toBe(0);
  return root;
}

test('a parser patch cascades through exact dependent manifests and lock metadata', async () => {
  const root = await createFixture();
  const lockBeforeVersioning = await lockfile(root);
  const workspacePaths = new Set(
    ['parser', 'graphics', 'video', 'react'].map(
      (directory) => `packages/${directory}`,
    ),
  );
  const lockPackagesOutsideWorkspaces = Object.fromEntries(
    Object.entries(lockBeforeVersioning.packages).filter(
      ([path]) => !workspacePaths.has(path),
    ),
  );
  const thirdPartyLockBeforeVersioning =
    lockBeforeVersioning.packages['node_modules/yaml'];
  expect(thirdPartyLockBeforeVersioning).toMatchObject({
    version: '2.8.3',
    dev: true,
  });
  const playgroundLockPath = 'examples/api-playground/package-lock.json';
  const playgroundLockBeforeVersioning = await lockfile(root, playgroundLockPath);
  expect(
    playgroundLockBeforeVersioning.packages['../../packages/parser']?.version,
  ).toBe('0.0.1');
  const playgroundWorkspacePaths = new Set(
    ['parser', 'graphics', 'video', 'react'].map(
      (directory) => `../../packages/${directory}`,
    ),
  );
  const playgroundPackagesOutsideWorkspaces = Object.fromEntries(
    Object.entries(playgroundLockBeforeVersioning.packages).filter(
      ([path]) => !playgroundWorkspacePaths.has(path),
    ),
  );

  const compatibilityWrites = [];
  const plan = await versionPackages({
    root,
    compatibilityWriter: async (writtenRoot) => {
      compatibilityWrites.push(writtenRoot);
    },
  });
  expect(compatibilityWrites).toEqual([root]);

  expect(plan.packages).toEqual([
    {
      name: '@meta-sam/parser',
      version: '0.0.2',
    },
    {
      name: '@meta-sam/graphics',
      version: '0.0.2',
    },
    {
      name: '@meta-sam/react',
      version: '0.0.2',
    },
  ]);
  expect((await manifest(root, 'video')).version).toBe('0.0.1');
  expect((await manifest(root, 'graphics')).dependencies).toEqual({
    '@meta-sam/parser': '0.0.2',
  });
  expect((await manifest(root, 'react')).dependencies).toEqual({
    '@meta-sam/graphics': '0.0.2',
    '@meta-sam/parser': '0.0.2',
    '@meta-sam/video': '0.0.1',
  });

  const lockAfterVersioning = await lockfile(root);
  expect(lockAfterVersioning.packages['packages/parser']).toEqual({
    name: '@meta-sam/parser',
    version: '0.0.2',
  });
  expect(lockAfterVersioning.packages['packages/graphics']).toEqual({
    name: '@meta-sam/graphics',
    version: '0.0.2',
    dependencies: { '@meta-sam/parser': '0.0.2' },
  });
  expect(lockAfterVersioning.packages['packages/video']).toEqual({
    name: '@meta-sam/video',
    version: '0.0.1',
  });
  expect(lockAfterVersioning.packages['packages/react']).toEqual({
    name: '@meta-sam/react',
    version: '0.0.2',
    dependencies: {
      '@meta-sam/graphics': '0.0.2',
      '@meta-sam/parser': '0.0.2',
      '@meta-sam/video': '0.0.1',
    },
  });
  expect(
    Object.fromEntries(
      Object.entries(lockAfterVersioning.packages).filter(
        ([path]) => !workspacePaths.has(path),
      ),
    ),
  ).toEqual(lockPackagesOutsideWorkspaces);
  expect(lockAfterVersioning.packages['node_modules/yaml']).toEqual(
    thirdPartyLockBeforeVersioning,
  );

  const playgroundLockAfterVersioning = await lockfile(root, playgroundLockPath);
  for (const directory of ['parser', 'graphics', 'video', 'react']) {
    expect(
      playgroundLockAfterVersioning.packages[`../../packages/${directory}`],
    ).toEqual(lockAfterVersioning.packages[`packages/${directory}`]);
  }
  expect(
    Object.fromEntries(
      Object.entries(playgroundLockAfterVersioning.packages).filter(
        ([path]) => !playgroundWorkspacePaths.has(path),
      ),
    ),
  ).toEqual(playgroundPackagesOutsideWorkspaces);
});

test('a playground lockfile update failure prevents release plan finalization', async () => {
  const root = await createFixture();
  const failingNpmCli = resolve(root, 'failing-npm.mjs');
  await writeFile(
    failingNpmCli,
    `if (process.argv.includes('--prefix')) {\n  process.stdout.write('playground lock stdout\\n');\n  process.stderr.write('playground lock stderr\\n');\n  process.exitCode = 23;\n}\n`,
  );

  await expect(
    versionPackages({
      root,
      npmCli: failingNpmCli,
      compatibilityWriter: async () => {
        throw new Error('compatibility must not be rewritten before lockfiles succeed');
      },
    }),
  ).rejects.toThrow(
    'playground npm lockfile update failed:\nplayground lock stdout\nplayground lock stderr\n',
  );
  await expect(
    readFile(resolve(root, '.changeset', 'release-plan.json'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
