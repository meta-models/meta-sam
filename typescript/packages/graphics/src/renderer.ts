/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  InvalidSegmentationMaskError,
  decodeMaskToRaster,
  type SegmentationBoxRecord,
  type SegmentationMask,
  type SegmentationMaskBounds,
  type SegmentationMaskRecord,
  type SegmentationResult,
  type SegmentationSnapshot,
} from '@meta-sam/parser';
import {
  InvalidMaskPayloadError,
  InvalidRenderOptionsError,
  Path2DUnavailableError,
  RendererDisposedError,
  SegmentationResourceLimitError,
  UnsupportedMaskEncodingError,
} from './errors.js';
import { traceContour } from './contour.js';

export interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SegmentationCanvasContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type VideoFrameFit = 'contain' | 'cover' | 'fill';

/**
 * Structural subset of a Canvas media-player render context.
 *
 * This deliberately does not import @meta-sam/video, so graphics and video remain
 * independently usable without a dependency cycle.
 */
export interface VideoFrameCompositionContext {
  readonly frame: CanvasImageSource & {
    readonly width: number;
    readonly height: number;
  };
  readonly frameIndex: number;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  readonly ctx: SegmentationCanvasContext;
  /** Optional bare-frame surface supplied by @meta-sam/video for deadline fallback. */
  readonly fallbackCanvas?: {
    readonly width: number;
    readonly height: number;
  };
  readonly fallbackCtx?: SegmentationCanvasContext;
  readonly signal: AbortSignal;
}

export interface VideoFrameCompositionOptions {
  /** Fit the decoded frame into the logical canvas. Defaults to contain. */
  readonly fit?: VideoFrameFit;
  /** Logical-to-backing-store scale. Defaults to 1 and may be read per render. */
  readonly devicePixelRatio?: number | (() => number);
  /** Object IDs, not mask identities, to omit from this composition. */
  readonly hiddenIds?: ReadonlySet<string> | readonly string[];
  /** Text shown before the object ID in box labels; see `boxLabels`. */
  readonly boxLabel?: string;
}

export interface MaskOutlineOptions {
  /**
   * Contour width in source pixels — the same space as mask rasters and box
   * edges, so it scales with the source-to-target transform. Defaults to
   * `0.003 × min(source.width, source.height)`.
   */
  readonly width?: number;
  /** Contour opacity. Defaults to 0.8. */
  readonly opacity?: number;
}

export interface SegmentationRendererOptions {
  /** Mask fill opacity. Defaults to 0.35. */
  readonly maskFillOpacity?: number;
  /**
   * Stroke the mask contour in the object color on top of the translucent
   * fill. Defaults to enabled; pass `false` for fill only.
   */
  readonly maskOutline?: boolean | MaskOutlineOptions;
  /**
   * Draw a label at each box's top-left corner: the render's `boxLabel`, the
   * box's object ID, then its parser `confidence` in parentheses, as
   * `pillow 3 (0.945)`. The label and the confidence appear only when present.
   * Defaults to `false`.
   */
  readonly boxLabels?: boolean;
  /** Traced paths kept in the LRU cache. */
  readonly maxCachedPaths?: number;
  /** Total traced-path characters kept in the LRU cache. */
  readonly maxCachedComplexity?: number;
  readonly maxRecords?: number;
  readonly maxMasks?: number;
  readonly maxBoxes?: number;
  readonly maxMaskArea?: number;
  readonly maxMaskPayloadLength?: number;
  /** Traced characters a single mask may produce before it fails. */
  readonly maxPathComplexity?: number;
  /**
   * Bookkeeping the retained state may hold across every known frame. Masks are
   * retained as identity plus a reference to the parser's own payload and are
   * traced lazily, so this counts per-mask bookkeeping and box geometry rather
   * than payload or traced-path characters.
   */
  readonly maxRetainedComplexity?: number;
}

export interface SegmentationUpdateOptions {
  readonly reset?: boolean;
}

interface RenderOptionsBase {
  readonly source: Rectangle;
  readonly target: Rectangle;
  readonly hiddenIds?: ReadonlySet<string> | readonly string[];
  /** Text shown before the object ID in box labels; see `boxLabels`. */
  readonly boxLabel?: string;
}

export interface ImageRenderOptions extends RenderOptionsBase {
  readonly media: 'image';
}

