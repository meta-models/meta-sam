/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { RelayInput, ServerConfig, ValidatedMedia } from './server-core.ts';

const MAX_UNARY_RESPONSE_SIZE = 16 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_SIZE = 64 * 1024;
const MAX_MODELS_RESPONSE_SIZE = 256 * 1024;
const MAX_MODELS = 500;
const FILE_ID_PATTERN = /^file-[A-Za-z0-9_-]{1,120}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

type ModelRequestInput = {
  model?: unknown;
  prompt: string;
  includeConfidence?: boolean;
};

type ImageRequestInput = ModelRequestInput & {
  media: ValidatedMedia;
  scoreThreshold?: number;
};

type RequestBody = string | FormData;

type RequestSpec<TBody extends RequestBody> = {
  endpoint: URL;
  init: Omit<RequestInit, 'body' | 'headers'> & {
    body: TBody;
    headers: Record<string, string>;
  };
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

export function normalizeSAMPrompt(expression: string): string {
  const phrase = expression.trim();
  if (phrase.length === 0) {
    throw new TypeError('The SAM prompt must contain a noun phrase.');
  }
  return phrase;
}

function endpoint(config: ServerConfig, path: string): URL {
  return new URL(path, `${config.baseURL.replace(/\/$/, '')}/`);
}

function authorization(config: ServerConfig): { Authorization: string } {
  return { Authorization: `Bearer ${config.apiKey}` };
}

function requestModel(config: ServerConfig, input: ModelRequestInput): string {
  const model = input.model ?? config.model;
  if (typeof model !== 'string' || !MODEL_ID_PATTERN.test(model)) {
    throw new TypeError('The model identifier is invalid.');
  }
  return model;
}

/**
 * Responses metadata is a string-to-string map, so request options travel as
 * strings. `include_confidence` asks the model for the optional `c` field on
 * each box and mask. The object is omitted when no option is set.
 */
function requestMetadata(input: ModelRequestInput & { scoreThreshold?: number }): {
  metadata?: Record<string, string>;
} {
  const metadata: Record<string, string> = {
    ...(input.scoreThreshold === undefined
      ? {}
      : { score_threshold: String(input.scoreThreshold) }),
    ...(input.includeConfidence === undefined
      ? {}
      : { include_confidence: String(input.includeConfidence) }),
  };
  return Object.keys(metadata).length === 0 ? {} : { metadata };
}

function userMessage(prompt: string, mediaPart: JsonRecord): readonly JsonRecord[] {
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: normalizeSAMPrompt(prompt) }, mediaPart],
    },
  ];
}

/**
 * Image requests are unary. The SAM video Responses API answers a
 * streaming image request with `response.failed`, so the image path asks for a
 * single JSON body and adapts it into the same event stream the video path
 * produces natively. Request options travel in `metadata`; see
 * `requestMetadata`.
 */
export function buildImageResponsesRequest(
  config: ServerConfig,
  input: ImageRequestInput,
): RequestSpec<string> {
  return {
    endpoint: endpoint(config, 'responses'),
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...authorization(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: requestModel(config, input),
        stream: false,
        input: userMessage(input.prompt, {
          type: 'input_image',
          image_url: `data:${input.media.mimeType};base64,${input.media.bytes.toString('base64')}`,
        }),
        ...requestMetadata(input),
      }),
    },
  };
}

/** Video bytes go through the Files API once; the request carries only the handle. */
export function buildFileUploadRequest(
  config: ServerConfig,
  media: ValidatedMedia,
): RequestSpec<FormData> {
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append(
    'file',
    new Blob([new Uint8Array(media.bytes)], { type: media.mimeType }),
    media.filename,
  );
  return {
    endpoint: endpoint(config, 'files'),
    init: {
      method: 'POST',
      headers: { Accept: 'application/json', ...authorization(config) },
      body: form,
    },
  };
}

export function buildVideoResponsesRequest(
  config: ServerConfig,
  input: ModelRequestInput,
  fileId: string,
): RequestSpec<string> {
  if (!FILE_ID_PATTERN.test(fileId)) {
    throw new TypeError('The uploaded file handle is invalid.');
  }
  return {
    endpoint: endpoint(config, 'responses'),
    init: {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        ...authorization(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: requestModel(config, input),
        stream: true,
        input: userMessage(input.prompt, { type: 'input_video', file_id: fileId }),
        ...requestMetadata(input),
      }),
    },
  };
}

