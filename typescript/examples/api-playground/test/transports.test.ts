/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  formats,
  frameIndexOf,
  parseResponsesStream,
  recordsOfKind,
  type ResponsesEvent,
} from '@meta-sam/parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getReplayScenario } from '../src/scenarios';
import {
  LiveTransport,
  parseStructuralResponse,
  ReplayTransport,
  STALE_FILE_HANDLE,
  uploadMediaFile,
  type StreamRequest,
} from '../src/transports';

const request: StreamRequest = {
  fixtureId: 'test',
  kind: 'image',
  prompt: 'shape',
  model: 'zeta-model',
};

function scenario(events: readonly ResponsesEvent[], delayMs = 0) {
  return {
    id: 'test',
    mediaMode: 'image' as const,
    title: 'Test',
    description: 'Test',
    prompt: 'shape',
    media: { url: '/test.svg', width: 1, height: 1 },
    events: events.map((event) => ({ delayMs, event })),
  };
}

async function collect(response: Response): Promise<ResponsesEvent[]> {
  const events: ResponsesEvent[] = [];
  for await (const event of parseStructuralResponse(
    response,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe('ReplayTransport', () => {
  it('preserves deterministic event order and terminal completion', async () => {
    const text =
      "<0f>0<|box;x1=0;y1=0;x2=7;y2=7;w=96;h=64|><|mask;x=0;y=0;data=8,8,!!!!!'y:Duu@D|>\n";
    const events: ResponsesEvent[] = [
      {
        type: 'response.output_text.delta',
        item_id: 'message',
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: 'response.output_text.done',
        item_id: 'message',
        output_index: 0,
        content_index: 0,
        text,
      },
      { type: 'response.completed' },
    ];
    const transport = new ReplayTransport([scenario(events)]);
    const parsed = parseResponsesStream(
      transport.stream(request, new AbortController().signal),
      formats.segmentation.image(),
    );
    const revisions: number[] = [];
    for await (const snapshot of parsed) revisions.push(snapshot.revision);
    await expect(parsed.finalResult).resolves.toMatchObject({
      outcome: { status: 'completed' },
      records: [
        { kind: 'box', objectId: '0' },
        { kind: 'mask', objectId: '0' },
      ],
    });
    expect(revisions).toEqual([1]);
  });

  it('rejects a request whose prompt does not match its replay scenario', async () => {
    const transport = new ReplayTransport([scenario([{ type: 'response.completed' }])]);
    const next = transport
      .stream({ ...request, prompt: 'different prompt' }, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow(
      'The replay prompt does not match the selected example.',
    );
  });

  it('rejects a request whose media mode does not match its replay scenario', async () => {
    const transport = new ReplayTransport([scenario([{ type: 'response.completed' }])]);
    const next = transport
      .stream({ ...request, kind: 'video' }, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow(
      'The replay scenario does not match the selected media kind.',
    );
  });

  it('parses the checked-in video scenario as cumulative frame-qualified records', async () => {
    const fixture = getReplayScenario('video-quick', 'video');
    const transport = new ReplayTransport([fixture]);
    const parsed = parseResponsesStream(
      transport.stream(
        {
          fixtureId: fixture.id,
          kind: 'video',
          prompt: fixture.prompt,
          model: 'zeta-model',
        },
        new AbortController().signal,
      ),
      formats.segmentation.video(),
    );
    const revisions: number[] = [];
    const recordCounts: number[] = [];
    for await (const snapshot of parsed) {
      revisions.push(snapshot.revision);
      recordCounts.push(snapshot.records.length);
    }
    const result = await parsed.finalResult;
    expect(revisions).toEqual([1, 2]);
    expect(recordCounts).toEqual([2, 4]);
    expect(result).toMatchObject({
      media: 'video',
      revision: 2,
      outcome: { status: 'completed' },
    });
    expect(result.records.map(frameIndexOf)).toEqual([0, 0, 4, 4]);
    expect(
      recordsOfKind(result.records, 'mask').map((record) => record.identity),
    ).toEqual(['video:0:0', 'video:4:1']);
  });

  it('aborts a pending deterministic delay', async () => {
    const transport = new ReplayTransport([
      scenario([{ type: 'response.completed' }], 10_000),
    ]);
    const controller = new AbortController();
    const next = transport
      .stream(request, controller.signal)
      [Symbol.asyncIterator]()
      .next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ships the checked-in scenarios in declared order', async () => {
    const fixture = getReplayScenario('two-objects');
    const transport = new ReplayTransport([fixture]);
    const types: string[] = [];
    for await (const event of transport.stream(
      { ...request, fixtureId: fixture.id, prompt: fixture.prompt },
      new AbortController().signal,
    )) {
      types.push(event.type);
    }
    expect(types).toEqual([
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.completed',
    ]);
  });
});

describe('structural response decoding', () => {
  it('decodes NDJSON without a prediction-specific envelope', async () => {
    const response = new Response('{"type":"response.completed"}\n', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
    await expect(collect(response)).resolves.toEqual([{ type: 'response.completed' }]);
  });

  it.each([
    ['LF', ['event: response.completed\ndata: {"type":"response.completed"}\n\n']],
    [
      'CRLF',
      ['event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n'],
    ],
    ['bare CR', ['event: response.completed\rdata: {"type":"response.completed"}\r\r']],
    [
      'chunk-split CRLF',
      [
        'event: response.completed\r',
        '\ndata: {"type":"response.completed"}\r',
        '\n\r',
        '\n',
      ],
    ],
  ])('decodes SSE with %s delimiters', async (_name, chunks) => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    await expect(collect(response)).resolves.toEqual([{ type: 'response.completed' }]);
  });

  it('emits multiple bare-CR SSE events before EOF', async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"response.created"}\r\r' +
                'data: {"type":"response.completed"}\r\r' +
                ': keepalive\r',
            ),
          );
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const iterator = parseStructuralResponse(response, new AbortController().signal)[
      Symbol.asyncIterator
    ]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'response.created' },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'response.completed' },
      done: false,
    });
    await iterator.return?.();
  });

  it('returns a bounded non-2xx JSON error message', async () => {
    const response = new Response(
      JSON.stringify({ error: { message: 'The request was invalid.' } }),
      { status: 400 },
    );
    const next = parseStructuralResponse(response, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow('The request was invalid.');
  });

  it('cancels an oversized non-2xx body without waiting for EOF', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 500 },
    );
    const next = parseStructuralResponse(response, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow('The live relay rejected the request.');
    expect(cancelled).toBe(true);
  });
});

