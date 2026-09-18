/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/**
 * Publishes the archives named by a release manifest to the public npm
 * registry, in dependency order, and reads every version back.
 *
 * Authentication is npm's own: in GitHub Actions with `id-token: write` and a
 * trusted publisher configured on npmjs.com, npm exchanges the workflow's OIDC
 * token itself; otherwise it uses `NODE_AUTH_TOKEN`/`.npmrc`. This script never
 * reads or writes a credential.
 *
 * Usage: publish-npm.mjs --manifest <release-manifest.json> [--tag <dist-tag>]
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  isExactSemver,
  releasePackageByName,
  releasePackagesForPlan,
} from './release-packages.mjs';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';
const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];
const bundledDependencyFields = ['bundleDependencies', 'bundledDependencies'];
const NOT_FOUND = Symbol('not-found');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || value === undefined) {
    throw new Error('Usage: publish-npm.mjs --manifest <path> [--tag <tag>]');
  }
  args.set(name.slice(2), value);
}
const tag = args.get('tag') ?? 'latest';
if (!args.get('manifest') || !/^[a-z][a-z0-9._-]*$/.test(tag)) {
  throw new Error('Usage: publish-npm.mjs --manifest <path> [--tag <tag>]');
}
const registry = process.env.META_SAM_NPM_REGISTRY ?? PUBLIC_REGISTRY;

// Read-back attempts × delay must outlast the registry's metadata propagation.
// npm says a fresh publish "may take a few minutes to become available"; the
// 0.0.11 release of @meta-sam/parser took more than the two minutes the
// original 12 × 10 s budget allowed, which aborted the plan after that package
// had already been published. Ten minutes covers the propagation seen so far;
// the plan is idempotent, so a re-run after a timeout resumes where it stopped.
function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}.`);
  }
  return Number(raw);
}
const verificationAttempts = positiveInteger('META_SAM_PUBLISH_VERIFY_ATTEMPTS', 30);
const verificationDelayMs = positiveInteger('META_SAM_PUBLISH_VERIFY_DELAY_MS', 20_000);

const manifestPath = await realpath(resolve(args.get('manifest')));
const releaseRoot = await realpath(dirname(manifestPath));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
  throw new Error('Release manifest must contain at least one package.');
}
const selectedPackages = releasePackagesForPlan({
  schemaVersion: 1,
  packages: manifest.packages.map((entry) => ({
    name: entry?.name,
    version: entry?.version,
  })),
});

function npm(commandArguments) {
  return spawnSync('npm', commandArguments, { encoding: 'utf8', stdio: 'pipe' });
}

function npmView(spec, field) {
  const result = npm(['view', spec, field, '--json', '--registry', registry]);
  if (result.status === 0) {
    const output = result.stdout.trim();
    if (output.length === 0) {
      throw new Error(`Could not read ${field} for ${spec}: npm returned no data.`);
    }
    let value;
    try {
      value = JSON.parse(output);
    } catch {
      throw new Error(
        `Could not read ${field} for ${spec}: npm returned invalid JSON:\n${output}`,
      );
    }
    if (value === null) {
      throw new Error(`Could not read ${field} for ${spec}: npm returned JSON null.`);
    }
    return value;
  }
  const error = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (/E404|404 Not Found|is not in this registry/i.test(error)) return NOT_FOUND;
  throw new Error(`Could not read ${field} for ${spec}:\n${error}`);
}

function npmPublish(entry) {
  const result = npm([
    'publish',
    entry.archivePath,
    '--ignore-scripts',
    '--access',
    'public',
    '--registry',
    registry,
    '--tag',
    tag,
  ]);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    throw new Error(`Publishing ${entry.spec} failed.`);
  }
}

function internalDependency(packageSpec, field, dependencyName, dependencySpec) {
  if (!releasePackageByName.has(dependencyName)) {
    if (typeof dependencySpec === 'string' && /^npm:@meta-sam\//.test(dependencySpec)) {
      throw new Error(
        `${packageSpec} ${field} entry ${dependencyName} aliases an internal package; use the package name directly.`,
      );
    }
    return null;
  }
  if (!isExactSemver(dependencySpec)) {
    throw new Error(
      `${packageSpec} ${field} entry ${dependencyName} must pin an exact version; got ${JSON.stringify(dependencySpec)}.`,
    );
  }
  return {
    name: dependencyName,
    version: dependencySpec,
    spec: `${dependencyName}@${dependencySpec}`,
  };
}

function registryHasExactDependency({ version, spec }) {
  const integrity = npmView(spec, 'dist.integrity');
  const registryVersion = npmView(spec, 'version');
  if (integrity === NOT_FOUND && registryVersion === NOT_FOUND) return false;
  if (
    integrity === NOT_FOUND ||
    registryVersion === NOT_FOUND ||
    typeof integrity !== 'string' ||
    integrity.length === 0 ||
    registryVersion !== version
  ) {
    throw new Error(`Registry metadata for ${spec} is incomplete or inconsistent.`);
  }
  return true;
}

function dependencyMap(packedManifest, field, packageSpec) {
  const dependencies = packedManifest[field] ?? {};
  if (
    dependencies === null ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    throw new Error(`${packageSpec} contains invalid ${field}.`);
  }
  return dependencies;
}

function validatePeerDependenciesMeta(packageSpec, packedManifest, peerDependencies) {
  if (packedManifest.peerDependenciesMeta === undefined) return;
  const metadata = packedManifest.peerDependenciesMeta;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error(`${packageSpec} contains invalid peerDependenciesMeta.`);
  }
  for (const [dependencyName, value] of Object.entries(metadata)) {
    if (!Object.hasOwn(peerDependencies, dependencyName)) {
      throw new Error(
        `${packageSpec} peerDependenciesMeta entry ${dependencyName} has no matching peerDependency.`,
      );
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `${packageSpec} peerDependenciesMeta entry ${dependencyName} must be an object.`,
      );
    }
    if (value.optional !== undefined && typeof value.optional !== 'boolean') {
      throw new Error(
        `${packageSpec} peerDependenciesMeta entry ${dependencyName} has a non-boolean optional flag.`,
      );
    }
  }
}

function validateBundledDependencies(packageSpec, packedManifest) {
  for (const field of bundledDependencyFields) {
    if (packedManifest[field] === undefined) continue;
    if (!Array.isArray(packedManifest[field])) {
      throw new Error(`${packageSpec} contains invalid ${field}.`);
    }
    for (const dependency of packedManifest[field]) {
      if (typeof dependency !== 'string') {
        throw new Error(`${packageSpec} contains a non-string ${field} entry.`);
      }
      if (releasePackageByName.has(dependency)) {
        throw new Error(
          `${packageSpec} cannot bundle internal package ${dependency} through ${field}.`,
        );
      }
    }
  }
}

async function validateArchive(snapshotRoot, entry, expectedName) {
  const { name, version, archive, integrity, sha256 } = entry;
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof archive !== 'string' ||
    typeof integrity !== 'string' ||
    typeof sha256 !== 'string'
  ) {
    throw new Error('Release manifest contains an invalid package entry.');
  }
  if (name !== expectedName) {
    throw new Error(`Release package must be ${expectedName}, got ${name}.`);
  }
  if (
    isAbsolute(archive) ||
    archive.includes('\\') ||
    archive.includes('/') ||
    archive === '..' ||
    !archive.endsWith('.tgz')
  ) {
    throw new Error(`${name} has an invalid archive path: ${archive}.`);
  }

  const archiveEntry = resolve(releaseRoot, archive);
  if ((await lstat(archiveEntry)).isSymbolicLink()) {
    throw new Error(`${name} archive must not be a symbolic link.`);
  }
  const archivePath = await realpath(archiveEntry);
  if (relative(releaseRoot, archivePath) !== archive) {
    throw new Error(`${name} archive resolves outside the release directory.`);
  }
  if (!(await stat(archivePath)).isFile()) {
    throw new Error(`${name} archive is not a regular file.`);
  }

  const bytes = await readFile(archivePath);
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  const actualIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actualSha256 !== sha256) {
    throw new Error(`${name} archive SHA-256 does not match the release manifest.`);
  }
  if (actualIntegrity !== integrity) {
    throw new Error(`${name} archive integrity does not match the release manifest.`);
  }

  // Publish from a private read-only copy so the audited bytes are the
  // published bytes even if the source archive changes afterwards.
  const snapshotPath = resolve(snapshotRoot, basename(archivePath));
  await writeFile(snapshotPath, bytes, { flag: 'wx', mode: 0o400 });
  const packedManifestResult = spawnSync(
    'tar',
    ['-xOf', snapshotPath, 'package/package.json'],
    { encoding: 'utf8', maxBuffer: 1_000_000 },
  );
  if (packedManifestResult.status !== 0) {
    throw new Error(`${name} archive has no readable package.json.`);
  }
  let packedManifest;
  try {
    packedManifest = JSON.parse(packedManifestResult.stdout);
  } catch {
    throw new Error(`${name} archive contains an invalid package.json.`);
  }
  if (packedManifest.name !== name || packedManifest.version !== version) {
    throw new Error(
      `${name}@${version} does not match embedded package ${packedManifest.name}@${packedManifest.version}.`,
    );
  }
  if (packedManifest.private === true) {
    throw new Error(`${name}@${version} is marked private.`);
  }

  const spec = `${name}@${version}`;
  const dependencySections = Object.fromEntries(
    dependencyFields.map((field) => [
      field,
      dependencyMap(packedManifest, field, spec),
    ]),
  );
  validatePeerDependenciesMeta(
    spec,
    packedManifest,
    dependencySections.peerDependencies,
  );
  validateBundledDependencies(spec, packedManifest);

  return {
    name,
    version,
    archivePath: snapshotPath,
    dependencySections,
    integrity,
    spec,
  };
}

function sleep(milliseconds) {
  if (milliseconds === 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function verifyPublished(entry) {
  let readBackIntegrity = NOT_FOUND;
  let taggedVersion = NOT_FOUND;
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    readBackIntegrity = npmView(entry.spec, 'dist.integrity');
    taggedVersion = npmView(`${entry.name}@${tag}`, 'version');
    if (readBackIntegrity === entry.integrity && taggedVersion === entry.version) {
      return;
    }
    if (readBackIntegrity !== NOT_FOUND && readBackIntegrity !== entry.integrity) {
      throw new Error(
        `Read-back verification found conflicting integrity for ${entry.spec}: ${readBackIntegrity}.`,
      );
    }
    if (attempt < verificationAttempts) sleep(verificationDelayMs);
  }
  throw new Error(
    `Read-back verification timed out for ${entry.spec}: integrity=${readBackIntegrity === NOT_FOUND ? 'missing' : readBackIntegrity}, tag=${taggedVersion === NOT_FOUND ? 'missing' : taggedVersion}.`,
  );
}

async function publishRelease() {
  const snapshotRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-publish-'));
  try {
    const plan = [];

    // Complete archive, registry, and dependency preflight before the first
    // irreversible publish.
    for (const [index, entry] of manifest.packages.entries()) {
      const validated = await validateArchive(
        snapshotRoot,
        entry,
        selectedPackages[index].name,
      );

      const existingIntegrity = npmView(validated.spec, 'dist.integrity');
      const existingVersion = npmView(validated.spec, 'version');
      const alreadyPublished =
        existingIntegrity !== NOT_FOUND || existingVersion !== NOT_FOUND;
      if (
        existingIntegrity !== NOT_FOUND &&
        existingIntegrity !== validated.integrity
      ) {
        throw new Error(
          `${validated.spec} already exists with integrity ${existingIntegrity}, expected ${validated.integrity}.`,
        );
      }
      if (existingVersion !== NOT_FOUND && existingVersion !== validated.version) {
        throw new Error(
          `${validated.spec} registry version is ${existingVersion}, expected ${validated.version}.`,
        );
      }
      if (
        alreadyPublished &&
        (existingIntegrity === NOT_FOUND || existingVersion === NOT_FOUND)
      ) {
        throw new Error(
          `Registry metadata for planned package ${validated.spec} is incomplete.`,
        );
      }
      if (alreadyPublished) {
        const taggedVersion = npmView(`${validated.name}@${tag}`, 'version');
        if (taggedVersion !== validated.version) {
          throw new Error(
            `${validated.spec} exists, but the ${tag} tag points to ${taggedVersion === NOT_FOUND ? 'nothing' : taggedVersion}.`,
          );
        }
      }
      plan.push({ ...validated, alreadyPublished });
    }

    const plannedByName = new Map(
      plan.map((entry, index) => [entry.name, { entry, index }]),
    );
    const externalDependencyExistence = new Map();
    for (const [index, entry] of plan.entries()) {
      for (const field of dependencyFields) {
        for (const [dependencyName, dependencySpec] of Object.entries(
          entry.dependencySections[field],
        )) {
          const dependency = internalDependency(
            entry.spec,
            field,
            dependencyName,
            dependencySpec,
          );
          if (!dependency) continue;

          const plannedDependency = plannedByName.get(dependency.name);
          if (plannedDependency) {
            if (dependency.version !== plannedDependency.entry.version) {
              throw new Error(
                `${entry.spec} ${field} entry ${dependencyName} must target ${plannedDependency.entry.spec}; got ${JSON.stringify(dependencySpec)}.`,
              );
            }
            if (plannedDependency.index >= index) {
              throw new Error(
                `${entry.spec} must be published after its dependency ${plannedDependency.entry.spec} from ${field}.`,
              );
            }
            continue;
          }

          let exists = externalDependencyExistence.get(dependency.spec);
          if (exists === undefined) {
            exists = registryHasExactDependency(dependency);
            externalDependencyExistence.set(dependency.spec, exists);
          }
          if (!exists) {
            throw new Error(
              `${entry.spec} requires ${dependency.spec}, but that exact internal ${field} dependency is not published and is outside this release plan.`,
            );
          }
        }
      }
    }

    for (const entry of plan) {
      if (entry.alreadyPublished) {
        process.stdout.write(`Already published and verified ${entry.spec}\n`);
        continue;
      }
      npmPublish(entry);
      verifyPublished(entry);
      process.stdout.write(`Published and verified ${entry.spec}\n`);
    }
  } finally {
    await rm(snapshotRoot, { force: true, recursive: true });
  }
}

await publishRelease();
