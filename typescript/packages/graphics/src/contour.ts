/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { SegmentationResourceLimitError } from './errors.js';

export interface TracedContour {
  readonly d: string;
  readonly complexity: number;
}

export interface TraceContourOptions {
  /**
   * Replace each closed polygon with a uniform quadratic B-spline through its
   * edge midpoints. Defaults to enabled; pass `false` for the raw polygons.
   */
  readonly smooth?: boolean;
}

/**
 * A contour this small is a lone pixel or a two-pixel sliver, whose polygon is
 * already smaller than the stroke. Smoothing would shrink it further — the
 * single-pixel diamond loses a quarter of its radius — so it keeps its
 * straight segments and stays a visible mark.
 */
const SMALL_CONTOUR_VERTICES = 4;

/**
 * Doubled lattice coordinate to SVG user units. Vertices sit on half pixels
 * and their midpoints on quarter pixels, so one decimal is exact for a vertex
 * and rounds a midpoint by at most 0.05 source pixels — two orders of
 * magnitude under the stroke width, and it keeps the path string short.
 */
function coordinate(doubled: number): string {
  return String(Math.round(doubled * 5) / 10);
}

/**
 * Marching-squares cell cases. A cell spans four pixel centers, so its corners
 * are the centers of pixels (cx, cy), (cx + 1, cy), (cx + 1, cy + 1) and
 * (cx, cy + 1); the grid runs from cx = -1 so that the border of the raster is
 * covered by cells whose outer corners are empty.
 */
const TOP_LEFT = 1;
const TOP_RIGHT = 2;
const BOTTOM_RIGHT = 4;
const BOTTOM_LEFT = 8;

/**
 * Crossing vertices, in doubled coordinates so every lattice point is an
 * integer: a crossing sits at the midpoint of the cell edge it cuts, which is
 * always half a pixel from one pixel center and half a pixel from the next.
 */
function topVertex(cx: number, cy: number, stride: number): number {
  return (2 * cy + 1) * stride + (2 * cx + 2);
}

function rightVertex(cx: number, cy: number, stride: number): number {
  return (2 * cy + 2) * stride + (2 * cx + 3);
}

function bottomVertex(cx: number, cy: number, stride: number): number {
  return (2 * cy + 3) * stride + (2 * cx + 2);
}

function leftVertex(cx: number, cy: number, stride: number): number {
  return (2 * cy + 2) * stride + (2 * cx + 1);
}

/**
 * Emits a decimated polygon as straight segments, the geometry the tracer
 * produced before any smoothing.
 */
function polyline(vx: readonly number[], vy: readonly number[]): string {
  let part = `M${coordinate(vx[0]!)} ${coordinate(vy[0]!)}`;
  for (let index = 1; index < vx.length; index += 1) {
    part += `L${coordinate(vx[index]!)} ${coordinate(vy[index]!)}`;
  }
  return `${part}Z`;
}

/**
 * Emits a closed polygon as a uniform quadratic B-spline: the curve runs
 * through the midpoint of every edge and takes each vertex as the control
 * point between two midpoints, so `M m₀ Q p₁ m₁ … Q p₀ m₀ Z`.
 *
 * The curve therefore never passes through a vertex: a 1-pixel step becomes a
 * curve instead of a corner, while the middle of a long edge is a knot the
 * curve interpolates with the edge's own tangent, so decimated straight runs
 * stay straight. A vertex is pulled toward the chord of its two midpoints by
 * an eighth of the difference of its edge vectors, which for the 45° bevel
 * marching squares puts on a right-angle corner is under half a source pixel.
 */
function spline(vx: readonly number[], vy: readonly number[]): string {
  const total = vx.length;
  const midX = (index: number): number => (vx[index]! + vx[(index + 1) % total]!) / 2;
  const midY = (index: number): number => (vy[index]! + vy[(index + 1) % total]!) / 2;
  const startX = coordinate(midX(0));
  const startY = coordinate(midY(0));
  let part = `M${startX} ${startY}`;
  for (let index = 1; index < total; index += 1) {
    part += `Q${coordinate(vx[index]!)} ${coordinate(vy[index]!)} ${coordinate(
      midX(index),
    )} ${coordinate(midY(index))}`;
  }
  return `${part}Q${coordinate(vx[0]!)} ${coordinate(vy[0]!)} ${startX} ${startY}Z`;
}

/**
 * Traces the contour of a binary raster as closed polygons with marching
 * squares, then smooths each polygon.
 *
 * Contour vertices are the midpoints of the edges between neighbouring pixel
 * centers, so a boundary that runs straight follows the pixel edge exactly
 * while a corner or a diagonal is cut at 45° instead of stepping. Every
 * segment is emitted with the filled region on its right, which makes outer
 * contours wind opposite to the holes they enclose; the caller fills the
 * result with `evenodd` and strokes the same path.
 *
 * The two saddle cases (a filled diagonal pair) are both resolved as a filled
 * center, matching the eight-connected reading of the raster. That choice is
 * what makes every crossing the endpoint of exactly one segment, so chaining
 * the segments is a walk rather than a search.
 *
 * A polygon is then decimated — a vertex the contour passes straight through
 * is dropped, collapsing a straight run to its two endpoints — and emitted as
 * a quadratic B-spline through the edge midpoints, which turns the 1-pixel
 * staircase of a native-resolution mask into a smooth boundary. Contours of at
 * most `SMALL_CONTOUR_VERTICES` vertices keep their straight segments.
 */
