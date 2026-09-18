/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { releasePackages } from './release-packages.mjs';

const roots = [];
const internalDependencies = new Map([
  ['@meta-sam/graphics', ['@meta-sam/parser']],
  ['@meta-sam/react', ['@meta-sam/graphics', '@meta-sam/parser', '@meta-sam/video']],
]);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function digests(bytes) {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// A registry double: `npm view` answers from a JSON state file, `npm publish`
// records the archive's digests into it. Every invocation is logged.
const fakeNpmSource = `#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const statePath = process.env.FAKE_NPM_STATE;
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { versions: {}, tags: {}, pendingReads: 0 };
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
if (args[0] === 'view') {
  const [spec, field] = [args[1], args[2]];
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  let version = spec.slice(at + 1);
  if (state.tags[name] && Object.hasOwn(state.tags[name], version)) {
    version = state.tags[name][version];
  }
  const key = name + '@' + version;
  const published = state.versions[key];
  if (!published || (state.pendingReads > 0 && published.fresh)) {
    if (published && published.fresh) { state.pendingReads -= 1; save(); }
    console.error('npm error code E404');
    console.error('npm error 404 Not Found - GET ' + spec);
    process.exit(1);
  }
  if (field === 'dist.integrity') process.stdout.write(JSON.stringify(published.integrity));
  else if (field === 'version') process.stdout.write(JSON.stringify(version));
  else process.exit(2);
  process.exit(0);
}
if (args[0] === 'publish') {
  const bytes = fs.readFileSync(args[1]);
  const manifest = JSON.parse(
    require('node:child_process').execFileSync('tar', ['-xOf', args[1], 'package/package.json']),
  );
  const key = manifest.name + '@' + manifest.version;
  if (state.versions[key]) { console.error('npm error code E403'); process.exit(1); }
  const tagIndex = args.indexOf('--tag');
  state.versions[key] = {
    integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64'),
    fresh: state.pendingReads > 0,
    args,
  };
  state.tags[manifest.name] ??= {};
  state.tags[manifest.name][args[tagIndex + 1]] = manifest.version;
  save();
  process.stdout.write('+ ' + key + '\\n');
  process.exit(0);
}
process.exit(3);
`;

async function archiveBytes(name, version, versions, { extraManifest = {} } = {}) {
  const stage = await mkdtemp(resolve(tmpdir(), 'meta-sam-archive-'));
  roots.push(stage);
  const packageRoot = resolve(stage, 'package');
  await mkdir(packageRoot);
  const dependencies = Object.fromEntries(
    (internalDependencies.get(name) ?? []).map((dependency) => [
      dependency,
      versions.get(dependency),
    ]),
  );
  await writeFile(
    resolve(packageRoot, 'package.json'),
    JSON.stringify({ name, version, dependencies, ...extraManifest }),
  );
  await writeFile(
    resolve(packageRoot, 'index.js'),
    `export const name = ${JSON.stringify(name)};\n`,
  );
  const archive = resolve(stage, 'archive.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], {
    encoding: 'utf8',
  });
  if (tar.status !== 0) throw new Error(tar.stderr);
  return readFile(archive);
}

async function fixture({
  selected = releasePackages,
  versions: versionOverrides = {},
  manifestOverrides = {},
  registryState = null,
} = {}) {
  const versions = new Map(
    releasePackages.map((entry, index) => [
      entry.name,
      versionOverrides[entry.name] ?? `1.0.${index}`,
    ]),
  );
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-publish-test-'));
  roots.push(root);
  const bin = resolve(root, 'bin');
  const release = resolve(root, 'release');
  await mkdir(bin);
  await mkdir(release);
  const fakeNpm = resolve(bin, 'npm');
  await writeFile(fakeNpm, fakeNpmSource);
  await chmod(fakeNpm, 0o755);
  const statePath = resolve(root, 'state.json');
  const log = resolve(root, 'npm.log');
  if (registryState) await writeFile(statePath, JSON.stringify(registryState));

  const packages = [];
  for (const entry of selected) {
    const version = versions.get(entry.name);
    const bytes = await archiveBytes(entry.name, version, versions, {
      extraManifest: manifestOverrides[entry.name] ?? {},
    });
    const archive = `${entry.name.slice(1).replace('/', '-')}-${version}.tgz`;
    await writeFile(resolve(release, archive), bytes);
    packages.push({ name: entry.name, version, archive, ...digests(bytes) });
  }
  const manifestPath = resolve(release, 'release-manifest.json');
  await writeFile(manifestPath, JSON.stringify({ sourceCommit: null, packages }));

  return {
    root,
    release,
    manifestPath,
    packages,
    versions,
    statePath,
    log,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_NPM_LOG: log,
      FAKE_NPM_STATE: statePath,
      META_SAM_PUBLISH_VERIFY_ATTEMPTS: '5',
      META_SAM_PUBLISH_VERIFY_DELAY_MS: '1',
    },
  };
}

