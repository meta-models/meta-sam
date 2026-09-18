/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const browserRoot = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(browserRoot, '.generated');

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(browserRoot, 'harness.ts')],
  outfile: path.join(outputDirectory, 'harness.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
await writeFile(
  path.join(outputDirectory, 'index.html'),
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Mediabunny browser conformance</title></head>',
    '<body><main id="status">ready</main><script type="module" src="/harness.js"></script></body>',
    '</html>',
    '',
  ].join('\n'),
);
