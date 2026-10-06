/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { createCodeExamples, inferMediaMimeType } from '../src/code-examples';

const image = {
  endpointOrigin: 'https://sam.example.test',
  model: 'sam-3.1',
  prompt: '  duck  ',
  mediaKind: 'image' as const,
  filename: 'truck.jpg',
  mimeType: 'image/jpeg',
};
const video = {
  endpointOrigin: 'https://sam.example.test',
  model: 'zeta-model',
  prompt: 'pillow',
  mediaKind: 'video' as const,
  filename: 'bedroom.mp4',
  mimeType: 'video/mp4',
};

describe('code examples', () => {
  it('pins the exact image examples', () => {
    expect(createCodeExamples(image)).toMatchSnapshot();
  });

  it('pins the exact video examples with a placeholder handle', () => {
    expect(createCodeExamples(video)).toMatchSnapshot();
  });

  it('pins the exact video examples with a known handle', () => {
    const examples = createCodeExamples({ ...video, fileId: 'file-safe_123' });
    expect(examples).toMatchSnapshot();
    expect(examples.curl).not.toContain('<file-id from step 1>');
    expect(examples.typescript).not.toContain('upload.append');
  });

  it('adds a score threshold to image examples as string metadata', () => {
    const examples = createCodeExamples({ ...image, scoreThreshold: 0.35 });
    for (const source of [examples.curl, examples.typescript]) {
      expect(source).toContain('"metadata": {');
      expect(source).toContain('"score_threshold": "0.35"');
    }
    const unset = createCodeExamples({ ...image, scoreThreshold: null });
    expect(unset).toEqual(createCodeExamples(image));
    expect(unset.curl).not.toContain('score_threshold');
  });

  it('asks for confidence in image and video examples only when set', () => {
    const imageExamples = createCodeExamples({
      ...image,
      scoreThreshold: 0.35,
      includeConfidence: true,
    });
    const videoExamples = createCodeExamples({ ...video, includeConfidence: true });
    for (const source of [
      imageExamples.curl,
      imageExamples.typescript,
      videoExamples.curl,
      videoExamples.typescript,
    ]) {
      expect(source).toContain('"include_confidence": "true"');
    }
    expect(imageExamples.curl).toContain('"score_threshold": "0.35"');
    expect(videoExamples.curl).not.toContain('score_threshold');
    expect(createCodeExamples({ ...video, includeConfidence: false })).toEqual(
      createCodeExamples(video),
    );
    expect(createCodeExamples({ ...image, includeConfidence: null })).toEqual(
      createCodeExamples(image),
    );
  });

  it('uses the published package names and real parser APIs', () => {
    for (const example of [createCodeExamples(image), createCodeExamples(video)]) {
      expect(example.typescript).toContain("from '@meta-sam/parser'");
      expect(example.typescript).toContain("from '@meta-sam/graphics'");
      // Every bare specifier in the example must be a published package name
      // (or a Node builtin) so the snippet runs as pasted.
      const specifiers = [...example.typescript.matchAll(/from '([^']+)'/g)].map(
        (m) => m[1],
      );
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier).toMatch(/^(node:|@meta-sam\/(parser|graphics|video|react)$)/);
      }
      expect(example.typescript).toContain('parseResponsesStream');
      expect(example.typescript).toContain('new SegmentationRenderer()');
    }
    expect(createCodeExamples(image).typescript).toContain(
      'formats.segmentation.image()',
    );
    expect(createCodeExamples(video).typescript).toContain(
      'formats.segmentation.video()',
    );
  });

  it('emits executable shell and coherent Node TypeScript', () => {
    const imageExamples = createCodeExamples(image);
    expect(imageExamples.curl).toContain(
      "IMAGE_BASE64=$(base64 -i truck.jpg | tr -d '\\n')",
    );
    expect(imageExamples.curl).toContain('<<EOF');
    expect(imageExamples.curl).not.toContain("<<'EOF'");
    expect(imageExamples.curl).toContain('data:image/jpeg;base64,$IMAGE_BASE64');
    const shellSensitive = createCodeExamples({
      ...image,
      prompt: 'duck $(touch nope) `touch nope` \\ dollar $HOME',
    }).curl;
    expect(shellSensitive).toContain('duck \\$(touch nope) \\`touch nope\\`');
    expect(shellSensitive).toContain('dollar \\$HOME');
    expect(imageExamples.typescript).toContain("from 'node:fs/promises'");
    expect(imageExamples.typescript).not.toContain('FileReader');

    const pendingVideo = createCodeExamples(video).typescript;
    expect(pendingVideo).toContain('new Blob([new Uint8Array(videoBytes)]');
    expect(pendingVideo).toContain('pendingCarriageReturn');
    expect(pendingVideo).toContain('const finalEvent = eventFromBlock(buffer)');

    const knownVideo = createCodeExamples({
      ...video,
      fileId: 'file-safe_123',
    }).typescript;
    expect(knownVideo).not.toContain("from 'node:fs/promises'");

    for (const source of [imageExamples.typescript, pendingVideo, knownVideo]) {
      const result = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      expect(result.diagnostics ?? []).toEqual([]);
    }
  });

  it('never includes credential values or unsupported request fields', () => {
    for (const example of [createCodeExamples(image), createCodeExamples(video)]) {
      const combined = `${example.curl}\n${example.typescript}`;
      expect(combined).toContain('SAM_API_KEY');
      expect(combined).not.toContain('secret-value');
      expect(example.curl).not.toMatch(
        /instructions|temperature|max_output_tokens|metadata/,
      );
    }
  });

  it('falls back to the documented origin and infers media types', () => {
    expect(createCodeExamples({ ...image, endpointOrigin: null }).curl).toContain(
      'https://api.meta.ai/v1/responses',
    );
    expect(inferMediaMimeType('photo.PNG', 'image')).toBe('image/png');
    expect(inferMediaMimeType('fixture.svg', 'image')).toBe('image/svg+xml');
    expect(inferMediaMimeType('clip.mov', 'video')).toBe('video/quicktime');
    expect(inferMediaMimeType('unknown', 'image')).toBe('image/jpeg');
  });
});
