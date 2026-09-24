/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { ResponsesEvent } from '@meta-sam/parser';

import type { MediaKind } from './model';
import type { ReplayScenario } from './scenarios';

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
// `output_text.done` carries the whole output text, so one event can be as
// large as the entire segmentation output.
const MAX_EVENT_BYTES = 48 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_EVENTS = 200_000;
const MAX_UPLOAD_RESPONSE_BYTES = 64 * 1024;
const RELAY_REJECTION_MESSAGE = 'The live relay rejected the request.';
const FILE_ID_PATTERN = /^file-[A-Za-z0-9_-]{1,120}$/;

/** The relay error code for a handle the upstream no longer accepts. */
export const STALE_FILE_HANDLE = 'stale_file_handle';

export interface StreamRequest {
  readonly fixtureId: string | null;
  readonly kind: MediaKind;
  readonly prompt: string;
  readonly model: string;
  /** The media bytes for a live image request; video sends its handle instead. */
  readonly media?: Blob;
  readonly filename?: string;
  /** The `file-…` handle a live video request references. */
  readonly fileId?: string;
  /** Minimum detection score for a live image request; video ignores it. */
  readonly scoreThreshold?: number;
}

export interface UploadedFile {
  readonly fileId: string;
  readonly bytes: number;
}

export interface ResponsesTransport {
  stream(request: StreamRequest, signal: AbortSignal): AsyncIterable<ResponsesEvent>;
}

/** A relay response that carried the relay's own error contract. */
export class RelayRequestError extends Error {
  public constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = 'RelayRequestError';
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('The stream was cancelled.', 'AbortError');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ReplayTransport implements ResponsesTransport {
  readonly #scenarios: ReadonlyMap<string, ReplayScenario>;

  public constructor(scenarios: readonly ReplayScenario[]) {
    this.#scenarios = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  }

  public async *stream(
    request: StreamRequest,
    signal: AbortSignal,
  ): AsyncIterable<ResponsesEvent> {
    const scenario = this.#scenarios.get(request.fixtureId ?? '');
    if (scenario === undefined) throw new Error('The replay scenario is unavailable.');
    if (request.kind !== scenario.mediaMode) {
      throw new Error('The replay scenario does not match the selected media kind.');
    }
    if (request.prompt.trim() !== scenario.prompt.trim()) {
      throw new Error('The replay prompt does not match the selected example.');
    }
    for (const step of scenario.events) {
      await delay(step.delayMs, signal);
      if (signal.aborted) throw abortError(signal);
      yield structuredClone(step.event);
    }
  }
}

function structuralEvent(value: unknown): ResponsesEvent {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('The response stream emitted an invalid structural event.');
  }
  return value as ResponsesEvent;
}

function parseJsonEvent(text: string): ResponsesEvent | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === '[DONE]') return null;
  if (new TextEncoder().encode(trimmed).byteLength > MAX_EVENT_BYTES) {
    throw new Error('The response stream emitted an oversized event.');
  }
  return structuralEvent(JSON.parse(trimmed) as unknown);
}

