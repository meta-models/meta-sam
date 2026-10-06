/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { once } from 'node:events';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { isIP } from 'node:net';

export const MAX_MEDIA_SIZE = 20 * 1024 * 1024;
export const MAX_REQUEST_SIZE = MAX_MEDIA_SIZE + 64 * 1024;
export const MAX_PROMPT_LENGTH = 160;
export const MAX_FILENAME_LENGTH = 200;
export const MAX_FILE_ID_LENGTH = 126;
export const MAX_MODEL_ID_LENGTH = 120;
export const MAX_SCORE_THRESHOLD_LENGTH = 32;
/** `include_confidence` is exactly `true` or `false`. */
const MAX_INCLUDE_CONFIDENCE_LENGTH = 5;
/** A plain decimal: digits with an optional fraction, or a fraction alone. */
const SCORE_THRESHOLD_PATTERN = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
/** The opaque Files API handle the browser is allowed to hold and send back. */
export const FILE_ID_PATTERN = /^file-[A-Za-z0-9_-]{1,120}$/;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const uploadFields = new Set(['media']);
const responsesFields = new Set([
  'prompt',
  'model',
  'media',
  'file_id',
  'score_threshold',
  'include_confidence',
]);
const MODEL_CACHE_TTL = 5 * 60 * 1_000;
const MAX_STREAM_SIZE = 64 * 1024 * 1024;
// Terminal Responses events (`content_part.done`, `output_item.done`,
// `response.completed`) echo the whole output text, so one event can be as
// large as the entire segmentation output.
const MAX_EVENT_SIZE = 48 * 1024 * 1024;
const MAX_EVENTS = 200_000;
const STREAM_IDLE_LIMIT = 120_000;
const MULTIPART_CONTENT_TYPE = /^multipart\/form-data\s*;/i;
const allowedImageTypes = new Map([
  ['image/png', 'image/png'],
  ['image/jpeg', 'image/jpeg'],
  ['image/jpg', 'image/jpeg'],
  ['image/webp', 'image/webp'],
  ['image/gif', 'image/gif'],
]);
const allowedVideoTypes = new Map([['video/mp4', 'video/mp4']]);

type MediaKind = 'image' | 'video';

type MultipartMedia = {
  bytes: Buffer;
  filename?: string;
  contentType?: string;
};

export type MultipartFields = {
  prompt?: string;
  model?: string;
  file_id?: string;
  score_threshold?: string;
  include_confidence?: string;
  media?: MultipartMedia;
};

type MultipartTextField =
  'prompt' | 'model' | 'file_id' | 'score_threshold' | 'include_confidence';

export type ValidatedMedia = Readonly<
  | {
      kind: 'image';
      mimeType: string;
      filename: string;
      bytes: Buffer;
    }
  | {
      kind: 'video';
      mimeType: string;
      filename: string;
      bytes: Buffer;
    }
>;

export type ImageRelayInput = Readonly<{
  prompt: string;
  model?: string;
  kind: 'image';
  media: ValidatedMedia & { kind: 'image' };
  /** Minimum detection score from 0 through 1; absent means no filtering. */
  scoreThreshold?: number;
  /** Whether to ask for the optional `c` confidence; absent sends nothing. */
  includeConfidence?: boolean;
}>;

export type VideoRelayInput = Readonly<{
  prompt: string;
  model?: string;
  kind: 'video';
  fileId: string;
  /** Whether to ask for the optional `c` confidence; absent sends nothing. */
  includeConfidence?: boolean;
}>;

export type RelayInput = ImageRelayInput | VideoRelayInput;

export type ServerConfig = Readonly<{
  apiKey: string | null;
  baseURL: string;
  configured: boolean;
  model: string | null;
  port: number;
  host: string;
}>;

type ResponseEvent = Record<string, unknown> & { type: string };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export class StreamIdleTimeoutError extends Error {
  constructor() {
    super('The upstream stream exceeded its idle limit.');
    this.name = 'StreamIdleTimeoutError';
  }
}

function safeInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'string' && value.length > 0 ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return parsed;
}

function validateBaseUrl(value: string): string {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('SAM_API_BASE_URL must be a valid HTTPS URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError(
      'SAM_API_BASE_URL must be a credential-free HTTPS URL without query parameters.',
    );
  }
  return parsed.href.replace(/\/$/, '');
}

function normalizedHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const hostname = normalizedHostname(value);
  if (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }
  if (isIP(hostname) !== 4) return false;
  const octets = hostname.split('.').map(Number);
  return (
    octets.length === 4 && octets[0] === 127 && octets.every((part) => part <= 255)
  );
}

