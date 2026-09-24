/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { InvalidSegmentationMaskError } from './errors.js';
import { decodeMaskToRaster } from './mask-codec.js';
import { parseResponsesStream } from './stream.js';
import type {
  ParsedResponsesStream,
  ResponseFormat,
  ResponseFormatParser,
  ResponseStreamOutcome,
} from './types.js';

export interface FrameReference {
  readonly frameIndex: number;
}

/** The wire encodings of a mask payload: `~` selects `lossless`, `!` selects `one_bit`. */
export type SegmentationMaskEncoding = 'lossless' | 'one_bit';

/**
 * One complete mask exactly as the SAM API emitted it. `payload` is the base85
 * text after the encoding marker and is never partial; `width` and `height` are
 * the raster's own dimensions, not the frame's.
 */
export interface SegmentationMask {
  readonly encoding: SegmentationMaskEncoding;
  readonly payload: string;
  readonly width: number;
  readonly height: number;
}

interface RecordBase {
  readonly order: number;
  readonly objectId: string;
  readonly frame?: FrameReference;
}

export interface SegmentationTextRecord {
  readonly kind: 'text';
  readonly order: number;
  readonly text: string;
}

export interface SegmentationBoxRecord extends RecordBase {
  readonly kind: 'box';
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /**
   * Detection confidence from the box token's optional `c` field, a finite
   * number from 0 through 1. Absent when the API omitted `c`; absence does not
   * mean zero.
   */
  readonly confidence?: number;
}

export interface SegmentationMaskBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface SegmentationMaskRecord extends RecordBase {
  readonly kind: 'mask';
  readonly identity: string;
  readonly revision: number;
  readonly mask: SegmentationMask;
  /** The half-open source-pixel box the raster covers; the record's box. */
  readonly bounds: SegmentationMaskBounds;
  /**
   * Detection confidence from the mask token's optional `c` field, a finite
   * number from 0 through 1. Absent when the API omitted `c`; absence does not
   * mean zero.
   */
  readonly confidence?: number;
}

export type SegmentationRecord =
  SegmentationTextRecord | SegmentationBoxRecord | SegmentationMaskRecord;

export type SegmentationRecordKind = SegmentationRecord['kind'];

export type SegmentationRecordOfKind<Kind extends SegmentationRecordKind> = Extract<
  SegmentationRecord,
  { readonly kind: Kind }
>;

export interface SegmentationDiagnostic {
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly raw: string;
}

interface SegmentationViewBase {
  readonly revision: number;
  readonly records: readonly SegmentationRecord[];
  readonly diagnostics: readonly SegmentationDiagnostic[];
  readonly rawOutput: string;
}

export interface ImageSegmentationSnapshot extends SegmentationViewBase {
  readonly media: 'image';
}

export interface VideoSegmentationSnapshot extends SegmentationViewBase {
  readonly media: 'video';
}

export type SegmentationSnapshot =
  ImageSegmentationSnapshot | VideoSegmentationSnapshot;

export interface ImageSegmentationResult extends ImageSegmentationSnapshot {
  readonly outcome: ResponseStreamOutcome;
}

export interface VideoSegmentationResult extends VideoSegmentationSnapshot {
  readonly outcome: ResponseStreamOutcome;
}

export type SegmentationResult = ImageSegmentationResult | VideoSegmentationResult;

type SegmentationMedia = SegmentationResult['media'];
type SegmentationSnapshotFor<Media extends SegmentationMedia> = Media extends 'image'
  ? ImageSegmentationSnapshot
  : VideoSegmentationSnapshot;
type SegmentationResultFor<Media extends SegmentationMedia> = Media extends 'image'
  ? ImageSegmentationResult
  : VideoSegmentationResult;

/**
 * The SAM API record grammar. A line is a frame header `<Nf>`, optionally with
 * `;key=value` fields before its `>`, followed by records. A record is an
 * ASCII-decimal object id followed by tokens `<|name|>` or `<|name;fields|>`;
 * it needs exactly one `box` and one `mask` token, in any order, and other
 * tokens are ignored with a warning. The payload alphabet never contains `|`
 * or `;`, so `[^|]*` ends exactly at a token's closing `|>` and every `;`
 * separates fields; `,` before a record is the wire separator and is optional.
 * The sticky patterns are only read through `matchAt`.
 */
