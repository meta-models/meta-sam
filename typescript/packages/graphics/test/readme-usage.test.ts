/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  RendererDisposedError,
  SegmentationRenderer,
  type SegmentationRenderOptions,
  type VideoFrameCompositionOptions,
} from '@meta-sam/graphics';
import {
  parseImageStream,
  type ImageSegmentationResult,
  type ResponsesEvent,
  type VideoSegmentationResult,
} from '@meta-sam/parser';

class MockPath2D {
  static instances: MockPath2D[] = [];

  readonly rectangles: number[][] = [];

  constructor(readonly source?: string) {
    MockPath2D.instances.push(this);
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.rectangles.push([x, y, width, height]);
  }
}

type CanvasCall = {
  readonly name: string;
  readonly args: readonly unknown[];
};

function createContext(calls: CanvasCall[]): CanvasRenderingContext2D {
  return {
    fillStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '',
    save() {
      calls.push({ name: 'save', args: [] });
    },
    restore() {
      calls.push({ name: 'restore', args: [] });
    },
    setTransform(...args: [number, number, number, number, number, number]) {
      calls.push({ name: 'setTransform', args });
    },
    clearRect(left: number, top: number, width: number, height: number) {
      calls.push({ name: 'clearRect', args: [left, top, width, height] });
    },
    drawImage(...args: unknown[]) {
      calls.push({ name: 'drawImage', args });
    },
    clip(path: Path2D) {
      calls.push({ name: 'clip', args: [path] });
    },
    transform(...args: [number, number, number, number, number, number]) {
      calls.push({ name: 'transform', args });
    },
    translate(x: number, y: number) {
      calls.push({ name: 'translate', args: [x, y] });
    },
    scale(x: number, y: number) {
      calls.push({ name: 'scale', args: [x, y] });
    },
    fill(path: Path2D, fillRule: CanvasFillRule) {
      calls.push({ name: 'fill', args: [path, fillRule] });
    },
    stroke(path: Path2D) {
      calls.push({ name: 'stroke', args: [path] });
    },
    strokeRect(left: number, top: number, width: number, height: number) {
      calls.push({ name: 'strokeRect', args: [left, top, width, height] });
    },
  } as unknown as CanvasRenderingContext2D;
}

const result: ImageSegmentationResult = {
  media: 'image',
  revision: 1,
  records: [
    {
      kind: 'mask',
      order: 0,
      objectId: 'bus',
      identity: 'image:*:bus',
      revision: 1,
      mask: {
        encoding: 'one_bit',
        width: 5,
        height: 5,
        payload: '!!!!!(QO(0lu8?',
      },
      bounds: { left: 0, top: 0, right: 5, bottom: 5 },
    },
    {
      kind: 'box',
      order: 1,
      objectId: 'bus',
      left: 1,
      top: 1,
      right: 4,
      bottom: 4,
    },
  ],
  diagnostics: [],
  rawOutput: '',
  outcome: { status: 'completed' },
};

const videoResult: VideoSegmentationResult = {
  ...result,
  media: 'video',
};

const compositionOptions: VideoFrameCompositionOptions = {
  fit: 'contain',
  devicePixelRatio: 2,
  hiddenIds: new Set(),
};

const renderOptions: SegmentationRenderOptions = {
  media: 'image',
  source: { x: 1, y: 1, width: 4, height: 4 },
  target: { x: 10, y: 20, width: 200, height: 100 },
};

// The README quick-start input: one SAM API record in a 320×334 image.
const readmeOutputText =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";

async function* readmeEvents(): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: 'message-1', output_index: 0, content_index: 0 };
  yield { type: 'response.output_text.delta', ...lane, delta: readmeOutputText };
  yield { type: 'response.output_text.done', ...lane, text: readmeOutputText };
  yield { type: 'response.completed' };
}

