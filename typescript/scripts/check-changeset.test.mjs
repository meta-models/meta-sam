/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test } from 'vitest';

import { parseNameStatus, releaseIntentProblem } from './check-changeset.mjs';

const change = (status, ...paths) => ({ status, paths });

test('requires a changeset for published source and manifest changes', () => {
  expect(
    releaseIntentProblem([change('M', 'typescript/packages/parser/src/stream.ts')]),
  ).toMatch(/require a changeset/);
  expect(
    releaseIntentProblem([change('M', 'typescript/packages/parser/package.json')]),
  ).toMatch(/require a changeset/);
});

test('accepts release intent for a published package change', () => {
  expect(
    releaseIntentProblem([
      change('M', 'typescript/packages/parser/src/stream.ts'),
      change('A', 'typescript/.changeset/fix-parser.md'),
    ]),
  ).toBeNull();
});

test('requires a changeset for packaged documentation changes', () => {
  expect(
    releaseIntentProblem([change('M', 'typescript/packages/parser/README.md')]),
  ).toMatch(/require a changeset/);
  expect(
    releaseIntentProblem([change('M', 'typescript/packages/parser/LICENSE')]),
  ).toMatch(/require a changeset/);
});

test('does not require a release for tests or release infrastructure', () => {
  expect(
    releaseIntentProblem([
      change('M', 'typescript/packages/parser/test/parser.test.ts'),
      change('M', 'typescript/scripts/publish-npm.mjs'),
      change('M', 'typescript/docs/releasing.md'),
      change('M', 'conformance/README.md'),
      change('M', 'conformance/compatibility.json'),
    ]),
  ).toBeNull();
});

test('requires parser release intent for shared contract changes', () => {
  expect(
    releaseIntentProblem([
      change('M', 'protocol/sam3.md'),
      change('M', 'conformance/cases/synthetic-video-basic.json'),
      change('M', 'conformance/case.schema.json'),
    ]),
  ).toMatch(/require a changeset/);
});

test('test-only package changes do not require release intent', () => {
  expect(
    releaseIntentProblem([
      change('D', 'packages/parser/test/parser.test.ts'),
      change('A', 'typescript/packages/parser/test/parser.test.ts'),
      change('A', 'typescript/test/conformance/parser.test.ts'),
    ]),
  ).toBeNull();
});

test('does not require a release for exact workspace relocation', () => {
  expect(
    releaseIntentProblem([
      change(
        'R100',
        'packages/parser/src/stream.ts',
        'typescript/packages/parser/src/stream.ts',
      ),
      change(
        'R100',
        'packages/parser/package.json',
        'typescript/packages/parser/package.json',
      ),
    ]),
  ).toBeNull();
});

test('requires a release for changed or package-internal renames', () => {
  expect(
    releaseIntentProblem([
      change(
        'R099',
        'packages/parser/src/stream.ts',
        'typescript/packages/parser/src/stream.ts',
      ),
    ]),
  ).toMatch(/typescript\/packages\/parser\/src\/stream\.ts/);
  expect(
    releaseIntentProblem([
      change(
        'R100',
        'typescript/packages/parser/src/stream.ts',
        'typescript/packages/parser/src/renamed-stream.ts',
      ),
    ]),
  ).toMatch(/typescript\/packages\/parser\/src\/renamed-stream\.ts/);
});

test('parses git name-status output including exact renames', () => {
  expect(
    parseNameStatus(
      'M\ttypescript/packages/parser/src/index.ts\n' +
        'R100\tpackages/parser/src/stream.ts\ttypescript/packages/parser/src/stream.ts\n',
    ),
  ).toEqual([
    change('M', 'typescript/packages/parser/src/index.ts'),
    change(
      'R100',
      'packages/parser/src/stream.ts',
      'typescript/packages/parser/src/stream.ts',
    ),
  ]);
});