const frameHeaderPattern = /^<(\d+)f(?:;([^>]*))?>(.*)$/;
const recordStartPattern = /,?([0-9]+)(?=<\|)/y;
const tokenPattern = /<\|([A-Za-z][A-Za-z0-9_.-]*)(?:;([^|]*))?\|>/y;
const recordBoundaryPattern = /^[,0-9]$/;
const signedIntegerPattern = /^-?[0-9]+$/;
const unsignedIntegerPattern = /^[0-9]+$/;
const maskDataPattern = /^([0-9]+),([0-9]+),([!~][^|]+)$/;
const confidencePattern = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

const boxFieldKeys: ReadonlySet<string> = new Set([
  'x1',
  'y1',
  'x2',
  'y2',
  'w',
  'h',
  'c',
]);
const maskFieldKeys: ReadonlySet<string> = new Set(['x', 'y', 'data', 'c']);
const frameHeaderFieldKeys: ReadonlySet<string> = new Set();

function matchAt(pattern: RegExp, text: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(text);
}

type FieldOwner = 'box' | 'mask' | 'frame header';

/**
 * Something the parser ignored while keeping the record it belongs to. It is
 * reported as a `warning` diagnostic only when that record is accepted, and
 * each code and subject is reported once per stream.
 */
interface PendingWarning {
  readonly code: 'ignored_field' | 'ignored_token' | 'ignored_confidence';
  readonly subject: string;
  readonly message: string;
}

interface FieldRead {
  /** Field values by key; `null` is a field written without `=`. */
  readonly values: ReadonlyMap<string, string | null>;
  /** `c` appeared more than once, so no single value can be trusted. */
  readonly repeatedConfidence: boolean;
}

interface ApiToken {
  readonly name: string;
  readonly body: string | undefined;
}

/**
 * Reads one `;`-separated field list. Whitespace around keys and values is
 * trimmed and empty fields are skipped. A field without `=` has no value. A
 * key the owner does not define is ignored with an `ignored_field` warning.
 * A repeated key the owner defines makes the record malformed (`undefined`),
 * except `c`, which is reported through `repeatedConfidence`.
 */
function readFields(
  body: string | undefined,
  owner: FieldOwner,
  known: ReadonlySet<string>,
  warnings: PendingWarning[],
): FieldRead | undefined {
  const values = new Map<string, string | null>();
  let repeatedConfidence = false;
  for (const part of body === undefined ? [] : body.split(';')) {
    const field = part.trim();
    if (field.length === 0) continue;
    const separator = field.indexOf('=');
    const key = (separator < 0 ? field : field.slice(0, separator)).trim();
    const value = separator < 0 ? null : field.slice(separator + 1).trim();
    if (!known.has(key)) {
      const name = key.length > 0 ? key : field;
      warnings.push({
        code: 'ignored_field',
        subject: `${owner}:${name}`,
        message: `Ignored unknown ${owner} field "${name}".`,
      });
      continue;
    }
    if (values.has(key)) {
      if (key !== 'c') return undefined;
      repeatedConfidence = true;
      continue;
    }
    values.set(key, value);
  }
  return { values, repeatedConfidence };
}

/**
 * Reads the optional `c` field. An absent field gives `undefined`. A field
 * that is not one finite decimal number from 0 through 1 also gives
 * `undefined`, with an `ignored_confidence` warning: the record is kept.
 */
function readConfidence(
  fields: FieldRead,
  warnings: PendingWarning[],
): number | undefined {
  if (!fields.values.has('c')) return undefined;
  const text = fields.values.get('c');
  const value =
    !fields.repeatedConfidence &&
    typeof text === 'string' &&
    confidencePattern.test(text)
      ? Number(text)
      : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    warnings.push({
      code: 'ignored_confidence',
      subject: 'c',
      message: 'Ignored a confidence value that is not a number from 0 through 1.',
    });
    return undefined;
  }
  return value === 0 ? 0 : value;
}

function withConfidence(confidence: number | undefined): { confidence?: number } {
  return confidence === undefined ? {} : { confidence };
}

interface ApiRecordFields {
  readonly objectId: string;
  readonly box: readonly [number, number, number, number, number, number];
  readonly maskHeight: number;
  readonly maskWidth: number;
  readonly payload: string;
  readonly boxConfidence: number | undefined;
  readonly maskConfidence: number | undefined;
}

/**
 * Returns the record's fields, or `undefined` when the record is malformed.
 * Warnings go to `warnings` in a fixed order: ignored tokens, box fields,
 * mask fields, then box and mask confidence.
 */
