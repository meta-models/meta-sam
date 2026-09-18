/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  objectColor,
  SegmentationRenderer,
  type SegmentationRenderOptions,
} from '../src/index.js';
import type { SegmentationMaskRecord, SegmentationSnapshot } from '@meta-sam/parser';

import { encodeSegmentationMask } from '../../parser/src/mask-codec.js';

const payload = '!!!!!(QO(0lu8?';
/**
 * The smoothed marching-squares contour of the 5×5 payload: one closed subpath
 * per eight-connected component. Vertices sit on the midpoints of the edges
 * between pixel centers, and each contour larger than four vertices is emitted
 * as a quadratic B-spline whose control points are those vertices.
 */
const expectedPath =
  'M0 0.5L0.5 0L1 0.5L0.5 1Z' +
  'M3.8 0.3Q4 0.5 4 1Q4 1.5 3.8 1.8Q3.5 2 3 2Q2.5 2 2.3 1.8Q2 1.5 2.8 0.8Q3.5 0 3.8 0.3Z' +
  'M0.3 3.3Q0.5 3 0.8 3.3Q1 3.5 1 4Q1 4.5 0.8 4.8Q0.5 5 0.3 4.8Q0 4.5 0 4Q0 3.5 0.3 3.3Z' +
  'M2.3 3.3Q2.5 3 3.5 3Q4.5 3 4.8 3.3Q5 3.5 5 4Q5 4.5 4.8 4.8Q4.5 5 4 4.5Q3.5 4 3 4Q2.5 4 2.3 3.8Q2 3.5 2.3 3.3Z';

class MockPath2D {
  static created: string[] = [];
  readonly rectangles: number[][] = [];
  public constructor(public readonly d = '') {
    if (d.length > 0) MockPath2D.created.push(d);
  }
  rect(...values: number[]): void {
    this.rectangles.push(values);
  }
}

/** Every traced path; the clip path is built empty and is not recorded. */
function tracedPaths(): string[] {
  return MockPath2D.created;
}

/**
 * The closed subpaths of a traced contour, as polygon vertex lists: the
 * control point of every `Q`, or the `M`/`L` points of a subpath small enough
 * to have been left straight.
 */
function polygons(d: string): Array<Array<[number, number]>> {
  return d
    .split('Z')
    .filter((part) => part.length > 0)
    .map((part) => {
      const curves = [...part.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)];
      const matches =
        curves.length > 0 ? curves : [...part.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
      return matches.map(
        (match) => [Number(match[1]), Number(match[2])] as [number, number],
      );
    });
}

function snapshot(
  records: SegmentationSnapshot['records'],
  media: 'image' | 'video' = 'image',
  revision = 0,
): SegmentationSnapshot {
  return Object.freeze({
    media,
    revision,
    records: Object.freeze(records),
    diagnostics: Object.freeze([]),
    rawOutput: '',
  }) as SegmentationSnapshot;
}

function mask(
  identity: string,
  objectId: string,
  revision = 1,
  order = 0,
  encodedPayload = payload,
) {
  return Object.freeze({
    kind: 'mask' as const,
    order,
    objectId,
    identity,
    revision,
    mask: Object.freeze({
      encoding: 'one_bit' as const,
      payload: encodedPayload,
      width: 5,
      height: 5,
    }),
    // Every API mask carries its box; the raster's own extent is the identity
    // placement the tests below assume unless they override it.
    bounds: Object.freeze({ left: 0, top: 0, right: 5, bottom: 5 }),
  });
}

function context() {
  const calls: Array<{ name: string; arguments: unknown[] }> = [];
  const strokes: Array<{
    path: MockPath2D;
    strokeStyle: string;
    globalAlpha: number;
    lineWidth: number;
    lineJoin: string;
    lineCap: string;
  }> = [];
  const fills: Array<{ path: MockPath2D; globalAlpha: number }> = [];
  const strokeRects: Array<{
    arguments: [number, number, number, number];
    globalAlpha: number;
  }> = [];
  const call =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, arguments: args });
    };
  const value = {
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    save: call('save'),
    restore: call('restore'),
    setTransform: call('setTransform'),
    clearRect: call('clearRect'),
    drawImage: call('drawImage'),
    beginPath: call('beginPath'),
    rect: call('rect'),
    clip: call('clip'),
    transform: call('transform'),
    translate: call('translate'),
    scale: call('scale'),
    fill: (path: MockPath2D, rule?: CanvasFillRule) => {
      calls.push({ name: 'fill', arguments: [path, rule] });
      fills.push({ path, globalAlpha: value.globalAlpha });
    },
    stroke: (path: MockPath2D) => {
      calls.push({ name: 'stroke', arguments: [path] });
      strokes.push({
        path,
        strokeStyle: value.strokeStyle,
        globalAlpha: value.globalAlpha,
        lineWidth: value.lineWidth,
        lineJoin: value.lineJoin,
        lineCap: value.lineCap,
      });
    },
    strokeRect: (left: number, top: number, width: number, height: number) => {
      const arguments_: [number, number, number, number] = [left, top, width, height];
      calls.push({ name: 'strokeRect', arguments: arguments_ });
      strokeRects.push({ arguments: arguments_, globalAlpha: value.globalAlpha });
    },
  };
  return {
    value: value as unknown as CanvasRenderingContext2D,
    calls,
    strokes,
    fills,
    strokeRects,
  };
}

const imageOptions: SegmentationRenderOptions = {
  media: 'image',
  source: { x: 0, y: 0, width: 5, height: 5 },
  target: { x: 0, y: 0, width: 50, height: 50 },
};

beforeEach(() => {
  MockPath2D.created = [];
  Object.defineProperty(globalThis, 'Path2D', {
    configurable: true,
    value: MockPath2D,
  });
});

