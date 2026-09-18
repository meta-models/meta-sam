/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releasePackages } from './release-packages.mjs';

const require = createRequire(import.meta.url);
const defaultRoot = resolve(import.meta.dirname, '..');
const defaultCli = resolve(defaultRoot, 'node_modules', '@changesets', 'cli', 'bin.js');
const defaultNpmCli = process.env.npm_execpath;

async function readVersions(root) {
  return new Map(
    await Promise.all(
      releasePackages.map(async (entry) => {
        const manifest = JSON.parse(
          await readFile(
            resolve(root, 'packages', entry.directory, 'package.json'),
            'utf8',
          ),
        );
        if (manifest.name !== entry.name) {
          throw new Error(
            `${entry.directory} is ${manifest.name}, expected ${entry.name}.`,
          );
        }
        return [entry.name, manifest.version];
      }),
    ),
  );
}

// The Changesets action commits with `git add .` from the TypeScript workspace,
// so a file outside it is only committed when it is already staged. Regenerate
// the matrix and stage it in the same step.
export async function stageCompatibilityMatrix(root) {
  const repositoryRoot = resolve(root, '..');
  const { MATRIX_PATH, writeCompatibilityMatrix } = require(
    resolve(repositoryRoot, 'scripts', 'compatibility-matrix.cjs'),
  );
  const matrix = await writeCompatibilityMatrix(repositoryRoot);
  const staged = spawnSync('git', ['add', '--', MATRIX_PATH], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (staged.status !== 0) {
    throw new Error(
      `Could not stage ${MATRIX_PATH}:\n${staged.stdout ?? ''}${staged.stderr ?? ''}`,
    );
  }
  return matrix;
}

export async function versionPackages({
  root = defaultRoot,
  changesetsCli = defaultCli,
  npmCli = defaultNpmCli,
  compatibilityWriter = stageCompatibilityMatrix,
} = {}) {
  if (!npmCli) {
    throw new Error(
      'npm CLI path is unavailable. Run versioning through `npm run version-packages`.',
    );
  }

  const planPath = resolve(root, '.changeset', 'release-plan.json');
  const before = await readVersions(root);
  await rm(planPath, { force: true });

  const result = spawnSync(process.execPath, [changesetsCli, 'version'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `changeset version failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }

  const after = await readVersions(root);
  const packages = releasePackages
    .filter((entry) => before.get(entry.name) !== after.get(entry.name))
    .map((entry) => ({ name: entry.name, version: after.get(entry.name) }));
  if (packages.length === 0) {
    throw new Error(
      'Changesets consumed release intent but changed no package versions.',
    );
  }

  const lockUpdates = [
    { label: 'workspace', prefix: null },
    {
      label: 'playground',
      prefix: resolve(root, 'examples', 'api-playground'),
    },
  ];
  for (const { label, prefix } of lockUpdates) {
    const prefixArgs = prefix ? ['--prefix', prefix] : [];
    const lockResult = spawnSync(
      process.execPath,
      [
        npmCli,
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        ...prefixArgs,
        '--no-audit',
        '--no-fund',
      ],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    if (lockResult.status !== 0) {
      const errorDetail = lockResult.error ? `${lockResult.error.message}\n` : '';
      throw new Error(
        `${label} npm lockfile update failed:\n${lockResult.stdout ?? ''}${lockResult.stderr ?? ''}${errorDetail}`,
      );
    }
  }

  // The compatibility matrix records the parser version that passed the shared
  // conformance corpus, so a parser bump must rewrite it in the same commit.
  if (after.get('@meta-sam/parser') !== before.get('@meta-sam/parser')) {
    await compatibilityWriter(root);
  }

  const plan = { schemaVersion: 1, packages };
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(
    `${result.stdout ?? ''}Planned ${packages.length} package release(s).\n`,
  );
  return plan;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await versionPackages();
}
