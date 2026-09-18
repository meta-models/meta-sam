/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { checkReleasePlan } from './check-release-plan.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function planRoot(plan, versions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'meta-sam-plan-check-'));
  roots.push(root);
  await mkdir(resolve(root, '.changeset'), { recursive: true });
  for (const [directory, name] of [
    ['parser', '@meta-sam/parser'],
    ['graphics', '@meta-sam/graphics'],
    ['video', '@meta-sam/video'],
    ['react', '@meta-sam/react'],
  ]) {
    await mkdir(resolve(root, 'packages', directory), { recursive: true });
    await writeFile(
      resolve(root, 'packages', directory, 'package.json'),
      `${JSON.stringify({ name, version: versions[name] ?? '0.0.3' })}\n`,
    );
  }
  if (plan !== null) {
    await writeFile(
      resolve(root, '.changeset', 'release-plan.json'),
      `${JSON.stringify(plan)}\n`,
    );
  }
  return root;
}

function plan(...entries) {
  return {
    schemaVersion: 1,
    packages: entries.map(([name, version]) => ({ name, version })),
  };
}

test('reports an absent plan without failing', async () => {
  const output = [];
  const root = await planRoot(null);
  await expect(
    checkReleasePlan({ root, writeStdout: (text) => output.push(text) }),
  ).resolves.toBeNull();
  expect(output.join('')).toContain('No release plan is present');
});

test('accepts a plan whose versions match the workspace manifests', async () => {
  const output = [];
  const root = await planRoot(
    plan(['@meta-sam/parser', '0.0.7'], ['@meta-sam/react', '0.1.5']),
    { '@meta-sam/parser': '0.0.7', '@meta-sam/react': '0.1.5' },
  );
  await expect(
    checkReleasePlan({ root, writeStdout: (text) => output.push(text) }),
  ).resolves.toEqual({ packageCount: 2 });
  expect(output.join('')).toContain(
    'Release plan: @meta-sam/parser@0.0.7, @meta-sam/react@0.1.5.',
  );
});

test('rejects a plan whose version differs from the workspace manifest', async () => {
  const root = await planRoot(plan(['@meta-sam/parser', '0.0.7']), {
    '@meta-sam/parser': '0.0.6',
  });
  await expect(checkReleasePlan({ root, writeStdout: () => {} })).rejects.toThrow(
    '@meta-sam/parser is 0.0.6, but the release plan requires 0.0.7.',
  );
});

test('rejects a plan outside dependency order', async () => {
  const root = await planRoot(
    plan(['@meta-sam/react', '0.0.3'], ['@meta-sam/parser', '0.0.3']),
  );
  await expect(checkReleasePlan({ root, writeStdout: () => {} })).rejects.toThrow(
    /dependency order/,
  );
});

test('rejects a plan that still carries registry aliases', async () => {
  const root = await planRoot({
    schemaVersion: 1,
    packages: [
      { canonicalName: '@meta-sam/parser', aliasName: 'alias', version: '0.0.3' },
    ],
  });
  await expect(checkReleasePlan({ root, writeStdout: () => {} })).rejects.toThrow(
    /Invalid planned package/,
  );
});
