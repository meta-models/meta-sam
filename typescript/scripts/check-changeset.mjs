/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const releaseAffectingPath =
  /^(?:typescript\/)?packages\/(parser|graphics|video|react)\/(package\.json|README\.md|LICENSE|src\/.*)$/;
const sharedParserContractPath =
  /^(?:protocol\/.*|conformance\/(?:case\.schema\.json|cases\/.*))$/;
const changesetPath = /^typescript\/\.changeset\/(?!README\.md$)[^/]+\.md$/;

function publishedLocation(path) {
  if (sharedParserContractPath.test(path)) {
    return { packageName: 'parser', packagePath: path };
  }
  const match = releaseAffectingPath.exec(path);
  return match === null ? null : { packageName: match[1], packagePath: match[2] };
}

function isContentPreservingWorkspaceMove(change) {
  if (change.status !== 'R100' || change.paths.length !== 2) return false;
  const before = publishedLocation(change.paths[0]);
  const after = publishedLocation(change.paths[1]);
  return (
    before !== null &&
    after !== null &&
    before.packageName === after.packageName &&
    before.packagePath === after.packagePath
  );
}

export function parseNameStatus(output) {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      const expectedPathCount = /^[RC]\d+$/.test(status) ? 2 : 1;
      if (paths.length !== expectedPathCount) {
        throw new Error(`Unexpected git name-status entry: ${line}`);
      }
      return { status, paths };
    });
}

export function releaseIntentProblem(changes) {
  const affected = changes.flatMap((change) => {
    if (isContentPreservingWorkspaceMove(change)) return [];
    return change.paths.filter((path) => publishedLocation(path) !== null);
  });
  const hasChangeset = changes.some((change) =>
    change.paths.some((path) => changesetPath.test(path)),
  );
  if (affected.length === 0 || hasChangeset) return null;
  return [
    'Published package changes require a changeset.',
    ...[...new Set(affected)].map((path) => `- ${path}`),
    'Run `npm run changeset` from `typescript/`, select the directly changed packages, and commit the generated file.',
  ].join('\n');
}

function parseBase(argv) {
  const argument = argv.find((value) => value.startsWith('--base='));
  if (!argument) throw new Error('Usage: check-changeset.mjs --base=<revision>');
  return argument.slice('--base='.length);
}

function changedFiles(base) {
  const result = spawnSync(
    'git',
    ['diff', '--name-status', '--find-renames=100%', `${base}...HEAD`],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`Could not read changed files:\n${result.stderr}`);
  }
  return parseNameStatus(result.stdout);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const problem = releaseIntentProblem(changedFiles(parseBase(process.argv.slice(2))));
  if (problem) throw new Error(problem);
}