export interface VideoRenderOptions extends RenderOptionsBase {
  readonly media: 'video';
  readonly frameIndex: number;
}

export type SegmentationRenderOptions = ImageRenderOptions | VideoRenderOptions;

type SegmentationView = SegmentationResult | SegmentationSnapshot;

/**
 * A mask the retained state knows about. Nothing here scales with the mask's
 * pixels: `record` is the parser's own frozen record, so the payload is shared
 * rather than copied, and the SVG path is traced only when a frame needs it.
 */
interface RetainedMask {
  readonly identity: string;
  readonly revision: number;
  readonly record: SegmentationMaskRecord;
  readonly objectId: string;
  readonly frameIndex?: number;
  readonly width: number;
  readonly height: number;
  readonly bounds: SegmentationMaskBounds;
}

interface BoxPath {
  readonly identity: string;
  readonly objectId: string;
  readonly frameIndex?: number;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly confidence?: number;
}

interface RetainedState {
  readonly media: 'image' | 'video';
  readonly snapshotRevision: number;
  readonly masks: ReadonlyMap<string, RetainedMask>;
  readonly boxes: ReadonlyMap<string, BoxPath>;
  readonly complexity: number;
}

interface CachedPath {
  /** Marching-squares contour; both the fill and the stroke use it. */
  readonly path: Path2D;
  readonly complexity: number;
  readonly empty: boolean;
}

interface Limits {
  readonly maxCachedPaths: number;
  readonly maxCachedComplexity: number;
  readonly maxRecords: number;
  readonly maxMasks: number;
  readonly maxBoxes: number;
  readonly maxMaskArea: number;
  readonly maxMaskPayloadLength: number;
  readonly maxPathComplexity: number;
  readonly maxRetainedComplexity: number;
}

