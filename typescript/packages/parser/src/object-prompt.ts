/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/**
 * Builds the object-prompt text a SAM API request sends as `input_text`: one
 * block per source frame, each an object id followed by a box and points. See
 * "SAM API input" in the protocol document. The builder only formats text; it
 * does not send requests, and the API remains the authority on which prompts it
 * accepts.
 */

/** A positive point marks part of the object; a negative point marks a region that is not. */
export type PromptPointLabel = 'positive' | 'negative';

/**
 * The media's width and height in pixels, as displayed after any rotation the
 * file specifies. Every prompt coordinate is in this space, so scale coordinates
 * from a scaled or cropped view to it before building the prompt.
 */
export interface PromptSize {
  readonly width: number;
  readonly height: number;
}

/**
 * A box with half-open `right` and `bottom`, the same shape as a parsed
 * `SegmentationBoxRecord`, so a parsed record can be passed as is.
 */
export interface PromptBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PromptPoint {
  readonly x: number;
  readonly y: number;
  /** Defaults to `'positive'`. */
  readonly label?: PromptPointLabel;
}

/** One object's prompts on one source frame. */
export interface FramePrompt {
  /** The zero-based source frame. Defaults to 0, the only frame of an image. */
  readonly frame?: number;
  readonly box?: PromptBox;
  readonly points?: readonly PromptPoint[];
}

export interface PromptObject {
  /**
   * The id the response reports the object under: a non-negative integer, or
   * its decimal string such as a parsed record's `objectId`.
   */
  readonly id: number | string;
  readonly prompts: readonly FramePrompt[];
}

export interface BuildObjectPromptOptions {
  readonly size: PromptSize;
  readonly objects: readonly PromptObject[];
}

export type ObjectPromptErrorCode =
  | 'no_objects'
  | 'invalid_size'
  | 'invalid_object_id'
  | 'duplicate_object_id'
  | 'empty_object'
  | 'invalid_frame'
  | 'duplicate_frame'
  | 'empty_prompt'
  | 'invalid_box'
  | 'invalid_point'
  | 'invalid_point_label';

/** Thrown for input the builder cannot encode as object-prompt text. */
export class ObjectPromptError extends Error {
  public constructor(
    message: string,
    public readonly code: ObjectPromptErrorCode,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

const canonicalDecimal = /^(?:0|[1-9][0-9]*)$/;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function objectIdText(id: unknown): string {
  if (isNonNegativeInteger(id)) return String(id);
  if (
    typeof id === 'string' &&
    canonicalDecimal.test(id) &&
    Number.isSafeInteger(Number(id))
  ) {
    return id;
  }
  throw new ObjectPromptError(
    `Object id ${JSON.stringify(id)} is not a non-negative integer or its decimal string.`,
    'invalid_object_id',
  );
}

function boxToken(box: PromptBox, size: PromptSize, view: string): string {
  const { left, top, right, bottom } = box ?? ({} as PromptBox);
  const valid =
    [left, top, right, bottom].every(isNonNegativeInteger) &&
    left < right &&
    top < bottom &&
    right <= size.width &&
    bottom <= size.height;
  if (!valid) {
    throw new ObjectPromptError(
      `Box ${JSON.stringify(box)} must have integer edges with left < right <= ${size.width} and top < bottom <= ${size.height}.`,
      'invalid_box',
    );
  }
  return `<|box;x1=${left};y1=${top};x2=${right - 1};y2=${bottom - 1};${view}|>`;
}

function pointToken(point: PromptPoint, size: PromptSize, view: string): string {
  const { x, y, label = 'positive' } = point ?? ({} as PromptPoint);
  if (
    !isNonNegativeInteger(x) ||
    !isNonNegativeInteger(y) ||
    x >= size.width ||
    y >= size.height
  ) {
    throw new ObjectPromptError(
      `Point ${JSON.stringify(point)} must have integer coordinates inside the ${size.width}x${size.height} media.`,
      'invalid_point',
    );
  }
  if (label !== 'positive' && label !== 'negative') {
    throw new ObjectPromptError(
      `Point label ${JSON.stringify(label)} must be 'positive' or 'negative'.`,
      'invalid_point_label',
    );
  }
  return `${label === 'negative' ? '-' : ''}<|point;x=${x};y=${y};${view}|>`;
}

/**
 * Builds object-prompt text for a SAM API request.
 *
 * Frames are emitted in ascending order, objects in input order within a frame,
 * and each object's box before its points. Throws `ObjectPromptError` for input
 * it cannot encode: a size or coordinate that is not a non-negative integer,
 * a box or point outside `size`, an empty box, an object or frame prompt with no
 * box and no points, or the same object or frame given twice.
 */
export function buildObjectPrompt(options: BuildObjectPromptOptions): string {
  const { size, objects } = options;
  if (
    size === null ||
    typeof size !== 'object' ||
    !isNonNegativeInteger(size.width) ||
    !isNonNegativeInteger(size.height) ||
    size.width === 0 ||
    size.height === 0
  ) {
    throw new ObjectPromptError(
      `Size ${JSON.stringify(size)} must have positive integer width and height.`,
      'invalid_size',
    );
  }
  if (!Array.isArray(objects) || objects.length === 0) {
    throw new ObjectPromptError('At least one object is required.', 'no_objects');
  }
  const view = `w=${size.width};h=${size.height}`;
  const seenIds = new Set<string>();
  const segmentsByFrame = new Map<number, string[]>();
  for (const object of objects) {
    const id = objectIdText(object?.id);
    if (seenIds.has(id)) {
      throw new ObjectPromptError(
        `Object ${id} is given more than once; list all of its frames in one object.`,
        'duplicate_object_id',
      );
    }
    seenIds.add(id);
    if (!Array.isArray(object.prompts) || object.prompts.length === 0) {
      throw new ObjectPromptError(`Object ${id} has no prompts.`, 'empty_object');
    }
    const seenFrames = new Set<number>();
    for (const prompt of object.prompts) {
      const frame = prompt?.frame ?? 0;
      if (!isNonNegativeInteger(frame)) {
        throw new ObjectPromptError(
          `Frame ${JSON.stringify(frame)} of object ${id} is not a non-negative integer.`,
          'invalid_frame',
        );
      }
      if (seenFrames.has(frame)) {
        throw new ObjectPromptError(
          `Object ${id} has more than one prompt on frame ${frame}.`,
          'duplicate_frame',
        );
      }
      seenFrames.add(frame);
      const points: readonly PromptPoint[] = prompt.points ?? [];
      if (prompt.box === undefined && points.length === 0) {
        throw new ObjectPromptError(
          `Object ${id} has neither a box nor points on frame ${frame}.`,
          'empty_prompt',
        );
      }
      const tokens = [
        ...(prompt.box === undefined ? [] : [boxToken(prompt.box, size, view)]),
        ...points.map((point) => pointToken(point, size, view)),
      ];
      const segments = segmentsByFrame.get(frame) ?? [];
      segments.push(`${id}${tokens.join('')}`);
      segmentsByFrame.set(frame, segments);
    }
  }
  return [...segmentsByFrame.keys()]
    .sort((a, b) => a - b)
    .map((frame) => `<${frame}f>${segmentsByFrame.get(frame)!.join(',')}`)
    .join('');
}
