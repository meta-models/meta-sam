/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReleaseArchives } from './create-release-archives.mjs';

const defaultRoot = resolve(import.meta.dirname, '..');

export function changesetTagLines(plan, publisherOutput) {
  const outputLines = new Set(publisherOutput.trim().split('\n'));
  return plan.packages.map(({ name, version }) => {
    const spec = `${name}@${version}`;
    if (
      !outputLines.has(`Published and verified ${spec}`) &&
      !outputLines.has(`Already published and verified ${spec}`)
    ) {
      throw new Error(`Publisher did not verify planned package ${spec}.`);
    }
    return `New tag: ${spec}`;
  });
}

async function githubObjectExists(path, { env, fetchImpl }) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error(
      'GITHUB_REPOSITORY and GITHUB_TOKEN are required to reconcile release tags.',
    );
  }
  const api = env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await fetchImpl(`${api}/repos/${repository}/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `GitHub release reconciliation failed for ${path}: HTTP ${response.status}.`,
    );
  }
  return true;
}

export async function githubTagReleaseState(
  tag,
  { env = process.env, fetchImpl = fetch } = {},
) {
  const refPath = tag.split('/').map(encodeURIComponent).join('/');
  const releaseTag = encodeURIComponent(tag);
  const [tagExists, releaseExists] = await Promise.all([
    githubObjectExists(`git/ref/tags/${refPath}`, { env, fetchImpl }),
    githubObjectExists(`releases/tags/${releaseTag}`, { env, fetchImpl }),
  ]);
  return { releaseExists, tagExists };
}

export async function pendingChangesetTagLines(
  plan,
  publisherOutput,
  releaseStateReader = githubTagReleaseState,
) {
  const lines = changesetTagLines(plan, publisherOutput);
  const pending = [];
  for (const line of lines) {
    const tag = line.slice('New tag: '.length);
    const { releaseExists, tagExists } = await releaseStateReader(tag);
    if (releaseExists && !tagExists) {
      throw new Error(`GitHub release ${tag} exists without its tag ref.`);
    }
    if (!releaseExists) pending.push(line);
  }
  return pending;
}

export async function publishReleasePlan({
  root = defaultRoot,
  archiveCreator = createReleaseArchives,
  publisherRunner = spawnSync,
  releaseStateReader = githubTagReleaseState,
  writeStderr = (text) => process.stderr.write(text),
  writeStdout = (text) => process.stdout.write(text),
} = {}) {
  const planPath = resolve(root, '.changeset', 'release-plan.json');
  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      writeStdout('No release plan is present; nothing to publish.\n');
      return;
    }
    throw error;
  }

  await archiveCreator({
    output: resolve(root, '.packs', 'release'),
    releasePlan: plan,
  });

  const publisher = publisherRunner(
    process.execPath,
    [
      resolve(root, 'scripts', 'publish-npm.mjs'),
      '--manifest',
      resolve(root, '.packs', 'release', 'release-manifest.json'),
      '--tag',
      'latest',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  writeStdout(publisher.stdout ?? '');
  writeStderr(publisher.stderr ?? '');
  if (publisher.status !== 0) {
    throw new Error(`npm publisher exited with status ${publisher.status ?? 1}.`);
  }

  const tagLines = await pendingChangesetTagLines(
    plan,
    publisher.stdout ?? '',
    releaseStateReader,
  );
  if (tagLines.length > 0) writeStdout(`${tagLines.join('\n')}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await publishReleasePlan();
}