const palette = [
  '#1677ff',
  '#00a870',
  '#d46b08',
  '#c41d7f',
  '#531dab',
  '#08979c',
  '#cf1322',
  '#5b8c00',
] as const;

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function unitInterval(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a finite number from zero through one.`);
  }
  return value;
}

function colorFor(identity: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return palette[(hash >>> 0) % palette.length]!;
}

/**
 * The fill and stroke color the renderer assigns to an object identifier.
 * Exposed so legends and inspectors can match the composited overlay exactly.
 */
export function objectColor(objectId: string): string {
  return colorFor(objectId);
}

/**
 * Retained bookkeeping charged per known mask: the map entry plus the retained
 * descriptor. Payload and traced characters are deliberately excluded — the
 * payload belongs to the parser's record and the path is traced on demand.
 */
const RETAINED_MASK_OVERHEAD = 64;

function sameBounds(
  left: SegmentationMaskBounds,
  right: SegmentationMaskBounds,
): boolean {
  return (
    left.left === right.left &&
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom
  );
}

/**
 * Compares two mask records field by field, cheapest first, so that identical
 * payloads are only scanned when everything else already matches.
 */
function sameMaskRecord(
  left: SegmentationMaskRecord,
  right: SegmentationMaskRecord,
): boolean {
  return (
    left === right ||
    (left.identity === right.identity &&
      left.revision === right.revision &&
      left.order === right.order &&
      left.objectId === right.objectId &&
      (left.frame?.frameIndex ?? null) === (right.frame?.frameIndex ?? null) &&
      left.mask.encoding === right.mask.encoding &&
      left.mask.width === right.mask.width &&
      left.mask.height === right.mask.height &&
      left.mask.payload.length === right.mask.payload.length &&
      sameBounds(left.bounds, right.bounds) &&
      left.mask.payload === right.mask.payload)
  );
}

function boxIdentity(record: SegmentationBoxRecord): string {
  return `box:${record.frame?.frameIndex ?? '*'}:${record.objectId}`;
}

function hiddenSet(
  hidden: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (hidden === undefined) return new Set();
  return hidden instanceof Set ? hidden : new Set(hidden);
}

function validateRectangle(rectangle: Rectangle, name: string): void {
  if (
    !Number.isFinite(rectangle.x) ||
    !Number.isFinite(rectangle.y) ||
    !Number.isFinite(rectangle.width) ||
    !Number.isFinite(rectangle.height) ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  ) {
    throw new InvalidRenderOptionsError(
      `${name} must contain finite coordinates and positive dimensions.`,
    );
  }
}

function validateFit(fit: VideoFrameFit | undefined): VideoFrameFit {
  const resolved = fit ?? 'contain';
  if (resolved !== 'contain' && resolved !== 'cover' && resolved !== 'fill') {
    throw new InvalidRenderOptionsError('fit must be contain, cover, or fill.');
  }
  return resolved;
}

function resolveDevicePixelRatio(option: number | (() => number) | undefined): number {
  const value = typeof option === 'function' ? option() : (option ?? 1);
  if (!Number.isFinite(value) || value <= 0) {
    throw new InvalidRenderOptionsError(
      'devicePixelRatio must be finite and greater than zero.',
    );
  }
  return value;
}

function fittedTarget(
  source: Rectangle,
  display: Rectangle,
  fit: VideoFrameFit,
): Rectangle {
  if (fit === 'fill') return display;
  const scale =
    fit === 'contain'
      ? Math.min(display.width / source.width, display.height / source.height)
      : Math.max(display.width / source.width, display.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: display.x + (display.width - width) / 2,
    y: display.y + (display.height - height) / 2,
    width,
    height,
  };
}

function drawDecodedFrame(
  context: SegmentationCanvasContext,
  frame: CanvasImageSource,
  source: Rectangle,
  target: Rectangle,
  display: Rectangle,
  devicePixelRatio: number,
): void {
  context.save();
  try {
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    context.clearRect(0, 0, display.width, display.height);
    context.drawImage(
      frame,
      source.x,
      source.y,
      source.width,
      source.height,
      target.x,
      target.y,
      target.width,
      target.height,
    );
  } finally {
    context.restore();
  }
}

function validateFrame(frameIndex: number | undefined): void {
  if (
    frameIndex !== undefined &&
    (!Number.isSafeInteger(frameIndex) || frameIndex < 0)
  ) {
    throw new InvalidRenderOptionsError(
      'Frame indexes must be non-negative safe integers.',
    );
  }
}

function retainMask(record: SegmentationMaskRecord): RetainedMask {
  return {
    identity: record.identity,
    revision: record.revision,
    record,
    objectId: record.objectId,
    ...(record.frame === undefined ? {} : { frameIndex: record.frame.frameIndex }),
    width: record.mask.width,
    height: record.mask.height,
    bounds: record.bounds,
  };
}

interface TracedMask {
  readonly d: string;
  readonly complexity: number;
}

function traceMask(mask: SegmentationMask, limit: number): TracedMask {
  if (mask.encoding !== 'one_bit' && mask.encoding !== 'lossless') {
    throw new UnsupportedMaskEncodingError(mask.encoding);
  }
  let raster: Uint8Array;
  try {
    raster = decodeMaskToRaster(mask);
  } catch (error) {
    if (error instanceof InvalidSegmentationMaskError) {
      throw new InvalidMaskPayloadError(error.message);
    }
    throw error;
  }
  return traceContour(raster, mask.width, mask.height, limit);
}

/** Default fill opacity under the contour. */
const DEFAULT_MASK_FILL_OPACITY = 0.35;
/** Default contour opacity. */
const DEFAULT_MASK_OUTLINE_OPACITY = 0.8;
/**
 * Contour width as a fraction of the shorter source edge: about 2.2 source
 * pixels on 720p, so the weight tracks the resolution rather than a fixed
 * pixel count.
 */
const MASK_OUTLINE_WIDTH_RATIO = 0.003;
/** Contour width in target CSS pixels when the source size is unusable. */
const FALLBACK_MASK_OUTLINE_WIDTH = 1.5;

/** Box label geometry in target CSS pixels. */
const BOX_LABEL_HEIGHT = 16;
const BOX_LABEL_PADDING = 4;
const BOX_LABEL_FONT =
  '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const BOX_LABEL_TEXT_COLOR = '#ffffff';

/** A confidence as box labels show it: the value with three decimals. */
export function formatConfidence(confidence: number): string {
  return confidence.toFixed(3);
}

/**
 * The text of one box label: the trimmed label, the object ID, then the
 * confidence in parentheses, as `pillow 3 (0.945)`. A missing or blank label
 * and a missing confidence are left out, so the object ID is always shown.
 */
export function formatBoxLabel(
  label: string | undefined,
  objectId: string,
  confidence: number | undefined,
): string {
  return [
    ...(label === undefined || label.trim().length === 0 ? [] : [label.trim()]),
    objectId,
    ...(confidence === undefined ? [] : [`(${formatConfidence(confidence)})`]),
  ].join(' ');
}

function validateBoxLabel(label: unknown): void {
  if (label !== undefined && typeof label !== 'string') {
    throw new InvalidRenderOptionsError('boxLabel must be a string.');
  }
}

interface OutlineSettings {
  readonly enabled: boolean;
  /** Configured width in source pixels; resolution-relative when absent. */
  readonly width: number | null;
  readonly opacity: number;
}

function resolveMaskOutline(
  option: boolean | MaskOutlineOptions | undefined,
): OutlineSettings {
  if (option === false) {
    return { enabled: false, width: null, opacity: DEFAULT_MASK_OUTLINE_OPACITY };
  }
  if (option === undefined || option === true) {
    return { enabled: true, width: null, opacity: DEFAULT_MASK_OUTLINE_OPACITY };
  }
  if (typeof option !== 'object' || option === null) {
    throw new TypeError('maskOutline must be a boolean or an options object.');
  }
  let width: number | null = null;
  if (option.width !== undefined) {
    if (!Number.isFinite(option.width) || option.width <= 0) {
      throw new TypeError(
        'maskOutline.width must be a finite number greater than zero.',
      );
    }
    width = option.width;
  }
  return {
    enabled: true,
    width,
    opacity: unitInterval(
      option.opacity,
      DEFAULT_MASK_OUTLINE_OPACITY,
      'maskOutline.opacity',
    ),
  };
}

export class SegmentationRenderer {
  readonly #limits: Limits;
  readonly #maskFillOpacity: number;
  readonly #outline: OutlineSettings;
  readonly #boxLabels: boolean;
  readonly #cache = new Map<RetainedMask, CachedPath>();
  #cacheComplexity = 0;
  #state: RetainedState | undefined;
  #tail: Promise<void> = Promise.resolve();
  #epoch = 0;
  #disposed = false;

  public constructor(options: SegmentationRendererOptions = {}) {
    this.#maskFillOpacity = unitInterval(
      options.maskFillOpacity,
      DEFAULT_MASK_FILL_OPACITY,
      'maskFillOpacity',
    );
    this.#outline = resolveMaskOutline(options.maskOutline);
    if (options.boxLabels !== undefined && typeof options.boxLabels !== 'boolean') {
      throw new TypeError('boxLabels must be a boolean.');
    }
    this.#boxLabels = options.boxLabels === true;
    this.#limits = {
      maxCachedPaths: positiveInteger(options.maxCachedPaths, 128, 'maxCachedPaths'),
      maxCachedComplexity: positiveInteger(
        options.maxCachedComplexity,
        250_000,
        'maxCachedComplexity',
      ),
      maxRecords: positiveInteger(options.maxRecords, 20_000, 'maxRecords'),
      maxMasks: positiveInteger(options.maxMasks, 4_096, 'maxMasks'),
      maxBoxes: positiveInteger(options.maxBoxes, 8_192, 'maxBoxes'),
      maxMaskArea: positiveInteger(options.maxMaskArea, 16_777_216, 'maxMaskArea'),
      maxMaskPayloadLength: positiveInteger(
        options.maxMaskPayloadLength,
        2_000_000,
        'maxMaskPayloadLength',
      ),
      maxPathComplexity: positiveInteger(
        options.maxPathComplexity,
        250_000,
        'maxPathComplexity',
      ),
      maxRetainedComplexity: positiveInteger(
        options.maxRetainedComplexity,
        1_000_000,
        'maxRetainedComplexity',
      ),
    };
  }

  public update(
    result: SegmentationView,
    options: SegmentationUpdateOptions = {},
  ): Promise<void> {
    if (this.#disposed) return Promise.reject(new RendererDisposedError());
    const epoch = this.#epoch;
    const task = this.#tail.then(async () => {
      if (this.#disposed) throw new RendererDisposedError();
      await Promise.resolve();
      if (this.#disposed) throw new RendererDisposedError();
      if (epoch !== this.#epoch) return;
      const reset = options.reset === true;
      const candidate = this.#buildState(result, reset);
      if (this.#disposed) throw new RendererDisposedError();
      if (epoch !== this.#epoch) return;
      if (reset) this.#dropCache();
      this.#state = candidate;
      this.#pruneCache(candidate);
    });
    this.#tail = task.catch(() => undefined);
    return task;
  }

  public renderVideoFrame(
    composition: VideoFrameCompositionContext,
    options: VideoFrameCompositionOptions = {},
  ): boolean {
    if (composition.signal.aborted) return false;
    if (this.#disposed) throw new RendererDisposedError();

    const fit = validateFit(options.fit);
    const devicePixelRatio = resolveDevicePixelRatio(options.devicePixelRatio);
    validateFrame(composition.frameIndex);
    const source: Rectangle = {
      x: 0,
      y: 0,
      width: composition.frame.width,
      height: composition.frame.height,
    };
    const display: Rectangle = {
      x: 0,
      y: 0,
      width: composition.canvas.width / devicePixelRatio,
      height: composition.canvas.height / devicePixelRatio,
    };
    validateRectangle(source, 'frame');
    validateRectangle(display, 'canvas');
    const target = fittedTarget(source, display, fit);
    validateRectangle(target, 'target');
    const fallbackCanvas = composition.fallbackCanvas;
    const fallbackCtx = composition.fallbackCtx;
    if ((fallbackCanvas === undefined) !== (fallbackCtx === undefined)) {
      throw new InvalidRenderOptionsError(
        'fallbackCanvas and fallbackCtx must be provided together.',
      );
    }
    if (
      fallbackCanvas !== undefined &&
      (fallbackCanvas.width !== composition.canvas.width ||
        fallbackCanvas.height !== composition.canvas.height)
    ) {
      throw new InvalidRenderOptionsError(
        'The fallback canvas dimensions must match the composition canvas.',
      );
    }

    const state = this.#state;
    if (state !== undefined) {
      if (state.media !== 'video') {
        throw new InvalidRenderOptionsError(
          `Cannot render ${state.media} segmentation as video.`,
        );
      }
      const Constructor = (globalThis as typeof globalThis & { Path2D?: typeof Path2D })
        .Path2D;
      if (Constructor === undefined) throw new Path2DUnavailableError();
    }

    const { ctx } = composition;
    if (fallbackCtx !== undefined) {
      drawDecodedFrame(
        fallbackCtx,
        composition.frame,
        source,
        target,
        display,
        devicePixelRatio,
      );
    }
    drawDecodedFrame(ctx, composition.frame, source, target, display, devicePixelRatio);
    if (composition.signal.aborted) return false;
    ctx.save();
    try {
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      this.render(ctx, {
        media: 'video',
        frameIndex: composition.frameIndex,
        source,
        target,
        ...(options.hiddenIds === undefined ? {} : { hiddenIds: options.hiddenIds }),
        ...(options.boxLabel === undefined ? {} : { boxLabel: options.boxLabel }),
      });
    } finally {
      ctx.restore();
    }
    return !composition.signal.aborted;
  }

  public render(
    context: SegmentationCanvasContext,
    options: SegmentationRenderOptions,
  ): void {
    if (this.#disposed) throw new RendererDisposedError();
    validateRectangle(options.source, 'source');
    validateRectangle(options.target, 'target');
    if (options.media === 'video') validateFrame(options.frameIndex);
    validateBoxLabel(options.boxLabel);
    const state = this.#state;
    if (state === undefined) return;
    if (state.media !== options.media) {
      throw new InvalidRenderOptionsError(
        `Cannot render ${state.media} segmentation as ${options.media}.`,
      );
    }

    const hidden = hiddenSet(options.hiddenIds);
    const scaleX = options.target.width / options.source.width;
    const scaleY = options.target.height / options.source.height;
    const offsetX = options.target.x - options.source.x * scaleX;
    const offsetY = options.target.y - options.source.y * scaleY;
    if (
      !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) ||
      !Number.isFinite(offsetX) ||
      !Number.isFinite(offsetY)
    ) {
      throw new InvalidRenderOptionsError(
        'The source-to-target transform exceeds the supported numeric range.',
      );
    }

    const Constructor = (globalThis as typeof globalThis & { Path2D?: typeof Path2D })
      .Path2D;
    if (Constructor === undefined) throw new Path2DUnavailableError();
    const clipPath = new Constructor();
    clipPath.rect(
      options.target.x,
      options.target.y,
      options.target.width,
      options.target.height,
    );

    context.save();
    try {
      context.clip(clipPath);
      context.transform(scaleX, 0, 0, scaleY, offsetX, offsetY);
      const outlineWidth = this.#outline.enabled
        ? this.#outlineWidth(options.source, scaleX, scaleY)
        : 0;
      if (this.#outline.enabled) {
        context.lineJoin = 'round';
        context.lineCap = 'round';
      }

      for (const mask of state.masks.values()) {
        if (
          hidden.has(mask.objectId) ||
          (options.media === 'video' &&
            mask.frameIndex !== undefined &&
            mask.frameIndex !== options.frameIndex)
        ) {
          continue;
        }
        const traced = this.#path(mask);
        if (traced.empty) continue;
        const color = colorFor(mask.objectId);
        context.fillStyle = color;
        // The raster covers the record's box: scale width × height into bounds.
        context.save();
        try {
          const boundsScaleX = (mask.bounds.right - mask.bounds.left) / mask.width;
          const boundsScaleY = (mask.bounds.bottom - mask.bounds.top) / mask.height;
          context.translate(mask.bounds.left, mask.bounds.top);
          context.scale(boundsScaleX, boundsScaleY);
          this.#paintMask(
            context,
            traced.path,
            color,
            outlineWidth /
              Math.max(
                Math.abs(boundsScaleX),
                Math.abs(boundsScaleY),
                Number.MIN_VALUE,
              ),
          );
        } finally {
          context.restore();
        }
      }
      for (const box of state.boxes.values()) {
        if (
          hidden.has(box.objectId) ||
          (options.media === 'video' &&
            box.frameIndex !== undefined &&
            box.frameIndex !== options.frameIndex)
        ) {
          continue;
        }
        context.strokeStyle = colorFor(box.objectId);
        context.globalAlpha = 1;
        context.lineWidth =
          2 / Math.max(Math.abs(scaleX), Math.abs(scaleY), Number.MIN_VALUE);
        context.strokeRect(
          box.left,
          box.top,
          box.right - box.left,
          box.bottom - box.top,
        );
      }
      if (this.#boxLabels) {
        this.#paintBoxLabels(context, state, options, hidden, {
          scaleX,
          scaleY,
          offsetX,
          offsetY,
        });
      }
    } finally {
      context.restore();
    }
  }

  /**
   * Draws each visible box's label in target CSS pixels, so the label keeps
   * one size whatever the media scale. The label sits on the box's top
   * edge, above the box when the target has room and inside it otherwise, and
   * it is shifted left when it would extend past the target's right edge.
   */
  #paintBoxLabels(
    context: SegmentationCanvasContext,
    state: RetainedState,
    options: SegmentationRenderOptions,
    hidden: ReadonlySet<string>,
    transform: {
      readonly scaleX: number;
      readonly scaleY: number;
      readonly offsetX: number;
      readonly offsetY: number;
    },
  ): void {
    const { scaleX, scaleY, offsetX, offsetY } = transform;
    const { target } = options;
    context.save();
    try {
      // Undo the source-to-target transform; any device-pixel scale stays.
      context.transform(
        1 / scaleX,
        0,
        0,
        1 / scaleY,
        -offsetX / scaleX,
        -offsetY / scaleY,
      );
      context.globalAlpha = 1;
      context.font = BOX_LABEL_FONT;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      for (const box of state.boxes.values()) {
        if (
          hidden.has(box.objectId) ||
          (options.media === 'video' &&
            box.frameIndex !== undefined &&
            box.frameIndex !== options.frameIndex)
        ) {
          continue;
        }
        const text = formatBoxLabel(options.boxLabel, box.objectId, box.confidence);
        const width = context.measureText(text).width + 2 * BOX_LABEL_PADDING;
        const left = offsetX + box.left * scaleX;
        const top = offsetY + box.top * scaleY;
        const x = Math.max(target.x, Math.min(left, target.x + target.width - width));
        const y = top - BOX_LABEL_HEIGHT >= target.y ? top - BOX_LABEL_HEIGHT : top;
        context.fillStyle = colorFor(box.objectId);
        context.fillRect(x, y, width, BOX_LABEL_HEIGHT);
        context.fillStyle = BOX_LABEL_TEXT_COLOR;
        context.fillText(text, x + BOX_LABEL_PADDING, y + BOX_LABEL_HEIGHT / 2);
      }
    } finally {
      context.restore();
    }
  }

  public clear(): void {
    if (this.#disposed) return;
    this.#epoch += 1;
    this.#tail = Promise.resolve();
    this.#state = undefined;
    this.#dropCache();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch += 1;
    this.#tail = Promise.resolve();
    this.#state = undefined;
    this.#dropCache();
  }

  #buildState(result: SegmentationView, reset: boolean): RetainedState {
    const previous =
      !reset && this.#state?.media === result.media ? this.#state : undefined;
    if (!Number.isSafeInteger(result.revision) || result.revision < 0) {
      throw new InvalidRenderOptionsError(
        'Segmentation snapshot revisions must be non-negative safe integers.',
      );
    }
    if (previous !== undefined && result.revision < previous.snapshotRevision) {
      return previous;
    }
    const latestMasks = new Map<string, SegmentationMaskRecord>();
    const boxes = new Map<string, BoxPath>();
    let maskRecords = 0;
    let boxRecords = 0;

    if (result.records.length > this.#limits.maxRecords) {
      throw new SegmentationResourceLimitError('maxRecords');
    }
    for (const record of result.records) {
      validateFrame(record.kind === 'text' ? undefined : record.frame?.frameIndex);
      if (record.kind === 'mask') {
        maskRecords += 1;
        if (maskRecords > this.#limits.maxMasks) {
          throw new SegmentationResourceLimitError('maxMasks');
        }
        this.#preflightMask(record);
        const current = latestMasks.get(record.identity);
        if (current === undefined || record.revision > current.revision) {
          latestMasks.set(record.identity, record);
        } else if (
          record.revision === current.revision &&
          !sameMaskRecord(record, current)
        ) {
          throw new InvalidMaskPayloadError(
            `Mask ${record.identity} has conflicting data at revision ${record.revision}.`,
          );
        }
      } else if (record.kind === 'box') {
        boxRecords += 1;
        if (boxRecords > this.#limits.maxBoxes) {
          throw new SegmentationResourceLimitError('maxBoxes');
        }
        const width = record.right - record.left;
        const height = record.bottom - record.top;
        if (
          !Number.isFinite(record.left) ||
          !Number.isFinite(record.top) ||
          !Number.isFinite(record.right) ||
          !Number.isFinite(record.bottom) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width < 0 ||
          height < 0
        ) {
          throw new InvalidRenderOptionsError('Box coordinates are invalid.');
        }
        if (
          record.confidence !== undefined &&
          (!Number.isFinite(record.confidence) ||
            record.confidence < 0 ||
            record.confidence > 1)
        ) {
          throw new InvalidRenderOptionsError(
            'Box confidence must be a number from 0 through 1.',
          );
        }
        const identity = boxIdentity(record);
        boxes.set(identity, {
          identity,
          objectId: record.objectId,
          ...(record.frame === undefined
            ? {}
            : { frameIndex: record.frame.frameIndex }),
          left: record.left,
          top: record.top,
          right: record.right,
          bottom: record.bottom,
          ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
        });
      }
    }
    const masks = new Map<string, RetainedMask>();
    let complexity = 0;
    for (const box of boxes.values()) {
      complexity += JSON.stringify([
        box.identity,
        box.objectId,
        box.frameIndex ?? null,
        box.left,
        box.top,
        box.right,
        box.bottom,
        box.confidence ?? null,
      ]).length;
      if (complexity > this.#limits.maxRetainedComplexity) {
        throw new SegmentationResourceLimitError('maxRetainedComplexity');
      }
    }
    for (const record of latestMasks.values()) {
      const prior = previous?.masks.get(record.identity);
      let retained: RetainedMask;
      if (prior !== undefined && record.revision < prior.revision) {
        retained = prior;
      } else if (prior?.revision === record.revision) {
        if (!sameMaskRecord(prior.record, record)) {
          throw new InvalidMaskPayloadError(
            `Mask ${record.identity} has conflicting data at revision ${record.revision}.`,
          );
        }
        retained = prior;
      } else {
        retained = retainMask(record);
      }
      complexity += retained.identity.length + RETAINED_MASK_OVERHEAD;
      if (complexity > this.#limits.maxRetainedComplexity) {
        throw new SegmentationResourceLimitError('maxRetainedComplexity');
      }
      masks.set(record.identity, retained);
    }
    return {
      media: result.media,
      snapshotRevision: result.revision,
      masks,
      boxes,
      complexity,
    };
  }

  #preflightMask(record: SegmentationMaskRecord): void {
    const { mask } = record;
    if (mask.encoding !== 'one_bit' && mask.encoding !== 'lossless') {
      throw new UnsupportedMaskEncodingError(mask.encoding);
    }
    if (
      !Number.isSafeInteger(record.order) ||
      record.order < 0 ||
      !Number.isSafeInteger(record.revision) ||
      record.revision <= 0 ||
      record.identity.length === 0 ||
      record.objectId.length === 0
    ) {
      throw new InvalidMaskPayloadError(
        'Mask record identity and revision are invalid.',
      );
    }
    if (
      !Number.isSafeInteger(mask.width) ||
      !Number.isSafeInteger(mask.height) ||
      mask.width <= 0 ||
      mask.height <= 0
    ) {
      throw new InvalidMaskPayloadError(
        'Mask dimensions must be positive safe integers.',
      );
    }
    if (
      record.bounds === undefined ||
      ![
        record.bounds.left,
        record.bounds.top,
        record.bounds.right,
        record.bounds.bottom,
      ].every(Number.isFinite) ||
      record.bounds.right <= record.bounds.left ||
      record.bounds.bottom <= record.bounds.top
    ) {
      throw new InvalidMaskPayloadError('Mask bounds are invalid.');
    }
    const area = mask.width * mask.height;
    if (!Number.isSafeInteger(area) || area > this.#limits.maxMaskArea) {
      throw new SegmentationResourceLimitError('maxMaskArea');
    }
    if (mask.payload.length > this.#limits.maxMaskPayloadLength) {
      throw new SegmentationResourceLimitError('maxMaskPayloadLength');
    }
  }

  /**
   * The contour width in source pixels. The default is relative to the source
   * resolution, so a mask keeps the same visual weight whatever the media size
   * is; the CSS-pixel fallback only applies when the source cannot supply one.
   */
  #outlineWidth(source: Rectangle, scaleX: number, scaleY: number): number {
    if (this.#outline.width !== null) return this.#outline.width;
    const shortest = Math.min(source.width, source.height);
    if (Number.isFinite(shortest) && shortest > 0) {
      return MASK_OUTLINE_WIDTH_RATIO * shortest;
    }
    return (
      FALLBACK_MASK_OUTLINE_WIDTH /
      Math.max(Math.abs(scaleX), Math.abs(scaleY), Number.MIN_VALUE)
    );
  }

  /**
   * Fills the contour and strokes the same path, so the translucent body and
   * the crisp edge always agree. `width` is in the coordinate space in force,
   * which is source pixels unless a box-local mask added its own bounds scale.
   */
  #paintMask(
    context: SegmentationCanvasContext,
    path: Path2D,
    color: string,
    width: number,
  ): void {
    context.globalAlpha = this.#maskFillOpacity;
    context.fill(path, 'evenodd');
    if (!this.#outline.enabled) return;
    context.strokeStyle = color;
    context.globalAlpha = this.#outline.opacity;
    context.lineWidth = width;
    context.stroke(path);
  }

  #path(mask: RetainedMask): CachedPath {
    const cached = this.#cache.get(mask);
    if (cached !== undefined) {
      this.#cache.delete(mask);
      this.#cache.set(mask, cached);
      return cached;
    }
    const Constructor = (globalThis as typeof globalThis & { Path2D?: typeof Path2D })
      .Path2D;
    if (Constructor === undefined) throw new Path2DUnavailableError();
    const traced = traceMask(mask.record.mask, this.#limits.maxPathComplexity);
    const entry: CachedPath = {
      path: new Constructor(traced.d),
      complexity: traced.complexity,
      empty: traced.d.length === 0,
    };
    this.#cache.set(mask, entry);
    this.#cacheComplexity += entry.complexity;
    this.#evict();
    return entry;
  }

  #evict(): void {
    while (
      this.#cache.size > this.#limits.maxCachedPaths ||
      this.#cacheComplexity > this.#limits.maxCachedComplexity
    ) {
      const first = this.#cache.entries().next().value as
        [RetainedMask, CachedPath] | undefined;
      if (first === undefined) return;
      this.#cache.delete(first[0]);
      this.#cacheComplexity -= first[1].complexity;
    }
  }

  #pruneCache(state: RetainedState): void {
    const retained = new Set(state.masks.values());
    for (const [key, cached] of this.#cache) {
      if (retained.has(key)) continue;
      this.#cache.delete(key);
      this.#cacheComplexity -= cached.complexity;
    }
  }

  #dropCache(): void {
    this.#cache.clear();
    this.#cacheComplexity = 0;
  }
}
