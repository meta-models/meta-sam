/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releasePackages } from './release-packages.mjs';

const marker = '<!-- readme-example -->';
const checkedFence = /<!-- readme-example -->\s*\n```(ts|tsx)\n([\s\S]*?)\n```/g;
const shellFence = /```(?:sh|bash)\n([\s\S]*?)\n```/g;

function packageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  ) {
    return null;
  }
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function installedPackageName(token) {
  if (token.startsWith('-')) return null;
  if (token.startsWith('@')) {
    const separator = token.indexOf('@', 1);
    return separator === -1 ? token : token.slice(0, separator);
  }
  const separator = token.indexOf('@');
  return separator === -1 ? token : token.slice(0, separator);
}

export function missingInstalledExamplePackages(markdown, source) {
  const imports = new Set();
  for (const example of extractCheckedExamples(markdown, source)) {
    const patterns = [
      /\bimport\s+(?:type\s+)?[^;]*?\sfrom\s+['"]([^'"]+)['"]/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
      for (const match of example.code.matchAll(pattern)) {
        const name = packageName(match[1]);
        if (name !== null) imports.add(name);
      }
    }
  }

  const installed = new Set();
  for (const match of markdown.matchAll(shellFence)) {
    for (const line of match[1].split('\n')) {
      const command = /^\s*npm\s+install\s+(.+?)\s*$/.exec(line);
      if (command === null) continue;
      for (const token of command[1].split(/\s+/)) {
        const name = installedPackageName(token);
        if (name !== null) installed.add(name);
      }
    }
  }
  return [...imports].filter((name) => !installed.has(name)).sort();
}

export function requireInstalledExamplePackages(markdown, source) {
  const missing = missingInstalledExamplePackages(markdown, source);
  if (missing.length > 0) {
    throw new Error(
      `${source} must install every package imported by its checked examples: ${missing.join(', ')}.`,
    );
  }
}

export function requirePackageSafeLinks(markdown, source) {
  const parentRelative = [...markdown.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map(
    (match) => match[1],
  );
  if (parentRelative.length > 0) {
    throw new Error(
      `${source} contains links outside the published package: ${parentRelative.join(', ')}.`,
    );
  }
}

export function extractCheckedExamples(markdown, source) {
  const markerCount = markdown.split(marker).length - 1;
  const examples = [];
  for (const match of markdown.matchAll(checkedFence)) {
    examples.push({ language: match[1], source, code: match[2] });
  }
  if (examples.length !== markerCount) {
    throw new Error(
      `${source} contains ${markerCount} README example marker(s), but ${examples.length} checked fence(s).`,
    );
  }
  return examples;
}

export function requireCheckedExamples(markdown, source) {
  const examples = extractCheckedExamples(markdown, source);
  if (examples.length === 0) {
    throw new Error(`${source} must contain at least one checked README example.`);
  }
  return examples;
}

export async function checkReadmeExamples({
  root = resolve(import.meta.dirname, '..'),
} = {}) {
  const configured = JSON.parse(
    await readFile(resolve(root, '.readme-examples.json'), 'utf8'),
  );
  if (!Array.isArray(configured) || new Set(configured).size !== configured.length) {
    throw new Error('.readme-examples.json must contain unique package directories.');
  }
  const expected = new Set(configured);
  const examples = [];
  for (const entry of releasePackages) {
    const readme = resolve(root, 'packages', entry.directory, 'README.md');
    const markdown = await readFile(readme, 'utf8');
    requirePackageSafeLinks(markdown, readme);
    requireInstalledExamplePackages(markdown, readme);
    const extracted = expected.has(entry.directory)
      ? requireCheckedExamples(markdown, readme)
      : extractCheckedExamples(markdown, readme);
    examples.push(...extracted);
    expected.delete(entry.directory);
  }
  if (expected.size > 0) {
    throw new Error(
      `.readme-examples.json contains unknown package directories: ${[...expected].join(', ')}.`,
    );
  }

  const cache = resolve(root, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(resolve(cache, 'meta-sam-readmes-'));
  try {
    const files = [];
    for (const [index, example] of examples.entries()) {
      const file = resolve(
        temporary,
        `${index}-${example.source.split('/').at(-2)}.${example.language}`,
      );
      await writeFile(file, `${example.code}\n`);
      files.push(file);
    }

    const compiler = resolve(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const result = spawnSync(
      process.execPath,
      [
        compiler,
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--lib',
        'ES2022,DOM,DOM.Iterable',
        '--jsx',
        'react-jsx',
        ...files,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(
        `README examples failed to compile:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
      );
    }
    process.stdout.write(`Compiled ${examples.length} checked README example(s).\n`);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await checkReadmeExamples();
}
