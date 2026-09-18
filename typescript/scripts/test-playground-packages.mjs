/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PACKAGE_LICENSE,
  SAM_LICENSE_SHA256,
  createCanonicalArchives,
} from './create-release-archives.mjs';
import { releasePackages } from './release-packages.mjs';

const root = resolve(import.meta.dirname, '..');
const playgroundSource = resolve(root, 'examples', 'api-playground');
export const publicNpmRegistry = 'https://registry.npmjs.org/';
export const canonicalRootCopyPaths = [
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.json',
];
export const canonicalPackageCopyPaths = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'LICENSE',
  'src',
];
export const playgroundCopyFiles = [
  'DESIGN.md',
  'README.md',
  'index.html',
  'openai-request.mjs',
  'package-lock.json',
  'package.json',
  'playwright.config.ts',
  'server-core.mjs',
  'server.mjs',
  'static-files.mjs',
  'tsconfig.json',
  'vite.config.ts',
];
export const playgroundCopyDirectories = ['public', 'src', 'test'];
const focusedBrowserFlows = [
  'streams cumulative evidence, renders overlay pixels, and fills the inspector',
  'plays packet-exact frames with one Canvas and follows the streamed frame',
];

function run(command, args, { cwd, env, capture = false } = {}) {
  if (env === undefined) {
    throw new Error(`An explicit environment is required for ${command}.`);
  }
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20_000_000,
    stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with status ${result.status ?? 'unknown'}.` +
        (capture ? `\n${result.stdout ?? ''}${result.stderr ?? ''}` : ''),
    );
  }
  return capture ? result.stdout.trim() : '';
}

function pathWithin(parent, child) {
  const nested = relative(parent, child);
  return (
    nested === '' ||
    (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

function copyPathSegments(relativePath) {
  if (isAbsolute(relativePath)) return null;
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }
  return segments;
}

function isSensitiveCopyName(name) {
  const lowerName = name.toLowerCase();
  return (
    /^\.env(?:$|[._-])/.test(lowerName) ||
    /^\.envrc(?:$|[._-])/.test(lowerName) ||
    /^\.npmrc(?:$|[._-])/.test(lowerName) ||
    /(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:$|[._-])/i.test(name)
  );
}

export function isSensitiveCopyPath(relativePath) {
  const segments = copyPathSegments(relativePath);
  return segments === null || segments.some(isSensitiveCopyName);
}

export function isPlaygroundCopyPath(relativePath) {
  const segments = copyPathSegments(relativePath);
  if (segments === null || segments.some(isSensitiveCopyName)) return false;
  if (segments.length === 1) {
    return (
      playgroundCopyFiles.includes(segments[0]) ||
      playgroundCopyDirectories.includes(segments[0])
    );
  }
  return playgroundCopyDirectories.includes(segments[0]);
}

export function rewritePlaygroundManifest(manifest, archives, playgroundRoot) {
  const archiveByName = new Map(archives.map((archive) => [archive.name, archive]));
  const dependencies = { ...manifest.dependencies };
  for (const entry of releasePackages) {
    const archive = archiveByName.get(entry.name);
    if (archive === undefined) {
      throw new Error(`Canonical archive is missing for ${entry.name}.`);
    }
    if (!Object.hasOwn(dependencies, entry.name)) {
      throw new Error(`Playground dependency is missing ${entry.name}.`);
    }
    const archivePath = relative(playgroundRoot, archive.archive).split(sep).join('/');
    dependencies[entry.name] = `file:${archivePath}`;
  }
  return { ...manifest, dependencies };
}

async function assertRealDirectory(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return realpath(path);
}

async function prepareCopyDestination(sourceRoot, destinationRoot, label) {
  const realSourceRoot = await assertRealDirectory(sourceRoot, `${label} source`);
  const resolvedDestinationRoot = resolve(destinationRoot);
  if (
    pathWithin(realSourceRoot, resolvedDestinationRoot) ||
    pathWithin(resolvedDestinationRoot, realSourceRoot)
  ) {
    throw new Error(`${label} source and destination trees must be disjoint.`);
  }
  try {
    await lstat(resolvedDestinationRoot);
    throw new Error(`${label} destination must not already exist.`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(resolvedDestinationRoot, { recursive: true });
  await assertRealDirectory(resolvedDestinationRoot, `${label} destination`);
  return { sourceRoot: realSourceRoot, destinationRoot: resolvedDestinationRoot };
}

async function copyVerifiedPath(source, destination, relativePath) {
  if (isSensitiveCopyPath(relativePath)) {
    throw new Error(`Sensitive file is forbidden in an isolated copy: ${relativePath}`);
  }
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    throw new Error(
      `Symbolic links are forbidden in an isolated copy: ${relativePath}`,
    );
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await opendir(source);
    for await (const entry of entries) {
      const childRelativePath = `${relativePath}/${entry.name}`;
      await copyVerifiedPath(
        resolve(source, entry.name),
        resolve(destination, entry.name),
        childRelativePath,
      );
    }
    return;
  }
  if (!info.isFile()) {
    throw new Error(`Only regular files may enter an isolated copy: ${relativePath}`);
  }
  await copyFile(source, destination);
}

export async function copyCanonicalBuildInputs(
  sourceWorkspaceRoot,
  buildWorkspaceRoot,
) {
  const roots = await prepareCopyDestination(
    sourceWorkspaceRoot,
    buildWorkspaceRoot,
    'Canonical build',
  );
  for (const relativePath of canonicalRootCopyPaths) {
    await copyVerifiedPath(
      resolve(roots.sourceRoot, relativePath),
      resolve(roots.destinationRoot, relativePath),
      relativePath,
    );
  }
  for (const entry of releasePackages) {
    const packageDestination = resolve(
      roots.destinationRoot,
      'packages',
      entry.directory,
    );
    await mkdir(packageDestination, { recursive: true });
    for (const relativePath of canonicalPackageCopyPaths) {
      const packageRelativePath = `packages/${entry.directory}/${relativePath}`;
      await copyVerifiedPath(
        resolve(roots.sourceRoot, packageRelativePath),
        resolve(roots.destinationRoot, packageRelativePath),
        packageRelativePath,
      );
    }
  }
}

export async function copyPlaygroundAllowlist(sourceRoot, destinationRoot) {
  const roots = await prepareCopyDestination(sourceRoot, destinationRoot, 'Playground');
  for (const relativePath of [...playgroundCopyFiles, ...playgroundCopyDirectories]) {
    await copyVerifiedPath(
      resolve(roots.sourceRoot, relativePath),
      resolve(roots.destinationRoot, relativePath),
      relativePath,
    );
  }
}

async function collectRegularTreeFiles(directory, label) {
  await assertRealDirectory(directory, label);
  const files = [];
  const pending = [[directory, '']];
  while (pending.length > 0) {
    const [current, currentRelative] = pending.pop();
    const entries = await opendir(current);
    for await (const entry of entries) {
      const relativePath = currentRelative
        ? `${currentRelative}/${entry.name}`
        : entry.name;
      if (isSensitiveCopyPath(relativePath)) {
        throw new Error(`${label} contains a sensitive file: ${relativePath}`);
      }
      const path = resolve(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) pending.push([path, relativePath]);
      else if (info.isFile()) files.push(relativePath);
      else throw new Error(`${label} contains a non-regular file: ${relativePath}`);
    }
  }
  return files.sort();
}

export async function auditCanonicalBuildOutputs(workspaceRoot) {
  for (const entry of releasePackages) {
    const packageRoot = resolve(workspaceRoot, 'packages', entry.directory);
    const sourceFiles = await collectRegularTreeFiles(
      resolve(packageRoot, 'src'),
      `${entry.name} source`,
    );
    const expectedFiles = sourceFiles
      .flatMap((sourceFile) => {
        if (sourceFile.endsWith('.d.ts')) return [sourceFile];
        if (!/\.tsx?$/.test(sourceFile)) {
          throw new Error(
            `${entry.name} has an unsupported source file: ${sourceFile}`,
          );
        }
        const outputBase = sourceFile.replace(/\.tsx?$/, '');
        return [`${outputBase}.d.ts`, `${outputBase}.js`];
      })
      .sort();
    const actualFiles = await collectRegularTreeFiles(
      resolve(packageRoot, 'dist'),
      `${entry.name} build output`,
    );
    const missing = expectedFiles.filter((file) => !actualFiles.includes(file));
    const unexpected = actualFiles.filter((file) => !expectedFiles.includes(file));
    if (missing.length > 0 || unexpected.length > 0) {
      throw new Error(
        `${entry.name} build output mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}.`,
      );
    }
  }
}

async function assertSafeCopiedTree(directory) {
  await collectRegularTreeFiles(directory, 'Copied playground');
}

export function createSubprocessEnvironment({
  sourceEnvironment = process.env,
  home,
  npmCache,
  userConfig,
  globalConfig,
  registry = publicNpmRegistry,
  playwrightBrowsersPath = sourceEnvironment.PLAYWRIGHT_BROWSERS_PATH,
}) {
  for (const [label, value] of [
    ['home', home],
    ['npm cache', npmCache],
    ['npm userconfig', userConfig],
    ['npm globalconfig', globalConfig],
  ]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`A controlled ${label} path is required.`);
    }
  }
  const environment = {};
  for (const name of [
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'CI',
    'SystemRoot',
    'COMSPEC',
    'PATHEXT',
    'WINDIR',
  ]) {
    if (sourceEnvironment[name] !== undefined) {
      environment[name] = sourceEnvironment[name];
    }
  }
  if (playwrightBrowsersPath !== undefined) {
    environment.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_REGISTRY: registry,
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
}

async function createIsolatedSubprocessEnvironment(temporaryRoot) {
  const home = resolve(temporaryRoot, 'home');
  const npmCache = resolve(temporaryRoot, 'npm-cache');
  const userConfig = resolve(home, '.npmrc');
  const globalConfig = resolve(home, 'global.npmrc');
  await mkdir(home, { recursive: true });
  await mkdir(npmCache, { recursive: true });
  await writeFile(userConfig, '', { mode: 0o600 });
  await writeFile(globalConfig, '', { mode: 0o600 });
  return createSubprocessEnvironment({
    home,
    npmCache,
    userConfig,
    globalConfig,
    playwrightBrowsersPath:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      resolve(homedir(), '.cache', 'ms-playwright'),
  });
}

async function availablePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a packed-playground port.');
  }
  await new Promise((resolveClose, rejectClose) =>
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  return address.port;
}

async function sha512Integrity(path) {
  return `sha512-${createHash('sha512')
    .update(await readFile(path))
    .digest('base64')}`;
}

async function assertPackedInstallation(playgroundRoot, archives, sourceRoot) {
  const lockText = await readFile(resolve(playgroundRoot, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  if (lockText.includes(sourceRoot) || lockText.includes('../../packages/')) {
    throw new Error(
      'Packed playground lockfile still points into the source checkout.',
    );
  }

  const nodeModulesRoot = await realpath(resolve(playgroundRoot, 'node_modules'));
  const versions = new Map(archives.map((archive) => [archive.name, archive.version]));
  for (const archive of archives) {
    const expectedIntegrity = await sha512Integrity(archive.archive);
    if (archive.integrity !== expectedIntegrity) {
      throw new Error(`${archive.name} tarball integrity changed after packing.`);
    }

    const lockKey = `node_modules/${archive.name}`;
    const locked = lock.packages?.[lockKey];
    if (
      locked?.version !== archive.version ||
      locked?.integrity !== archive.integrity ||
      locked.link === true
    ) {
      throw new Error(`${archive.name} lock metadata does not match its tarball.`);
    }
    if (typeof locked.resolved !== 'string' || !locked.resolved.startsWith('file:')) {
      throw new Error(`${archive.name} was not locked from its canonical tarball.`);
    }
    const lockedArchive = resolve(
      playgroundRoot,
      locked.resolved.slice('file:'.length),
    );
    if (lockedArchive !== archive.archive) {
      throw new Error(`${archive.name} resolved from an unexpected archive path.`);
    }

    const installedRoot = resolve(playgroundRoot, lockKey);
    if ((await lstat(installedRoot)).isSymbolicLink()) {
      throw new Error(`${archive.name} was installed as a symbolic link.`);
    }
    const installedRealRoot = await realpath(installedRoot);
    if (!pathWithin(nodeModulesRoot, installedRealRoot)) {
      throw new Error(`${archive.name} resolves outside the packed node_modules tree.`);
    }
    const installedManifest = JSON.parse(
      await readFile(resolve(installedRoot, 'package.json'), 'utf8'),
    );
    if (
      installedManifest.name !== archive.name ||
      installedManifest.version !== archive.version ||
      installedManifest.license !== PACKAGE_LICENSE
    ) {
      throw new Error(
        `${archive.name} installed identity or license does not match its tarball.`,
      );
    }
    const installedLicenseSha256 = createHash('sha256')
      .update(await readFile(resolve(installedRoot, 'LICENSE')))
      .digest('hex');
    if (installedLicenseSha256 !== SAM_LICENSE_SHA256) {
      throw new Error(
        `${archive.name} installed LICENSE is not the approved SAM License.`,
      );
    }
    for (const [dependencyName, dependencyVersion] of Object.entries(
      installedManifest.dependencies ?? {},
    )) {
      const expectedVersion = versions.get(dependencyName);
      if (expectedVersion !== undefined && dependencyVersion !== expectedVersion) {
        throw new Error(
          `${archive.name} must depend on canonical ${dependencyName}@${expectedVersion}.`,
        );
      }
      if (
        expectedVersion !== undefined &&
        /^(?:file:|link:|npm:)/.test(dependencyVersion)
      ) {
        throw new Error(
          `${archive.name} contains a local or aliased internal dependency.`,
        );
      }
    }
  }
}

async function verifyRootImports(playgroundRoot, env) {
  const entry = resolve(playgroundRoot, 'packed-imports.mjs');
  await writeFile(
    entry,
    [
      "import { formats, parseResponsesStream } from '@meta-sam/parser';",
      "import { SegmentationRenderer } from '@meta-sam/graphics';",
      "import { MediaPlayer, createMediaPlayer } from '@meta-sam/video';",
      "import { Video, useMediaPlayer } from '@meta-sam/react';",
      "if (!formats.segmentation || typeof parseResponsesStream !== 'function') throw new Error('parser root exports are missing');",
      "if (typeof SegmentationRenderer !== 'function') throw new Error('graphics root exports are missing');",
      "if (typeof MediaPlayer !== 'function' || typeof createMediaPlayer !== 'function') throw new Error('video root exports are missing');",
      "if (typeof Video !== 'object' && typeof Video !== 'function') throw new Error('react Video root export is missing');",
      "if (typeof useMediaPlayer !== 'function') throw new Error('react hook root export is missing');",
    ].join('\n'),
  );
  run(process.execPath, [entry], { cwd: playgroundRoot, env });
}

async function verifyDeclarations(playgroundRoot, env) {
  await writeFile(
    resolve(playgroundRoot, 'packed-declarations.ts'),
    [
      "import { formats, type VideoSegmentationResult } from '@meta-sam/parser';",
      "import { SegmentationRenderer, type VideoFrameCompositionOptions } from '@meta-sam/graphics';",
      "import { MediaPlayer, createMediaPlayer, type MediaPlayerOptions } from '@meta-sam/video';",
      "import { Video, useMediaPlayer, type VideoProps } from '@meta-sam/react';",
      'declare const renderer: SegmentationRenderer;',
      'declare const mediaPlayer: MediaPlayer;',
      'declare const canvas: HTMLCanvasElement;',
      'declare const options: MediaPlayerOptions;',
      'declare const result: VideoSegmentationResult;',
      'declare const composition: VideoFrameCompositionOptions;',
      'declare const props: VideoProps;',
      'void formats.segmentation.video();',
      'void renderer;',
      'void mediaPlayer;',
      'void createMediaPlayer(canvas, options);',
      'void result;',
      'void composition;',
      'void props;',
      'void Video;',
      'void useMediaPlayer;',
    ].join('\n'),
  );
  await writeFile(
    resolve(playgroundRoot, 'packed-declarations.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ['packed-declarations.ts'],
      },
      null,
      2,
    )}\n`,
  );
  run(
    process.execPath,
    [
      resolve(playgroundRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      'packed-declarations.json',
    ],
    { cwd: playgroundRoot, env },
  );
}