export function traceContour(
  raster: Uint8Array,
  width: number,
  height: number,
  limit: number,
  options: TraceContourOptions = {},
): TracedContour {
  const smooth = options.smooth !== false;
  const stride = 2 * width + 1;
  /** Start vertex to end vertex; each vertex starts at most one segment. */
  const next = new Map<number, number>();

  for (let cy = -1; cy < height; cy += 1) {
    const topRow = cy >= 0 ? cy * width : -1;
    const bottomRow = cy + 1 < height ? (cy + 1) * width : -1;
    let topLeft = 0;
    let bottomLeft = 0;
    for (let cx = -1; cx < width; cx += 1) {
      const column = cx + 1;
      const inside = column < width;
      const topRight = topRow >= 0 && inside ? raster[topRow + column]! : 0;
      const bottomRight = bottomRow >= 0 && inside ? raster[bottomRow + column]! : 0;
      const corners =
        (topLeft === 1 ? TOP_LEFT : 0) |
        (topRight === 1 ? TOP_RIGHT : 0) |
        (bottomRight === 1 ? BOTTOM_RIGHT : 0) |
        (bottomLeft === 1 ? BOTTOM_LEFT : 0);
      topLeft = topRight;
      bottomLeft = bottomRight;
      if (corners === 0 || corners === 15) continue;
      switch (corners) {
        case TOP_LEFT:
          next.set(topVertex(cx, cy, stride), leftVertex(cx, cy, stride));
          break;
        case TOP_RIGHT:
          next.set(rightVertex(cx, cy, stride), topVertex(cx, cy, stride));
          break;
        case BOTTOM_RIGHT:
          next.set(bottomVertex(cx, cy, stride), rightVertex(cx, cy, stride));
          break;
        case BOTTOM_LEFT:
          next.set(leftVertex(cx, cy, stride), bottomVertex(cx, cy, stride));
          break;
        case TOP_LEFT | TOP_RIGHT:
          next.set(rightVertex(cx, cy, stride), leftVertex(cx, cy, stride));
          break;
        case TOP_RIGHT | BOTTOM_RIGHT:
          next.set(bottomVertex(cx, cy, stride), topVertex(cx, cy, stride));
          break;
        case BOTTOM_RIGHT | BOTTOM_LEFT:
          next.set(leftVertex(cx, cy, stride), rightVertex(cx, cy, stride));
          break;
        case TOP_LEFT | BOTTOM_LEFT:
          next.set(topVertex(cx, cy, stride), bottomVertex(cx, cy, stride));
          break;
        case TOP_RIGHT | BOTTOM_RIGHT | BOTTOM_LEFT:
          next.set(leftVertex(cx, cy, stride), topVertex(cx, cy, stride));
          break;
        case TOP_LEFT | BOTTOM_RIGHT | BOTTOM_LEFT:
          next.set(topVertex(cx, cy, stride), rightVertex(cx, cy, stride));
          break;
        case TOP_LEFT | TOP_RIGHT | BOTTOM_LEFT:
          next.set(rightVertex(cx, cy, stride), bottomVertex(cx, cy, stride));
          break;
        case TOP_LEFT | TOP_RIGHT | BOTTOM_RIGHT:
          next.set(bottomVertex(cx, cy, stride), leftVertex(cx, cy, stride));
          break;
        case TOP_LEFT | BOTTOM_RIGHT:
          next.set(topVertex(cx, cy, stride), rightVertex(cx, cy, stride));
          next.set(bottomVertex(cx, cy, stride), leftVertex(cx, cy, stride));
          break;
        default:
          // TOP_RIGHT | BOTTOM_LEFT, the other saddle.
          next.set(leftVertex(cx, cy, stride), topVertex(cx, cy, stride));
          next.set(rightVertex(cx, cy, stride), bottomVertex(cx, cy, stride));
          break;
      }
    }
  }

  const parts: string[] = [];
  let complexity = 0;
  const points: number[] = [];
  const vx: number[] = [];
  const vy: number[] = [];

  while (next.size > 0) {
    const start = next.keys().next().value as number;
    points.length = 0;
    let vertex = start;
    for (;;) {
      const following = next.get(vertex);
      if (following === undefined) break;
      next.delete(vertex);
      points.push(vertex);
      vertex = following;
      if (vertex === start) break;
    }
    const total = points.length;
    if (total < 3) continue;

    vx.length = 0;
    vy.length = 0;
    for (let index = 0; index < total; index += 1) {
      const point = points[index]!;
      const previous = points[(index + total - 1) % total]!;
      const following = points[(index + 1) % total]!;
      const x = point % stride;
      const y = (point - x) / stride;
      const previousX = previous % stride;
      const followingX = following % stride;
      // Drop a vertex the contour passes straight through, so a run of cells
      // along one pixel edge — or one 45° diagonal — collapses to its two
      // endpoints. Every step of the walk is one cell wide, so equal steps in
      // and out are exactly the collinear case.
      if (
        followingX - x === x - previousX &&
        (following - followingX) / stride - y === y - (previous - previousX) / stride
      ) {
        continue;
      }
      vx.push(x);
      vy.push(y);
    }
    if (vx.length < 3) continue;

    const part =
      smooth && vx.length > SMALL_CONTOUR_VERTICES ? spline(vx, vy) : polyline(vx, vy);
    complexity += part.length;
    if (complexity > limit) {
      throw new SegmentationResourceLimitError('maxPathComplexity');
    }
    parts.push(part);
  }

  return { d: parts.join(''), complexity };
}