async function readBoundedJson(
  response: Response,
  limit: number,
  description: string,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`The ${description} exceeded its size limit.`);
  }
  if (response.body === null) {
    throw new Error(`The ${description} had no body.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel(`${description} exceeded its size limit.`).catch(() => {});
        throw new Error(`The ${description} exceeded its size limit.`);
      }
      chunks.push(item.value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export class UpstreamRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamRequestError';
    this.status = status;
  }
}

export async function fetchModelIds(
  config: ServerConfig,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchImpl(endpoint(config, 'models'), {
    method: 'GET',
    headers: { Accept: 'application/json', ...authorization(config) },
    signal,
  });
  if (!response.ok) {
    throw new UpstreamRequestError(response.status, 'The model list is unavailable.');
  }
  const body = record(
    await readBoundedJson(response, MAX_MODELS_RESPONSE_SIZE, 'model list'),
  );
  if (body === null || !Array.isArray(body.data) || body.data.length > MAX_MODELS) {
    throw new TypeError('The model list is invalid.');
  }
  return body.data.map((value) => {
    const entry = record(value);
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!MODEL_ID_PATTERN.test(id)) throw new TypeError('The model list is invalid.');
    return id;
  });
}

export async function uploadMediaFile(
  config: ServerConfig,
  media: ValidatedMedia,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const request = buildFileUploadRequest(config, media);
  const response = await fetchImpl(request.endpoint, { ...request.init, signal });
  if (!response.ok) {
    throw new UpstreamRequestError(
      response.status,
      'The segmentation service rejected the upload.',
    );
  }
  const body = record(
    await readBoundedJson(response, MAX_UPLOAD_RESPONSE_SIZE, 'upload response'),
  );
  const fileId = typeof body?.id === 'string' ? body.id : '';
  if (!FILE_ID_PATTERN.test(fileId)) {
    throw new Error('The segmentation service returned an invalid file handle.');
  }
  return fileId;
}

function responseEvents(value: unknown): JsonRecord[] {
  const body = record(value);
  if (body === null) {
    throw new TypeError('The segmentation service returned an invalid response.');
  }
  const output = Array.isArray(body.output) ? body.output : [];
  const events: JsonRecord[] = [];
  let contentIndex = 0;
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = record(output[outputIndex]);
    if (item === null || !Array.isArray(item.content)) {
      continue;
    }
    const itemId =
      typeof item.id === 'string' && item.id.length > 0 ? item.id : 'sam-image';
    for (const value of item.content) {
      const part = record(value);
      if (part === null) continue;
      const lane = {
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
      };
      if (part.type === 'output_text' && typeof part.text === 'string') {
        events.push({ type: 'response.output_text.delta', delta: part.text, ...lane });
        events.push({ type: 'response.output_text.done', text: part.text, ...lane });
        contentIndex += 1;
      } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
        events.push({ type: 'response.refusal.delta', delta: part.refusal, ...lane });
        events.push({ type: 'response.refusal.done', refusal: part.refusal, ...lane });
        contentIndex += 1;
      }
    }
  }
  if (body.status === 'completed') {
    events.push({ type: 'response.completed' });
  } else if (body.status === 'incomplete') {
    events.push({
      type: 'response.incomplete',
      response: { incomplete_details: body.incomplete_details ?? null },
    });
  } else if (body.status === 'failed') {
    events.push({ type: 'response.failed', response: { error: body.error ?? null } });
  } else {
    throw new TypeError(
      'The segmentation service returned an invalid response status.',
    );
  }
  return events;
}

export async function adaptUnaryResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = await readBoundedJson(
    response,
    MAX_UNARY_RESPONSE_SIZE,
    'segmentation response',
  );
  const events = responseEvents(body);
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  });
}

/**
 * Starts the upstream request for a validated relay input and resolves to a
 * streaming `Response` (SSE or NDJSON) the relay can forward. Image inputs are
 * unary and adapted; video inputs reference a handle uploaded earlier through
 * `uploadMediaFile`, so no bytes cross this boundary a second time.
 */
export async function createSAMResponsesStream(
  config: ServerConfig,
  input: RelayInput,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (input.kind === 'image') {
    const request = buildImageResponsesRequest(config, input);
    const response = await fetchImpl(request.endpoint, { ...request.init, signal });
    return await adaptUnaryResponse(response);
  }
  const request = buildVideoResponsesRequest(config, input, input.fileId);
  const response = await fetchImpl(request.endpoint, { ...request.init, signal });
  if (!response.ok) {
    throw new UpstreamRequestError(
      response.status,
      'The segmentation service rejected the request.',
    );
  }
  return response;
}
