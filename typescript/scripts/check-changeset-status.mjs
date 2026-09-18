/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { parseNameStatus } from './check-changeset.mjs';

const packageTreePath = /^(typescript\/)?packages\/([^/]+)\/(.+)$/;

function packageLocation(path) {
  const match = packageTreePath.exec(path);
  return match === null
    ? null
    : {
        inTypeScript: match[1] !== undefined,
        packageName: match[2],
        packagePath: match[3],
      };
}

function isExactWorkspacePackageMove(change) {
  if (change.status !== 'R100' || change.paths.length !== 2) return false;
  const before = packageLocation(change.paths[0]);
  const after = packageLocation(change.paths[1]);
  return (
    before !== null &&
    after !== null &&
    !before.inTypeScript &&
    after.inTypeScript &&
    before.packageName === after.packageName &&
    before.packagePath === after.packagePath
  );
}

function isTestOnlyPackageChange(change) {
  const locations = change.paths.map(packageLocation);
  return (
    locations.every((location) => location !== null) &&
    locations.every((location) => location.packagePath.startsWith('test/'))
  );
}

function isReleaseAffectingLocation(location) {
  return (
    location.packagePath === 'package.json' ||
    location.packagePath === 'README.md' ||
    location.packagePath === 'LICENSE' ||
    location.packagePath.startsWith('src/')
  );
}

export function canSkipChangesetStatus(changes) {
  const packageChanges = changes.filter((change) =>
    change.paths.some((path) => packageLocation(path) !== null),
  );
  const hasReleasePayloadMove = packageChanges.some(
    (change) =>
      isExactWorkspacePackageMove(change) &&
      change.paths.map(packageLocation).some(isReleaseAffectingLocation),
  );
  return (
    hasReleasePayloadMove &&
    packageChanges.every(
      (change) =>
        isExactWorkspacePackageMove(change) || isTestOnlyPackageChange(change),
    )
  );
}

export function changesetStatusDecision(changes) {
  return canSkipChangesetStatus(changes) ? 'skip' : 'delegate';
}

export function runChangesetStatus(changes, { delegate, log }) {
  if (changesetStatusDecision(changes) === 'skip') {
    log(
      'Skipping stock Changesets status: published package paths are exact workspace moves and other package changes are test-only.',
    );
    return;
  }
  return delegate();
}

function parseSince(argv) {
  const argument = argv.find((value) => value.startsWith('--since='));
  if (!argument) {
    throw new Error('Usage: check-changeset-status.mjs --since=<revision>');
  }
  return argument.slice('--since='.length);
}

function changedFiles(base) {
  const result = spawnSync(
    'git',
    ['diff', '--name-status', '--find-renames=100%', `${base}...HEAD`],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not read changed files:\n${result.stderr}`);
  }
  return parseNameStatus(result.stdout);
}

function delegateToRawStatus(argv) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'changeset:status:raw', '--', ...argv], {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const changes = changedFiles(parseSince(argv));
  runChangesetStatus(changes, {
    delegate: () => delegateToRawStatus(argv),
    log: (message) => process.stdout.write(`${message}\n`),
  });
}