describe('SegmentationRenderer', () => {
  it('traces one contour per mask lazily and draws masks before boxes', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(
      snapshot([
        mask('image:*:shape', 'shape'),
        Object.freeze({
          kind: 'box' as const,
          order: 1,
          objectId: 'shape',
          left: 0,
          top: 0,
          right: 5,
          bottom: 5,
        }),
      ]),
    );
    expect(MockPath2D.created).toEqual([]);
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(tracedPaths()).toEqual([expectedPath]);
    // Four eight-connected components in the raster, four closed contours.
    const contours = polygons(expectedPath);
    expect(contours).toHaveLength(4);
    for (const contour of contours) {
      for (const [x, y] of contour) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(5);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(5);
      }
    }
    expect(canvas.calls.findIndex((entry) => entry.name === 'fill')).toBeLessThan(
      canvas.calls.findIndex((entry) => entry.name === 'strokeRect'),
    );
    // One outer save/restore for the render, one inner pair placing the mask
    // raster at its bounds.
    expect(canvas.calls.filter((entry) => entry.name === 'save')).toHaveLength(2);
    expect(canvas.calls.filter((entry) => entry.name === 'restore')).toHaveLength(2);
    expect(canvas.calls.some((entry) => entry.name === 'beginPath')).toBe(false);
    expect(canvas.calls.some((entry) => entry.name === 'rect')).toBe(false);
    expect(canvas.calls.find((entry) => entry.name === 'fill')?.arguments[1]).toBe(
      'evenodd',
    );
    // One path serves both the fill and the contour stroke.
    expect(canvas.strokes[0]?.path).toBe(canvas.fills[0]?.path);
  });

  it('renders a canonical lossless mask through the shared decoder', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(
      snapshot([
        Object.freeze({
          ...mask(
            'image:*:lossless',
            'lossless',
            1,
            0,
            '~!!!!5!!SS2!]]5!!!!!!!!!!!!!!',
          ),
          mask: Object.freeze({
            encoding: 'lossless',
            payload: '~!!!!5!!SS2!]]5!!!!!!!!!!!!!!',
            width: 128,
            height: 128,
          }),
          bounds: Object.freeze({ left: 0, top: 0, right: 128, bottom: 128 }),
        }),
      ]),
    );
    const canvas = context();
    expect(() =>
      renderer.render(canvas.value, {
        media: 'image',
        source: { x: 0, y: 0, width: 128, height: 128 },
        target: { x: 0, y: 0, width: 128, height: 128 },
      }),
    ).not.toThrow();
  });

  it('places a box-local canonical mask inside its source-pixel bounds', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(
      snapshot([
        Object.freeze({
          ...mask('image:*:shape', 'shape'),
          bounds: Object.freeze({ left: 10, top: 20, right: 30, bottom: 50 }),
        }),
      ]),
    );
    const canvas = context();
    renderer.render(canvas.value, {
      media: 'image',
      source: { x: 0, y: 0, width: 100, height: 80 },
      target: { x: 0, y: 0, width: 100, height: 80 },
    });
    expect(canvas.calls.filter((entry) => entry.name === 'translate')).toEqual([
      { name: 'translate', arguments: [10, 20] },
    ]);
    expect(canvas.calls.filter((entry) => entry.name === 'scale')).toEqual([
      { name: 'scale', arguments: [4, 6] },
    ]);
    expect(canvas.calls.filter((entry) => entry.name === 'save')).toHaveLength(2);
    expect(canvas.calls.filter((entry) => entry.name === 'restore')).toHaveLength(2);
  });

  it('uses one clipped transform for masks and boxes with a non-zero source origin', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(
      snapshot([
        mask('image:*:shape', 'shape'),
        Object.freeze({
          kind: 'box' as const,
          order: 1,
          objectId: 'shape',
          left: 2,
          top: 3,
          right: 4,
          bottom: 5,
        }),
      ]),
    );
    const canvas = context();
    renderer.render(canvas.value, {
      media: 'image',
      source: { x: 1, y: 2, width: 5, height: 5 },
      target: { x: 10, y: 20, width: 50, height: 100 },
    });
    expect(canvas.calls.filter((entry) => entry.name === 'transform')).toEqual([
      { name: 'transform', arguments: [10, 0, 0, 20, 0, -20] },
    ]);
    const clipPath = canvas.calls.find((entry) => entry.name === 'clip')
      ?.arguments[0] as MockPath2D;
    expect(clipPath.rectangles).toEqual([[10, 20, 50, 100]]);
    expect(
      canvas.calls.find((entry) => entry.name === 'strokeRect')?.arguments,
    ).toEqual([2, 3, 2, 2]);

    const downscaled = context();
    renderer.render(downscaled.value, {
      media: 'image',
      source: { x: 0, y: 0, width: 1920, height: 1080 },
      target: { x: 0, y: 0, width: 640, height: 360 },
    });
    expect((downscaled.value as CanvasRenderingContext2D).lineWidth).toBeCloseTo(6);
  });

  it('validates render options before mutating canvas state', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('image:*:shape', 'shape')]));
    const canvas = context();
    expect(() =>
      renderer.render(canvas.value, {
        media: 'image',
        source: { x: 0, y: 0, width: 0, height: 5 },
        target: { x: 0, y: 0, width: 5, height: 5 },
      }),
    ).toThrow(/positive dimensions/);
    expect(() =>
      renderer.render(canvas.value, {
        media: 'image',
        source: { x: Number.MIN_VALUE, y: 0, width: Number.MIN_VALUE, height: 5 },
        target: { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 5 },
      }),
    ).toThrow(/numeric range/);
    expect(canvas.calls).toEqual([]);
  });

  it('rejects box dimensions that overflow before rendering', async () => {
    const renderer = new SegmentationRenderer();
    await expect(
      renderer.update(
        snapshot([
          Object.freeze({
            kind: 'box' as const,
            order: 0,
            objectId: 'wide',
            left: -Number.MAX_VALUE,
            top: 0,
            right: Number.MAX_VALUE,
            bottom: 1,
          }),
        ]),
      ),
    ).rejects.toMatchObject({ code: 'invalid_render_options' });
  });

  it('rolls back unsupported and equal-revision conflicts', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('image:*:kept', 'kept')]));
    const unsupported = Object.freeze({
      ...mask('image:*:bad', 'bad'),
      mask: Object.freeze({
        encoding: 'unknown' as unknown as 'one_bit',
        payload: 'x',
        width: 1,
        height: 1,
      }),
    });
    await expect(renderer.update(snapshot([unsupported]))).rejects.toMatchObject({
      code: 'unsupported_encoding',
    });
    const conflict = Object.freeze({
      ...mask('image:*:kept', 'kept'),
      objectId: 'changed',
    });
    await expect(renderer.update(snapshot([conflict]))).rejects.toMatchObject({
      code: 'invalid_mask_payload',
    });
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(canvas.calls.some((entry) => entry.name === 'fill')).toBe(true);
  });

  it('drops stale Path2D entries only after a successful reset commit', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('same', 'same', 1)]));
    renderer.render(context().value, imageOptions);
    const firstPath = tracedPaths()[0];

    await renderer.update(snapshot([mask('same', 'same', 1, 0, "!!!!!'y:0v[qU")]), {
      reset: true,
    });
    renderer.render(context().value, imageOptions);
    expect(tracedPaths()).toHaveLength(2);
    expect(tracedPaths()[1]).not.toBe(firstPath);

    const invalid = Object.freeze({
      ...mask('same', 'same', 1),
      mask: Object.freeze({
        encoding: 'unknown' as unknown as 'one_bit',
        payload: 'invalid',
        width: 5,
        height: 5,
      }),
    });
    await expect(
      renderer.update(snapshot([invalid]), { reset: true }),
    ).rejects.toMatchObject({ code: 'unsupported_encoding' });
    renderer.render(context().value, imageOptions);
    expect(tracedPaths()).toHaveLength(2);
  });

  it('does not reuse cached geometry across media changes', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('same', 'same', 1)], 'image'));
    renderer.render(context().value, imageOptions);
    await renderer.update(
      snapshot([mask('same', 'same', 1, 0, "!!!!!'y:0v[qU")], 'video'),
    );
    renderer.render(context().value, {
      media: 'video',
      frameIndex: 0,
      source: imageOptions.source,
      target: imageOptions.target,
    });
    expect(tracedPaths()).toHaveLength(2);
    expect(tracedPaths()[0]).not.toBe(tracedPaths()[1]);
  });

  it('retains known masks without their payload or traced path', async () => {
    const canonicalOverhead = JSON.stringify([
      'a',
      1,
      0,
      'a',
      null,
      'one_bit',
      5,
      5,
      payload,
    ]).length;
    // The old eager state charged canonical + traced characters per mask; the
    // retained state now holds identity plus a reference, so this commits.
    const renderer = new SegmentationRenderer({
      maxRetainedComplexity: expectedPath.length + canonicalOverhead - 1,
    });
    await expect(renderer.update(snapshot([mask('a', 'a')]))).resolves.toBeUndefined();
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(tracedPaths()).toEqual([expectedPath]);
  });

  it('bounds retained mask bookkeeping across frames', async () => {
    const renderer = new SegmentationRenderer({ maxRetainedComplexity: 100 });
    await expect(
      renderer.update(snapshot([mask('a', 'a'), mask('b', 'b')])),
    ).rejects.toMatchObject({
      code: 'resource_limit',
      limit: 'maxRetainedComplexity',
    });
  });

  it('includes retained box metadata in the aggregate bound', async () => {
    const renderer = new SegmentationRenderer({ maxRetainedComplexity: 10 });
    await expect(
      renderer.update(
        snapshot([
          Object.freeze({
            kind: 'box' as const,
            order: 0,
            objectId: 'box-with-metadata',
            left: 0,
            top: 0,
            right: 1,
            bottom: 1,
          }),
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'resource_limit',
      limit: 'maxRetainedComplexity',
    });
  });

  it('fences stale invalid work before expensive decoding after clear', async () => {
    const renderer = new SegmentationRenderer();
    const invalid = Object.freeze({
      ...mask('bad', 'bad'),
      mask: Object.freeze({
        encoding: 'unknown' as unknown as 'one_bit',
        payload: 'invalid',
        width: 5,
        height: 5,
      }),
    });
    const pending = renderer.update(snapshot([invalid]));
    renderer.clear();
    await expect(pending).resolves.toBeUndefined();
  });

  it('does not roll boxes back from an older cumulative snapshot', async () => {
    const newerBox = Object.freeze({
      kind: 'box' as const,
      order: 1,
      objectId: 'shape',
      left: 10,
      top: 10,
      right: 20,
      bottom: 20,
    });
    const olderBox = Object.freeze({
      ...newerBox,
      left: 1,
      top: 1,
      right: 2,
      bottom: 2,
    });
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('shape', 'shape', 2), newerBox], 'image', 2));
    await renderer.update(snapshot([mask('shape', 'shape', 1), olderBox], 'image', 1));
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(
      canvas.calls.find((entry) => entry.name === 'strokeRect')?.arguments,
    ).toEqual([10, 10, 10, 10]);
  });

  it('accepts forward cumulative boxes while retaining the newest mask', async () => {
    const firstBox = Object.freeze({
      kind: 'box' as const,
      order: 1,
      objectId: 'shape',
      left: 1,
      top: 1,
      right: 2,
      bottom: 2,
    });
    const nextBox = Object.freeze({
      ...firstBox,
      left: 10,
      top: 10,
      right: 20,
      bottom: 20,
    });
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('shape', 'shape', 1), firstBox], 'image', 1));
    await renderer.update(
      snapshot(
        [mask('shape', 'shape', 1), mask('shape', 'shape', 2, 2), nextBox],
        'image',
        2,
      ),
    );
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(
      canvas.calls.find((entry) => entry.name === 'strokeRect')?.arguments,
    ).toEqual([10, 10, 10, 10]);
  });

  it('ignores an older snapshot even when it omits the retained mask', async () => {
    const newerBox = Object.freeze({
      kind: 'box' as const,
      order: 1,
      objectId: 'shape',
      left: 10,
      top: 10,
      right: 20,
      bottom: 20,
    });
    const olderBox = Object.freeze({
      ...newerBox,
      left: 1,
      top: 1,
      right: 2,
      bottom: 2,
    });
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('shape', 'shape', 2), newerBox], 'image', 2));
    await renderer.update(snapshot([olderBox], 'image', 1));
    const canvas = context();
    renderer.render(canvas.value, imageOptions);
    expect(tracedPaths()).toHaveLength(1);
    expect(
      canvas.calls.find((entry) => entry.name === 'strokeRect')?.arguments,
    ).toEqual([10, 10, 10, 10]);
  });

  it('reconciles newer revisions, stale updates, removal, and reset', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('image:*:shape', 'shape', 2)]));
    renderer.render(context().value, imageOptions);
    await renderer.update(snapshot([mask('image:*:shape', 'shape', 1)]));
    renderer.render(context().value, imageOptions);
    expect(tracedPaths()).toHaveLength(1);

    await renderer.update(snapshot([]));
    const removed = context();
    renderer.render(removed.value, imageOptions);
    expect(removed.calls.some((entry) => entry.name === 'fill')).toBe(false);

    await renderer.update(snapshot([mask('image:*:shape', 'shape', 1)]), {
      reset: true,
    });
    renderer.clear();
    const cleared = context();
    renderer.render(cleared.value, imageOptions);
    expect(cleared.calls).toEqual([]);
  });

  it.each([
    ['maxRecords', { maxRecords: 1 }, [mask('a', 'a'), mask('b', 'b')]],
    ['maxMasks', { maxMasks: 1 }, [mask('a', 'a'), mask('b', 'b')]],
    [
      'maxBoxes',
      { maxBoxes: 1 },
      [
        Object.freeze({
          kind: 'box' as const,
          order: 0,
          objectId: 'a',
          left: 0,
          top: 0,
          right: 1,
          bottom: 1,
        }),
        Object.freeze({
          kind: 'box' as const,
          order: 1,
          objectId: 'b',
          left: 0,
          top: 0,
          right: 1,
          bottom: 1,
        }),
      ],
    ],
    ['maxMaskArea', { maxMaskArea: 24 }, [mask('a', 'a')]],
    ['maxMaskPayloadLength', { maxMaskPayloadLength: 5 }, [mask('a', 'a')]],
    [
      'maxRetainedComplexity',
      // Two masks charge identity plus per-mask bookkeeping; one fits, two do not.
      { maxRetainedComplexity: 100 },
      [mask('a', 'a'), mask('b', 'b')],
    ],
  ] as const)('enforces %s before commit', async (limit, options, records) => {
    const renderer = new SegmentationRenderer(options);
    await expect(renderer.update(snapshot(records))).rejects.toMatchObject({
      code: 'resource_limit',
      limit,
    });
    expect(MockPath2D.created).toEqual([]);
  });

  it('fences pending updates, evicts paths, and recreates from retained data', async () => {
    const renderer = new SegmentationRenderer({ maxCachedPaths: 1 });
    const pending = renderer.update(snapshot([mask('a', 'a')]));
    renderer.clear();
    await pending;
    await renderer.update(snapshot([mask('a', 'a'), mask('b', 'b')]));
    renderer.render(context().value, imageOptions);
    renderer.render(context().value, imageOptions);
    expect(tracedPaths()).toHaveLength(4);
  });

  it('composes the decoded frame before exact and global video records', async () => {
    const renderer = new SegmentationRenderer({
      maskFillOpacity: 0.6,
      maskOutline: { opacity: 0.5 },
    });
    await renderer.update(
      snapshot(
        [
          Object.freeze({
            ...mask('video:1:subject', 'subject'),
            frame: Object.freeze({ frameIndex: 1 }),
          }),
          Object.freeze({
            kind: 'box' as const,
            order: 1,
            objectId: 'global',
            left: 4,
            top: 4,
            right: 12,
            bottom: 12,
          }),
          Object.freeze({
            kind: 'box' as const,
            order: 2,
            objectId: 'subject',
            frame: Object.freeze({ frameIndex: 1 }),
            left: 24,
            top: 16,
            right: 72,
            bottom: 48,
          }),
        ],
        'video',
        1,
      ),
    );
    const canvas = context();
    const fallback = context();
    const frame = { width: 96, height: 64 } as CanvasImageSource & {
      readonly width: number;
      readonly height: number;
    };

    expect(
      renderer.renderVideoFrame(
        {
          frame,
          frameIndex: 1,
          canvas: { width: 202, height: 150 },
          ctx: canvas.value,
          fallbackCanvas: { width: 202, height: 150 },
          fallbackCtx: fallback.value as unknown as OffscreenCanvasRenderingContext2D,
          signal: new AbortController().signal,
        },
        { fit: 'contain', devicePixelRatio: 2 },
      ),
    ).toBe(true);
    expect(canvas.fills[0]?.globalAlpha).toBe(0.6);
    expect(canvas.strokes[0]?.globalAlpha).toBe(0.5);

    const draw = canvas.calls.find((entry) => entry.name === 'drawImage');
    expect(
      canvas.calls.find((entry) => entry.name === 'setTransform')?.arguments,
    ).toEqual([2, 0, 0, 2, 0, 0]);
    expect(canvas.calls.find((entry) => entry.name === 'clearRect')?.arguments).toEqual(
      [0, 0, 101, 75],
    );
    expect(draw?.arguments.slice(0, 5)).toEqual([frame, 0, 0, 96, 64]);
    expect(draw?.arguments[5]).toBeCloseTo(0);
    expect(draw?.arguments[6]).toBeCloseTo(23 / 6);
    expect(draw?.arguments[7]).toBeCloseTo(101);
    expect(draw?.arguments[8]).toBeCloseTo(202 / 3);
    const fallbackDraw = fallback.calls.find((entry) => entry.name === 'drawImage');
    expect(fallbackDraw?.arguments.slice(0, 5)).toEqual([frame, 0, 0, 96, 64]);
    for (let index = 5; index <= 8; index += 1) {
      expect(fallbackDraw?.arguments[index]).toBeCloseTo(
        draw?.arguments[index] as number,
      );
    }
    expect(fallback.calls.some((entry) => entry.name === 'fill')).toBe(false);
    expect(fallback.calls.some((entry) => entry.name === 'strokeRect')).toBe(false);
    expect(canvas.calls.findIndex((entry) => entry.name === 'drawImage')).toBeLessThan(
      canvas.calls.findIndex((entry) => entry.name === 'fill'),
    );
    expect(canvas.calls.filter((entry) => entry.name === 'strokeRect')).toEqual([
      { name: 'strokeRect', arguments: [4, 4, 8, 8] },
      { name: 'strokeRect', arguments: [24, 16, 48, 32] },
    ]);

    const otherFrame = context();
    renderer.renderVideoFrame({
      frame,
      frameIndex: 0,
      canvas: { width: 101, height: 75 },
      ctx: otherFrame.value,
      signal: new AbortController().signal,
    });
    expect(otherFrame.calls.some((entry) => entry.name === 'fill')).toBe(false);
    expect(otherFrame.calls.filter((entry) => entry.name === 'strokeRect')).toEqual([
      { name: 'strokeRect', arguments: [4, 4, 8, 8] },
    ]);

    const hidden = context();
    renderer.renderVideoFrame(
      {
        frame,
        frameIndex: 1,
        canvas: { width: 101, height: 75 },
        ctx: hidden.value,
        signal: new AbortController().signal,
      },
      { hiddenIds: ['global', 'subject'] },
    );
    expect(hidden.calls.some((entry) => entry.name === 'drawImage')).toBe(true);
    expect(hidden.calls.some((entry) => entry.name === 'fill')).toBe(false);
    expect(hidden.calls.some((entry) => entry.name === 'strokeRect')).toBe(false);
  });

  it.each([
    ['contain', [0, 23 / 6, 101, 202 / 3]],
    ['cover', [-23 / 4, 0, 225 / 2, 75]],
    ['fill', [0, 0, 101, 75]],
  ] as const)(
    'recomputes %s geometry from odd resized backing dimensions',
    (fit, expectedTarget) => {
      const renderer = new SegmentationRenderer();
      const canvas = context();
      const frame = { width: 96, height: 64 } as CanvasImageSource & {
        readonly width: number;
        readonly height: number;
      };
      const composition = {
        frame,
        frameIndex: 0,
        canvas: { width: 101, height: 75 },
        ctx: canvas.value,
        signal: new AbortController().signal,
      };

      renderer.renderVideoFrame(composition, { fit, devicePixelRatio: 1 });
      let draw = canvas.calls.find((entry) => entry.name === 'drawImage');
      expectedTarget.forEach((value, index) =>
        expect(draw?.arguments[index + 5]).toBeCloseTo(value),
      );

      canvas.calls.length = 0;
      renderer.renderVideoFrame(
        { ...composition, canvas: { width: 202, height: 150 } },
        { fit, devicePixelRatio: 2 },
      );
      draw = canvas.calls.find((entry) => entry.name === 'drawImage');
      expectedTarget.forEach((value, index) =>
        expect(draw?.arguments[index + 5]).toBeCloseTo(value),
      );
    },
  );

  it('does not touch the canvas for aborted or invalid compositions', () => {
    const renderer = new SegmentationRenderer();
    const canvas = context();
    const controller = new AbortController();
    controller.abort();
    const composition = {
      frame: { width: 96, height: 64 } as CanvasImageSource & {
        readonly width: number;
        readonly height: number;
      },
      frameIndex: 0,
      canvas: { width: 96, height: 64 },
      ctx: canvas.value,
      signal: controller.signal,
    };

    expect(renderer.renderVideoFrame(composition)).toBe(false);
    expect(canvas.calls).toEqual([]);

    const active = { ...composition, signal: new AbortController().signal };
    expect(() => renderer.renderVideoFrame(active, { devicePixelRatio: 0 })).toThrow(
      /devicePixelRatio/,
    );
    expect(canvas.calls).toEqual([]);
  });

  it('skips hidden IDs and fences disposal', async () => {
    const renderer = new SegmentationRenderer();
    await renderer.update(snapshot([mask('hidden', 'hidden')]));
    renderer.render(context().value, { ...imageOptions, hiddenIds: ['hidden'] });
    expect(MockPath2D.created).toEqual([]);
    renderer.dispose();
    renderer.dispose();
    await expect(renderer.update(snapshot([]))).rejects.toMatchObject({
      code: 'renderer_disposed',
    });
  });

  describe('mask contours', () => {
    const size = 10;

    function maskFromRaster(
      raster: Uint8Array,
      objectId = 'shape',
      dimension = size,
    ): SegmentationMaskRecord {
      return Object.freeze({
        kind: 'mask',
        order: 0,
        objectId,
        identity: `image:*:${objectId}`,
        revision: 1,
        mask: encodeSegmentationMask(raster, dimension, dimension),
        bounds: Object.freeze({ left: 0, top: 0, right: dimension, bottom: dimension }),
      }) as SegmentationMaskRecord;
    }

    function solidRaster(dimension = size): Uint8Array {
      return new Uint8Array(dimension * dimension).fill(1);
    }

    /** A square annulus: a filled border with a rectangular hole inside it. */
    function ringRaster(): Uint8Array {
      const raster = solidRaster();
      for (let y = 3; y < 7; y += 1) raster.fill(0, y * size + 3, y * size + 7);
      return raster;
    }

    function singlePixelRaster(): Uint8Array {
      const raster = new Uint8Array(size * size);
      raster[5 * size + 5] = 1;
      return raster;
    }

    const squareOptions: SegmentationRenderOptions = {
      media: 'image',
      source: { x: 0, y: 0, width: size, height: size },
      target: { x: 0, y: 0, width: size * 10, height: size * 10 },
    };

    it('fills and strokes one contour per visible mask in the object color', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(
        snapshot([
          maskFromRaster(solidRaster(), 'left'),
          mask('image:*:right', 'right'),
        ]),
      );
      const canvas = context();
      renderer.render(canvas.value, squareOptions);

      expect(canvas.fills).toHaveLength(2);
      expect(canvas.strokes).toHaveLength(2);
      expect(canvas.strokes.map((entry) => entry.strokeStyle)).toEqual([
        objectColor('left'),
        objectColor('right'),
      ]);
      for (const [index, entry] of canvas.strokes.entries()) {
        expect(entry.globalAlpha).toBe(0.8);
        expect(entry.lineJoin).toBe('round');
        expect(entry.lineCap).toBe('round');
        // 0.003 × the shorter source edge, in source pixels.
        expect(entry.lineWidth).toBeCloseTo(0.03);
        // The fill and the contour are the same path object.
        expect(entry.path).toBe(canvas.fills[index]?.path);
      }
      for (const entry of canvas.fills) expect(entry.globalAlpha).toBe(0.35);
      expect(canvas.calls.findIndex((entry) => entry.name === 'fill')).toBeLessThan(
        canvas.calls.findIndex((entry) => entry.name === 'stroke'),
      );
    });

    it.each([
      ['zero with default width', 0, 0, undefined, 0.03],
      ['fractional with default width', 0.6, 0.5, undefined, 0.03],
      ['one with default width', 1, 1, undefined, 0.03],
      ['zero with custom width', 0, 0, 3, 3],
      ['fractional with custom width', 0.6, 0.5, 3, 3],
      ['one with custom width', 1, 1, 3, 3],
    ] as const)(
      'uses %s fill and outline opacity',
      async (_name, fillOpacity, outlineOpacity, width, expectedWidth) => {
        const renderer = new SegmentationRenderer({
          maskFillOpacity: fillOpacity,
          maskOutline:
            width === undefined
              ? { opacity: outlineOpacity }
              : { width, opacity: outlineOpacity },
        });
        await renderer.update(snapshot([maskFromRaster(solidRaster())]));
        const canvas = context();
        renderer.render(canvas.value, squareOptions);

        expect(canvas.fills).toHaveLength(1);
        expect(canvas.fills[0]?.globalAlpha).toBe(fillOpacity);
        expect(canvas.strokes).toHaveLength(1);
        expect(canvas.strokes[0]?.globalAlpha).toBe(outlineOpacity);
        expect(canvas.strokes[0]?.lineWidth).toBeCloseTo(expectedWidth);
      },
    );

    it.each([
      -0.1,
      1.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '0.5',
      null,
      true,
      false,
    ])('rejects invalid fill and outline opacity %s', (opacity) => {
      expect(
        () => new SegmentationRenderer({ maskFillOpacity: opacity as number }),
      ).toThrow(TypeError);
      expect(
        () =>
          new SegmentationRenderer({
            maskOutline: { opacity: opacity as number },
          }),
      ).toThrow(TypeError);
    });

    it('resolves mutable opacity settings once in the constructor', async () => {
      const outline = { width: 3, opacity: 0.5 };
      const options = { maskFillOpacity: 0.6, maskOutline: outline };
      const renderer = new SegmentationRenderer(options);
      options.maskFillOpacity = 0;
      outline.width = 7;
      outline.opacity = 0;

      await renderer.update(snapshot([maskFromRaster(solidRaster())]));
      const canvas = context();
      renderer.render(canvas.value, squareOptions);

      expect(canvas.fills[0]?.globalAlpha).toBe(0.6);
      expect(canvas.strokes[0]?.globalAlpha).toBe(0.5);
      expect(canvas.strokes[0]?.lineWidth).toBe(3);
    });

    it('renders boxes at full opacity after custom mask alpha', async () => {
      const renderer = new SegmentationRenderer({
        maskFillOpacity: 0.6,
        maskOutline: { opacity: 0.5 },
      });
      await renderer.update(
        snapshot([
          maskFromRaster(solidRaster()),
          Object.freeze({
            kind: 'box' as const,
            order: 1,
            objectId: 'shape',
            left: 1,
            top: 1,
            right: 9,
            bottom: 9,
          }),
        ]),
      );
      const canvas = context();
      renderer.render(canvas.value, squareOptions);

      expect(canvas.fills[0]?.globalAlpha).toBe(0.6);
      expect(canvas.strokes[0]?.globalAlpha).toBe(0.5);
      expect(canvas.strokeRects).toEqual([{ arguments: [1, 1, 8, 8], globalAlpha: 1 }]);
    });

    it('traces a solid rectangle as one contour with a vertex per bevel', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(snapshot([maskFromRaster(solidRaster())]));
      renderer.render(context().value, squareOptions);

      const traced = tracedPaths()[0]!;
      expect(traced).toBe(
        'M0.3 0.3Q0.5 0 5 0Q9.5 0 9.8 0.3Q10 0.5 10 5Q10 9.5 9.8 9.8' +
          'Q9.5 10 5 10Q0.5 10 0.3 9.8Q0 9.5 0 5Q0 0.5 0.3 0.3Z',
      );
      const [contour] = polygons(traced);
      expect(polygons(traced)).toHaveLength(1);
      // Eight control vertices: the two ends of the half-pixel bevel at each
      // of the four corners, whatever the row count is — the sides carry none
      // and the old per-row fill path had one command per row.
      expect(contour).toHaveLength(8);

      MockPath2D.created = [];
      const taller = new SegmentationRenderer();
      await taller.update(snapshot([maskFromRaster(solidRaster(40), 'shape', 40)]));
      taller.render(context().value, {
        media: 'image',
        source: { x: 0, y: 0, width: 40, height: 40 },
        target: { x: 0, y: 0, width: 400, height: 400 },
      });
      expect(polygons(tracedPaths()[0]!)[0]).toHaveLength(8);
    });

    it('traces both contours of a hollow mask and fills them with evenodd', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(snapshot([maskFromRaster(ringRaster())]));
      const canvas = context();
      renderer.render(canvas.value, squareOptions);

      const traced = tracedPaths()[0]!;
      expect(polygons(traced)).toHaveLength(2);
      expect(traced).toBe(
        'M0.3 0.3Q0.5 0 5 0Q9.5 0 9.8 0.3Q10 0.5 10 5Q10 9.5 9.8 9.8' +
          'Q9.5 10 5 10Q0.5 10 0.3 9.8Q0 9.5 0 5Q0 0.5 0.3 0.3Z' +
          'M3.3 3.3Q3 3.5 3 5Q3 6.5 3.3 6.8Q3.5 7 5 7Q6.5 7 6.8 6.8' +
          'Q7 6.5 7 5Q7 3.5 6.8 3.3Q6.5 3 5 3Q3.5 3 3.3 3.3Z',
      );
      expect(canvas.calls.find((entry) => entry.name === 'fill')?.arguments[1]).toBe(
        'evenodd',
      );
    });

    it('leaves a single pixel a straight half-pixel diamond', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(snapshot([maskFromRaster(singlePixelRaster())]));
      renderer.render(context().value, squareOptions);

      // Four vertices or fewer keep their straight segments, so a lone pixel
      // stays a full-width mark instead of being smoothed inward.
      const traced = tracedPaths()[0]!;
      expect(traced).toBe('M5 5.5L5.5 5L6 5.5L5.5 6Z');
      expect(polygons(traced)[0]).toHaveLength(4);
    });

    it('smooths a diagonal boundary into one line rather than a staircase', async () => {
      const raster = new Uint8Array(size * size);
      for (let y = 0; y < size; y += 1) raster.fill(1, y * size, y * size + y + 1);
      const renderer = new SegmentationRenderer();
      await renderer.update(snapshot([maskFromRaster(raster)]));
      renderer.render(context().value, squareOptions);

      const [contour] = polygons(tracedPaths()[0]!);
      // Six vertices for the whole triangle: the hypotenuse is one decimated
      // edge, so its curve is the straight line between two edge midpoints.
      expect(contour).toHaveLength(6);
      expect(tracedPaths()[0]!).toContain('Q0.5 0 5.3 4.8Q10 9.5 9.8 9.8');
    });

    it('places the contour inside box-local mask bounds', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(
        snapshot([
          Object.freeze({
            ...maskFromRaster(solidRaster()),
            bounds: Object.freeze({ left: 10, top: 20, right: 30, bottom: 50 }),
          }) as SegmentationMaskRecord,
        ]),
      );
      const canvas = context();
      renderer.render(canvas.value, {
        media: 'image',
        source: { x: 0, y: 0, width: 100, height: 80 },
        target: { x: 0, y: 0, width: 100, height: 80 },
      });

      expect(canvas.calls.filter((entry) => entry.name === 'scale')).toEqual([
        { name: 'scale', arguments: [2, 3] },
      ]);
      // 0.003 × 80 source pixels, under the mask's own 2×/3× bounds scale.
      expect(canvas.strokes[0]?.lineWidth).toBeCloseTo(0.08);
    });

    it('skips the contour for hidden objects', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(snapshot([maskFromRaster(solidRaster(), 'hidden')]));
      const canvas = context();
      renderer.render(canvas.value, { ...squareOptions, hiddenIds: ['hidden'] });
      expect(canvas.strokes).toEqual([]);
      expect(canvas.fills).toEqual([]);
      expect(MockPath2D.created).toEqual([]);
    });

    it('draws configured fill only when the outline is disabled', async () => {
      const renderer = new SegmentationRenderer({
        maskFillOpacity: 0.6,
        maskOutline: false,
      });
      await renderer.update(snapshot([maskFromRaster(solidRaster())]));
      const canvas = context();
      renderer.render(canvas.value, squareOptions);
      expect(canvas.fills).toEqual([
        { path: expect.any(MockPath2D), globalAlpha: 0.6 },
      ]);
      expect(canvas.strokes).toEqual([]);
      // The same contour still fills; nothing extra is traced for the stroke.
      expect(tracedPaths()).toHaveLength(1);
    });

    it.each([
      ['true', true, 0.03],
      ['an empty object', {}, 0.03],
      ['a width-only object', { width: 3 }, 3],
    ] as const)(
      'defaults contour opacity for %s',
      async (_name, maskOutline, expectedWidth) => {
        const renderer = new SegmentationRenderer({ maskOutline });
        await renderer.update(snapshot([maskFromRaster(solidRaster())]));
        const canvas = context();
        renderer.render(canvas.value, squareOptions);
        expect(canvas.strokes[0]?.globalAlpha).toBe(0.8);
        expect(canvas.strokes[0]?.lineWidth).toBeCloseTo(expectedWidth);
      },
    );

    it('rejects an invalid configured contour width', () => {
      expect(() => new SegmentationRenderer({ maskOutline: { width: 0 } })).toThrow(
        TypeError,
      );
    });
  });

  describe('large mask sequences', () => {
    const size = 96;
    const frames = 24;
    const objects = 2;
    const videoOptions = {
      source: { x: 0, y: 0, width: size, height: size },
      target: { x: 0, y: 0, width: size, height: size },
    } as const;

    /** Deterministic raster with `runs` separated horizontal spans per row. */
    function stripedRaster(runs: number): Uint8Array {
      const raster = new Uint8Array(size * size);
      const span = Math.floor(size / (runs * 2));
      for (let y = 0; y < size; y += 1) {
        for (let run = 0; run < runs; run += 1) {
          const start = run * 2 * span + (y % span);
          raster.fill(1, y * size + start, y * size + start + span);
        }
      }
      return raster;
    }

    const payloads = [3, 4, 5, 6].map((runs) =>
      encodeSegmentationMask(stripedRaster(runs), size, size),
    );

    function videoRecords(): SegmentationMaskRecord[] {
      const records: SegmentationMaskRecord[] = [];
      for (let frame = 0; frame < frames; frame += 1) {
        for (let object = 0; object < objects; object += 1) {
          records.push(
            Object.freeze({
              kind: 'mask',
              order: records.length,
              objectId: `object-${object}`,
              identity: `video:${frame}:object-${object}`,
              revision: 1,
              frame: Object.freeze({ frameIndex: frame }),
              mask: payloads[(frame + object) % payloads.length]!,
              bounds: Object.freeze({ left: 0, top: 0, right: size, bottom: size }),
            }) as SegmentationMaskRecord,
          );
        }
      }
      return records;
    }

    function tracedCharacters(): number {
      return tracedPaths().reduce((total, path) => total + path.length, 0);
    }

    it('renders frame by frame without retaining every traced path', async () => {
      const maxRetainedComplexity = 20_000;
      const renderer = new SegmentationRenderer({
        maxRetainedComplexity,
        maxCachedPaths: 8,
        maxCachedComplexity: 100_000,
      });
      await renderer.update(snapshot(videoRecords(), 'video', 1));
      expect(MockPath2D.created).toEqual([]);

      for (let frame = 0; frame < frames; frame += 1) {
        const canvas = context();
        renderer.render(canvas.value, {
          media: 'video',
          frameIndex: frame,
          ...videoOptions,
        });
        expect(canvas.calls.filter((entry) => entry.name === 'fill')).toHaveLength(
          objects,
        );
      }
      expect(tracedPaths()).toHaveLength(frames * objects);
      // Eager retention charged every frame's path against the same budget.
      expect(tracedCharacters()).toBeGreaterThan(maxRetainedComplexity * 5);
    });

    it('serves a repeated frame from the cache and re-traces after eviction', async () => {
      const renderer = new SegmentationRenderer({
        maxRetainedComplexity: 20_000,
        maxCachedPaths: objects,
        maxCachedComplexity: 1_000_000,
      });
      await renderer.update(snapshot(videoRecords(), 'video', 1));
      const first = { media: 'video', frameIndex: 0, ...videoOptions } as const;
      renderer.render(context().value, first);
      const traced = tracedPaths().length;
      expect(traced).toBe(objects);

      renderer.render(context().value, first);
      expect(tracedPaths()).toHaveLength(traced);

      renderer.render(context().value, {
        media: 'video',
        frameIndex: 1,
        ...videoOptions,
      });
      expect(tracedPaths()).toHaveLength(traced + objects);
      renderer.render(context().value, first);
      expect(tracedPaths()).toHaveLength(traced + 2 * objects);
    });

    it('keeps the image path caching one traced mask per revision', async () => {
      const renderer = new SegmentationRenderer();
      await renderer.update(
        snapshot(
          [
            Object.freeze({
              kind: 'mask',
              order: 0,
              objectId: 'subject',
              identity: 'image:*:subject',
              revision: 1,
              mask: payloads[0]!,
              bounds: Object.freeze({ left: 0, top: 0, right: size, bottom: size }),
            }) as SegmentationMaskRecord,
          ],
          'image',
          1,
        ),
      );
      const options = { media: 'image', ...videoOptions } as const;
      renderer.render(context().value, options);
      renderer.render(context().value, options);
      expect(tracedPaths()).toHaveLength(1);
      expect(tracedPaths()[0]!.length).toBeGreaterThan(1_000);
    });

    it('fails loudly for one mask over the per-mask path limit', async () => {
      const renderer = new SegmentationRenderer({ maxPathComplexity: 500 });
      await expect(
        renderer.update(snapshot(videoRecords(), 'video', 1)),
      ).resolves.toBeUndefined();
      let caught: unknown;
      try {
        renderer.render(context().value, {
          media: 'video',
          frameIndex: 0,
          ...videoOptions,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: 'resource_limit',
        limit: 'maxPathComplexity',
      });
    });
  });
});
