/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCanonicalArchives } from './create-release-archives.mjs';
import { releasePackages } from './release-packages.mjs';
import {
  auditCanonicalBuildOutputs,
  canonicalPackageCopyPaths,
  canonicalRootCopyPaths,
  copyCanonicalBuildInputs,
  copyPlaygroundAllowlist,
  createSubprocessEnvironment,
  isPlaygroundCopyPath,
  playgroundCopyDirectories,
  playgroundCopyFiles,
  publicNpmRegistry,
  rewritePlaygroundManifest,
} from './test-playground-packages.mjs';

const archives = [
  ['@meta-sam/parser', 'meta-sam-parser-0.0.2.tgz'],
  ['@meta-sam/graphics', 'meta-sam-graphics-0.1.0.tgz'],
  ['@meta-sam/video', 'meta-sam-video-0.1.0.tgz'],
  ['@meta-sam/react', 'meta-sam-react-0.1.0.tgz'],
].map(([name, filename]) => ({
  name,
  archive: resolve('/tmp/packed-gate/packs', filename),
}));

async function expectMissing(path) {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function createPlaygroundFixture(sourceRoot) {
  await mkdir(sourceRoot, { recursive: true });
  for (const file of playgroundCopyFiles) {
    await writeFile(resolve(sourceRoot, file), `${file}\n`);
  }
  for (const directory of playgroundCopyDirectories) {
    await mkdir(resolve(sourceRoot, directory), { recursive: true });
    await writeFile(resolve(sourceRoot, directory, 'known.txt'), `${directory}\n`);
  }
}

async function createCanonicalSourceFixture(sourceRoot) {
  await mkdir(sourceRoot, { recursive: true });
  for (const file of canonicalRootCopyPaths) {
    const content =
      file === 'package.json'
        ? JSON.stringify({ name: 'canonical-fixture', private: true })
        : '{}';
    await writeFile(resolve(sourceRoot, file), `${content}\n`);
  }
  for (const entry of releasePackages) {
    const packageRoot = resolve(sourceRoot, 'packages', entry.directory);
    await mkdir(resolve(packageRoot, 'src'), { recursive: true });
    const contentByPath = {
      'package.json': `${JSON.stringify(
        {
          name: entry.name,
          version: '1.0.0',
          license: 'SEE LICENSE IN LICENSE',
          repository: {
            type: 'git',
            url: 'git+https://github.com/meta-models/meta-sam.git',
            directory: `typescript/packages/${entry.directory}`,
          },
          publishConfig: { access: 'public' },
          type: 'module',
          files: ['dist', 'README.md', 'LICENSE'],
        },
        null,
        2,
      )}\n`,
      'tsconfig.json': '{}\n',
      'README.md': `# ${entry.name}\n`,
      LICENSE: await readFile(
        resolve(import.meta.dirname, '..', '..', 'LICENSE'),
        'utf8',
      ),
    };
    for (const file of canonicalPackageCopyPaths) {
      if (file === 'src') continue;
      await writeFile(resolve(packageRoot, file), contentByPath[file]);
    }
    await writeFile(
      resolve(packageRoot, 'src', 'index.ts'),
      'export const value = 1;\n',
    );
  }
  const staleDist = resolve(sourceRoot, 'packages', 'parser', 'dist');
  await mkdir(staleDist, { recursive: true });
  await writeFile(
    resolve(staleDist, 'deleted-source.js'),
    'throw new Error("stale checkout output");\n',
  );
}

describe('packed playground isolation', () => {
  it('copies only explicit playground roots and rejects sensitive names', () => {
    expect(isPlaygroundCopyPath('test/playground.spec.ts')).toBe(true);
    expect(isPlaygroundCopyPath('src/App.tsx')).toBe(true);
    for (const path of [
      '.ENV',
      '.env.local',
      '.envrc',
      '.npmrc',
      'src/credentials.json',
      'src/client-secret.txt',
      'test/access_tokens.json',
      'node_modules/package/index.js',
      'dist/assets/index.js',
      'random-root-file.txt',
      '../outside.txt',
    ]) {
      expect(isPlaygroundCopyPath(path), path).toBe(false);
    }
  });

  it('never copies an arbitrary root file or a fake root npm config', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'packed-copy-test-'));
    const sourceRoot = resolve(temporaryRoot, 'source');
    const destinationRoot = resolve(temporaryRoot, 'destination');
    try {
      await createPlaygroundFixture(sourceRoot);
      await writeFile(resolve(sourceRoot, '.npmrc'), '_authToken=poison\n');
      await writeFile(resolve(sourceRoot, 'credentials.json'), '{"token":"poison"}\n');
      await writeFile(resolve(sourceRoot, 'arbitrary.txt'), 'not allowlisted\n');

      await copyPlaygroundAllowlist(sourceRoot, destinationRoot);

      expect(await readFile(resolve(destinationRoot, 'src', 'known.txt'), 'utf8')).toBe(
        'src\n',
      );
      await expectMissing(resolve(destinationRoot, '.npmrc'));
      await expectMissing(resolve(destinationRoot, 'credentials.json'));
      await expectMissing(resolve(destinationRoot, 'arbitrary.txt'));
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('fails closed on a sensitive file or symlink within an allowlisted directory', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'packed-copy-test-'));
    const sourceRoot = resolve(temporaryRoot, 'source');
    try {
      await createPlaygroundFixture(sourceRoot);
      await writeFile(resolve(sourceRoot, 'src', 'credentials.json'), '{}\n');
      await expect(
        copyPlaygroundAllowlist(sourceRoot, resolve(temporaryRoot, 'sensitive-copy')),
      ).rejects.toThrow(/Sensitive file/);
      await rm(resolve(sourceRoot, 'src', 'credentials.json'));
      await symlink(
        resolve(sourceRoot, 'README.md'),
        resolve(sourceRoot, 'src', 'linked-readme'),
      );
      await expect(
        copyPlaygroundAllowlist(sourceRoot, resolve(temporaryRoot, 'symlink-copy')),
      ).rejects.toThrow(/Symbolic links/);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('does not expose poisoned process or npm configuration to subprocesses', () => {
    const controlledUserConfig = '/isolated/home/.npmrc';
    const env = createSubprocessEnvironment({
      sourceEnvironment: {
        PATH: process.env.PATH ?? '',
        LANG: 'C.UTF-8',
        CI: 'true',
        PLAYWRIGHT_BROWSERS_PATH: '/controlled/playwright',
        NODE_OPTIONS: '--require=/poison/node-options.cjs',
        NPM_CONFIG_USERCONFIG: '/poison/.npmrc',
        NPM_TOKEN: 'poison',
        HTTPS_PROXY: 'http://user:password@poison.invalid',
        SAM_API_KEY: 'poison',
        VITE_SECRET: 'poison',
      },
      home: '/isolated/home',
      npmCache: '/isolated/npm-cache',
      userConfig: controlledUserConfig,
      globalConfig: '/isolated/home/global.npmrc',
    });
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(JSON.stringify({
          nodeOptions: process.env.NODE_OPTIONS,
          userConfig: process.env.NPM_CONFIG_USERCONFIG,
          npmToken: process.env.NPM_TOKEN,
          proxy: process.env.HTTPS_PROXY,
          sam: process.env.SAM_API_KEY,
          vite: process.env.VITE_SECRET,
          registry: process.env.NPM_CONFIG_REGISTRY,
          browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
        }))`,
      ],
      { encoding: 'utf8', env },
    );

    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      userConfig: controlledUserConfig,
      registry: publicNpmRegistry,
      browserPath: '/controlled/playwright',
    });
  });

  it('cannot pack stale output for a deleted source file', async () => {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'packed-stale-test-'));
    const sourceRoot = resolve(temporaryRoot, 'source');
    const buildRoot = resolve(temporaryRoot, 'build');
    try {
      await createCanonicalSourceFixture(sourceRoot);
      await copyCanonicalBuildInputs(sourceRoot, buildRoot);
      await expectMissing(
        resolve(buildRoot, 'packages', 'parser', 'dist', 'deleted-source.js'),
      );

      for (const entry of releasePackages) {
        const distRoot = resolve(buildRoot, 'packages', entry.directory, 'dist');
        await mkdir(distRoot, { recursive: true });
        await writeFile(resolve(distRoot, 'index.js'), 'export const value = 1;\n');
        await writeFile(
          resolve(distRoot, 'index.d.ts'),
          'export declare const value = 1;\n',
        );
      }
      const staleOutput = resolve(
        buildRoot,
        'packages',
        'parser',
        'dist',
        'deleted-source.js',
      );
      await writeFile(staleOutput, 'throw new Error("stale");\n');
      await expect(auditCanonicalBuildOutputs(buildRoot)).rejects.toThrow(
        /unexpected: deleted-source\.js/,
      );
      await rm(staleOutput);
      await auditCanonicalBuildOutputs(buildRoot);

      const home = resolve(temporaryRoot, 'home');
      await mkdir(home, { recursive: true });
      const userConfig = resolve(home, '.npmrc');
      const globalConfig = resolve(home, 'global.npmrc');
      await writeFile(userConfig, '');
      await writeFile(globalConfig, '');
      const env = createSubprocessEnvironment({
        home,
        npmCache: resolve(temporaryRoot, 'npm-cache'),
        userConfig,
        globalConfig,
        playwrightBrowsersPath: '/controlled/playwright',
      });
      const packed = await createCanonicalArchives(resolve(temporaryRoot, 'packs'), {
        workspaceRoot: buildRoot,
        sourceRoot: resolve(buildRoot, 'packages'),
        env,
        registry: publicNpmRegistry,
      });
      expect(
        packed.find((archive) => archive.name === '@meta-sam/parser')?.files,
      ).not.toContain('dist/deleted-source.js');
      await expect(
        createCanonicalArchives(resolve(temporaryRoot, 'outside-packs'), {
          workspaceRoot: buildRoot,
          sourceRoot: resolve(sourceRoot, 'packages'),
          env,
          registry: publicNpmRegistry,
        }),
      ).rejects.toThrow(/child of the workspace root/);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it('rewrites exactly the four canonical package dependencies to tarballs', () => {
    const manifest = {
      dependencies: {
        '@meta-sam/parser': 'file:../../packages/parser',
        '@meta-sam/graphics': 'file:../../packages/graphics',
        '@meta-sam/video': 'file:../../packages/video',
        '@meta-sam/react': 'file:../../packages/react',
        react: '19.2.8',
      },
    };
    const rewritten = rewritePlaygroundManifest(
      manifest,
      archives,
      '/tmp/packed-gate/examples/api-playground',
    );

    expect(rewritten.dependencies).toEqual({
      '@meta-sam/parser': 'file:../../packs/meta-sam-parser-0.0.2.tgz',
      '@meta-sam/graphics': 'file:../../packs/meta-sam-graphics-0.1.0.tgz',
      '@meta-sam/video': 'file:../../packs/meta-sam-video-0.1.0.tgz',
      '@meta-sam/react': 'file:../../packs/meta-sam-react-0.1.0.tgz',
      react: '19.2.8',
    });
    expect(manifest.dependencies['@meta-sam/parser']).toBe(
      'file:../../packages/parser',
    );
  });

  it('fails closed when a canonical tarball or playground dependency is absent', () => {
    const dependencies = Object.fromEntries(
      archives.map(({ name }) => [name, `file:../../packages/${name.split('/')[1]}`]),
    );
    expect(() =>
      rewritePlaygroundManifest(
        { dependencies },
        archives.slice(1),
        '/tmp/packed-gate/examples/api-playground',
      ),
    ).toThrow(/archive is missing/);
    delete dependencies['@meta-sam/react'];
    expect(() =>
      rewritePlaygroundManifest(
        { dependencies },
        archives,
        '/tmp/packed-gate/examples/api-playground',
      ),
    ).toThrow(/dependency is missing/);
  });
});