function validateBindHost(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('--host must be a hostname or address.');
  }
  const host = value.trim();
  if (
    host.length === 0 ||
    host.length > 253 ||
    /[\s/@?#\\]/.test(host) ||
    (isIP(host) === 0 &&
      host !== 'localhost' &&
      !host
        .split('.')
        .every((label) =>
          /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/.test(label),
        ))
  ) {
    throw new TypeError('--host must be a hostname or address.');
  }
  return host;
}

function optionalEnvironmentValue(
  env: Record<string, string | undefined>,
  name: string,
  maximumLength: number,
): string | null {
  const value = env[name]?.trim() || null;
  if (
    value !== null &&
    (value.length > maximumLength ||
      // oxlint-disable-next-line no-control-regex -- Reject all ASCII control characters in environment values.
      /[\u0000-\u001f\u007f]/.test(value))
  ) {
    throw new TypeError(
      `${name} must contain 1 through ${maximumLength} printable characters.`,
    );
  }
  return value;
}

export function readServerConfig(
  env: Record<string, string | undefined>,
  overrides: { host?: string; port?: string | number } = {},
): ServerConfig {
  const apiKey = optionalEnvironmentValue(env, 'SAM_API_KEY', 8_192);
  const model = optionalEnvironmentValue(env, 'SAM_MODEL', MAX_MODEL_ID_LENGTH);
  if (model !== null && !MODEL_ID_PATTERN.test(model)) {
    throw new TypeError(
      'SAM_MODEL must match /^[A-Za-z0-9._:-]{1,120}$/ and contain no spaces.',
    );
  }
  const host = validateBindHost(overrides.host ?? '127.0.0.1');
  if (apiKey !== null && !isLoopbackHost(host)) {
    throw new TypeError(
      'SAM_API_KEY requires a loopback host. Use 127.0.0.1, localhost, or ::1 and an SSH tunnel for remote access.',
    );
  }
  return Object.freeze({
    apiKey,
    baseURL: validateBaseUrl(env.SAM_API_BASE_URL ?? 'https://api.meta.ai/v1'),
    configured: apiKey !== null && model !== null,
    model,
    port: safeInteger(overrides.port ?? env.PORT ?? 4_173, 'PORT', 1, 65_535),
    host,
  });
}

function hasBytes(bytes: Buffer, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function isIsoBmff(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    hasBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70]) &&
    bytes.readUInt32BE(0) >= 8
  );
}

/**
 * Sniffs the media kind from the leading bytes rather than trusting the
 * declared type. Returns the canonical MIME type or null when unsupported.
 */
export function detectMediaType(
  bytes: Buffer,
): { kind: MediaKind; mimeType: string } | null {
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mimeType: 'image/png' };
  }
  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mimeType: 'image/jpeg' };
  }
  if (
    hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return { kind: 'image', mimeType: 'image/webp' };
  }
  if (
    hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    hasBytes(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { kind: 'image', mimeType: 'image/gif' };
  }
  if (isIsoBmff(bytes)) return { kind: 'video', mimeType: 'video/mp4' };
  return null;
}

function safeFilename(value: unknown, fallback: string): string {
  const cleaned =
    typeof value === 'string'
      ? value
          // oxlint-disable-next-line no-control-regex -- Remove ASCII controls and filename delimiters before forwarding.
          .replace(/[\u0000-\u001f\u007f"\\/]/g, '')
          .trim()
          .slice(0, MAX_FILENAME_LENGTH)
      : '';
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Validates one decoded `media` part: the declared MIME type must agree with
 * the sniffed bytes, and the sniffed type wins.
 */
function validateMediaPart(value: unknown): ValidatedMedia {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, 'invalid_media', 'The media payload is missing.');
  }
  const media = value as Partial<MultipartMedia>;
  if (!Buffer.isBuffer(media.bytes)) {
    throw new HttpError(400, 'invalid_media', 'The media payload is missing.');
  }
  if (media.bytes.length === 0) {
    throw new HttpError(400, 'invalid_media', 'The media payload is empty.');
  }
  if (media.bytes.length > MAX_MEDIA_SIZE) {
    throw new HttpError(413, 'media_too_large', 'The media exceeds 20 MiB.');
  }
  const detected = detectMediaType(media.bytes);
  if (detected === null) {
    throw new HttpError(
      415,
      'unsupported_media',
      'Upload a PNG, JPEG, WebP, or GIF image, or an MP4 video.',
    );
  }
  const declared =
    typeof media.contentType === 'string' ? media.contentType.toLowerCase() : '';
  const declaredCanonical =
    detected.kind === 'image'
      ? allowedImageTypes.get(declared)
      : allowedVideoTypes.get(declared);
  if (declared.length > 0 && declaredCanonical !== detected.mimeType) {
    throw new HttpError(
      400,
      'invalid_media',
      'The declared media type does not match its content.',
    );
  }
  return Object.freeze({
    kind: detected.kind,
    mimeType: detected.mimeType,
    filename: safeFilename(
      media.filename,
      detected.kind === 'image' ? 'image' : 'video.mp4',
    ),
    bytes: media.bytes,
  });
}

function validatePrompt(value: unknown): string {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new HttpError(
      400,
      'invalid_prompt',
      `The prompt must contain 1 through ${MAX_PROMPT_LENGTH} characters.`,
    );
  }
  return prompt;
}

function validateOptionalModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const model = typeof value === 'string' ? value.trim() : '';
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new HttpError(400, 'invalid_model', 'The model identifier is invalid.');
  }
  return model;
}

function validateOptionalScoreThreshold(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  const threshold = SCORE_THRESHOLD_PATTERN.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new HttpError(
      400,
      'invalid_score_threshold',
      'The score threshold must be a number from 0 through 1.',
    );
  }
  return threshold;
}

function validateOptionalIncludeConfidence(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') {
    throw new HttpError(
      400,
      'invalid_include_confidence',
      'include_confidence must be "true" or "false".',
    );
  }
  return value === 'true';
}

/**
 * Validates the decoded multipart fields of an upload request. Only MP4 video
 * is accepted: the Files API handle exists for the streaming video path, and an
 * image handle could never be referenced.
 */
export function validateUploadInput(fields: MultipartFields): Readonly<{
  media: ValidatedMedia;
}> {
  const media = validateMediaPart(fields.media);
  if (media.kind !== 'video') {
    throw new HttpError(415, 'unsupported_media', 'Upload an MP4 video.');
  }
  return Object.freeze({ media });
}

/**
 * Validates the decoded multipart fields into the relay input. Images carry
 * their bytes inline; video carries the opaque handle returned by `/api/files`
 * and never the bytes.
 */
export function validateMediaInput(fields: MultipartFields): RelayInput {
  const prompt = validatePrompt(fields.prompt);
  const model = validateOptionalModel(fields.model);
  const scoreThreshold = validateOptionalScoreThreshold(fields.score_threshold);
  const includeConfidence = validateOptionalIncludeConfidence(
    fields.include_confidence,
  );
  const confidence = includeConfidence === undefined ? {} : { includeConfidence };
  const hasFileId = fields.file_id !== undefined;
  const hasMedia = fields.media !== undefined;
  if (hasFileId && hasMedia) {
    throw new HttpError(
      400,
      'invalid_request',
      'The request must carry either media bytes or an uploaded file handle.',
    );
  }
  if (hasFileId) {
    if (typeof fields.file_id !== 'string' || !FILE_ID_PATTERN.test(fields.file_id)) {
      throw new HttpError(400, 'invalid_file_id', 'The file handle is invalid.');
    }
    if (scoreThreshold !== undefined) {
      throw new HttpError(
        400,
        'invalid_score_threshold',
        'The score threshold applies to image requests only.',
      );
    }
    return Object.freeze({
      prompt,
      ...(model === undefined ? {} : { model }),
      kind: 'video',
      fileId: fields.file_id,
      ...confidence,
    });
  }
  const media = validateMediaPart(fields.media);
  if (media.kind === 'video') {
    throw new HttpError(
      400,
      'invalid_media',
      'Upload the video to /api/files and send its file_id.',
    );
  }
  return Object.freeze({
    prompt,
    ...(model === undefined ? {} : { model }),
    kind: 'image',
    media,
    ...(scoreThreshold === undefined ? {} : { scoreThreshold }),
    ...confidence,
  });
}

