/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  releasePackageByName,
  releasePackages,
  releasePackagesForPlan,
} from './release-packages.mjs';

const root = resolve(import.meta.dirname, '..');
const packsRoot = resolve(root, '.packs');
export const SAM_LICENSE_SHA256 =
  '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be';
export const PACKAGE_LICENSE = 'SEE LICENSE IN LICENSE';
export const REPOSITORY_URL = 'git+https://github.com/meta-models/meta-sam.git';
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const forbiddenContent = [
  { label: 'absolute home path', pattern: /(?:\/home\/|\/Users\/|[A-Za-z]:\\)/ },
  { label: 'temporary path', pattern: /\/tmp\// },
  {
    label: 'internal hostname',
    pattern: /(?:internalfb\.com|internalmeta\.com|facebook\.com)/i,
  },
  { label: 'source map metadata', pattern: /sourceMappingURL=/ },
  {
    label: 'pre-release status wording',
    pattern:
      /(?:package|packages) (?:is|are) (?:currently )?private|not been approved for publication/i,
  },
  { label: 'private key', pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    label: 'credential assignment',
    pattern: /(?:api[_-]?key|access[_-]?token|npm[_-]?token|_authToken)\s*[:=]/i,
  },
  {
    label: 'authorization bearer',
    pattern: /authorization\s*[:=]\s*bearer/i,
  },
];

function versionWithSuffix(version, suffix) {
  if (!suffix) return version;
  if (!/^-[0-9A-Za-z][0-9A-Za-z.-]*$/.test(suffix)) {
    throw new Error(`Invalid version suffix: ${suffix}`);
  }
  if (version.includes('-')) {
    throw new Error(`Cannot append a prerelease suffix to ${version}.`);
  }
  return `${version}${suffix}`;
}

function pathWithin(parent, child) {
  const nested = relative(parent, child);
  return (
    nested === '' ||
    (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

async function resolveCanonicalSourceRoots(workspaceRoot, sourceRoot) {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const resolvedSourceRoot = resolve(
    sourceRoot ?? resolve(resolvedWorkspaceRoot, 'packages'),
  );
  for (const [label, path] of [
    ['Canonical workspace root', resolvedWorkspaceRoot],
    ['Canonical source root', resolvedSourceRoot],
  ]) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`${label} must be a real directory.`);
    }
  }
  const realWorkspaceRoot = await realpath(resolvedWorkspaceRoot);
  const realSourceRoot = await realpath(resolvedSourceRoot);
  if (
    !pathWithin(realWorkspaceRoot, realSourceRoot) ||
    realWorkspaceRoot === realSourceRoot
  ) {
    throw new Error('Canonical source root must be a child of the workspace root.');
  }
  return { workspaceRoot: realWorkspaceRoot, sourceRoot: realSourceRoot };
}

export async function resolveCanonicalPackageRoot(sourceRoot, directory) {
  const packageRoot = resolve(sourceRoot, directory);
  if (!pathWithin(sourceRoot, packageRoot) || packageRoot === sourceRoot) {
    throw new Error(`Canonical package path escapes the source root: ${directory}`);
  }
  const info = await lstat(packageRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Canonical package source must be a real directory: ${directory}`);
  }
  const realPackageRoot = await realpath(packageRoot);
  if (!pathWithin(sourceRoot, realPackageRoot) || realPackageRoot === sourceRoot) {
    throw new Error(`Canonical package source escapes the source root: ${directory}`);
  }
  return realPackageRoot;
}

export function validateOutputPath(output) {
  const resolvedOutput = resolve(output);
  const pathWithinPacks = relative(packsRoot, resolvedOutput);
  if (
    pathWithinPacks === '' ||
    pathWithinPacks === '..' ||
    pathWithinPacks.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(pathWithinPacks)
  ) {
    throw new Error('Release output must be a child directory of .packs.');
  }
  return resolvedOutput;
}

export async function assertNoSymlinkAncestors(output, base = packsRoot) {
  try {
    const packsInfo = await lstat(base);
    if (packsInfo.isSymbolicLink() || !packsInfo.isDirectory()) {
      throw new Error('.packs must be a real directory, not a link or file.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(base, { recursive: true });
  }
  const segments = relative(base, output).split(/[\\/]/);
  let current = base;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Release output traverses a symbolic link: ${current}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Release output ancestor is not a directory: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

export function assertReleaseOrder(entries, manifestsByName) {
  const selectedNames = new Set(entries.map((entry) => entry.name));
  const published = new Set();
  for (const entry of entries) {
    const manifest = manifestsByName.get(entry.name);
    if (!manifest) throw new Error(`Missing manifest for ${entry.name}.`);
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (
          selectedNames.has(dependency) &&
          releasePackageByName.has(dependency) &&
          !published.has(dependency)
        ) {
          throw new Error(
            `${entry.name} must be published after its ${field} dependency ${dependency}.`,
          );
        }
      }
    }
    published.add(entry.name);
  }
}

export function assertPeerDependenciesMeta(manifest) {
  if (manifest.peerDependenciesMeta === undefined) return;
  const metadata = manifest.peerDependenciesMeta;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${manifest.name} contains invalid peerDependenciesMeta.`);
  }
  const peerDependencies = manifest.peerDependencies ?? {};
  if (
    peerDependencies === null ||
    typeof peerDependencies !== 'object' ||
    Array.isArray(peerDependencies)
  ) {
    throw new Error(`${manifest.name} contains invalid peerDependencies.`);
  }
  for (const [dependencyName, value] of Object.entries(metadata)) {
    if (!Object.hasOwn(peerDependencies, dependencyName)) {
      throw new Error(
        `${manifest.name} peerDependenciesMeta entry ${dependencyName} has no matching peerDependency.`,
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `${manifest.name} peerDependenciesMeta entry ${dependencyName} must be an object.`,
      );
    }
    if (value.optional !== undefined && typeof value.optional !== 'boolean') {
      throw new Error(
        `${manifest.name} peerDependenciesMeta entry ${dependencyName} has a non-boolean optional flag.`,
      );
    }
  }
}

