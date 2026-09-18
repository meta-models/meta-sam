/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test } from 'vitest';

import {
  conformanceCaseSchema,
  discoverConformanceCases,
  loadConformanceCases,
  parseConformanceCase,
  runConformanceCase,
  type ConformanceCase,
  type Media,
} from './runner.js';
import { validateAgainstSchema } from './schema-validator.js';

const temporaryDirectories: string[] = [];

function minimalCase(media: Media = 'image'): ConformanceCase {
  return {
    schema_version: 1,
    name: `synthetic-${media}`,
    description: `Minimal synthetic ${media} completion.`,
    media,
    chunks: [],
    events: [
      {
        type: 'output_text_done',
        lane: { item_id: 'message-1', output_index: 0, content_index: 0 },
        text: '',
      },
      { type: 'response_completed' },
    ],
    expected: {
      snapshots: [],
      result: {
        media,
        revision: 0,
        records: [],
        diagnostics: [],
        raw_output: '',
        outcome: { status: 'completed' },
      },
    },
  };
}

function fixtureSource(update: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...minimalCase(), ...update });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'meta-sam-conformance-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const conformanceCases = await loadConformanceCases();

test('discovers the complete quota-free shared corpus', () => {
  expect(conformanceCases).toHaveLength(35);
});

test.each(conformanceCases)('shared conformance: $name', async (fixture) => {
  await expect(runConformanceCase(fixture)).resolves.toEqual(fixture.expected);
});

test('loads the checked-in schema as JSON Schema 2020-12', () => {
  expect(conformanceCaseSchema).toMatchObject({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'meta-sam parser conformance case',
    type: 'object',
  });
});

test('fails closed when the checked-in validator sees an unsupported schema keyword', () => {
  expect(() =>
    parseConformanceCase(fixtureSource(), 'synthetic.json', {
      ...(conformanceCaseSchema as Record<string, unknown>),
      dependentSchemas: {},
    }),
  ).toThrow(/Unsupported JSON Schema keyword dependentSchemas/);
});

test.each(['constructor', 'toString', '__proto__'])(
  'rejects prototype-named additional property %s',
  (property) => {
    const fixture = JSON.parse(fixtureSource()) as Record<string, unknown>;
    Object.defineProperty(fixture, property, {
      configurable: true,
      enumerable: true,
      value: 'not allowed',
    });
    expect(() =>
      parseConformanceCase(JSON.stringify(fixture), 'synthetic.json'),
    ).toThrow(/not an allowed property/);
  },
);

test('applies $ref siblings under JSON Schema 2020-12', () => {
  expect(
    validateAgainstSchema(1, {
      $defs: { integer: { type: 'integer' } },
      $ref: '#/$defs/integer',
      minimum: 2,
    }),
  ).toEqual([expect.objectContaining({ schemaPath: '#/minimum' })]);
});

test('compares unique object items independent of key order', () => {
  expect(
    validateAgainstSchema(
      [
        { left: 1, right: 2 },
        { right: 2, left: 1 },
      ],
      { type: 'array', uniqueItems: true },
    ),
  ).toEqual([expect.objectContaining({ schemaPath: '#/uniqueItems' })]);
});

test('enforces items false with and without prefixItems', () => {
  expect(validateAgainstSchema([1], { type: 'array', items: false })).toHaveLength(1);
  expect(
    validateAgainstSchema([1], {
      type: 'array',
      prefixItems: [{ type: 'integer' }],
      items: false,
    }),
  ).toEqual([]);
  expect(
    validateAgainstSchema([1, 2], {
      type: 'array',
      prefixItems: [{ type: 'integer' }],
      items: false,
    }),
  ).toHaveLength(1);
});

test('discovers every JSON case in lexical order', async () => {
  const directory = await temporaryDirectory();
  await Promise.all([
    writeFile(resolve(directory, 'z.json'), '{}'),
    writeFile(resolve(directory, 'a.json'), '{}'),
  ]);
  const discovered = await discoverConformanceCases(
    pathToFileURL(`${directory}${sep}`),
  );
  expect(discovered.map((url) => url.pathname.split('/').at(-1))).toEqual([
    'a.json',
    'z.json',
  ]);
});