export function assertMultipartContentType(headers: IncomingHttpHeaders): string {
  const value = headers['content-type'];
  const contentType = Array.isArray(value) ? value[0] : value;
  if (typeof contentType !== 'string' || !MULTIPART_CONTENT_TYPE.test(contentType)) {
    throw new HttpError(
      415,
      'unsupported_media_type',
      'Content-Type must be multipart/form-data.',
    );
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (
    boundary.length === 0 ||
    boundary.length > 70 ||
    !/^[\w'()+,\-./:=? ]+$/.test(boundary)
  ) {
    throw new HttpError(400, 'invalid_request', 'The multipart boundary is invalid.');
  }
  return boundary;
}

export function readRawBody(
  request: IncomingMessage,
  limit = MAX_REQUEST_SIZE,
): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.reject(
      new HttpError(413, 'request_too_large', 'The request is too large.'),
    );
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        request.pause();
        finish(() => {
          request.resume();
          reject(new HttpError(413, 'request_too_large', 'The request is too large.'));
        });
      } else {
        chunks.push(bytes);
      }
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks, size)));
    const onAborted = () =>
      finish(() =>
        reject(new HttpError(400, 'request_aborted', 'The request was aborted.')),
      );
    const onError = () =>
      finish(() =>
        reject(new HttpError(400, 'request_error', 'The request could not be read.')),
      );
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

type MultipartDisposition = {
  name: string;
  filename?: string;
  contentType?: string;
};

function parseDisposition(headerBlock: string): MultipartDisposition | null {
  const headers = new Map<string, string>();
  for (const line of headerBlock.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  const disposition = headers.get('content-disposition') ?? '';
  if (!/^form-data\b/i.test(disposition)) return null;
  const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1];
  if (name === undefined) return null;
  const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1];
  return {
    name,
    filename,
    contentType: headers.get('content-type'),
  };
}

/**
 * Decodes a `multipart/form-data` body into its accepted fields. Only the
 * fields the route expects are accepted; anything else fails closed.
 */
export function parseMultipartBody(
  body: Buffer,
  boundary: string,
  accepted: ReadonlySet<string> = responsesFields,
): MultipartFields {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: MultipartFields = {};
  let cursor = body.indexOf(delimiter);
  if (cursor !== 0 && !(cursor === 2 && body[0] === 0x0d && body[1] === 0x0a)) {
    throw new HttpError(400, 'invalid_request', 'The multipart body is malformed.');
  }
  for (;;) {
    cursor += delimiter.length;
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) {
      throw new HttpError(400, 'invalid_request', 'The multipart body is malformed.');
    }
    cursor += 2;
    const headerEnd = body.indexOf('\r\n\r\n', cursor, 'latin1');
    if (headerEnd < 0) {
      throw new HttpError(400, 'invalid_request', 'The multipart body is malformed.');
    }
    const headerBlock = body.toString('utf8', cursor, headerEnd);
    const dataStart = headerEnd + 4;
    const next = body.indexOf(delimiter, dataStart);
    if (next < dataStart + 2 || body[next - 2] !== 0x0d || body[next - 1] !== 0x0a) {
      throw new HttpError(400, 'invalid_request', 'The multipart body is malformed.');
    }
    const data = body.subarray(dataStart, next - 2);
    const part = parseDisposition(headerBlock);
    if (part === null || !accepted.has(part.name)) {
      throw new HttpError(
        400,
        'invalid_request',
        'The request contains unsupported fields.',
      );
    }
    if (part.name in fields) {
      throw new HttpError(400, 'invalid_request', 'The request repeats a field.');
    }
    if (part.name === 'media') {
      fields.media = {
        bytes: data,
        filename: part.filename,
        contentType: part.contentType,
      };
    } else {
      const name = part.name as MultipartTextField;
      const code = {
        prompt: 'invalid_prompt',
        model: 'invalid_model',
        file_id: 'invalid_file_id',
        score_threshold: 'invalid_score_threshold',
        include_confidence: 'invalid_include_confidence',
      }[name];
      const limit = {
        prompt: 4 * MAX_PROMPT_LENGTH,
        model: 4 * MAX_MODEL_ID_LENGTH,
        file_id: MAX_FILE_ID_LENGTH,
        score_threshold: MAX_SCORE_THRESHOLD_LENGTH,
        include_confidence: MAX_INCLUDE_CONFIDENCE_LENGTH,
      }[name];
      if (part.filename !== undefined || data.length > limit) {
        throw new HttpError(400, code, `The ${part.name} field is invalid.`);
      }
      try {
        fields[name] = new TextDecoder('utf-8', {
          fatal: true,
        }).decode(data);
      } catch {
        throw new HttpError(400, code, `The ${part.name} field is invalid.`);
      }
    }
    cursor = next;
  }
  return fields;
}