/**
 * A manifest is publishable when it is not marked private, declares the SAM
 * License, points `repository` at this repository and its package directory,
 * and requests public access. Provenance attestation verifies the repository
 * field against the workflow that publishes, so the URL must be exact.
 */
export function assertPublishableManifest(manifest, directory) {
  const label = manifest.name ?? directory;
  if (manifest.private === true) {
    throw new Error(`${label} is marked private and cannot be published.`);
  }
  assertManifestLicense(manifest, `${label} manifest`);
  if (
    manifest.repository?.type !== 'git' ||
    manifest.repository?.url !== REPOSITORY_URL ||
    manifest.repository?.directory !== `typescript/packages/${directory}`
  ) {
    throw new Error(
      `${label} must declare repository {type: "git", url: ${JSON.stringify(REPOSITORY_URL)}, directory: "typescript/packages/${directory}"}.`,
    );
  }
  if (manifest.publishConfig?.access !== 'public') {
    throw new Error(`${label} must declare publishConfig.access "public".`);
  }
  assertPeerDependenciesMeta(manifest);
  for (const field of dependencyFields) {
    for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
      if (releasePackageByName.has(dependency) && !isExactSemverSpec(spec)) {
        throw new Error(
          `${label} ${field} entry ${dependency} must pin an exact version; got ${JSON.stringify(spec)}.`,
        );
      }
    }
  }
}

function isExactSemverSpec(spec) {
  return typeof spec === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec);
}