async function relayError(response: Response): Promise<RelayRequestError> {
  if (response.body === null)
    return new RelayRequestError(RELAY_REJECTION_MESSAGE, null);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      totalBytes += item.value.byteLength;
      if (totalBytes > MAX_ERROR_BYTES) {
        await reader
          .cancel('Error response exceeded its byte limit.')
          .catch(() => undefined);
        return new RelayRequestError(RELAY_REJECTION_MESSAGE, null);
      }
      chunks.push(item.value);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      error?: { message?: unknown; code?: unknown };
    };
    return new RelayRequestError(
      typeof payload.error?.message === 'string'
        ? payload.error.message
        : RELAY_REJECTION_MESSAGE,
      typeof payload.error?.code === 'string' ? payload.error.code : null,
    );
  } catch {
    return new RelayRequestError(RELAY_REJECTION_MESSAGE, null);
  } finally {
    if (!complete)
      await reader.cancel('Error response reading stopped.').catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Uploads video bytes to the same-origin relay once and returns the opaque
 * handle later runs reference. The bytes never leave the browser again.
 */
export async function uploadMediaFile(
  media: Blob,
  filename: string,
  signal: AbortSignal,
): Promise<UploadedFile> {
  const body = new FormData();
  body.append('media', media, filename);
  const response = await fetch('/api/files', {
    method: 'POST',
    body,
    signal,
    credentials: 'same-origin',
  });
  if (!response.ok) throw await relayError(response);
  const raw = await response.arrayBuffer();
  if (raw.byteLength > MAX_UPLOAD_RESPONSE_BYTES) {
    throw new Error('The live relay returned an oversized upload response.');
  }
  const payload = JSON.parse(new TextDecoder().decode(new Uint8Array(raw))) as {
    file_id?: unknown;
    bytes?: unknown;
  };
  if (typeof payload.file_id !== 'string' || !FILE_ID_PATTERN.test(payload.file_id)) {
    throw new Error('The live relay returned an invalid file handle.');
  }
  return {
    fileId: payload.file_id,
    bytes: typeof payload.bytes === 'number' ? payload.bytes : media.size,
  };
}

function ssePayload(block: string): string {
  return block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
}

export async function* parseStructuralResponse(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ResponsesEvent> {
  if (!response.ok) throw await relayError(response);
  if (response.body === null) throw new Error('The live relay returned no stream.');
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const isSse = contentType.includes('text/event-stream');
  const isNdjson =
    contentType.includes('application/x-ndjson') ||
    contentType.includes('application/ndjson');
  if (!isSse && !isNdjson) {
    throw new Error('The live relay returned an unsupported stream type.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let pendingCarriageReturn = false;
  let totalBytes = 0;
  let eventCount = 0;
  let complete = false;
  const cancel = () => void reader.cancel(abortError(signal)).catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });

  const accept = (payload: string): ResponsesEvent | null => {
    const event = parseJsonEvent(payload);
    if (event !== null) {
      eventCount += 1;
      if (eventCount > MAX_EVENTS) {
        throw new Error('The response stream exceeded its event limit.');
      }
    }
    return event;
  };

  const normalizeSseNewlines = (text: string, final: boolean): string => {
    let value = pendingCarriageReturn ? `\r${text}` : text;
    pendingCarriageReturn = false;
    if (!final && value.endsWith('\r')) {
      value = value.slice(0, -1);
      pendingCarriageReturn = true;
    }
    return value.replace(/\r\n|\r/g, '\n');
  };

  try {
    for (;;) {
      if (signal.aborted) throw abortError(signal);
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > MAX_STREAM_BYTES) {
        throw new Error('The response stream exceeded its byte limit.');
      }
      const decoded = decoder.decode(item.value, { stream: true });
      buffer += isSse ? normalizeSseNewlines(decoded, false) : decoded;
      if (isSse) {
        for (;;) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = accept(ssePayload(block));
          if (event !== null) yield event;
        }
      } else {
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          const event = accept(line);
          if (event !== null) yield event;
        }
      }
    }

    const decoded = decoder.decode();
    buffer += isSse ? normalizeSseNewlines(decoded, true) : decoded;
    if (isSse) {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = accept(ssePayload(block));
        if (event !== null) yield event;
      }
    }
    if (buffer.trim().length > 0) {
      if (isSse) {
        const event = accept(ssePayload(buffer));
        if (event !== null) yield event;
      } else {
        const event = accept(buffer.replace(/\r?\n$/, ''));
        if (event !== null) yield event;
      }
    }
    complete = true;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) {
      await reader.cancel('Stream parsing stopped.').catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export class LiveTransport implements ResponsesTransport {
  public async *stream(
    request: StreamRequest,
    signal: AbortSignal,
  ): AsyncIterable<ResponsesEvent> {
    const body = new FormData();
    body.append('prompt', request.prompt);
    body.append('model', request.model);
    if (request.kind === 'video') {
      if (request.fileId === undefined) {
        throw new Error('A live video request requires an uploaded file handle.');
      }
      body.append('file_id', request.fileId);
    } else {
      if (request.media === undefined) {
        throw new Error('A live request requires media bytes.');
      }
      body.append('media', request.media, request.filename ?? `media.${request.kind}`);
      if (request.scoreThreshold !== undefined) {
        body.append('score_threshold', String(request.scoreThreshold));
      }
    }
    const response = await fetch('/api/responses', {
      method: 'POST',
      body,
      signal,
      credentials: 'same-origin',
    });
    yield* parseStructuralResponse(response, signal);
  }
}
