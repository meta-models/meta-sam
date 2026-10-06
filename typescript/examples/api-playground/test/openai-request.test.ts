/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  adaptUnaryResponse,
  buildFileUploadRequest,
  buildImageResponsesRequest,
  buildVideoResponsesRequest,
  createSAMResponsesStream,
  fetchModelIds,
  normalizeSAMPrompt,
  uploadMediaFile,
} from '../server/openai-request.ts';

import type {
  ImageRelayInput,
  ServerConfig,
  ValidatedMedia,
  VideoRelayInput,
} from '../server/server-core.ts';

const config: ServerConfig = {
  apiKey: 'server-only-key',
  baseURL: 'https://api.meta.ai/v1',
  configured: true,
  host: '127.0.0.1',
  model: 'configured-model',
  port: 4173,
};
const imageInput: ImageRelayInput = {
  prompt: 'rectangular panel',
  model: 'sam-3.1',
  kind: 'image',
  media: {
    kind: 'image',
    mimeType: 'image/png',
    filename: 'panel.png',
    bytes: Buffer.from('png'),
  },
};
const videoMedia: ValidatedMedia = {
  kind: 'video',
  mimeType: 'video/mp4',
  filename: 'clip.mp4',
  bytes: Buffer.from('mp4-bytes'),
};
const videoInput: VideoRelayInput = {
  prompt: 'apple',
  kind: 'video',
  fileId: 'file-987',
};

type FetchCall = [input: string | URL | Request, init?: RequestInit];

function fetchCall(mock: { mock: { calls: FetchCall[] } }, index = 0): FetchCall {
  const call = mock.mock.calls[index];
  if (call === undefined) throw new Error(`Missing fetch call ${index}.`);
  return call;
}

function fetchUrl(input: string | URL | Request): URL {
  if (input instanceof Request) return new URL(input.url);
  return input instanceof URL ? input : new URL(input);
}

function fetchHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON body.');
  return JSON.parse(init.body) as Record<string, unknown>;
}

function unaryResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          id: 'message-1',
          content: [{ type: 'output_text', text: '<0f>record\n' }],
        },
      ],
      ...overrides,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

