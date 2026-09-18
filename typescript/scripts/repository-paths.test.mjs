/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

const repositoryRoot = new URL('../../', import.meta.url);

async function readRepositoryFile(path) {
  return readFile(new URL(path, repositoryRoot), 'utf8');
}

test('root documentation uses the portable Node validation entry points', async () => {
  const [readme, contributing] = await Promise.all([
    readRepositoryFile('README.md'),
    readRepositoryFile('CONTRIBUTING.md'),
  ]);
  for (const document of [readme, contributing]) {
    expect(document).toContain('node scripts/validate');
    expect(document).not.toContain('./scripts/validate');
  }
  expect(readme).toContain('node scripts/validate-conformance');
});

test('Prettier ignores validation and browser output trees', async () => {
  const ignored = new Set(
    (await readRepositoryFile('typescript/.prettierignore'))
      .split('\n')
      .filter(Boolean),
  );
  const requiredPatterns = [
    'node_modules/',
    '**/node_modules/',
    'dist/',
    '**/dist/',
    'coverage/',
    '**/coverage/',
    '.cache/',
    '**/.cache/',
    '.packs/',
    '**/.packs/',
    '.generated/',
    '**/.generated/',
    'test-results/',
    '**/test-results/',
    'playwright-report/',
    '**/playwright-report/',
  ];
  for (const pattern of requiredPatterns) {
    expect(ignored.has(pattern), `${pattern} must be ignored`).toBe(true);
  }
});

test('playground instructions and banner identify the relocated environment file', async () => {
  const [readme, app] = await Promise.all([
    readRepositoryFile('typescript/examples/api-playground/README.md'),
    readRepositoryFile('typescript/examples/api-playground/src/App.tsx'),
  ]);
  expect(readme).toContain('From `typescript/`:');
  expect(readme).toContain('`typescript/examples/api-playground/.env.local`');
  expect(readme).not.toContain('From the repository root:');
  expect(app).toContain('typescript/examples/api-playground/.env.local');
  expect(app).not.toContain('in examples/api-playground/.env.local and restart');
});