function lane(
  event: ResponseEvent,
): { item_id: string; output_index: number; content_index: number } | undefined {
  const outputIndex = event.output_index;
  const contentIndex = event.content_index;
  return typeof event.item_id === 'string' &&
    event.item_id.length > 0 &&
    typeof outputIndex === 'number' &&
    Number.isSafeInteger(outputIndex) &&
    outputIndex >= 0 &&
    typeof contentIndex === 'number' &&
    Number.isSafeInteger(contentIndex) &&
    contentIndex >= 0
    ? {
        item_id: event.item_id,
        output_index: outputIndex,
        content_index: contentIndex,
      }
    : undefined;
}

function outputTextEvent(
  event: ResponseEvent,
  field: 'delta' | 'text' | 'refusal',
): Record<string, unknown> | undefined {
  const identity = lane(event);
  return identity !== undefined && typeof event[field] === 'string'
    ? { type: event.type, [field]: event[field], ...identity }
    : undefined;
}

export function projectResponsesEvent(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    typeof value.type !== 'string'
  ) {
    throw new TypeError('The upstream stream emitted an invalid event.');
  }
  const event = value as ResponseEvent;
  switch (event.type) {
    case 'response.output_text.delta':
      return outputTextEvent(event, 'delta');
    case 'response.output_text.done':
      return outputTextEvent(event, 'text');
    case 'response.refusal.delta':
      return outputTextEvent(event, 'delta');
    case 'response.refusal.done':
      return outputTextEvent(event, 'refusal');
    case 'response.content_part.done': {
      // The production stream closes a text lane with `content_part.done` and
      // never emits `output_text.done`; the parser requires the latter.
      const identity = lane(event);
      const part = objectRecord(event.part);
      if (identity === undefined || part === null) return null;
      if (part.type === 'output_text' && typeof part.text === 'string') {
        return { type: 'response.output_text.done', text: part.text, ...identity };
      }
      if (part.type === 'refusal' && typeof part.refusal === 'string') {
        return { type: 'response.refusal.done', refusal: part.refusal, ...identity };
      }
      return null;
    }
    case 'response.completed':
      return { type: event.type };
    case 'response.incomplete': {
      const response = objectRecord(event.response);
      const incompleteDetails = objectRecord(response?.incomplete_details);
      const reason = incompleteDetails?.reason;
      const safeReason =
        reason === 'max_output_tokens' || reason === 'content_filter'
          ? reason
          : undefined;
      return {
        type: event.type,
        response: {
          ...(safeReason === undefined
            ? {}
            : { incomplete_details: { reason: safeReason } }),
        },
      };
    }
    case 'response.failed':
      return {
        type: event.type,
        response: { error: { message: 'The segmentation request failed.' } },
      };
    case 'error':
      return {
        type: event.type,
        message: 'The segmentation stream reported an error.',
      };
    default:
      return null;
  }
}

function waitWithIdleLimit<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal,
  idleLimit: number,
  onIdle?: () => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const running = Promise.resolve().then(operation);
  void running.catch(() => undefined);
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('The request was cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      onIdle?.();
      reject(new StreamIdleTimeoutError());
    }, idleLimit);
  });
  return Promise.race([running, interrupted]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

async function* parseUpstreamResponse(
  response: Response,
  signal: AbortSignal,
  idleLimit: number,
  onIdle: (() => void) | undefined,
  eventLimit = MAX_EVENT_SIZE,
): AsyncGenerator<unknown> {
  if (!response.ok || response.body === null) {
    throw new HttpError(
      502,
      'upstream_error',
      'The segmentation service rejected the request.',
    );
  }
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const isSse = contentType.includes('text/event-stream');
  const isNdjson =
    contentType.includes('application/x-ndjson') ||
    contentType.includes('application/ndjson');
  if (!isSse && !isNdjson) {
    throw new HttpError(
      502,
      'upstream_protocol',
      'The segmentation service returned an invalid stream.',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let totalBytes = 0;
  let events = 0;
  let complete = false;
  try {
    for (;;) {
      const item = (await waitWithIdleLimit(
        () => reader.read(),
        signal,
        idleLimit,
        onIdle,
      )) as { done: boolean; value: Uint8Array };
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > MAX_STREAM_SIZE)
        throw new Error('Upstream stream limit exceeded.');
      buffer += decoder.decode(item.value, { stream: true });
      if (isSse) {
        buffer = buffer.replaceAll('\r\n', '\n');
        for (;;) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const payload = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
            .trim();
          if (payload.length === 0 || payload === '[DONE]') continue;
          if (Buffer.byteLength(payload) > eventLimit)
            throw new Error('Event too large.');
          events += 1;
          if (events > MAX_EVENTS) throw new Error('Event limit exceeded.');
          yield JSON.parse(payload);
        }
      } else {
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          if (Buffer.byteLength(line) > eventLimit) throw new Error('Event too large.');
          events += 1;
          if (events > MAX_EVENTS) throw new Error('Event limit exceeded.');
          yield JSON.parse(line);
        }
      }
    }
    buffer += decoder.decode();
    const tail = isSse
      ? buffer
          .replaceAll('\r\n', '\n')
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
          .trim()
      : buffer.trim();
    if (tail.length > 0 && tail !== '[DONE]') {
      if (Buffer.byteLength(tail) > eventLimit) throw new Error('Event too large.');
      events += 1;
      if (events > MAX_EVENTS) throw new Error('Event limit exceeded.');
      yield JSON.parse(tail);
    }
    complete = true;
  } finally {
    if (!complete)
      await reader.cancel('Upstream parsing stopped.').catch(() => undefined);
    reader.releaseLock();
  }
}

