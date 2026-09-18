/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test } from 'vitest';

import {
  extractCheckedExamples,
  missingInstalledExamplePackages,
  requireCheckedExamples,
  requireInstalledExamplePackages,
  requirePackageSafeLinks,
} from './check-readme-examples.mjs';

test('extracts explicitly marked TypeScript and TSX fences', () => {
  expect(
    extractCheckedExamples(
      [
        '# Guide',
        '<!-- readme-example -->',
        '```ts',
        "import { example } from 'package';",
        'example();',
        '```',
        '',
        '<!-- readme-example -->',
        '```tsx',
        'const view = <div />;',
        '```',
      ].join('\n'),
      'README.md',
    ),
  ).toEqual([
    {
      language: 'ts',
      source: 'README.md',
      code: "import { example } from 'package';\nexample();",
    },
    {
      language: 'tsx',
      source: 'README.md',
      code: 'const view = <div />;',
    },
  ]);
});

test('requires a checked example in every package README', () => {
  expect(() => requireCheckedExamples('# Guide\n\nNo example.', 'README.md')).toThrow(
    'README.md must contain at least one checked README example.',
  );
});

test('requires every checked-example import in an npm install command', () => {
  const readme = [
    '# Guide',
    '```sh',
    'npm install @scope/example react',
    '```',
    '<!-- readme-example -->',
    '```tsx',
    "import { thing } from '@scope/example';",
    "import type { Other } from '@scope/other/subpath';",
    "import { useState } from 'react';",
    "import 'side-effect-package';",
    "import { readFile } from 'node:fs/promises';",
    "import { local } from './local.js';",
    'void thing; void useState; void local;',
    '```',
  ].join('\n');

  expect(missingInstalledExamplePackages(readme, 'README.md')).toEqual([
    '@scope/other',
    'side-effect-package',
  ]);
  expect(() => requireInstalledExamplePackages(readme, 'README.md')).toThrow(
    /@scope\/other, side-effect-package/,
  );
  expect(() =>
    requireInstalledExamplePackages(
      readme.replace(
        'npm install @scope/example react',
        'npm install @scope/example @scope/other react side-effect-package',
      ),
      'README.md',
    ),
  ).not.toThrow();
});

test('rejects parent-relative links that break in a published package', () => {
  expect(() =>
    requirePackageSafeLinks(
      'See [repository docs](../../docs/media-performance.md).',
      'README.md',
    ),
  ).toThrow(/links outside the published package/);
  expect(() =>
    requirePackageSafeLinks(
      'See [repository docs](https://github.com/example/repo/blob/main/docs.md).',
      'README.md',
    ),
  ).not.toThrow();
});

test('rejects a marker that is not followed by a checked fence', () => {
  expect(() =>
    extractCheckedExamples(
      '<!-- readme-example -->\n```js\nexample();\n```',
      'README.md',
    ),
  ).toThrow(/1 README example marker.*0 checked fence/);
});
