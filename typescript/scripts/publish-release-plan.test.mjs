/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { expect, test } from 'vitest';

import {
  changesetTagLines,
  githubTagReleaseState,
  pendingChangesetTagLines,
  publishReleasePlan,
} from './publish-release-plan.mjs';

const plan = {
  schemaVersion: 1,
  packages: [
    { name: '@meta-sam/parser', version: '0.0.2' },
    { name: '@meta-sam/react', version: '0.1.0' },
  ],
};

const expectedTagLines = [
  'New tag: @meta-sam/parser@0.0.2',
  'New tag: @meta-sam/react@0.1.0',
];

test('emits canonical package tags after every planned publish is verified', () => {
  expect(
    changesetTagLines(
      plan,
      [
        'Published and verified @meta-sam/parser@0.0.2',
        'Published and verified @meta-sam/react@0.1.0',
      ].join('\n'),
    ),
  ).toEqual(expectedTagLines);
});

test('re-emits canonical tags for an already-published idempotent retry', () => {
  expect(
    changesetTagLines(
      plan,
      [
        'Already published and verified @meta-sam/parser@0.0.2',
        'Already published and verified @meta-sam/react@0.1.0',
      ].join('\n'),
    ),
  ).toEqual(expectedTagLines);
});

test('reads exact remote tag and release state through authenticated GitHub API calls', async () => {
  const requests = [];
  const state = await githubTagReleaseState('@meta-sam/parser@0.0.2', {
    env: {
      GITHUB_API_URL: 'https://api.github.test',
      GITHUB_REPOSITORY: 'meta/meta-sam',
      GITHUB_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: requests.length === 1, status: requests.length === 1 ? 200 : 404 };
    },
  });

  expect(state).toEqual({ releaseExists: false, tagExists: true });
  expect(requests.map(({ url }) => url)).toEqual([
    'https://api.github.test/repos/meta/meta-sam/git/ref/tags/%40meta-sam/parser%400.0.2',
    'https://api.github.test/repos/meta/meta-sam/releases/tags/%40meta-sam%2Fparser%400.0.2',
  ]);
  for (const { options } of requests) {
    expect(options.headers.authorization).toBe('Bearer token');
  }
});

test('emits an idempotent retry only while its GitHub release is missing', async () => {
  const publisherOutput = [
    'Already published and verified @meta-sam/parser@0.0.2',
    'Already published and verified @meta-sam/react@0.1.0',
  ].join('\n');
  const states = new Map([
    ['@meta-sam/parser@0.0.2', { releaseExists: true, tagExists: true }],
    ['@meta-sam/react@0.1.0', { releaseExists: false, tagExists: true }],
  ]);

  await expect(
    pendingChangesetTagLines(plan, publisherOutput, async (tag) => states.get(tag)),
  ).resolves.toEqual(['New tag: @meta-sam/react@0.1.0']);
});

test('fails closed when a GitHub release exists without its tag ref', async () => {
  await expect(
    pendingChangesetTagLines(
      { ...plan, packages: [plan.packages[0]] },
      'Already published and verified @meta-sam/parser@0.0.2',
      async () => ({ releaseExists: true, tagExists: false }),
    ),
  ).rejects.toThrow(/exists without its tag ref/);
});

test('writes parser-compatible tags after an idempotent publisher run', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-plan-test-'));
  const stdout = [];
  try {
    await mkdir(resolve(root, '.changeset'));
    await writeFile(
      resolve(root, '.changeset', 'release-plan.json'),
      `${JSON.stringify({ ...plan, packages: [plan.packages[0]] })}\n`,
    );
    await publishReleasePlan({
      root,
      archiveCreator: async () => {},
      publisherRunner: () => ({
        status: 0,
        stderr: '',
        stdout: 'Already published and verified @meta-sam/parser@0.0.2\n',
      }),
      releaseStateReader: async () => ({
        releaseExists: false,
        tagExists: false,
      }),
      writeStderr: () => {},
      writeStdout: (text) => stdout.push(text),
    });

    expect(stdout.join('')).toBe(
      'Already published and verified @meta-sam/parser@0.0.2\n' +
        'New tag: @meta-sam/parser@0.0.2\n',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('suppresses action output when the GitHub tag and release already exist', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-plan-test-'));
  const stdout = [];
  try {
    await mkdir(resolve(root, '.changeset'));
    await writeFile(
      resolve(root, '.changeset', 'release-plan.json'),
      `${JSON.stringify({ ...plan, packages: [plan.packages[0]] })}\n`,
    );
    await publishReleasePlan({
      root,
      archiveCreator: async () => {},
      publisherRunner: () => ({
        status: 0,
        stderr: '',
        stdout: 'Already published and verified @meta-sam/parser@0.0.2\n',
      }),
      releaseStateReader: async () => ({
        releaseExists: true,
        tagExists: true,
      }),
      writeStderr: () => {},
      writeStdout: (text) => stdout.push(text),
    });

    expect(stdout.join('')).toBe(
      'Already published and verified @meta-sam/parser@0.0.2\n',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('does not emit tags unless every planned package was verified', () => {
  expect(() =>
    changesetTagLines(plan, 'Published and verified @meta-sam/parser@0.0.2\n'),
  ).toThrow(/did not verify planned package @meta-sam\/react@0.1.0/);
});
