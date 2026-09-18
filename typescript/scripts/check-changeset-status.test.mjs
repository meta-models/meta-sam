/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';

import { expect, test, vi } from 'vitest';

import {
  canSkipChangesetStatus,
  changesetStatusDecision,
  runChangesetStatus,
} from './check-changeset-status.mjs';

const change = (status, ...paths) => ({ status, paths });

const exactMove = (path) =>
  change('R100', `packages/parser/${path}`, `typescript/packages/parser/${path}`);

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

test('package scripts preserve raw Changesets status behind the wrapper', () => {
  expect(manifest.scripts['changeset:status']).toBe(
    'node scripts/check-changeset-status.mjs',
  );
  expect(manifest.scripts['changeset:status:raw']).toBe('changeset status');
});

test('skips stock status when non-exact package changes are test-only', () => {
  const changes = [
    exactMove('package.json'),
    exactMove('src/index.ts'),
    change('D', 'packages/parser/test/parser.test.ts'),
    change('A', 'typescript/packages/parser/test/parser.test.ts'),
    change('M', '.github/workflows/validate.yml'),
    change('A', 'protocol/README.md'),
  ];
  const delegate = vi.fn();
  const log = vi.fn();
  expect(canSkipChangesetStatus(changes)).toBe(true);
  expect(changesetStatusDecision(changes)).toBe('skip');
  expect(runChangesetStatus(changes, { delegate, log })).toBeUndefined();
  expect(delegate).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('test-only'));
});

test.each([
  [
    'modified package source',
    [exactMove('package.json'), change('M', 'typescript/packages/parser/src/index.ts')],
  ],
  [
    'modified package manifest',
    [exactMove('src/index.ts'), change('M', 'typescript/packages/parser/package.json')],
  ],
  [
    'modified packaged README',
    [exactMove('src/index.ts'), change('M', 'typescript/packages/parser/README.md')],
  ],
  [
    'inexact relocation',
    [
      change(
        'R099',
        'packages/parser/src/index.ts',
        'typescript/packages/parser/src/index.ts',
      ),
    ],
  ],
  [
    'package-internal rename',
    [
      change(
        'R100',
        'typescript/packages/parser/src/index.ts',
        'typescript/packages/parser/src/renamed.ts',
      ),
    ],
  ],
  ['no package changes', [change('M', 'README.md')]],
])('delegates stock status for %s', (_label, changes) => {
  const delegate = vi.fn(() => 17);
  const log = vi.fn();
  expect(canSkipChangesetStatus(changes)).toBe(false);
  expect(changesetStatusDecision(changes)).toBe('delegate');
  expect(runChangesetStatus(changes, { delegate, log })).toBe(17);
  expect(delegate).toHaveBeenCalledOnce();
  expect(log).not.toHaveBeenCalled();
});
