/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  buildObjectPrompt,
  ObjectPromptError,
  type BuildObjectPromptOptions,
} from '../../packages/parser/src/index.js';
import { validateAgainstSchema, type JsonSchema } from './schema-validator.js';

interface ObjectPromptCase {
  readonly name: string;
  readonly input: BuildObjectPromptOptions;
  readonly expected: { readonly text: string } | { readonly error: string };
}

const conformanceRoot = resolve(import.meta.dirname, '..', '..', '..', 'conformance');
const schema = JSON.parse(
  await readFile(resolve(conformanceRoot, 'object-prompt.schema.json'), 'utf8'),
) as JsonSchema;
const directory = resolve(conformanceRoot, 'object-prompts');

async function loadCases(): Promise<ObjectPromptCase[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const unsupported = entries.filter(
    (entry) => !entry.isFile() || !entry.name.endsWith('.json'),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported object-prompt conformance entries: ${unsupported.map((entry) => entry.name).join(', ')}`,
    );
  }
  return Promise.all(
    entries
      .map((entry) => entry.name)
      .sort()
      .map(async (file) => {
        const value: unknown = JSON.parse(
          await readFile(resolve(directory, file), 'utf8'),
        );
        const issues = validateAgainstSchema(value, schema);
        if (issues.length > 0) {
          throw new Error(
            `${file} failed schema validation: ${JSON.stringify(issues)}`,
          );
        }
        const fixture = value as ObjectPromptCase;
        if (`${fixture.name}.json` !== file) {
          throw new Error(`${file} must be named after its case name ${fixture.name}.`);
        }
        return fixture;
      }),
  );
}

const cases = await loadCases();

test('discovers the complete shared object-prompt corpus', () => {
  expect(cases).toHaveLength(22);
});

test.each(cases)('shared object prompt: $name', (fixture) => {
  if ('text' in fixture.expected) {
    expect(buildObjectPrompt(fixture.input)).toBe(fixture.expected.text);
    return;
  }
  let thrown: unknown;
  try {
    buildObjectPrompt(fixture.input);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ObjectPromptError);
  expect((thrown as ObjectPromptError).code).toBe(fixture.expected.error);
});