describe('Model API Responses request', () => {
  it('uses the native unary SAM image contract without overriding model behavior', () => {
    const request = buildImageResponsesRequest(config, imageInput);
    expect(request.endpoint.href).toBe('https://api.meta.ai/v1/responses');
    expect(request.init.headers.Accept).toBe('application/json');
    expect(request.init.headers.Authorization).toBe('Bearer server-only-key');
    expect(JSON.parse(request.init.body)).toEqual({
      model: 'sam-3.1',
      stream: false,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'rectangular panel' },
            { type: 'input_image', image_url: 'data:image/png;base64,cG5n' },
          ],
        },
      ],
    });
    expect(() => normalizeSAMPrompt('   ')).toThrow(/noun phrase/);
  });

  it('sends a score threshold as string metadata only when one is set', () => {
    const withThreshold = JSON.parse(
      buildImageResponsesRequest(config, { ...imageInput, scoreThreshold: 0.35 }).init
        .body,
    ) as Record<string, unknown>;
    expect(withThreshold.metadata).toEqual({ score_threshold: '0.35' });
    const atZero = JSON.parse(
      buildImageResponsesRequest(config, { ...imageInput, scoreThreshold: 0 }).init
        .body,
    ) as Record<string, unknown>;
    expect(atZero.metadata).toEqual({ score_threshold: '0' });
    const without = JSON.parse(
      buildImageResponsesRequest(config, imageInput).init.body,
    ) as Record<string, unknown>;
    expect(without).not.toHaveProperty('metadata');
  });

  it('asks for confidence through string metadata on image and video requests', () => {
    const image = JSON.parse(
      buildImageResponsesRequest(config, {
        ...imageInput,
        scoreThreshold: 0.35,
        includeConfidence: true,
      }).init.body,
    ) as Record<string, unknown>;
    expect(image.metadata).toEqual({
      score_threshold: '0.35',
      include_confidence: 'true',
    });
    const optedOut = JSON.parse(
      buildImageResponsesRequest(config, { ...imageInput, includeConfidence: false })
        .init.body,
    ) as Record<string, unknown>;
    expect(optedOut.metadata).toEqual({ include_confidence: 'false' });
    const video = JSON.parse(
      buildVideoResponsesRequest(
        config,
        { prompt: 'pillow', model: 'sam-3.1', includeConfidence: true },
        'file-123',
      ).init.body,
    ) as Record<string, unknown>;
    expect(video.metadata).toEqual({ include_confidence: 'true' });
    const plainVideo = JSON.parse(
      buildVideoResponsesRequest(
        config,
        { prompt: 'pillow', model: 'sam-3.1' },
        'file-123',
      ).init.body,
    ) as Record<string, unknown>;
    expect(plainVideo).not.toHaveProperty('metadata');
  });

  it('uploads video through the Files API and references the opaque handle', () => {
    const upload = buildFileUploadRequest(config, videoMedia);
    expect(upload.endpoint.href).toBe('https://api.meta.ai/v1/files');
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers.Authorization).toBe('Bearer server-only-key');
    expect(upload.init.body).toBeInstanceOf(FormData);
    expect(upload.init.body.get('purpose')).toBe('user_data');
    const file = upload.init.body.get('file');
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new TypeError('Expected an uploaded File.');
    expect(file.name).toBe('clip.mp4');
    expect(file.type).toBe('video/mp4');

    const request = buildVideoResponsesRequest(config, videoInput, 'file-123');
    expect(request.init.headers.Accept).toBe('text/event-stream');
    expect(JSON.parse(request.init.body)).toEqual({
      model: 'configured-model',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'apple' },
            { type: 'input_video', file_id: 'file-123' },
          ],
        },
      ],
    });
    expect(() => buildVideoResponsesRequest(config, videoInput, 'not-a-file')).toThrow(
      /file handle/,
    );
  });

  it('fetches and validates a bounded unfiltered model list', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'zeta-model' }, { id: 'beta-model' }],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    await expect(fetchModelIds(config, undefined, fetchImpl)).resolves.toEqual([
      'zeta-model',
      'beta-model',
    ]);
    const [modelsInput, modelsInit] = fetchCall(fetchImpl);
    expect(fetchUrl(modelsInput).href).toBe('https://api.meta.ai/v1/models');
    expect(fetchHeaders(modelsInit).get('Authorization')).toBe(
      'Bearer server-only-key',
    );

    for (const data of [
      [{ id: 'invalid model' }],
      Array.from({ length: 501 }, () => ({ id: 'same' })),
    ]) {
      const invalid = vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response(JSON.stringify({ data }))),
      );
      await expect(fetchModelIds(config, undefined, invalid)).rejects.toThrow(
        /model list is invalid/i,
      );
    }
  });

  it('rejects an oversized model response without exposing its body', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [], secret: 'x'.repeat(300_000) })),
      ),
    );
    await expect(fetchModelIds(config, undefined, fetchImpl)).rejects.toThrow(
      /model list exceeded its size limit/i,
    );
  });

  it('rejects upload responses without a well-formed file id', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'nope' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(
      uploadMediaFile(config, videoMedia, undefined, fetchImpl),
    ).rejects.toThrow(/invalid file handle/);
    const rejected = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('denied', { status: 403 })),
    );
    await expect(
      uploadMediaFile(config, videoMedia, undefined, rejected),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('adapts a unary Model API result to structural parser events', async () => {
    const adapted = await adaptUnaryResponse(unaryResponse());
    const events = (await adapted.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      {
        type: 'response.output_text.delta',
        delta: '<0f>record\n',
        item_id: 'message-1',
        output_index: 0,
        content_index: 0,
      },
      {
        type: 'response.output_text.done',
        text: '<0f>record\n',
        item_id: 'message-1',
        output_index: 0,
        content_index: 0,
      },
      { type: 'response.completed' },
    ]);
  });

  it('preserves failed and incomplete terminal states', async () => {
    const failed = await adaptUnaryResponse(
      unaryResponse({ status: 'failed', output: [], error: { message: 'boom' } }),
    );
    expect(JSON.parse((await failed.text()).trim())).toEqual({
      type: 'response.failed',
      response: { error: { message: 'boom' } },
    });
    const incomplete = await adaptUnaryResponse(
      unaryResponse({
        status: 'incomplete',
        output: [],
        incomplete_details: { reason: 'max_output_tokens' },
      }),
    );
    expect(JSON.parse((await incomplete.text()).trim())).toEqual({
      type: 'response.incomplete',
      response: { incomplete_details: { reason: 'max_output_tokens' } },
    });
    const passthrough = new Response('denied', { status: 401 });
    expect(await adaptUnaryResponse(passthrough)).toBe(passthrough);
  });

  it('dispatches image inputs to the unary path and video handles straight to the stream', async () => {
    const imageFetch = vi.fn<typeof fetch>(() => Promise.resolve(unaryResponse()));
    const controller = new AbortController();
    const image = await createSAMResponsesStream(
      config,
      imageInput,
      controller.signal,
      imageFetch,
    );
    expect(image.headers.get('content-type')).toContain('application/x-ndjson');
    expect(imageFetch).toHaveBeenCalledOnce();
    const [, imageInit] = fetchCall(imageFetch);
    expect(jsonBody(imageInit).stream).toBe(false);

    const videoFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('data: {"type":"response.completed"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    );
    const video = await createSAMResponsesStream(
      config,
      videoInput,
      controller.signal,
      videoFetch,
    );
    expect(video.headers.get('content-type')).toContain('text/event-stream');
    expect(videoFetch).toHaveBeenCalledOnce();
    const [videoInputUrl, videoInit] = fetchCall(videoFetch);
    expect(fetchUrl(videoInputUrl).pathname).toBe('/v1/responses');
    const responsesBody = jsonBody(videoInit) as {
      stream: boolean;
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(responsesBody.stream).toBe(true);
    expect(responsesBody.input[0]?.content[1]).toEqual({
      type: 'input_video',
      file_id: 'file-987',
    });
    expect(videoInit?.signal).toBe(controller.signal);
  });

  it('surfaces the upstream status when a video handle is rejected', async () => {
    const rejected = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('missing file', { status: 404 })),
    );
    await expect(
      createSAMResponsesStream(config, videoInput, undefined, rejected),
    ).rejects.toMatchObject({ name: 'UpstreamRequestError', status: 404 });
    expect(rejected).toHaveBeenCalledOnce();
  });
});