async function runFocusedProductionFlows(playgroundRoot, env) {
  const port = await availablePort();
  const configPath = resolve(playgroundRoot, 'packed-playwright.config.mjs');
  await writeFile(
    configPath,
    `import { defineConfig, devices } from '@playwright/test';\n\nexport default defineConfig(${JSON.stringify(
      {
        testDir: './test',
        testMatch: '**/playground.spec.ts',
        fullyParallel: false,
        workers: 1,
        retries: 0,
        reporter: 'line',
        use: {
          baseURL: `http://127.0.0.1:${port}`,
          trace: 'retain-on-failure',
          screenshot: 'only-on-failure',
        },
        webServer: {
          command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
          url: `http://127.0.0.1:${port}/api/config`,
          reuseExistingServer: false,
          timeout: 120000,
        },
      },
      null,
      2,
    )});\n`,
  );
  const config = await readFile(configPath, 'utf8');
  await writeFile(
    configPath,
    config.replace('"use": {', '"use": {\n    ...devices[\'Desktop Chrome\'],'),
  );

  const playwrightManifest = JSON.parse(
    await readFile(
      resolve(playgroundRoot, 'node_modules', '@playwright', 'test', 'package.json'),
      'utf8',
    ),
  );
  const cli = resolve(
    playgroundRoot,
    'node_modules',
    '@playwright',
    'test',
    typeof playwrightManifest.bin === 'string'
      ? playwrightManifest.bin
      : playwrightManifest.bin.playwright,
  );
  run(
    process.execPath,
    [cli, 'test', '--config', configPath, '--grep', focusedBrowserFlows.join('|')],
    { cwd: playgroundRoot, env },
  );
}

export async function testPackedPlayground() {
  const rootManifest = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  );
  const expectedNpm = rootManifest.packageManager?.match(/^npm@(.+)$/)?.[1];
  if (expectedNpm === undefined)
    throw new Error('The workspace must pin an exact npm.');

  const committedLockPath = resolve(playgroundSource, 'package-lock.json');
  const committedLock = await readFile(committedLockPath);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-playground-packed-'));
  const removeTemporaryRoot = () => rm(temporaryRoot, { recursive: true, force: true });
  try {
    const env = await createIsolatedSubprocessEnvironment(temporaryRoot);
    const actualNpm = run('npm', ['--version'], {
      cwd: root,
      env,
      capture: true,
    });
    if (actualNpm !== expectedNpm) {
      throw new Error(
        `Packed playground requires npm ${expectedNpm}; found ${actualNpm}.`,
      );
    }

    const buildWorkspaceRoot = resolve(temporaryRoot, 'canonical-workspace');
    await copyCanonicalBuildInputs(root, buildWorkspaceRoot);
    run(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry',
        publicNpmRegistry,
      ],
      { cwd: buildWorkspaceRoot, env },
    );
    run('npm', ['run', 'build', '--', '--force'], {
      cwd: buildWorkspaceRoot,
      env,
    });
    await auditCanonicalBuildOutputs(buildWorkspaceRoot);

    const archiveRoot = resolve(temporaryRoot, 'packs');
    const playgroundRoot = resolve(temporaryRoot, 'examples', 'api-playground');
    await mkdir(archiveRoot, { recursive: true });
    const archives = await createCanonicalArchives(archiveRoot, {
      workspaceRoot: buildWorkspaceRoot,
      sourceRoot: resolve(buildWorkspaceRoot, 'packages'),
      env,
      registry: publicNpmRegistry,
    });

    await copyPlaygroundAllowlist(playgroundSource, playgroundRoot);
    const fixtureDestination = resolve(temporaryRoot, 'test', 'browser', 'fixtures');
    await mkdir(fixtureDestination, { recursive: true });
    for (const fixture of ['webm-vp9-opus.webm', 'webm-vp9-opus-cfr30-8s.webm']) {
      await copyVerifiedPath(
        resolve(root, 'test', 'browser', 'fixtures', fixture),
        resolve(fixtureDestination, fixture),
        `test/browser/fixtures/${fixture}`,
      );
    }
    await assertSafeCopiedTree(playgroundRoot);
    await assertSafeCopiedTree(fixtureDestination);

    const manifestPath = resolve(playgroundRoot, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.license !== PACKAGE_LICENSE) {
      throw new Error('The playground manifest has a stale license declaration.');
    }
    const packedManifest = rewritePlaygroundManifest(
      manifest,
      archives,
      playgroundRoot,
    );
    await writeFile(manifestPath, `${JSON.stringify(packedManifest, null, 2)}\n`);

    const installArguments = [
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry',
      publicNpmRegistry,
    ];
    run('npm', ['install', '--package-lock-only', ...installArguments], {
      cwd: playgroundRoot,
      env,
    });
    run('npm', ['ci', ...installArguments], {
      cwd: playgroundRoot,
      env,
    });
    await assertSafeCopiedTree(archiveRoot);
    await assertPackedInstallation(playgroundRoot, archives, root);
    await verifyRootImports(playgroundRoot, env);
    await verifyDeclarations(playgroundRoot, env);

    run('npm', ['run', 'build'], { cwd: playgroundRoot, env });
    await runFocusedProductionFlows(playgroundRoot, env);

    if (!(await readFile(committedLockPath)).equals(committedLock)) {
      throw new Error(
        'Packed playground gate modified the committed playground lockfile.',
      );
    }
    process.stdout.write(
      `Packed playground passed with ${archives.length} canonical tarballs, exact SAM License bytes, and ${focusedBrowserFlows.length} production browser flows.\n`,
    );
  } finally {
    await removeTemporaryRoot();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await testPackedPlayground();
}
