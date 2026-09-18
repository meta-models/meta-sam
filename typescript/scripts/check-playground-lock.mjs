/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const rootPackage = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const playgroundPackage = JSON.parse(
  await readFile(
    new URL('../examples/api-playground/package.json', import.meta.url),
    'utf8',
  ),
);
const playgroundLock = JSON.parse(
  await readFile(
    new URL('../examples/api-playground/package-lock.json', import.meta.url),
    'utf8',
  ),
);
const lockedRoot = playgroundLock.packages?.[''];

if (rootPackage.packageManager !== 'npm@11.16.0') {
  throw new Error('The workspace must pin npm@11.16.0.');
}
if (playgroundLock.lockfileVersion !== 3 || playgroundLock.requires !== true) {
  throw new Error('The playground lockfile must use npm lockfile version 3.');
}
if (lockedRoot === undefined) {
  throw new Error('The playground lockfile is missing its root install metadata.');
}
for (const key of [
  'name',
  'version',
  'license',
  'dependencies',
  'devDependencies',
  'engines',
]) {
  if (!isDeepStrictEqual(lockedRoot[key], playgroundPackage[key])) {
    throw new Error(`The playground lockfile has stale ${key} metadata.`);
  }
}

process.stdout.write('Playground lockfile metadata is current.\n');