test.each([
  [
    'a non-JSON file',
    async (directory: string) => writeFile(resolve(directory, 'notes.txt'), '{}'),
  ],
  [
    'a nested directory',
    async (directory: string) => mkdir(resolve(directory, 'nested')),
  ],
] as const)(
  'rejects %s instead of silently ignoring it',
  async (_label, createEntry) => {
    const directory = await temporaryDirectory();
    await writeFile(resolve(directory, 'valid.json'), '{}');
    await createEntry(directory);
    await expect(
      discoverConformanceCases(pathToFileURL(`${directory}${sep}`)),
    ).rejects.toThrow(/unsupported entries/);
  },
);

test('rejects an empty case directory', async () => {
  const directory = await temporaryDirectory();
  await expect(
    loadConformanceCases(pathToFileURL(`${directory}${sep}`)),
  ).rejects.toThrow(/No shared conformance cases/);
});

test('requires a case name to match its filename', async () => {
  const directory = await temporaryDirectory();
  await writeFile(resolve(directory, 'wrong.json'), JSON.stringify(minimalCase()));
  await expect(
    loadConformanceCases(pathToFileURL(`${directory}${sep}`)),
  ).rejects.toThrow(/must be named synthetic-image\.json/);
});

test.each(['image', 'video'] as const)(
  'accepts and runs %s conformance media',
  async (media) => {
    const fixture = parseConformanceCase(
      JSON.stringify(minimalCase(media)),
      `synthetic-${media}.json`,
    );
    await expect(runConformanceCase(fixture)).resolves.toEqual(fixture.expected);
  },
);

test('rejects unsupported media through the checked-in schema', () => {
  expect(() =>
    parseConformanceCase(fixtureSource({ media: 'audio' }), 'synthetic.json'),
  ).toThrow(/schema validation/);
});

test('rejects expected frame indexes above the JavaScript safe-integer maximum', () => {
  const fixture = minimalCase();
  if (!('result' in fixture.expected)) throw new Error('Expected a result fixture.');
  const expectedResult = fixture.expected.result;
  expect(() =>
    parseConformanceCase(
      JSON.stringify({
        ...fixture,
        expected: {
          snapshots: [],
          result: {
            ...expectedResult,
            records: [
              {
                kind: 'box',
                order: 0,
                object_id: '0',
                frame_index: 9_007_199_254_740_992,
                left: 0,
                top: 0,
                right: 1,
                bottom: 1,
              },
            ],
          },
        },
      }),
      'synthetic.json',
    ),
  ).toThrow(/schema validation/);
});

test('rejects unsupported source event variants through the checked-in schema', () => {
  expect(() =>
    parseConformanceCase(
      fixtureSource({ events: [{ type: 'tool_call' }] }),
      'synthetic.json',
    ),
  ).toThrow(/unsupported variant "tool_call"/);
});

test('rejects parser options through the checked-in schema', () => {
  expect(() =>
    parseConformanceCase(fixtureSource({ options: {} }), 'synthetic.json'),
  ).toThrow(/not an allowed property/);
});

test('rejects unknown fields through the checked-in schema', () => {
  expect(() =>
    parseConformanceCase(
      fixtureSource({ implementation: 'typescript' }),
      'synthetic.json',
    ),
  ).toThrow(/not an allowed property/);
});

test('requires exactly one expected terminal shape', () => {
  const fixture = minimalCase();
  expect(() =>
    parseConformanceCase(
      JSON.stringify({
        ...fixture,
        expected: {
          ...fixture.expected,
          error: { code: 'response_error', message: 'synthetic' },
        },
      }),
      'synthetic.json',
    ),
  ).toThrow(/must match exactly one variant/);
});

test.each([
  {
    label: 'out-of-order chunk references',
    update: {
      chunks: ['a', 'b'],
      events: [
        {
          type: 'output_text_delta',
          lane: { item_id: 'message-1', output_index: 0, content_index: 0 },
          chunk: 1,
        },
      ],
    },
    message: /reference every chunk exactly once in order/,
  },
  {
    label: 'events after terminal input',
    update: {
      events: [
        { type: 'response_failed', message: 'synthetic failure' },
        { type: 'response_completed' },
      ],
    },
    message: /terminal source event must be the final event/,
  },
] as const)('rejects $label', ({ update, message }) => {
  expect(() => parseConformanceCase(fixtureSource(update), 'synthetic.json')).toThrow(
    message,
  );
});