export async function writeWithBackpressure(
  response: ServerResponse,
  chunk: string | Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('The response was cancelled.');
  if (response.destroyed || response.writableEnded) {
    throw new Error('The response is no longer writable.');
  }
  if (response.write(chunk)) return;
  await once(response, 'drain', { signal });
}

export async function relayResponsesEvents(
  upstreamResponse: Response,
  response: ServerResponse,
  signal: AbortSignal,
  {
    idleLimit = STREAM_IDLE_LIMIT,
    onIdle,
    eventLimit = MAX_EVENT_SIZE,
  }: { idleLimit?: number; onIdle?: () => void; eventLimit?: number } = {},
) {
  const finalizedLanes = new Set<string>();
  for await (const event of parseUpstreamResponse(
    upstreamResponse,
    signal,
    idleLimit,
    onIdle,
    eventLimit,
  )) {
    const projected = projectResponsesEvent(event);
    if (projected === undefined) {
      throw new TypeError('The upstream event is missing required parser fields.');
    }
    if (projected === null) continue;
    if (
      projected.type === 'response.output_text.done' ||
      projected.type === 'response.refusal.done'
    ) {
      if (
        !('item_id' in projected) ||
        !('output_index' in projected) ||
        !('content_index' in projected)
      ) {
        throw new TypeError('The finalized event is missing its lane identity.');
      }
      const key = `${projected.item_id}\u0000${projected.output_index}\u0000${projected.content_index}`;
      if (finalizedLanes.has(key)) continue;
      finalizedLanes.add(key);
    }
    await writeWithBackpressure(response, `${JSON.stringify(projected)}\n`, signal);
  }
}

export function bindDownstreamCancellation(
  request: IncomingMessage,
  response: ServerResponse,
  controller: AbortController,
): () => void {
  const onAborted = () => controller.abort(new Error('The request was aborted.'));
  const onClose = () => {
    if (!response.writableEnded)
      controller.abort(new Error('The response was closed.'));
  };
  request.once('aborted', onAborted);
  response.once('close', onClose);
  return () => {
    request.off('aborted', onAborted);
    response.off('close', onClose);
  };
}

const ASTRYX_HIGHLIGHT_STYLES_HASH =
  "'sha256-W8DZlwvt7jPAC5BancWmJ6mGbNdefbHBPaUSM8MxNfQ='";

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self' ${ASTRYX_HIGHLIGHT_STYLES_HASH}`,
  );
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  applySecurityHeaders(response);
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function sendJsonError(response: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  const message =
    error instanceof HttpError
      ? error.message
      : 'The server could not complete the request.';
  send(
    response,
    status,
    'application/json; charset=utf-8',
    `${JSON.stringify({ error: { code, message } })}\n`,
  );
}

function hasExactlyOneRawHeader(request: IncomingMessage, name: string): boolean {
  if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0)
    return false;
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count === 1;
}

function parseHostHeader(
  value: string | undefined,
): { host: string; hostname: string } | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 261 ||
    /[\s/@?#\\]/.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== '/' ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      return null;
    }
    return { host: parsed.host.toLowerCase(), hostname: parsed.hostname };
  } catch {
    return null;
  }
}

export function authorizeSameOrigin(
  request: IncomingMessage,
  config: ServerConfig,
): boolean {
  if (!hasExactlyOneRawHeader(request, 'host')) return false;
  const authority = parseHostHeader(request.headers.host);
  if (authority === null) return false;
  if (config.apiKey !== null && !isLoopbackHost(authority.hostname)) return false;
  if (request.method !== 'POST') return true;
  if (!hasExactlyOneRawHeader(request, 'origin')) return false;
  const origin = request.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0 &&
      parsed.host.toLowerCase() === authority.host
    );
  } catch {
    return false;
  }
}

