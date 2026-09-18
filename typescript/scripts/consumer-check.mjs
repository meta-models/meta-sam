/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const archiveRoot = resolve(root, '.packs');
const expectedLicenseSha256 =
  '4dea99bfaa016e21bc860d73f344236bd1e5c4977d1a9a8fd32f822b500ae1be';
const packageLicense = 'SEE LICENSE IN LICENSE';
const canonicalLicense = await readFile(resolve(root, '..', 'LICENSE'));
const canonicalLicenseSha256 = createHash('sha256')
  .update(canonicalLicense)
  .digest('hex');
if (canonicalLicenseSha256 !== expectedLicenseSha256) {
  throw new Error(`root LICENSE has unexpected sha256 ${canonicalLicenseSha256}`);
}
const packageNames = [
  '@meta-sam/parser',
  '@meta-sam/graphics',
  '@meta-sam/video',
  '@meta-sam/react',
];

await rm(archiveRoot, { force: true, recursive: true });
await mkdir(archiveRoot, { recursive: true });
const archives = [];
for (const name of packageNames) {
  const packed = spawnSync(
    'npm',
    ['pack', '--json', '--pack-destination', archiveRoot, '--workspace', name],
    { cwd: root, encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    throw new Error(`npm pack failed for ${name}:\n${packed.stderr}`);
  }
  const report = JSON.parse(packed.stdout)[0];
  archives.push(resolve(archiveRoot, basename(report.filename)));
}

function archiveFile(archive, path) {
  const result = spawnSync('tar', ['-xOf', archive, `package/${path}`], {
    encoding: null,
    maxBuffer: 20_000_000,
  });
  if (result.status !== 0) {
    throw new Error(`could not inspect package/${path} in ${archive}`);
  }
  return result.stdout;
}

for (const archive of archives) {
  const license = archiveFile(archive, 'LICENSE');
  if (!license.equals(canonicalLicense)) {
    throw new Error(`${basename(archive)} contains different SAM License bytes`);
  }
  const manifest = JSON.parse(archiveFile(archive, 'package.json').toString('utf8'));
  if (manifest.license !== packageLicense) {
    throw new Error(
      `${manifest.name ?? basename(archive)} has a stale license declaration`,
    );
  }
}

const parserArchive = archives.find((archive) =>
  basename(archive).startsWith('meta-sam-parser-'),
);
if (parserArchive === undefined) throw new Error('parser archive was not produced');
const parserConsumer = await mkdtemp(resolve(tmpdir(), 'meta-sam-parser-consumer-'));
try {
  await writeFile(
    resolve(parserConsumer, 'package.json'),
    JSON.stringify({ name: 'parser-consumer-check', private: true, type: 'module' }),
  );
  const installed = spawnSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      parserArchive,
      'typescript@5.9.3',
    ],
    { cwd: parserConsumer, encoding: 'utf8' },
  );
  if (installed.status !== 0) {
    throw new Error(`parser-only consumer install failed:\n${installed.stderr}`);
  }
  await writeFile(
    resolve(parserConsumer, 'typecheck.ts'),
    [
      "import { decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath, formats, type RLEObject, type SegmentationMask } from '@meta-sam/parser';",
      'declare const mask: SegmentationMask;',
      'const raster: Uint8Array = decodeMaskToRaster(mask);',
      'const rle: RLEObject = decodeMaskToRLE(mask);',
      'const svgPath: string = decodeMaskToSVGPath(mask);',
      'void formats.segmentation.image();',
      'void raster; void rle; void svgPath;',
    ].join('\n'),
  );
  await writeFile(
    resolve(parserConsumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['typecheck.ts'],
    }),
  );
  const checked = spawnSync(
    process.execPath,
    [resolve(parserConsumer, 'node_modules/typescript/bin/tsc')],
    { cwd: parserConsumer, encoding: 'utf8' },
  );
  if (checked.status !== 0) {
    throw new Error(
      `parser-only declaration typecheck failed:\n${checked.stdout}${checked.stderr}`,
    );
  }
} finally {
  await rm(parserConsumer, { force: true, recursive: true });
}