function readApiRecord(
  objectId: string,
  tokens: readonly ApiToken[],
  warnings: PendingWarning[],
): ApiRecordFields | undefined {
  const boxTokens = tokens.filter((token) => token.name === 'box');
  const maskTokens = tokens.filter((token) => token.name === 'mask');
  if (boxTokens.length !== 1 || maskTokens.length !== 1) return undefined;
  for (const token of tokens) {
    if (token.name === 'box' || token.name === 'mask') continue;
    warnings.push({
      code: 'ignored_token',
      subject: token.name,
      message: `Ignored unknown token "${token.name}".`,
    });
  }
  const box = readFields(boxTokens[0]!.body, 'box', boxFieldKeys, warnings);
  const mask = readFields(maskTokens[0]!.body, 'mask', maskFieldKeys, warnings);
  if (box === undefined || mask === undefined) return undefined;
  const coordinates = ['x1', 'y1', 'x2', 'y2'].map((key) => box.values.get(key));
  const dimensions = ['w', 'h'].map((key) => box.values.get(key));
  if (
    !coordinates.every(
      (value) => typeof value === 'string' && signedIntegerPattern.test(value),
    ) ||
    !dimensions.every(
      (value) => typeof value === 'string' && unsignedIntegerPattern.test(value),
    ) ||
    mask.values.get('x') !== '0' ||
    mask.values.get('y') !== '0'
  ) {
    return undefined;
  }
  const data = maskDataPattern.exec(mask.values.get('data') ?? '');
  if (data === null) return undefined;
  return {
    objectId,
    box: [...coordinates, ...dimensions].map((value) => {
      const parsed = Number(value);
      return parsed === 0 ? 0 : parsed;
    }) as unknown as ApiRecordFields['box'],
    maskHeight: Number(data[1]),
    maskWidth: Number(data[2]),
    payload: data[3]!,
    boxConfidence: readConfidence(box, warnings),
    maskConfidence: readConfidence(mask, warnings),
  };
}

function freezeFrame(frameIndex: number | undefined): FrameReference | undefined {
  return frameIndex === undefined ? undefined : Object.freeze({ frameIndex });
}

function freezeRecord<T extends SegmentationRecord>(record: T): T {
  if (record.kind === 'mask') Object.freeze(record.mask);
  if ('frame' in record && record.frame !== undefined) Object.freeze(record.frame);
  return Object.freeze(record);
}

class SegmentationParser<
  Media extends SegmentationMedia,
> implements ResponseFormatParser<
  SegmentationSnapshotFor<Media>,
  SegmentationResultFor<Media>