describe('README usage', () => {
  it('installs every package imported by the checked examples', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(
      'npm install @meta-sam/graphics @meta-sam/parser @meta-sam/video',
    );
    expect(readme).toContain(
      "'<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +",
    );
  });

  it('places a parsed SAM API mask at its box inside the source frame', async () => {
    Object.defineProperty(globalThis, 'Path2D', {
      configurable: true,
      writable: true,
      value: MockPath2D,
    });
    MockPath2D.instances = [];

    const parsed = await parseImageStream(readmeEvents()).finalResult;
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.records.map((record) => record.kind)).toEqual(['box', 'mask']);

    const calls: CanvasCall[] = [];
    const context = createContext(calls);
    const renderer = new SegmentationRenderer();
    await renderer.update(parsed);
    renderer.render(context, {
      media: 'image',
      source: { x: 0, y: 0, width: 320, height: 334 },
      target: { x: 0, y: 0, width: 640, height: 668 },
    });

    // Source → target is a uniform 2× scale here.
    expect(calls.find(({ name }) => name === 'transform')?.args).toEqual([
      2, 0, 0, 2, 0, 0,
    ]);
    // The 60×27 raster is scaled into the 60×27 half-open box at (211, 228).
    const translate = calls.find(({ name }) => name === 'translate');
    const scale = calls.find(({ name }) => name === 'scale');
    expect(translate?.args).toEqual([211, 228]);
    expect(scale?.args).toEqual([1, 1]);
    // The box is stroked in source pixels at the normalized half-open bounds.
    expect(calls.find(({ name }) => name === 'strokeRect')?.args).toEqual([
      211, 228, 60, 27,
    ]);
    expect(calls.map(({ name }) => name)).toContain('fill');
    renderer.dispose();
  });

  it('renders a complete parser result through the package-root API', async () => {
    Object.defineProperty(globalThis, 'Path2D', {
      configurable: true,
      writable: true,
      value: MockPath2D,
    });
    MockPath2D.instances = [];

    const calls: CanvasCall[] = [];
    const context = createContext(calls);
    const renderer = new SegmentationRenderer();

    await renderer.update(result);
    expect(MockPath2D.instances).toEqual([]);

    renderer.render(context, { ...renderOptions, hiddenIds: ['bus'] });
    expect(calls.map(({ name }) => name)).not.toContain('fill');
    expect(calls.map(({ name }) => name)).not.toContain('strokeRect');
    expect(MockPath2D.instances).toHaveLength(1);

    calls.length = 0;
    MockPath2D.instances = [];
    renderer.render(context, renderOptions);

    expect(MockPath2D.instances).toHaveLength(2);
    expect(MockPath2D.instances[0]?.rectangles).toEqual([[10, 20, 200, 100]]);
    // One smoothed marching-squares contour drives both fill and stroke.
    expect(MockPath2D.instances[1]?.source).toBe(
      'M0 0.5L0.5 0L1 0.5L0.5 1Z' +
        'M3.8 0.3Q4 0.5 4 1Q4 1.5 3.8 1.8Q3.5 2 3 2Q2.5 2 2.3 1.8Q2 1.5 2.8 0.8Q3.5 0 3.8 0.3Z' +
        'M0.3 3.3Q0.5 3 0.8 3.3Q1 3.5 1 4Q1 4.5 0.8 4.8Q0.5 5 0.3 4.8Q0 4.5 0 4Q0 3.5 0.3 3.3Z' +
        'M2.3 3.3Q2.5 3 3.5 3Q4.5 3 4.8 3.3Q5 3.5 5 4Q5 4.5 4.8 4.8Q4.5 5 4 4.5Q3.5 4 3 4Q2.5 4 2.3 3.8Q2 3.5 2.3 3.3Z',
    );
    expect(MockPath2D.instances[1]?.source).not.toContain('v1h-');
    expect(calls.findIndex(({ name }) => name === 'fill')).toBeLessThan(
      calls.findIndex(({ name }) => name === 'stroke'),
    );
    expect(calls.find(({ name }) => name === 'transform')?.args).toEqual([
      50, 0, 0, 25, -40, -5,
    ]);
    expect(calls.findIndex(({ name }) => name === 'fill')).toBeLessThan(
      calls.findIndex(({ name }) => name === 'strokeRect'),
    );

    calls.length = 0;
    MockPath2D.instances = [];
    renderer.clear();
    renderer.render(context, renderOptions);
    expect(calls).toEqual([]);
    expect(MockPath2D.instances).toEqual([]);

    await renderer.update(videoResult, { reset: true });
    calls.length = 0;
    MockPath2D.instances = [];
    const composed = renderer.renderVideoFrame(
      {
        frame: { width: 96, height: 64 } as CanvasImageSource & {
          readonly width: number;
          readonly height: number;
        },
        frameIndex: 0,
        canvas: { width: 400, height: 200 },
        ctx: context,
        signal: new AbortController().signal,
      },
      compositionOptions,
    );
    expect(composed).toBe(true);
    expect(calls.find(({ name }) => name === 'setTransform')?.args).toEqual([
      2, 0, 0, 2, 0, 0,
    ]);
    expect(calls.find(({ name }) => name === 'drawImage')?.args.slice(5)).toEqual([
      25, 0, 150, 100,
    ]);
    expect(calls.findIndex(({ name }) => name === 'drawImage')).toBeLessThan(
      calls.findIndex(({ name }) => name === 'fill'),
    );

    renderer.dispose();
    expect(() => renderer.render(context, renderOptions)).toThrow(
      RendererDisposedError,
    );
    await expect(renderer.update(result)).rejects.toBeInstanceOf(RendererDisposedError);
  });
});
