/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const pathFfmpeg = process.env.MEDIA_FIXTURE_FFMPEG ?? 'ffmpeg';
const pathFfprobe = process.env.MEDIA_FIXTURE_FFPROBE ?? 'ffprobe';
const independentFfmpeg =
  process.env.MEDIA_FIXTURE_INDEPENDENT_FFMPEG ??
  (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : pathFfmpeg);
const independentFfprobe =
  process.env.MEDIA_FIXTURE_INDEPENDENT_FFPROBE ??
  (existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : pathFfprobe);

function runClean(command, arguments_, fixture) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stderr.trim() !== '') {
    throw new Error(
      `${fixture}: ${command} validation failed (status ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

const independentFfmpegVersion = runClean(
  independentFfmpeg,
  ['-version'],
  'independent FFmpeg toolchain',
).split('\n')[0];
const independentFfprobeVersion = runClean(
  independentFfprobe,
  ['-version'],
  'independent ffprobe toolchain',
).split('\n')[0];
console.log(`Independent decode: ${independentFfmpegVersion}`);
console.log(`Independent probe: ${independentFfprobeVersion}`);

const manifest = JSON.parse(
  await readFile(path.join(fixtureDirectory, 'manifest.json')),
);
const checksumFile = await readFile(path.join(fixtureDirectory, 'SHA256SUMS'), 'utf8');
const expectedChecksumFile = `${manifest.fixtures
  .map(({ file, sha256 }) => `${sha256}  ${file}`)
  .join('\n')}\n`;

if (checksumFile !== expectedChecksumFile) {
  throw new Error('SHA256SUMS does not match manifest.json.');
}

const committedMedia = (await readdir(fixtureDirectory))
  .filter((file) => /\.(mp4|webm)$/.test(file))
  .sort();
const manifestedMedia = manifest.fixtures.map(({ file }) => file).sort();
if (JSON.stringify(committedMedia) !== JSON.stringify(manifestedMedia)) {
  throw new Error(
    `Fixture inventory mismatch: committed=${committedMedia.join(',')} manifest=${manifestedMedia.join(',')}`,
  );
}

for (const fixture of manifest.fixtures) {
  const fixturePath = path.join(fixtureDirectory, fixture.file);
  const bytes = await readFile(fixturePath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== fixture.bytes) {
    throw new Error(
      `${fixture.file}: expected ${fixture.bytes} bytes, got ${bytes.length}.`,
    );
  }
  if (hash !== fixture.sha256) {
    throw new Error(
      `${fixture.file}: expected SHA-256 ${fixture.sha256}, got ${hash}.`,
    );
  }

  const probeCommand = fixture.container === 'WebM' ? independentFfprobe : pathFfprobe;
  const decodeCommand = fixture.container === 'WebM' ? independentFfmpeg : pathFfmpeg;
  JSON.parse(
    runClean(
      probeCommand,
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fixturePath],
      fixture.file,
    ),
  );
  runClean(
    decodeCommand,
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      fixturePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-f',
      'null',
      '-',
    ],
    fixture.file,
  );

  const audio = fixture.expected.audio;
  if (fixture.container === 'WebM' && audio.codec === 'opus') {
    const timing = audio.timingSemantics;
    if (
      timing?.timestampNormalization !== 'codec-delay-to-zero' ||
      timing.terminalPacketDurationSource !== 'ffprobe-packet-duration' ||
      timing.terminalPacketDurationSeconds <= 0 ||
      timing.discardPaddingSamples !== 0 ||
      audio.durations.at(-1) !== 0
    ) {
      throw new Error(
        `${fixture.file}: invalid manifested WebM/Opus timing semantics.`,
      );
    }
  }
  console.log(`${fixture.file}: ${bytes.length} bytes ${hash}; probe/decode clean`);
}