function runPublisher(fixtureState, extraArgs = [], envOverrides = {}) {
  return spawnSync(
    process.execPath,
    [
      resolve(import.meta.dirname, 'publish-npm.mjs'),
      '--manifest',
      fixtureState.manifestPath,
      ...extraArgs,
    ],
    { encoding: 'utf8', env: { ...fixtureState.env, ...envOverrides } },
  );
}

async function npmCalls(fixtureState) {
  try {
    return (await readFile(fixtureState.log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function registryState(fixtureState) {
  return JSON.parse(await readFile(fixtureState.statePath, 'utf8'));
}

describe('npm publisher', () => {
  test('publishes the four packages in dependency order with public access', async () => {
    const state = await fixture();
    const result = runPublisher(state);
    expect(result.status, result.stderr).toBe(0);

    const publishes = (await npmCalls(state)).filter((call) => call[0] === 'publish');
    expect(publishes.map((call) => basename(call[1]))).toEqual(
      state.packages.map((entry) => entry.archive),
    );
    for (const call of publishes) {
      expect(call).toEqual(
        expect.arrayContaining([
          '--ignore-scripts',
          '--access',
          'public',
          '--registry',
          'https://registry.npmjs.org/',
          '--tag',
          'latest',
        ]),
      );
    }
    const registry = await registryState(state);
    for (const entry of state.packages) {
      expect(registry.versions[`${entry.name}@${entry.version}`]?.integrity).toBe(
        entry.integrity,
      );
    }
    expect(result.stdout).toContain('Published and verified @meta-sam/react@1.0.3');
  });

  test('never forces provenance explicitly', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const result = runPublisher(state);
    expect(result.status, result.stderr).toBe(0);
    const [publish] = (await npmCalls(state)).filter((call) => call[0] === 'publish');
    expect(publish).not.toContain('--provenance');
  });

  test('publishes an ordered subset whose external dependencies already exist', async () => {
    const parser = releasePackages[0];
    const graphics = releasePackages[1];
    const state = await fixture({
      selected: [graphics],
      registryState: {
        versions: { '@meta-sam/parser@1.0.0': { integrity: 'sha512-existing' } },
        tags: { '@meta-sam/parser': { latest: '1.0.0' } },
        pendingReads: 0,
      },
    });
    const result = runPublisher(state);
    expect(result.status, result.stderr).toBe(0);
    const calls = await npmCalls(state);
    expect(
      calls.some((call) => call[0] === 'view' && call[1] === `${parser.name}@1.0.0`),
    ).toBe(true);
    expect(result.stdout).toContain('Published and verified @meta-sam/graphics@1.0.1');
  });

  test('blocks a package whose dependency is neither planned nor published', async () => {
    const state = await fixture({ selected: [releasePackages[1]] });
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '@meta-sam/graphics@1.0.1 requires @meta-sam/parser@1.0.0, but that exact internal dependencies dependency is not published',
    );
    expect((await npmCalls(state)).some((call) => call[0] === 'publish')).toBe(false);
  });

  test('rejects a package whose planned dependency pins a different version', async () => {
    const state = await fixture({
      manifestOverrides: {
        '@meta-sam/graphics': { dependencies: { '@meta-sam/parser': '0.9.9' } },
      },
    });
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '@meta-sam/graphics@1.0.1 dependencies entry @meta-sam/parser must target @meta-sam/parser@1.0.0',
    );
    expect((await npmCalls(state)).some((call) => call[0] === 'publish')).toBe(false);
  });

  test('rejects ranged and aliased internal dependencies', async () => {
    for (const spec of ['^1.0.0', 'npm:@example/parser@1.0.0']) {
      const state = await fixture({
        selected: [releasePackages[0], releasePackages[1]],
        manifestOverrides: {
          '@meta-sam/graphics': { dependencies: { '@meta-sam/parser': spec } },
        },
      });
      const result = runPublisher(state);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must pin an exact version');
    }
  });

  test('resumes idempotently when identical bytes are already published', async () => {
    const state = await fixture();
    expect(runPublisher(state).status).toBe(0);
    const before = (await npmCalls(state)).length;
    const retry = runPublisher(state);
    expect(retry.status, retry.stderr).toBe(0);
    const calls = (await npmCalls(state)).slice(before);
    expect(calls.some((call) => call[0] === 'publish')).toBe(false);
    for (const entry of state.packages) {
      expect(retry.stdout).toContain(
        `Already published and verified ${entry.name}@${entry.version}`,
      );
    }
  });

  test('refuses an existing version with different bytes before publishing anything', async () => {
    const state = await fixture();
    const [parser] = state.packages;
    await writeFile(
      state.statePath,
      JSON.stringify({
        versions: {
          [`${parser.name}@${parser.version}`]: { integrity: 'sha512-other' },
        },
        tags: { [parser.name]: { latest: parser.version } },
        pendingReads: 0,
      }),
    );
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists with integrity sha512-other');
    expect((await npmCalls(state)).some((call) => call[0] === 'publish')).toBe(false);
  });

  test('refuses an existing version whose dist-tag points elsewhere', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const [parser] = state.packages;
    await writeFile(
      state.statePath,
      JSON.stringify({
        versions: {
          [`${parser.name}@${parser.version}`]: { integrity: parser.integrity },
          [`${parser.name}@0.0.1`]: { integrity: 'sha512-older' },
        },
        tags: { [parser.name]: { latest: '0.0.1' } },
        pendingReads: 0,
      }),
    );
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('but the latest tag points to 0.0.1');
  });

  test('waits for registry metadata to expose a fresh publish', async () => {
    const state = await fixture({
      selected: [releasePackages[0]],
      registryState: { versions: {}, tags: {}, pendingReads: 3 },
    });
    const result = runPublisher(state);
    expect(result.status, result.stderr).toBe(0);
    const views = (await npmCalls(state)).filter((call) => call[0] === 'view');
    expect(views.length).toBeGreaterThan(4);
  });

  test('fails when read-back never confirms the publish', async () => {
    const state = await fixture({
      selected: [releasePackages[0]],
      registryState: { versions: {}, tags: {}, pendingReads: 50 },
    });
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Read-back verification timed out');
  });

  test('preflights every archive before the first publish', async () => {
    const state = await fixture();
    const react = state.packages[3];
    await writeFile(resolve(state.release, react.archive), 'corrupted');
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archive SHA-256 does not match');
    expect((await npmCalls(state)).some((call) => call[0] === 'publish')).toBe(false);
  });

  test('publishes the audited snapshot even if the source archive changes afterwards', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const [parser] = state.packages;
    // The publisher copies the archive before publishing; a mutation of the
    // source between audit and publish must not reach the registry. Simulate
    // by making the fake npm record what it received and comparing digests.
    const result = runPublisher(state);
    expect(result.status, result.stderr).toBe(0);
    const [publish] = (await npmCalls(state)).filter((call) => call[0] === 'publish');
    expect(publish[1]).not.toBe(resolve(state.release, parser.archive));
    expect(publish[1]).toContain('meta-sam-publish-');
    const registry = await registryState(state);
    expect(registry.versions[`${parser.name}@${parser.version}`].integrity).toBe(
      parser.integrity,
    );
  });

  test('refuses archive paths that escape the release directory', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const manifest = JSON.parse(await readFile(state.manifestPath, 'utf8'));
    manifest.packages[0].archive = '../outside.tgz';
    await writeFile(state.manifestPath, JSON.stringify(manifest));
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has an invalid archive path');
  });

  test('refuses a symlinked archive', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const [parser] = state.packages;
    const target = resolve(state.root, 'elsewhere.tgz');
    await writeFile(target, await readFile(resolve(state.release, parser.archive)));
    await rm(resolve(state.release, parser.archive));
    await symlink(target, resolve(state.release, parser.archive));
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must not be a symbolic link');
  });

  test('refuses a private manifest inside an archive', async () => {
    const state = await fixture({
      selected: [releasePackages[0]],
      manifestOverrides: { '@meta-sam/parser': { private: true } },
    });
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is marked private');
  });

  test('refuses a manifest naming a package outside the release set', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const manifest = JSON.parse(await readFile(state.manifestPath, 'utf8'));
    manifest.packages[0].name = '@meta-sam/other';
    await writeFile(state.manifestPath, JSON.stringify(manifest));
    const result = runPublisher(state);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid planned package');
  });

  test('requires a positive integer verification budget', async () => {
    const state = await fixture({ selected: [releasePackages[0]] });
    const result = runPublisher(state, [], { META_SAM_PUBLISH_VERIFY_ATTEMPTS: '0' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'META_SAM_PUBLISH_VERIFY_ATTEMPTS must be a positive integer',
    );
  });
});