type ModelCache = {
  expiresAt: number;
  models: readonly string[];
};

type ApiHandlerOptions = {
  config: ServerConfig;
  createResponsesStream?: (input: RelayInput, signal: AbortSignal) => Promise<Response>;
  uploadMedia?: (media: ValidatedMedia, signal: AbortSignal) => Promise<string>;
  listModels?: (signal?: AbortSignal) => Promise<string[]>;
  streamIdleLimit?: number;
  modelCacheTtl?: number;
  now?: () => number;
};

type ApiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean>;

/**
 * Maps an upstream start failure onto the relay's error contract. A 404 or 410
 * on a video run indicates that the opaque Files handle is no longer available;
 * other client errors can come from the selected model or media contract and
 * must not trigger a redundant upload retry. Authentication and rate limiting
 * are never the handle's fault.
 */
function upstreamStartError(error: unknown, input: RelayInput): HttpError {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : undefined;
  if (input.kind === 'video' && (status === 404 || status === 410)) {
    return new HttpError(
      409,
      'stale_file_handle',
      'The uploaded video is no longer available. Upload it again.',
    );
  }
  return new HttpError(
    502,
    'upstream_error',
    'The segmentation service could not start the request.',
  );
}

export function createApiHandler({
  config,
  createResponsesStream,
  uploadMedia,
  listModels,
  streamIdleLimit = STREAM_IDLE_LIMIT,
  modelCacheTtl = MODEL_CACHE_TTL,
  now = Date.now,
}: ApiHandlerOptions): ApiHandler {
  let modelCache: ModelCache | null = null;

  async function cachedModels(signal?: AbortSignal): Promise<readonly string[]> {
    const timestamp = now();
    if (modelCache !== null && modelCache.expiresAt > timestamp) {
      return modelCache.models;
    }
    if (typeof listModels !== 'function') {
      throw new HttpError(503, 'not_configured', 'Live mode is not configured.');
    }
    let models: string[];
    try {
      models = await listModels(signal);
    } catch {
      throw new HttpError(502, 'upstream_error', 'The model list is unavailable.');
    }
    if (
      !Array.isArray(models) ||
      models.length > 500 ||
      models.some((model) => typeof model !== 'string' || !MODEL_ID_PATTERN.test(model))
    ) {
      throw new HttpError(502, 'upstream_error', 'The model list is unavailable.');
    }
    const normalized = Object.freeze([...new Set(models)].sort());
    modelCache = { expiresAt: timestamp + modelCacheTtl, models: normalized };
    return normalized;
  }

  async function handleFileUpload(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const downstream = new AbortController();
    const upstream = new AbortController();
    const forward = () => upstream.abort(downstream.signal.reason);
    downstream.signal.addEventListener('abort', forward, { once: true });
    const unbind = bindDownstreamCancellation(request, response, downstream);
    try {
      const boundary = assertMultipartContentType(request.headers);
      const input = validateUploadInput(
        parseMultipartBody(await readRawBody(request), boundary, uploadFields),
      );
      if (typeof uploadMedia !== 'function') {
        throw new HttpError(503, 'not_configured', 'Live mode is not configured.');
      }
      let fileId;
      try {
        fileId = await waitWithIdleLimit(
          () => uploadMedia(input.media, upstream.signal),
          downstream.signal,
          streamIdleLimit,
          () => upstream.abort(new StreamIdleTimeoutError()),
        );
      } catch {
        if (downstream.signal.aborted) return;
        throw new HttpError(
          502,
          'upstream_error',
          'The segmentation service rejected the upload.',
        );
      }
      if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
        throw new HttpError(
          502,
          'upstream_error',
          'The segmentation service returned an invalid file handle.',
        );
      }
      send(
        response,
        200,
        'application/json; charset=utf-8',
        `${JSON.stringify({ file_id: fileId, bytes: input.media.bytes.length })}\n`,
      );
    } catch (error) {
      if (downstream.signal.aborted || response.destroyed || response.writableEnded)
        return;
      sendJsonError(response, error);
    } finally {
      unbind();
      downstream.signal.removeEventListener('abort', forward);
      if (!upstream.signal.aborted)
        upstream.abort(new Error('The upload is no longer needed.'));
    }
  }

  return async function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (!url.pathname.startsWith('/api/')) return false;
    if (
      url.pathname !== '/api/config' &&
      url.pathname !== '/api/models' &&
      url.pathname !== '/api/responses' &&
      url.pathname !== '/api/files'
    ) {
      // Unknown API routes must not fall through to the SPA shell.
      sendJsonError(response, new HttpError(404, 'not_found', 'Unknown API route.'));
      return true;
    }
    if (url.search.length > 0) {
      send(
        response,
        400,
        'text/plain; charset=utf-8',
        'Query parameters are not allowed.\n',
      );
      return true;
    }
    if (!authorizeSameOrigin(request, config)) {
      send(response, 403, 'text/plain; charset=utf-8', 'Forbidden.\n');
      return true;
    }
    if (url.pathname === '/api/config') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed.\n', {
          Allow: 'GET, HEAD',
        });
        return true;
      }
      const body = `${JSON.stringify({
        configured: config.configured,
        endpointOrigin: new URL(config.baseURL).origin,
        model: config.model,
      })}\n`;
      send(
        response,
        200,
        'application/json; charset=utf-8',
        request.method === 'HEAD' ? '' : body,
        request.method === 'HEAD' ? { 'Content-Length': Buffer.byteLength(body) } : {},
      );
      return true;
    }
    if (url.pathname === '/api/models') {
      if (request.method !== 'GET') {
        send(
          response,
          405,
          'application/json; charset=utf-8',
          '{"error":{"code":"method_not_allowed","message":"Use GET."}}\n',
          { Allow: 'GET' },
        );
        return true;
      }
      if (!config.configured) {
        sendJsonError(
          response,
          new HttpError(503, 'not_configured', 'Live mode is not configured.'),
        );
        return true;
      }
      try {
        const models = await cachedModels(undefined);
        send(
          response,
          200,
          'application/json; charset=utf-8',
          `${JSON.stringify({
            models: models.map((id) => ({ id })),
            default: config.model,
          })}\n`,
        );
      } catch (error) {
        sendJsonError(response, error);
      }
      return true;
    }
    if (request.method !== 'POST') {
      send(
        response,
        405,
        'application/json; charset=utf-8',
        '{"error":{"code":"method_not_allowed","message":"Use POST."}}\n',
        { Allow: 'POST' },
      );
      return true;
    }
    if (!config.configured) {
      sendJsonError(
        response,
        new HttpError(503, 'not_configured', 'Live mode is not configured.'),
      );
      return true;
    }
    if (url.pathname === '/api/files') {
      await handleFileUpload(request, response);
      return true;
    }

    const downstream = new AbortController();
    const upstream = new AbortController();
    const forward = () => upstream.abort(downstream.signal.reason);
    downstream.signal.addEventListener('abort', forward, { once: true });
    const unbind = bindDownstreamCancellation(request, response, downstream);
    let streamStarted = false;
    try {
      const boundary = assertMultipartContentType(request.headers);
      const input = validateMediaInput(
        parseMultipartBody(await readRawBody(request), boundary),
      );
      if (typeof createResponsesStream !== 'function') {
        throw new HttpError(503, 'not_configured', 'Live mode is not configured.');
      }
      let source: Response;
      try {
        source = await waitWithIdleLimit(
          () => createResponsesStream(input, upstream.signal),
          downstream.signal,
          streamIdleLimit,
          () => upstream.abort(new StreamIdleTimeoutError()),
        );
      } catch (error) {
        if (downstream.signal.aborted) return true;
        throw upstreamStartError(error, input);
      }
      applySecurityHeaders(response);
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Transfer-Encoding': 'chunked',
      });
      streamStarted = true;
      await relayResponsesEvents(source, response, downstream.signal, {
        idleLimit: streamIdleLimit,
        onIdle: () => upstream.abort(new StreamIdleTimeoutError()),
      });
      response.end();
    } catch (error) {
      if (downstream.signal.aborted || response.destroyed || response.writableEnded)
        return true;
      if (!streamStarted && !response.headersSent) {
        sendJsonError(response, error);
      } else {
        try {
          await writeWithBackpressure(
            response,
            `${JSON.stringify({ type: 'error', message: 'The segmentation stream failed.' })}\n`,
            downstream.signal,
          );
          response.end();
        } catch {
          response.destroy();
        }
      }
    } finally {
      unbind();
      downstream.signal.removeEventListener('abort', forward);
      if (!upstream.signal.aborted)
        upstream.abort(new Error('The upstream stream is no longer needed.'));
    }
    return true;
  };
}