> {
  readonly #media: Media;
  readonly #records: SegmentationRecord[] = [];
  readonly #diagnostics: SegmentationDiagnostic[] = [];
  readonly #revisions = new Map<string, number>();
  readonly #warned = new Set<string>();
  #rawOutput = '';
  readonly #bufferParts: string[] = [];
  #line = 0;
  #revision = 0;

  public constructor(media: Media) {
    this.#media = media;
  }

  public push(
    chunk: string,
    options: { readonly emit?: boolean } = {},
  ): readonly SegmentationSnapshotFor<Media>[] {
    if (typeof chunk !== 'string')
      throw new TypeError('Parser chunks must be strings.');
    this.#rawOutput += chunk;

    let changed = false;
    const segments = chunk.split('\n');
    for (const segment of segments.slice(0, -1)) {
      this.#appendBuffer(segment);
      const buffered = this.#bufferParts.join('');
      const line = buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
      this.#clearBuffer();
      const priorRecords = this.#records.length;
      const priorDiagnostics = this.#diagnostics.length;
      this.#acceptLine(line);
      changed =
        changed ||
        priorRecords !== this.#records.length ||
        priorDiagnostics !== this.#diagnostics.length;
    }
    this.#appendBuffer(segments.at(-1)!);

    if (changed) this.#revision += 1;
    return changed && options.emit !== false ? [this.#snapshot()] : [];
  }

  public finish(outcome: ResponseStreamOutcome): {
    readonly events?: readonly SegmentationSnapshotFor<Media>[];
    readonly result: SegmentationResultFor<Media>;
  } {
    const events: SegmentationSnapshotFor<Media>[] = [];
    if (this.#bufferParts.length > 0) {
      const buffered = this.#bufferParts.join('');
      const line = buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
      this.#clearBuffer();
      const priorRecords = this.#records.length;
      const priorDiagnostics = this.#diagnostics.length;
      this.#acceptLine(line);
      if (
        priorRecords !== this.#records.length ||
        priorDiagnostics !== this.#diagnostics.length
      ) {
        this.#revision += 1;
        events.push(this.#snapshot());
      }
    }
    const view = this.#view();
    return {
      events,
      result: Object.freeze({
        ...view,
        outcome: Object.freeze({ ...outcome }),
      }) as unknown as SegmentationResultFor<Media>,
    };
  }

  #appendBuffer(value: string): void {
    if (value.length > 0) this.#bufferParts.push(value);
  }

  #clearBuffer(): void {
    this.#bufferParts.length = 0;
  }

  #acceptLine(raw: string): boolean {
    this.#line += 1;
    const line = raw.trim();
    if (line.length === 0) return false;

    if (line.startsWith('<')) {
      const accepted = this.#acceptApiLine(line, raw);
      if (accepted !== undefined) return accepted;
    }

    this.#addRecord(
      freezeRecord({ kind: 'text', order: this.#records.length, text: raw }),
    );
    return true;
  }

  #acceptApiLine(line: string, raw: string): boolean | undefined {
    const header = frameHeaderPattern.exec(line);
    if (header === null) return undefined;
    const frameIndex = Number(header[1]);
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      this.#diagnose(
        'invalid_frame',
        'Frame references must be non-negative safe integers.',
        raw,
      );
      return true;
    }
    if (this.#media === 'image' && frameIndex !== 0) {
      this.#diagnose(
        'unexpected_frame',
        'Image segmentation records require frame zero.',
        raw,
      );
      return true;
    }

    const frame = this.#media === 'video' ? freezeFrame(frameIndex) : undefined;
    // Header warnings are reported with the line's first accepted record.
    const headerWarnings: PendingWarning[] = [];
    readFields(header[2], 'frame header', frameHeaderFieldKeys, headerWarnings);
    const body = header[3]!;
    if (body.length === 0) {
      this.#diagnose('malformed_record', 'Malformed SAM API object record.', raw);
      return true;
    }
    let accepted = false;
    let position = 0;
    while (position < body.length) {
      const start = matchAt(recordStartPattern, body, position);
      const tokens: ApiToken[] = [];
      let end = start === null ? position : position + start[0].length;
      for (
        let token = start === null ? null : matchAt(tokenPattern, body, end);
        token !== null;
        token = matchAt(tokenPattern, body, end)
      ) {
        tokens.push({ name: token[1]!, body: token[2] });
        end += token[0].length;
      }
      const recordWarnings: PendingWarning[] = [];
      const fields =
        start === null || (end < body.length && !recordBoundaryPattern.test(body[end]!))
          ? undefined
          : readApiRecord(start[1]!, tokens, recordWarnings);
      if (fields === undefined) {
        this.#diagnose('malformed_record', 'Malformed SAM API object record.', raw);
        return true;
      }
      const { objectId, maskHeight, maskWidth, payload } = fields;
      const [left, top, inclusiveRight, inclusiveBottom, sourceWidth, sourceHeight] =
        fields.box;
      if (
        ![left, top, inclusiveRight, inclusiveBottom, sourceWidth, sourceHeight].every(
          Number.isSafeInteger,
        ) ||
        sourceWidth <= 0 ||
        sourceHeight <= 0 ||
        left < 0 ||
        top < 0 ||
        inclusiveRight < left ||
        inclusiveBottom < top ||
        inclusiveRight >= sourceWidth ||
        inclusiveBottom >= sourceHeight
      ) {
        this.#diagnose('invalid_box', 'SAM API box coordinates are invalid.', raw);
        return true;
      }
      const { boxConfidence, maskConfidence } = fields;
      this.#warn(headerWarnings.splice(0), raw);
      this.#warn(recordWarnings, raw);
      const bounds = Object.freeze({
        left,
        top,
        right: inclusiveRight + 1,
        bottom: inclusiveBottom + 1,
      });
      this.#addRecord(
        freezeRecord({
          kind: 'box',
          order: this.#records.length,
          objectId,
          ...(frame === undefined ? {} : { frame }),
          ...bounds,
          ...withConfidence(boxConfidence),
        }),
      );
      this.#acceptMask(
        objectId,
        frame,
        {
          encoding: payload.startsWith('~') ? 'lossless' : 'one_bit',
          payload,
          width: maskWidth,
          height: maskHeight,
        },
        raw,
        bounds,
        maskConfidence,
      );
      accepted = true;
      position = end;
    }
    return accepted;
  }

  #acceptMask(
    objectId: string,
    frame: FrameReference | undefined,
    mask: SegmentationMask,
    raw: string,
    bounds: SegmentationMaskBounds,
    confidence: number | undefined,
  ): void {
    const { width, height } = mask;
    if (width <= 0 || height <= 0 || !Number.isSafeInteger(width * height)) {
      this.#diagnose('invalid_mask_size', 'Mask dimensions must be positive.', raw);
      return;
    }
    try {
      decodeMaskToRaster(mask);
    } catch (error) {
      if (!(error instanceof InvalidSegmentationMaskError)) throw error;
      this.#diagnose('invalid_mask_payload', error.message, raw);
      return;
    }
    const identity = `${this.#media}:${frame?.frameIndex ?? '*'}:${objectId}`;
    const revision = (this.#revisions.get(identity) ?? 0) + 1;
    this.#revisions.set(identity, revision);
    this.#addRecord(
      freezeRecord({
        kind: 'mask',
        order: this.#records.length,
        objectId,
        ...(frame === undefined ? {} : { frame }),
        identity,
        revision,
        mask: Object.freeze({ ...mask }),
        bounds,
        ...withConfidence(confidence),
      }),
    );
  }

  #addRecord(record: SegmentationRecord): void {
    this.#records.push(record);
  }

  /**
   * Reports each ignored item as a `warning` the first time its code and
   * subject appear in this stream; the data it came with was kept.
   */
  #warn(warnings: readonly PendingWarning[], raw: string): void {
    for (const warning of warnings) {
      const key = `${warning.code}\u0000${warning.subject}`;
      if (this.#warned.has(key)) continue;
      this.#warned.add(key);
      this.#diagnostics.push(
        Object.freeze({
          severity: 'warning',
          code: warning.code,
          message: warning.message,
          line: this.#line,
          raw,
        }),
      );
    }
  }

  #diagnose(code: string, message: string, raw: string): void {
    this.#diagnostics.push(
      Object.freeze({ severity: 'error', code, message, line: this.#line, raw }),
    );
  }

  #view(): SegmentationSnapshotFor<Media> {
    const common = {
      revision: this.#revision,
      records: Object.freeze([...this.#records]),
      diagnostics: Object.freeze([...this.#diagnostics]),
      rawOutput: this.#rawOutput,
    };
    return Object.freeze({
      media: this.#media,
      ...common,
    }) as SegmentationSnapshotFor<Media>;
  }

  #snapshot(): SegmentationSnapshotFor<Media> {
    return this.#view();
  }
}

function segmentationFormat<Media extends SegmentationMedia>(
  media: Media,
): ResponseFormat<SegmentationSnapshotFor<Media>, SegmentationResultFor<Media>> {
  return Object.freeze({
    createParser: () => new SegmentationParser(media),
  });
}

function imageSegmentationFormat(): ResponseFormat<
  ImageSegmentationSnapshot,
  ImageSegmentationResult
> {
  if (arguments.length !== 0) {
    throw new TypeError('formats.segmentation.image() does not accept arguments.');
  }
  return segmentationFormat('image');
}

function videoSegmentationFormat(): ResponseFormat<
  VideoSegmentationSnapshot,
  VideoSegmentationResult
> {
  if (arguments.length !== 0) {
    throw new TypeError('formats.segmentation.video() does not accept arguments.');
  }
  return segmentationFormat('video');
}

const segmentation = Object.freeze({
  image: imageSegmentationFormat,
  video: videoSegmentationFormat,
});

export const formats = Object.freeze({ segmentation });

export function parseImageStream<SourceEventType extends { readonly type: string }>(
  source: AsyncIterable<SourceEventType>,
): ParsedResponsesStream<ImageSegmentationSnapshot, ImageSegmentationResult> {
  return parseResponsesStream(source, segmentation.image());
}

export function parseVideoStream<SourceEventType extends { readonly type: string }>(
  source: AsyncIterable<SourceEventType>,
): ParsedResponsesStream<VideoSegmentationSnapshot, VideoSegmentationResult> {
  return parseResponsesStream(source, segmentation.video());
}

export function frameIndexOf(record: SegmentationRecord): number | undefined {
  return record.kind === 'text' ? undefined : record.frame?.frameIndex;
}

export function recordsOfKind<Kind extends SegmentationRecordKind>(
  records: readonly SegmentationRecord[],
  kind: Kind,
): readonly SegmentationRecordOfKind<Kind>[] {
  return Object.freeze(
    records.filter(
      (record): record is SegmentationRecordOfKind<Kind> => record.kind === kind,
    ),
  );
}