describe('LiveTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(response: () => Response) {
    const calls: { url: string; body: FormData }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as FormData });
        return Promise.resolve(response());
      }),
    );
    return calls;
  }

  async function drain(request: StreamRequest): Promise<void> {
    for await (const _event of new LiveTransport().stream(
      request,
      new AbortController().signal,
    )) {
      // The relay's terminal event is enough for these assertions.
    }
  }

  it('sends a video handle instead of bytes and keeps images inline', async () => {
    const calls = stubFetch(
      () =>
        new Response('{"type":"response.completed"}\n', {
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
    );
    await drain({
      fixtureId: null,
      kind: 'video',
      prompt: 'pillow',
      model: 'sam-3.1',
      fileId: 'file-abc123',
    });
    expect(calls[0]?.url).toBe('/api/responses');
    expect(calls[0]?.body.get('prompt')).toBe('pillow');
    expect(calls[0]?.body.get('model')).toBe('sam-3.1');
    expect(calls[0]?.body.get('file_id')).toBe('file-abc123');
    expect(calls[0]?.body.get('media')).toBeNull();

    await drain({
      fixtureId: null,
      kind: 'image',
      prompt: 'duck',
      model: 'sam-3.1',
      media: new Blob(['png'], { type: 'image/png' }),
      filename: 'duck.png',
    });
    expect(calls[1]?.body.get('file_id')).toBeNull();
    expect(calls[1]?.body.get('media')).not.toBeNull();
  });

  it('refuses a live video request without an uploaded handle', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const next = new LiveTransport()
      .stream(
        {
          fixtureId: null,
          kind: 'video',
          prompt: 'pillow',
          model: 'zeta-model',
        },
        new AbortController().signal,
      )
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toThrow(/uploaded file handle/);
  });

  it('uploads media once and returns the opaque handle', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ file_id: 'file-abc123', bytes: 3 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      uploadMediaFile(
        new Blob(['mp4'], { type: 'video/mp4' }),
        'clip.mp4',
        new AbortController().signal,
      ),
    ).resolves.toEqual({ fileId: 'file-abc123', bytes: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/files');
    expect(calls[0]?.body.get('prompt')).toBeNull();
    expect(calls[0]?.body.get('media')).not.toBeNull();
  });

  it('rejects an upload response without a well-formed handle', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ file_id: 'nope' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      uploadMediaFile(new Blob(['mp4']), 'clip.mp4', new AbortController().signal),
    ).rejects.toThrow(/invalid file handle/);
  });

  it('carries the relay error code so a stale handle can be recovered', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: STALE_FILE_HANDLE,
          message: 'The uploaded video is no longer available. Upload it again.',
        },
      }),
      { status: 409 },
    );
    const next = parseStructuralResponse(response, new AbortController().signal)
      [Symbol.asyncIterator]()
      .next();
    await expect(next).rejects.toMatchObject({
      code: STALE_FILE_HANDLE,
      message: 'The uploaded video is no longer available. Upload it again.',
    });
  });
});
