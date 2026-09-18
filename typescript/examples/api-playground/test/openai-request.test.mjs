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
} from '../openai-request.mjs';

const config = {
  apiKey: 'server-only-key',
  baseURL: 'https://api.meta.ai/v1',
  model: 'configured-model',
};
const imageInput = {
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
const videoMedia = {
  kind: 'video',
  mimeType: 'video/mp4',
  filename: 'clip.mp4',
  bytes: Buffer.from('mp4-bytes'),
};
const videoInput = {
  prompt: 'apple',
  kind: 'video',
  fileId: 'file-987',
};

function unaryResponse(overrides = {}) {
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

  it('uploads video through the Files API and references the opaque handle', () => {
    const upload = buildFileUploadRequest(config, videoMedia);
    expect(upload.endpoint.href).toBe('https://api.meta.ai/v1/files');
    expect(upload.init.method).toBe('POST');
    expect(upload.init.headers.Authorization).toBe('Bearer server-only-key');
    expect(upload.init.body).toBeInstanceOf(FormData);
    expect(upload.init.body.get('purpose')).toBe('user_data');
    const file = upload.init.body.get('file');
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
    const fetchImpl = vi.fn(() =>
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
    expect(fetchImpl.mock.calls[0][0].href).toBe('https://api.meta.ai/v1/models');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      'Bearer server-only-key',
    );

    for (const data of [
      [{ id: 'invalid model' }],
      Array.from({ length: 501 }, () => ({ id: 'same' })),
    ]) {
      const invalid = vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ data }))),
      );
      await expect(fetchModelIds(config, undefined, invalid)).rejects.toThrow(
        /model list is invalid/i,
      );
    }
  });

  it('rejects an oversized model response without exposing its body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [], secret: 'x'.repeat(300_000) })),
      ),
    );
    await expect(fetchModelIds(config, undefined, fetchImpl)).rejects.toThrow(
      /model list exceeded its size limit/i,
    );
  });

  it('rejects upload responses without a well-formed file id', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: 'nope' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(
      uploadMediaFile(config, videoMedia, undefined, fetchImpl),
    ).rejects.toThrow(/invalid file handle/);
    const rejected = vi.fn(() =>
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
    const imageFetch = vi.fn(() => Promise.resolve(unaryResponse()));
    const controller = new AbortController();
    const image = await createSAMResponsesStream(
      config,
      imageInput,
      controller.signal,
      imageFetch,
    );
    expect(image.headers.get('content-type')).toContain('application/x-ndjson');
    expect(imageFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(imageFetch.mock.calls[0][1].body).stream).toBe(false);

    const videoFetch = vi.fn(() =>
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
    expect(videoFetch.mock.calls[0][0].pathname).toBe('/v1/responses');
    const responsesBody = JSON.parse(videoFetch.mock.calls[0][1].body);
    expect(responsesBody.stream).toBe(true);
    expect(responsesBody.input[0].content[1]).toEqual({
      type: 'input_video',
      file_id: 'file-987',
    });
    expect(videoFetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('surfaces the upstream status when a video handle is rejected', async () => {
    const rejected = vi.fn(() =>
      Promise.resolve(new Response('missing file', { status: 404 })),
    );
    await expect(
      createSAMResponsesStream(config, videoInput, undefined, rejected),
    ).rejects.toMatchObject({ name: 'UpstreamRequestError', status: 404 });
    expect(rejected).toHaveBeenCalledOnce();
  });
});
