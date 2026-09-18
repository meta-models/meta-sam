/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packages = ['parser', 'graphics', 'video', 'react'];
const expectedLicenseSha256 =
  '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be';
const packageLicense = 'SEE LICENSE IN LICENSE';
const canonicalLicense = await readFile(resolve(root, '..', 'LICENSE'));
const canonicalLicenseSha256 = createHash('sha256')
  .update(canonicalLicense)
  .digest('hex');
if (canonicalLicenseSha256 !== expectedLicenseSha256) {
  throw new Error(
    `root LICENSE has sha256 ${canonicalLicenseSha256}, expected ${expectedLicenseSha256}`,
  );
}
const archiveRoot = await mkdtemp(resolve(tmpdir(), 'meta-sam-pack-audit-'));
const forbiddenContent = [
  { label: 'absolute home path', pattern: /(?:\/home\/|\/Users\/|[A-Za-z]:\\)/ },
  { label: 'temporary path', pattern: /\/tmp\// },
  {
    label: 'internal hostname',
    pattern: /(?:internalfb\.com|internalmeta\.com|facebook\.com)/i,
  },
  { label: 'source map metadata', pattern: /sourceMappingURL=/ },
  {
    label: 'pre-release status wording',
    pattern:
      /(?:package|packages) (?:is|are) (?:currently )?private|not been approved for publication/i,
  },
  { label: 'private key', pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    label: 'credential assignment',
    pattern: /(?:api[_-]?key|access[_-]?token)\s*[:=]/i,
  },
];

try {
  for (const directory of packages) {
    const packageRoot = resolve(root, 'packages', directory);
    const manifest = JSON.parse(
      await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
    );
    if (manifest.private === true || manifest.license !== packageLicense) {
      throw new Error(
        `${manifest.name} must be publishable and declare ${JSON.stringify(packageLicense)}`,
      );
    }
    const sourceLicense = await readFile(resolve(packageRoot, 'LICENSE'));
    if (!sourceLicense.equals(canonicalLicense)) {
      throw new Error(
        `${manifest.name} LICENSE differs from the approved root LICENSE`,
      );
    }
    if (manifest.scripts?.prepack !== 'tsc -b --force') {
      throw new Error(`${manifest.name} must build through prepack`);
    }

    // Prove a direct pack rebuilds its output rather than relying on stale dist files.
    await rm(resolve(packageRoot, 'dist'), { force: true, recursive: true });
    const result = spawnSync(
      'npm',
      [
        'pack',
        '--json',
        '--pack-destination',
        archiveRoot,
        '--workspace',
        manifest.name,
      ],
      { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 },
    );
    if (result.status !== 0) {
      throw new Error(
        `direct npm pack failed for ${manifest.name}:\n${result.stdout}${result.stderr}`,
      );
    }
    const report = JSON.parse(result.stdout)[0];
    const archive = resolve(archiveRoot, basename(report.filename));
    const files = report.files.map((file) => file.path).sort();
    for (const required of ['package.json', 'README.md', 'LICENSE']) {
      if (!files.includes(required)) {
        throw new Error(`${manifest.name} is missing packed ${required}`);
      }
    }
    const unexpected = files.filter(
      (file) =>
        file !== 'package.json' &&
        file !== 'README.md' &&
        file !== 'LICENSE' &&
        !file.startsWith('dist/'),
    );
    if (unexpected.length > 0) {
      throw new Error(
        `${manifest.name} contains unexpected files: ${unexpected.join(', ')}`,
      );
    }
    for (const target of [manifest.types, manifest.exports['.'].import]) {
      const packedPath = target.replace(/^\.\//, '');
      if (!files.includes(packedPath)) {
        throw new Error(`${manifest.name} is missing exported file ${packedPath}`);
      }
    }
    const sourceMaps = files.filter((file) => file.endsWith('.map'));
    if (sourceMaps.length > 0) {
      throw new Error(
        `${manifest.name} contains source maps: ${sourceMaps.join(', ')}`,
      );
    }
    if (manifest.sideEffects !== false) {
      throw new Error(`${manifest.name} must declare sideEffects: false`);
    }

    for (const file of files) {
      const extracted = spawnSync('tar', ['-xOf', archive, `package/${file}`], {
        encoding: null,
        maxBuffer: 20_000_000,
      });
      if (extracted.status !== 0) {
        throw new Error(`could not inspect ${manifest.name}/${file}`);
      }
      if (file === 'LICENSE' && !extracted.stdout.equals(canonicalLicense)) {
        throw new Error(`${manifest.name} archive contains different license bytes`);
      }
      if (file === 'package.json') {
        const packedManifest = JSON.parse(extracted.stdout.toString('utf8'));
        if (packedManifest.license !== packageLicense) {
          throw new Error(
            `${manifest.name} archive contains a stale license declaration`,
          );
        }
      }
      const content = extracted.stdout.toString('utf8');
      for (const forbidden of forbiddenContent) {
        if (forbidden.pattern.test(content)) {
          throw new Error(`${manifest.name}/${file} contains ${forbidden.label}`);
        }
      }
    }
    process.stdout.write(`${manifest.name}: ${files.length} audited files\n`);
  }
} finally {
  await rm(archiveRoot, { force: true, recursive: true });
}