const consumer = await mkdtemp(resolve(tmpdir(), 'meta-sam-consumer-'));
try {
  await writeFile(
    resolve(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer-check', private: true, type: 'module' }),
  );
  const installed = spawnSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      ...archives,
      'openai@7.10.0',
      'react@19.1.1',
      'react-dom@19.1.1',
      '@types/react@19.1.12',
      '@types/react-dom@19.1.9',
      'typescript@5.9.3',
    ],
    { cwd: consumer, encoding: 'utf8' },
  );
  if (installed.status !== 0) {
    throw new Error(`clean consumer install failed:\n${installed.stderr}`);
  }
  const entry = resolve(consumer, 'entry.mjs');
  await writeFile(
    entry,
    [
      "import { decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath, formats } from '@meta-sam/parser';",
      "import { SegmentationRenderer } from '@meta-sam/graphics';",
      "import { MediaPlayer, createMediaPlayer } from '@meta-sam/video';",
      "import { Video, useMediaPlayer } from '@meta-sam/react';",
      "const mask = { encoding: 'one_bit', payload: '!!!!!(QO(0lu8?', width: 5, height: 5 };",
      "if (decodeMaskToRaster(mask).join('') !== '1001000110000001011110001') throw new Error('wrong raster');",
      "if (decodeMaskToRLE(mask).counts !== '01214OK0010O31') throw new Error('wrong RLE');",
      "if (!decodeMaskToSVGPath(mask).startsWith('M-0.5 0L0 -0.5')) throw new Error('wrong SVG path');",
      "if (!formats.segmentation || !SegmentationRenderer || typeof SegmentationRenderer.prototype.renderVideoFrame !== 'function' || !MediaPlayer || !createMediaPlayer || !Video || !useMediaPlayer) throw new Error('missing export');",
    ].join('\n'),
  );
  const imported = spawnSync(process.execPath, [entry], {
    cwd: consumer,
    encoding: 'utf8',
  });
  if (imported.status !== 0) {
    throw new Error(`clean ESM import failed:\n${imported.stderr}`);
  }
  const typecheckEntry = resolve(consumer, 'typecheck.ts');
  await writeFile(
    typecheckEntry,
    [
      "import OpenAI from 'openai';",
      "import { decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath, formats, parseResponsesStream, type RLEObject, type SegmentationMask } from '@meta-sam/parser';",
      "import { SegmentationRenderer, type MaskOutlineOptions, type SegmentationRendererOptions, type SegmentationRenderOptions, type VideoFrameCompositionOptions } from '@meta-sam/graphics';",
      "import { MediaPlayer, createMediaPlayer, type IMediaPlayer, type MediaPlayerAudioStatus, type MediaPlayerOptions, type MediaPlayerRenderContext, type VideoPacketMetadata } from '@meta-sam/video';",
      "import { Video, useMediaPlayer, type UseMediaPlayerOptions, type VideoProps, type VideoRef, type VideoStats } from '@meta-sam/react';",
      'declare const client: OpenAI;',
      'declare const renderer: SegmentationRenderer;',
      'declare const renderOptions: SegmentationRenderOptions;',
      'declare const compositionOptions: VideoFrameCompositionOptions;',
      'declare const mediaRenderContext: MediaPlayerRenderContext;',
      'declare const packet: VideoPacketMetadata;',
      'declare const mediaPlayer: IMediaPlayer;',
      'declare const concreteMediaPlayer: MediaPlayer;',
      'declare const mediaCanvas: HTMLCanvasElement;',
      'declare const mediaPlayerOptions: MediaPlayerOptions;',
      'declare const audioStatus: MediaPlayerAudioStatus;',
      'declare const props: VideoProps;',
      'declare const videoRef: VideoRef;',
      'declare const videoStats: VideoStats;',
      'declare const hookOptions: UseMediaPlayerOptions;',
      'declare const mask: SegmentationMask;',
      'const maskOutlineOptions: MaskOutlineOptions = { width: 2, opacity: 0.5 };',
      'const rendererOptions: SegmentationRendererOptions = { maskFillOpacity: 0.6, maskOutline: maskOutlineOptions };',
      'const configuredRenderer = new SegmentationRenderer(rendererOptions);',
      'const raster: Uint8Array = decodeMaskToRaster(mask);',
      'const rle: RLEObject = decodeMaskToRLE(mask);',
      'const svgPath: string = decodeMaskToSVGPath(mask);',
      'async function check(): Promise<void> {',
      "  const source = await client.responses.create({ model: 'gpt-5', input: 'segment', stream: true });",
      '  const parsed = parseResponsesStream(source, formats.segmentation.video());',
      '  await parsed.finalResult;',
      '}',
      'void check;',
      'void renderer;',
      'void configuredRenderer;',
      'void renderOptions;',
      'void renderer.renderVideoFrame(mediaRenderContext, compositionOptions);',
      'void packet;',
      'void mediaPlayer;',
      'void concreteMediaPlayer;',
      'void createMediaPlayer(mediaCanvas, mediaPlayerOptions);',
      'void audioStatus;',
      'void props;',
      'void videoRef;',
      'void videoStats;',
      'void hookOptions;',
      'void raster;',
      'void rle;',
      'void svgPath;',
      'void useMediaPlayer;',
      'void Video;',
    ].join('\n'),
  );
  // Mediabunny's transitive WebCodecs declarations must remain compatible with
  // default type discovery; do not suppress ambient packages here.
  await writeFile(
    resolve(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      files: ['typecheck.ts'],
    }),
  );
  const checked = spawnSync(
    process.execPath,
    [resolve(consumer, 'node_modules/typescript/bin/tsc')],
    { cwd: consumer, encoding: 'utf8' },
  );
  if (checked.status !== 0) {
    throw new Error(
      `clean declaration typecheck failed:\n${checked.stdout}${checked.stderr}`,
    );
  }

  const bundleEntry = resolve(consumer, 'browser-entry.mjs');
  await writeFile(
    bundleEntry,
    [
      "export { decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath, formats, parseResponsesStream } from '@meta-sam/parser';",
      "export { SegmentationRenderer } from '@meta-sam/graphics';",
      "export { MediaPlayer, createMediaPlayer } from '@meta-sam/video';",
      "export { Video, useMediaPlayer } from '@meta-sam/react';",
    ].join('\n'),
  );
  await build({
    entryPoints: [bundleEntry],
    outfile: resolve(consumer, 'bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  const bundle = await readFile(resolve(consumer, 'bundle.js'), 'utf8');
  if (bundle.length === 0 || !bundle.includes('segmentation')) {
    throw new Error('browser bundle is empty or omits the parser');
  }
  process.stdout.write(
    'clean ESM imports, declaration typecheck, browser bundle, and SAM License audit passed\n',
  );
} finally {
  await rm(consumer, { force: true, recursive: true });
}
