/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import { traceContour } from '../src/contour.js';

const NO_LIMIT = 10_000_000;

function raster(
  width: number,
  height: number,
  filled: (x: number, y: number) => boolean,
): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[y * width + x] = filled(x, y) ? 1 : 0;
    }
  }
  return data;
}

function contours(d: string): string[] {
  return d
    .split('Z')
    .filter((part) => part.length > 0)
    .map((part) => `${part}Z`);
}

type Point = readonly [number, number];

/**
 * The polygon vertices of one closed subpath: the control point of every `Q`,
 * or the `M`/`L` points of a subpath that was left straight.
 */
function controlPoints(part: string): Point[] {
  const curves = [...part.matchAll(/Q(-?[\d.]+) (-?[\d.]+)/g)];
  const matches =
    curves.length > 0 ? curves : [...part.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
  return matches.map((match) => [Number(match[1]), Number(match[2])] as Point);
}

/**
 * Evaluates a subpath without a canvas: `M`/`L` contribute their endpoint and
 * every `Q` is sampled as a quadratic Bézier, so a test can measure where the
 * rendered curve actually runs.
 */
function samplePath(part: string, steps = 24): Point[] {
  const points: Point[] = [];
  let current: Point = [0, 0];
  for (const [, command, rest] of part.matchAll(/([MLQ])([^MLQZ]*)/g)) {
    const numbers = (rest ?? '').trim().split(' ').map(Number);
    if (command === 'M' || command === 'L') {
      current = [numbers[0]!, numbers[1]!];
      points.push(current);
      continue;
    }
    const [controlX, controlY, endX, endY] = numbers as [
      number,
      number,
      number,
      number,
    ];
    const [startX, startY] = current;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const u = 1 - t;
      points.push([
        u * u * startX + 2 * u * t * controlX + t * t * endX,
        u * u * startY + 2 * u * t * controlY + t * t * endY,
      ]);
    }
    current = [endX, endY];
  }
  return points;
}