function run(command, args, options = {}) {
  const { cwd = root, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20_000_000,
    ...spawnOptions,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

export function assertSamLicense(content, label) {
  const digest = createHash('sha256').update(content).digest('hex');
  if (digest !== SAM_LICENSE_SHA256) {
    throw new Error(
      `${label} has sha256 ${digest}, expected the approved SAM License ${SAM_LICENSE_SHA256}.`,
    );
  }
}

export function assertManifestLicense(manifest, label) {
  if (manifest.license !== PACKAGE_LICENSE) {
    throw new Error(`${label} must declare ${JSON.stringify(PACKAGE_LICENSE)}.`);
  }
}

export async function assertPackageInputs(sourceRoot) {
  for (const file of ['package.json', 'README.md', 'LICENSE']) {
    const info = await lstat(resolve(sourceRoot, file));
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Canonical package ${file} must be a regular file.`);
    }
  }
  const sourceManifest = JSON.parse(
    await readFile(resolve(sourceRoot, 'package.json'), 'utf8'),
  );
  assertManifestLicense(
    sourceManifest,
    `${sourceManifest.name ?? sourceRoot} manifest`,
  );
  assertSamLicense(
    await readFile(resolve(sourceRoot, 'LICENSE')),
    `${sourceManifest.name ?? sourceRoot} LICENSE`,
  );
  const distRoot = resolve(sourceRoot, 'dist');
  const distInfo = await lstat(distRoot);
  if (distInfo.isSymbolicLink() || !distInfo.isDirectory()) {
    throw new Error('Canonical package dist must be a real directory.');
  }
  const pending = [distRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await opendir(current);
    for await (const entry of entries) {
      const path = resolve(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw new Error(`Canonical package dist contains a symbolic link: ${path}`);
      }
      if (info.isDirectory()) pending.push(path);
      else if (!info.isFile()) {
        throw new Error(`Canonical package dist contains a non-regular file: ${path}`);
      }
    }
  }
}

async function stagePackage(stageRoot, sourceRoot, manifest) {
  await assertPackageInputs(sourceRoot);
  await mkdir(resolve(stageRoot, 'dist'), { recursive: true });
  await cp(resolve(sourceRoot, 'dist'), resolve(stageRoot, 'dist'), {
    recursive: true,
  });
  await cp(resolve(sourceRoot, 'README.md'), resolve(stageRoot, 'README.md'));
  await cp(resolve(sourceRoot, 'LICENSE'), resolve(stageRoot, 'LICENSE'));
  await writeFile(
    resolve(stageRoot, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function pack(
  stageRoot,
  destination,
  { cwd = root, env = process.env, registry = null } = {},
) {
  const result = run(
    'npm',
    [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      destination,
      ...(registry === null ? [] : ['--registry', registry]),
      stageRoot,
    ],
    { cwd, env },
  );
  const report = JSON.parse(result.stdout)[0];
  if (!report?.filename || !Array.isArray(report.files)) {
    throw new Error(`npm pack returned an invalid report for ${stageRoot}.`);
  }
  return { report, archive: resolve(destination, basename(report.filename)) };
}

function archiveFile(archive, path, env = process.env) {
  const result = spawnSync('tar', ['-xOf', archive, `package/${path}`], {
    encoding: null,
    env,
    maxBuffer: 20_000_000,
  });
  if (result.status !== 0) {
    throw new Error(`Could not read package/${path} from ${archive}.`);
  }
  return result.stdout;
}

export function assertSafePackageContent(path, content) {
  for (const forbidden of forbiddenContent) {
    if (forbidden.pattern.test(content)) {
      throw new Error(`${path} contains ${forbidden.label}.`);
    }
  }
}

function auditArchive(archive, report, env = process.env) {
  const files = report.files.map((file) => file.path).sort();
  for (const required of ['package.json', 'README.md', 'LICENSE']) {
    if (!files.includes(required)) {
      throw new Error(`Archive is missing required file ${required}.`);
    }
  }
  const manifest = JSON.parse(
    archiveFile(archive, 'package.json', env).toString('utf8'),
  );
  assertManifestLicense(manifest, `${manifest.name ?? archive} archive manifest`);
  assertSamLicense(
    archiveFile(archive, 'LICENSE', env),
    `${manifest.name ?? archive} archive LICENSE`,
  );
  const unexpected = files.filter(
    (file) =>
      file !== 'package.json' &&
      file !== 'README.md' &&
      file !== 'LICENSE' &&
      !file.startsWith('dist/'),
  );
  if (unexpected.length > 0) {
    throw new Error(`Archive contains unexpected files: ${unexpected.join(', ')}`);
  }
  for (const path of files) {
    const content = archiveFile(archive, path, env).toString('utf8');
    assertSafePackageContent(path, content);
  }
  return files;
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export async function createCanonicalArchives(
  destination,
  { workspaceRoot = root, sourceRoot = null, env = process.env, registry = null } = {},
) {
  destination = resolve(destination);
  const canonicalRoots = await resolveCanonicalSourceRoots(workspaceRoot, sourceRoot);
  await mkdir(destination, { recursive: true });
  const destinationInfo = await lstat(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
    throw new Error('Canonical archive destination must be a real directory.');
  }

  const stagingRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-canonical-'));
  const archives = [];
  try {
    for (const entry of releasePackages) {
      const packageSourceRoot = await resolveCanonicalPackageRoot(
        canonicalRoots.sourceRoot,
        entry.directory,
      );
      const manifest = JSON.parse(
        await readFile(resolve(packageSourceRoot, 'package.json'), 'utf8'),
      );
      if (manifest.name !== entry.name) {
        throw new Error(
          `${entry.directory} is ${manifest.name}, expected ${entry.name}.`,
        );
      }
      assertPublishableManifest(manifest, entry.directory);

      const stageRoot = resolve(stagingRoot, entry.directory);
      await stagePackage(stageRoot, packageSourceRoot, manifest);
      const packed = pack(stageRoot, destination, {
        cwd: canonicalRoots.workspaceRoot,
        env,
        registry,
      });
      const files = auditArchive(packed.archive, packed.report, env);
      archives.push({
        directory: entry.directory,
        name: manifest.name,
        version: manifest.version,
        archive: packed.archive,
        integrity: packed.report.integrity,
        sha256: await sha256(packed.archive),
        files,
      });
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return archives;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith('--')) {
      throw new Error(
        'Usage: create-release-archives.mjs --output <path> [--version-suffix <suffix>] [--plan <path>]',
      );
    }
    const separator = argument.indexOf('=');
    if (separator !== -1) {
      values.set(argument.slice(2, separator), argument.slice(separator + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(
        'Usage: create-release-archives.mjs --output <path> [--version-suffix <suffix>] [--plan <path>]',
      );
    }
    values.set(argument.slice(2), value);
    index += 1;
  }
  const output = values.get('output');
  if (!output) {
    throw new Error('The --output argument is required.');
  }
  return {
    output: resolve(output),
    versionSuffix: values.get('version-suffix') ?? '',
    releasePlanPath: values.has('plan') ? resolve(values.get('plan')) : null,
  };
}

export async function createReleaseArchives({
  output,
  versionSuffix = '',
  releasePlan = null,
}) {
  output = validateOutputPath(output);
  await assertNoSymlinkAncestors(output);
  const canonicalRoots = await resolveCanonicalSourceRoots(root);
  const manifests = new Map();
  const packageRoots = new Map();
  const sourceVersions = new Map();
  const versions = new Map();
  for (const entry of releasePackages) {
    const packageRoot = await resolveCanonicalPackageRoot(
      canonicalRoots.sourceRoot,
      entry.directory,
    );
    packageRoots.set(entry.name, packageRoot);
    await assertPackageInputs(packageRoot);
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    if (manifest.name !== entry.name) {
      throw new Error(
        `${entry.directory} is ${manifest.name}, expected ${entry.name}.`,
      );
    }
    assertPublishableManifest(manifest, entry.directory);
    sourceVersions.set(entry.name, manifest.version);
    manifest.version = versionWithSuffix(manifest.version, versionSuffix);
    manifests.set(entry.name, manifest);
    versions.set(entry.name, manifest.version);
  }

  // Every internal dependency must pin the version this workspace builds, so a
  // published package never references a sibling version from another source
  // tree. A version suffix applies to those pins as well.
  for (const manifest of manifests.values()) {
    for (const field of dependencyFields) {
      for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
        if (!releasePackageByName.has(dependency)) continue;
        if (spec !== sourceVersions.get(dependency)) {
          throw new Error(
            `${manifest.name} ${field} entry ${dependency} is ${spec}, but the workspace builds ${sourceVersions.get(dependency)}.`,
          );
        }
        manifest[field][dependency] = versions.get(dependency);
      }
    }
  }

  const selectedPackages = releasePlan
    ? releasePackagesForPlan(releasePlan)
    : releasePackages;
  if (releasePlan) {
    for (const planned of releasePlan.packages) {
      const version = versions.get(planned.name);
      if (version !== planned.version) {
        throw new Error(
          `${planned.name} is ${version}, but the release plan requires ${planned.version}.`,
        );
      }
    }
  }
  assertReleaseOrder(selectedPackages, manifests);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const stagingRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-release-'));
  const packages = [];

  try {
    for (const entry of selectedPackages) {
      const sourceRoot = packageRoots.get(entry.name);
      if (sourceRoot === undefined) {
        throw new Error(`Missing canonical package root for ${entry.name}.`);
      }
      const manifest = manifests.get(entry.name);
      const stage = resolve(stagingRoot, entry.directory);
      await stagePackage(stage, sourceRoot, manifest);
      const packed = pack(stage, output);
      auditArchive(packed.archive, packed.report);

      packages.push({
        name: manifest.name,
        version: manifest.version,
        archive: relative(output, packed.archive),
        integrity: packed.report.integrity,
        sha256: await sha256(packed.archive),
      });
      process.stdout.write(`${manifest.name}@${manifest.version}\n`);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const releaseManifest = {
    sourceCommit: process.env.GITHUB_SHA ?? null,
    packages,
  };
  await writeFile(
    resolve(output, 'release-manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  );
  return releaseManifest;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.releasePlanPath) {
    options.releasePlan = JSON.parse(await readFile(options.releasePlanPath, 'utf8'));
  }
  await createReleaseArchives(options);
}
