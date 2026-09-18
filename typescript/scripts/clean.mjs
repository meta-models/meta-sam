/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const paths = [
  '.cache',
  'coverage',
  '.packs',
  'packages/parser/dist',
  'packages/graphics/dist',
  'packages/video/dist',
  'packages/react/dist',
];

await Promise.all(
  paths.map((path) => rm(resolve(root, path), { force: true, recursive: true })),
);