describe('traceContour', () => {
  it('traces nothing for an empty raster', () => {
    const traced = traceContour(
      raster(8, 8, () => false),
      8,
      8,
      NO_LIMIT,
    );
    expect(traced.d).toBe('');
    expect(traced.complexity).toBe(0);
  });

  it('keeps a single pixel a straight diamond so it stays a visible mark', () => {
    const traced = traceContour(
      raster(3, 3, (x, y) => x === 1 && y === 1),
      3,
      3,
      NO_LIMIT,
    );
    // Four vertices or fewer keep their straight segments: smoothing a diamond
    // this small would shrink it further instead of removing a jaggy.
    expect(traced.d).toBe('M1 1.5L1.5 1L2 1.5L1.5 2Z');
    const sampled = samplePath(traced.d);
    expect(
      Math.max(...sampled.map(([x]) => x)) - Math.min(...sampled.map(([x]) => x)),
    ).toBe(1);
  });

  it('keeps the sides of a solid rectangle straight and rounds its corners', () => {
    const traced = traceContour(
      raster(6, 4, () => true),
      6,
      4,
      NO_LIMIT,
    );
    expect(traced.d).toBe(
      'M0.3 0.3Q0.5 0 3 0Q5.5 0 5.8 0.3Q6 0.5 6 2Q6 3.5 5.8 3.8' +
        'Q5.5 4 3 4Q0.5 4 0.3 3.8Q0 3.5 0 2Q0 0.5 0.3 0.3Z',
    );
    expect(contours(traced.d)).toHaveLength(1);
    // Two control vertices per corner — the 45° bevel marching squares puts on
    // a right angle — and none along the sides, whatever the edge length is.
    expect(controlPoints(traced.d)).toHaveLength(8);
    expect(
      controlPoints(
        contours(
          traceContour(
            raster(40, 30, () => true),
            40,
            30,
            NO_LIMIT,
          ).d,
        )[0]!,
      ),
    ).toHaveLength(8);

    const sampled = samplePath(traced.d, 64);
    // The sides run along the pixel edge: the corner arc decays quadratically,
    // so 1.5 px in from either end nothing is more than a twentieth of a pixel
    // off the edge, and the middle of each edge is a knot exactly on it.
    for (const [x, y] of sampled) {
      if (x > 1.5 && x < 4.5) expect(Math.min(y, 4 - y)).toBeLessThan(0.05);
      if (y > 1.5 && y < 2.5) expect(Math.min(x, 6 - x)).toBeLessThan(0.05);
    }
    // Each right-angle corner rounds by well under half a source pixel: the
    // curve's closest approach to the sharp corner stays inside that budget.
    for (const [cornerX, cornerY] of [
      [0, 0],
      [6, 0],
      [6, 4],
      [0, 4],
    ] as ReadonlyArray<Point>) {
      const nearest = Math.min(
        ...sampled.map(([x, y]) => Math.hypot(x - cornerX, y - cornerY)),
      );
      expect(nearest).toBeGreaterThan(0);
      expect(nearest).toBeLessThan(0.5);
    }
  });

  it('keeps a 45° boundary a single straight run', () => {
    const traced = traceContour(
      raster(5, 5, (x, y) => x <= y),
      5,
      5,
      NO_LIMIT,
    );
    // Six control vertices for the whole triangle: the hypotenuse is one
    // decimated edge, so its curve is the straight line between two midpoints.
    expect(controlPoints(traced.d)).toHaveLength(6);
    expect(traced.d).toBe(
      'M0.3 0.3Q0.5 0 2.8 2.3Q5 4.5 4.8 4.8Q4.5 5 2.5 5Q0.5 5 0.3 4.8Q0 4.5 0 2.5Q0 0.5 0.3 0.3Z',
    );
  });

  it('smooths a 1-pixel staircase to within half a pixel of the ideal line', () => {
    // A diagonal band that rises one pixel every two rows: the genuine 1-px
    // staircase the live API produces at native video resolution.
    const size = 96;
    const rise = 2;
    const band = raster(size, size, (x, y) => {
      const start = Math.floor(y / rise);
      return x >= start && x < start + 10;
    });
    const ideal = (y: number): number => y / rise - 0.5;
    const offsets = (d: string): number[] =>
      contours(d)
        .flatMap((part) => samplePath(part))
        .filter(([x, y]) => y > 8 && y < size - 8 && Math.abs(x - ideal(y)) <= 1.5)
        // Perpendicular distance to the ideal line, which has slope 1 / rise.
        .map(([x, y]) => Math.abs(x - ideal(y)) / Math.hypot(1, 1 / rise));

    const smoothed = offsets(traceContour(band, size, size, NO_LIMIT).d);
    const stepped = offsets(
      traceContour(band, size, size, NO_LIMIT, { smooth: false }).d,
    );
    expect(smoothed.length).toBeGreaterThan(100);
    expect(Math.max(...smoothed)).toBeLessThan(0.5);
    // The staircase itself sits about a quarter pixel off the line; smoothing
    // halves that, which is what removes the visible step.
    expect(Math.max(...smoothed)).toBeLessThan(Math.max(...stepped) / 1.5);
  });

  it('emits raw polygons when smoothing is disabled', () => {
    const data = raster(6, 4, () => true);
    const traced = traceContour(data, 6, 4, NO_LIMIT, { smooth: false });
    expect(traced.d).toBe('M0 0.5L0.5 0L5.5 0L6 0.5L6 3.5L5.5 4L0.5 4L0 3.5Z');
    expect(traceContour(data, 6, 4, NO_LIMIT, {}).d).toBe(
      traceContour(data, 6, 4, NO_LIMIT).d,
    );
  });

  it('emits one contour per component and one more per hole', () => {
    const ring = traceContour(
      raster(10, 10, (x, y) => !(x >= 3 && x < 7 && y >= 3 && y < 7)),
      10,
      10,
      NO_LIMIT,
    );
    expect(contours(ring.d)).toHaveLength(2);

    const pair = traceContour(
      raster(5, 3, (x, y) => y === 1 && (x === 1 || x === 3)),
      5,
      3,
      NO_LIMIT,
    );
    expect(contours(pair.d)).toHaveLength(2);
  });

  it('joins pixels that touch only at a corner', () => {
    const traced = traceContour(
      raster(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2)),
      4,
      4,
      NO_LIMIT,
    );
    expect(contours(traced.d)).toHaveLength(1);
  });

  it('charges the emitted characters and fails over the limit', () => {
    const data = raster(20, 20, (x, y) => (x + y) % 2 === 0);
    const traced = traceContour(data, 20, 20, NO_LIMIT);
    expect(traced.complexity).toBe(traced.d.length);
    expect(() => traceContour(data, 20, 20, 200)).toThrow(
      expect.objectContaining({ code: 'resource_limit', limit: 'maxPathComplexity' }),
    );
  });

  it('traces a full-resolution mask well inside the frame budget', () => {
    const width = 640;
    const height = 633;
    const ellipse = raster(width, height, (x, y) => {
      const dx = (x - width / 2) / (width / 2 - 4);
      const dy = (y - height / 2) / (height / 2 - 4);
      return dx * dx + dy * dy <= 1;
    });
    const started = performance.now();
    const traced = traceContour(ellipse, width, height, NO_LIMIT);
    const elapsed = performance.now() - started;
    expect(contours(traced.d)).toHaveLength(1);
    // Measured at ~3 ms on a development machine, tracing and smoothing together; the
    // bound only catches a regression that changes the order of growth.
    expect(elapsed).toBeLessThan(200);
  });
});
