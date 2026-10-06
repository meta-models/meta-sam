/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeader,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';

import {
  applySecurityHeaders,
  assertMultipartContentType,
  authorizeSameOrigin,
  createApiHandler,
  detectMediaType,
  MAX_MEDIA_SIZE,
  parseMultipartBody,
  projectResponsesEvent,
  readServerConfig,
  relayResponsesEvents,
  validateMediaInput,
  validateUploadInput,
} from '../server/server-core.ts';
import type {
  MultipartFields,
  RelayInput,
  ValidatedMedia,
} from '../server/server-core.ts';

const mediaBytes = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
  'image/webp': Buffer.from('RIFF0000WEBP'),
  'image/gif': Buffer.from('GIF89a'),
  'video/mp4': Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0, 0, 0, 0]),
  ]),
};

interface MultipartPart {
  readonly name: string;
  readonly filename?: string;
  readonly contentType?: string;
  readonly data: string | Buffer;
}

interface RequestOptions {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly origin?: string;
  readonly rawHeaders?: string[];
}

type RecordedResponse = ServerResponse & {
  body: string;
  destroyed: boolean;
  headers: Record<string, OutgoingHttpHeader>;
  status: number | null;
  writableEnded: boolean;
};

function multipart(
  parts: readonly MultipartPart[],
  boundary = 'boundary-test',
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition =
      part.filename === undefined
        ? `Content-Disposition: form-data; name="${part.name}"\r\n`
        : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`;
    chunks.push(Buffer.from(disposition));
    if (part.contentType !== undefined) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function request({
  method = 'GET',
  url = '/api/config',
  host = '127.0.0.1:4173',
  origin,
  rawHeaders,
}: RequestOptions = {}): IncomingMessage {
  const headers: IncomingHttpHeaders = {
    host,
    ...(origin === undefined ? {} : { origin }),
  };
  return {
    method,
    url,
    headers,
    rawHeaders:
      rawHeaders ??
      Object.entries(headers).flatMap(([name, value]) => [name, String(value)]),
  } as IncomingMessage;
}

function responseRecorder(): RecordedResponse {
  const recorder = {
    body: '',
    destroyed: false,
    headers: {} as Record<string, OutgoingHttpHeader>,
    status: null as number | null,
    writableEnded: false,
    setHeader(name: string, value: OutgoingHttpHeader) {
      recorder.headers[name.toLowerCase()] = value;
      return recorder;
    },
    writeHead(status: number, headers: OutgoingHttpHeaders = {}) {
      recorder.status = status;
      for (const [name, value] of Object.entries(headers)) {
        if (value !== undefined) recorder.headers[name.toLowerCase()] = value;
      }
      return recorder;
    },
    write(chunk: string | Uint8Array) {
      recorder.body += String(chunk);
      return true;
    },
    end(body: string | Uint8Array = '') {
      recorder.body += String(body);
      recorder.writableEnded = true;
      return recorder;
    },
    on() {
      return recorder;
    },
    once() {
      return recorder;
    },
    off() {
      return recorder;
    },
  };
  return recorder as unknown as RecordedResponse;
}

function postRequest(
  url: string,
  body: Buffer,
  boundary = 'boundary-test',
): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.method = 'POST';
  stream.url = url;
  stream.headers = {
    host: '127.0.0.1:4173',
    origin: 'http://127.0.0.1:4173',
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(body.length),
  };
  stream.rawHeaders = Object.entries(stream.headers).flatMap(([name, value]) => [
    name,
    String(value),
  ]);
  return stream;
}

function writeOnlyResponse(
  write: (chunk: string | Uint8Array) => boolean,
): ServerResponse {
  return {
    destroyed: false,
    writableEnded: false,
    write,
  } as unknown as ServerResponse;
}

function liveConfig() {
  return readServerConfig(
    { SAM_API_KEY: 'private-value', SAM_MODEL: 'configured-model' },
    { host: '127.0.0.1' },
  );
}

describe('live server boundary', () => {
  it('uses a strict production CSP with only the required Astryx style hash', () => {
    const response = responseRecorder();
    applySecurityHeaders(response);
    expect(response.headers['content-security-policy']).toContain(
      "connect-src 'self';",
    );
    expect(response.headers['content-security-policy']).not.toMatch(/\bws:/);
    expect(response.headers['content-security-policy']).not.toMatch(/\bwss:/);
    expect(response.headers['content-security-policy']).not.toContain(
      "'unsafe-inline'",
    );
    expect(response.headers['content-security-policy']).toContain("script-src 'self';");
    expect(response.headers['content-security-policy']).toContain(
      "style-src 'self' 'sha256-W8DZlwvt7jPAC5BancWmJ6mGbNdefbHBPaUSM8MxNfQ='",
    );
  });

  it('requires explicit valid key and model, defaults the authoritative base URL, and keeps credentials loopback-only', () => {
    const unconfigured = readServerConfig({});
    expect(unconfigured).toMatchObject({
      apiKey: null,
      baseURL: 'https://api.meta.ai/v1',
      configured: false,
      host: '127.0.0.1',
      model: null,
    });
    expect(readServerConfig({ SAM_API_KEY: 'private-value' }).configured).toBe(false);
    expect(readServerConfig({ SAM_MODEL: 'configured-model' }).configured).toBe(false);
    expect(() => readServerConfig({ SAM_MODEL: 'invalid model' })).toThrow(
      /SAM_MODEL must match/,
    );

    const configured = readServerConfig(
      { SAM_API_KEY: 'private-value', SAM_MODEL: 'configured-model' },
      { host: 'localhost' },
    );
    const browserPayload = JSON.stringify({
      configured: configured.configured,
      endpointOrigin: new URL(configured.baseURL).origin,
      model: configured.model,
    });
    expect(browserPayload).toBe(
      '{"configured":true,"endpointOrigin":"https://api.meta.ai","model":"configured-model"}',
    );
    expect(browserPayload).not.toContain('private-value');

    expect(() =>
      readServerConfig(
        { SAM_API_KEY: 'private-value', SAM_MODEL: 'configured-model' },
        { host: '0.0.0.0' },
      ),
    ).toThrow(/requires a loopback host/i);
    expect(readServerConfig({}, { host: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('rejects credentials and query parameters in the upstream base URL', () => {
    for (const baseURL of [
      'https://user:secret@example.test/v1',
      'https://example.test/v1?api_key=secret',
      'https://example.test/v1#token',
    ]) {
      expect(() => readServerConfig({ SAM_API_BASE_URL: baseURL })).toThrow(
        /credential-free HTTPS URL without query parameters/i,
      );
    }
  });

  it('validates one Host and an exact same-origin POST authority', () => {
    const liveConfig = readServerConfig(
      { SAM_API_KEY: 'private-value' },
      { host: '127.0.0.1' },
    );
    const replayConfig = readServerConfig({}, { host: '0.0.0.0' });

    expect(
      authorizeSameOrigin(
        request({
          method: 'POST',
          host: '127.0.0.1:4173',
          origin: 'http://127.0.0.1:4173',
        }),
        liveConfig,
      ),
    ).toBe(true);
    expect(
      authorizeSameOrigin(
        request({
          method: 'POST',
          host: 'preview.example.test',
          origin: 'https://preview.example.test',
        }),
        liveConfig,
      ),
    ).toBe(false);
    expect(
      authorizeSameOrigin(
        request({
          method: 'POST',
          host: 'preview.example.test',
          origin: 'https://preview.example.test',
        }),
        replayConfig,
      ),
    ).toBe(true);
    expect(
      authorizeSameOrigin(
        request({
          method: 'POST',
          host: 'preview.example.test',
          origin: 'https://other.example.test',
        }),
        replayConfig,
      ),
    ).toBe(false);
    expect(
      authorizeSameOrigin(
        request({ rawHeaders: ['Host', 'localhost', 'Host', 'localhost'] }),
        liveConfig,
      ),
    ).toBe(false);
  });

  it('keeps remote replay preview available while live responses return 503', async () => {
    const config = readServerConfig({}, { host: '0.0.0.0' });
    const handler = createApiHandler({
      config,
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const response = responseRecorder();
    await handler(
      request({
        method: 'POST',
        url: '/api/responses',
        host: 'preview.example.test',
        origin: 'https://preview.example.test',
      }),
      response,
    );
    expect(response.status).toBe(503);
    expect(response.body).toContain('not_configured');
  });

  it('answers unknown /api routes with a JSON 404 instead of the SPA shell', async () => {
    const handler = createApiHandler({
      config: readServerConfig({}),
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const response = responseRecorder();
    const handled = await handler(request({ url: '/api/nope' }), response);
    expect(handled).toBe(true);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: { code: 'not_found', message: 'Unknown API route.' },
    });
    const passthrough = responseRecorder();
    expect(await handler(request({ url: '/media/truck.jpg' }), passthrough)).toBe(
      false,
    );
  });

  it('rejects query parameters at same-origin API endpoints', async () => {
    const handler = createApiHandler({
      config: readServerConfig({}),
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const response = responseRecorder();
    await handler(request({ url: '/api/config?token=secret' }), response);
    expect(response.status).toBe(400);
    expect(response.body).toBe('Query parameters are not allowed.\n');
  });

  it('returns only safe live metadata from GET /api/config', async () => {
    const handler = createApiHandler({
      config: readServerConfig(
        {
          SAM_API_KEY: 'private-value',
          SAM_API_BASE_URL: 'https://sam.example.test/v1',
          SAM_MODEL: 'configured-model',
        },
        { host: '127.0.0.1' },
      ),
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const response = responseRecorder();
    await handler(request(), response);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      configured: true,
      endpointOrigin: 'https://sam.example.test',
      model: 'configured-model',
    });
    expect(response.body).not.toContain('private-value');
  });

  it('reports the GET representation length for HEAD /api/config', async () => {
    const handler = createApiHandler({
      config: readServerConfig({}),
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const response = responseRecorder();
    await handler(request({ method: 'HEAD' }), response);
    const body = `${JSON.stringify({
      configured: false,
      endpointOrigin: 'https://api.meta.ai',
      model: null,
    })}\n`;
    expect(response.status).toBe(200);
    expect(response.headers['content-length']).toBe(Buffer.byteLength(body));
    expect(response.body).toBe('');
  });

  it('returns a sorted bounded model list and caches it for five minutes', async () => {
    let timestamp = 1_000;
    const listModels = vi.fn(() =>
      Promise.resolve(['sam-3.1', 'alpha-model', 'sam-3.1']),
    );
    const handler = createApiHandler({
      config: liveConfig(),
      listModels,
      createResponsesStream() {
        throw new Error('must not be called');
      },
      now: () => timestamp,
    });
    const first = responseRecorder();
    await handler(request({ url: '/api/models' }), first);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toEqual({
      models: [{ id: 'alpha-model' }, { id: 'sam-3.1' }],
      default: 'configured-model',
    });
    expect(listModels).toHaveBeenCalledOnce();

    timestamp += 5 * 60 * 1_000 - 1;
    await handler(request({ url: '/api/models' }), responseRecorder());
    expect(listModels).toHaveBeenCalledOnce();

    timestamp += 1;
    await handler(request({ url: '/api/models' }), responseRecorder());
    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('guards the models endpoint and sanitizes invalid upstream lists', async () => {
    const offline = createApiHandler({
      config: readServerConfig({}),
      listModels() {
        throw new Error('must not be called');
      },
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const unavailable = responseRecorder();
    await offline(request({ url: '/api/models' }), unavailable);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toContain('not_configured');

    const invalid = createApiHandler({
      config: liveConfig(),
      listModels() {
        return Promise.resolve(['valid-model', 'invalid model']);
      },
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const rejected = responseRecorder();
    await invalid(request({ url: '/api/models' }), rejected);
    expect(rejected.status).toBe(502);
    expect(rejected.body).toContain('upstream_error');
    expect(rejected.body).not.toContain('invalid model');

    const method = responseRecorder();
    await invalid(
      request({
        method: 'POST',
        url: '/api/models',
        origin: 'http://127.0.0.1:4173',
      }),
      method,
    );
    expect(method.status).toBe(405);
    expect(method.headers.allow).toBe('GET');
  });

  it('sniffs the media kind from bytes, not the declared type', () => {
    expect(detectMediaType(mediaBytes['image/png'])).toEqual({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(detectMediaType(mediaBytes['image/jpeg'])).toEqual({
      kind: 'image',
      mimeType: 'image/jpeg',
    });
    expect(detectMediaType(mediaBytes['image/webp'])).toEqual({
      kind: 'image',
      mimeType: 'image/webp',
    });
    expect(detectMediaType(mediaBytes['image/gif'])).toEqual({
      kind: 'image',
      mimeType: 'image/gif',
    });
    expect(detectMediaType(mediaBytes['video/mp4'])).toEqual({
      kind: 'video',
      mimeType: 'video/mp4',
    });
    expect(
      detectMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(detectMediaType(Buffer.from('\x1aE\xdf\xa3webm', 'latin1'))).toBeNull();
  });

  it('decodes exactly the prompt and media multipart parts', () => {
    const body = multipart([
      { name: 'prompt', data: 'apple' },
      { name: 'model', data: 'sam-3.1' },
      {
        name: 'media',
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        data: mediaBytes['video/mp4'],
      },
    ]);
    const boundary = assertMultipartContentType({
      'content-type': 'multipart/form-data; boundary=boundary-test',
    });
    const fields = parseMultipartBody(body, boundary);
    expect(fields.prompt).toBe('apple');
    expect(fields.model).toBe('sam-3.1');
    const media = fields.media;
    expect(media).toBeDefined();
    if (media === undefined) throw new TypeError('Expected a media field.');
    expect(media.filename).toBe('clip.mp4');
    expect(media.contentType).toBe('video/mp4');
    expect(Buffer.compare(media.bytes, mediaBytes['video/mp4'])).toBe(0);

    const upload = validateUploadInput(fields);
    expect(upload).toMatchObject({
      media: { kind: 'video', mimeType: 'video/mp4', filename: 'clip.mp4' },
    });

    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'x' },
          { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
          { name: 'apiKey', data: 'must-not-cross' },
        ]),
        boundary,
      ),
    ).toThrow(/unsupported fields/i);
    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'x' },
          { name: 'prompt', data: 'y' },
        ]),
        boundary,
      ),
    ).toThrow(/repeats a field/i);
    expect(() => parseMultipartBody(Buffer.from('garbage'), boundary)).toThrow(
      /malformed/i,
    );
    expect(() =>
      assertMultipartContentType({ 'content-type': 'application/json' }),
    ).toThrow(/multipart\/form-data/);
  });

  it('accepts only the media part on the upload route', () => {
    const boundary = 'boundary-test';
    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'apple' },
          { name: 'media', filename: 'clip.mp4', data: mediaBytes['video/mp4'] },
        ]),
        boundary,
        new Set(['media']),
      ),
    ).toThrow(/unsupported fields/i);

    const expectCode = (fields: MultipartFields, code: string): void => {
      let caught: unknown;
      try {
        validateUploadInput(fields);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
    };
    expectCode({ media: { bytes: mediaBytes['image/png'] } }, 'unsupported_media');
    expectCode({}, 'invalid_media');
    expectCode(
      { media: { bytes: Buffer.alloc(MAX_MEDIA_SIZE + 1) } },
      'media_too_large',
    );
  });

  it('takes video by handle and images by bytes on the responses route', () => {
    const boundary = 'boundary-test';
    const fields = parseMultipartBody(
      multipart([
        { name: 'prompt', data: 'apple' },
        { name: 'model', data: 'sam-3.1' },
        { name: 'file_id', data: 'file-abc123' },
      ]),
      boundary,
    );
    expect(validateMediaInput(fields)).toEqual({
      prompt: 'apple',
      model: 'sam-3.1',
      kind: 'video',
      fileId: 'file-abc123',
    });

    const expectCode = (fields: MultipartFields, code: string): void => {
      let caught: unknown;
      try {
        validateMediaInput(fields);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
    };
    expectCode(
      {
        prompt: 'panel',
        file_id: 'file-abc123',
        media: { bytes: mediaBytes['image/png'] },
      },
      'invalid_request',
    );
    expectCode({ prompt: 'panel' }, 'invalid_media');
    expectCode({ prompt: 'panel', file_id: 'not-a-handle' }, 'invalid_file_id');
    expectCode(
      { prompt: 'panel', model: 'invalid model', file_id: 'file-abc123' },
      'invalid_model',
    );
    expectCode(
      { prompt: 'panel', model: 'x'.repeat(121), file_id: 'file-abc123' },
      'invalid_model',
    );
    expectCode(
      { prompt: 'panel', media: { bytes: mediaBytes['video/mp4'] } },
      'invalid_media',
    );
    expect(
      validateMediaInput({
        prompt: 'panel',
        media: { bytes: mediaBytes['image/png'] },
      }),
    ).toMatchObject({ kind: 'image', media: { mimeType: 'image/png' } });
  });

  it('accepts include_confidence as exactly true or false for image and video', () => {
    const boundary = 'boundary-test';
    const image = parseMultipartBody(
      multipart([
        { name: 'prompt', data: 'apple' },
        { name: 'include_confidence', data: 'true' },
        { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
      ]),
      boundary,
    );
    expect(image.include_confidence).toBe('true');
    expect(validateMediaInput(image)).toMatchObject({
      kind: 'image',
      includeConfidence: true,
    });
    expect(
      validateMediaInput({
        prompt: 'apple',
        include_confidence: 'false',
        file_id: 'file-abc123',
      }),
    ).toEqual({
      prompt: 'apple',
      kind: 'video',
      fileId: 'file-abc123',
      includeConfidence: false,
    });
    expect(
      validateMediaInput({ prompt: 'apple', file_id: 'file-abc123' }),
    ).not.toHaveProperty('includeConfidence');

    for (const value of ['TRUE', 'yes', '1', '', ' true']) {
      let caught: unknown;
      try {
        validateMediaInput({
          prompt: 'apple',
          include_confidence: value,
          file_id: 'file-abc123',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'invalid_include_confidence' });
    }
    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'apple' },
          { name: 'include_confidence', data: 'truest' },
        ]),
        boundary,
      ),
    ).toThrow(/include_confidence field is invalid/);
  });

  it('accepts a score threshold from 0 through 1 for images only', () => {
    const boundary = 'boundary-test';
    const fields = parseMultipartBody(
      multipart([
        { name: 'prompt', data: 'apple' },
        { name: 'score_threshold', data: '0.35' },
        { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
      ]),
      boundary,
    );
    expect(fields.score_threshold).toBe('0.35');
    expect(validateMediaInput(fields)).toMatchObject({
      kind: 'image',
      scoreThreshold: 0.35,
    });
    expect(
      validateMediaInput({
        prompt: 'apple',
        media: { bytes: mediaBytes['image/png'] },
      }),
    ).not.toHaveProperty('scoreThreshold');
    for (const [value, expected] of [
      ['0', 0],
      ['1', 1],
      ['.5', 0.5],
      [' 0.5 ', 0.5],
    ] as const) {
      expect(
        validateMediaInput({
          prompt: 'apple',
          score_threshold: value,
          media: { bytes: mediaBytes['image/png'] },
        }),
      ).toMatchObject({ scoreThreshold: expected });
    }

    const expectCode = (fields: MultipartFields): void => {
      let caught: unknown;
      try {
        validateMediaInput(fields);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'invalid_score_threshold' });
    };
    for (const value of ['1.5', '-0.1', 'abc', '', '1e-1', 'NaN', 'Infinity', '0x1']) {
      expectCode({
        prompt: 'apple',
        score_threshold: value,
        media: { bytes: mediaBytes['image/png'] },
      });
    }
    expectCode({ prompt: 'apple', score_threshold: '0.5', file_id: 'file-abc123' });
    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'apple' },
          { name: 'score_threshold', data: '0.'.padEnd(33, '5') },
        ]),
        boundary,
      ),
    ).toThrow(/score_threshold field is invalid/);
  });

  it('validates media bytes, declared types, size, and prompt bounds', () => {
    const image = validateMediaInput({
      prompt: '  rectangular panel ',
      media: {
        bytes: mediaBytes['image/jpeg'],
        filename: 'p.jpg',
        contentType: 'image/jpg',
      },
    });
    expect(image).toMatchObject({
      prompt: 'rectangular panel',
      media: { kind: 'image', mimeType: 'image/jpeg', filename: 'p.jpg' },
    });
    const sanitizedImage = validateMediaInput({
      prompt: 'panel',
      media: { bytes: mediaBytes['image/png'], filename: '../"evil"/x.png' },
    });
    if (sanitizedImage.kind !== 'image') {
      throw new TypeError('Expected validated image media.');
    }
    expect(sanitizedImage.media.filename).toBe('..evilx.png');
    expect(
      validateUploadInput({ media: { bytes: mediaBytes['video/mp4'] } }).media.filename,
    ).toBe('video.mp4');

    const expectCode = (fields: MultipartFields, code: string): void => {
      let caught: unknown;
      try {
        validateMediaInput(fields);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code });
    };
    expectCode(
      {
        prompt: 'panel',
        media: { bytes: mediaBytes['image/png'], contentType: 'image/gif' },
      },
      'invalid_media',
    );
    expectCode(
      {
        prompt: 'panel',
        media: { bytes: mediaBytes['video/mp4'], contentType: 'video/webm' },
      },
      'invalid_media',
    );
    expectCode(
      { prompt: 'panel', media: { bytes: Buffer.from('<svg/>') } },
      'unsupported_media',
    );
    expectCode({ prompt: 'panel', media: { bytes: Buffer.alloc(0) } }, 'invalid_media');
    expectCode(
      { prompt: 'panel', media: { bytes: Buffer.alloc(MAX_MEDIA_SIZE + 1) } },
      'media_too_large',
    );
    expectCode(
      { prompt: '', media: { bytes: mediaBytes['image/png'] } },
      'invalid_prompt',
    );
    expectCode(
      { prompt: 'x'.repeat(161), media: { bytes: mediaBytes['image/png'] } },
      'invalid_prompt',
    );
    expectCode({ prompt: 'panel' }, 'invalid_media');
  });

  it('validates the optional multipart model field independently', () => {
    const boundary = 'boundary-test';
    for (const part of [
      { name: 'model', data: 'x'.repeat(121) },
      { name: 'model', data: Buffer.from([0xff]) },
      { name: 'model', data: 'sam-3.1', filename: 'model.txt' },
    ]) {
      let caught;
      try {
        validateMediaInput(
          parseMultipartBody(
            multipart([
              { name: 'prompt', data: 'panel' },
              part,
              { name: 'file_id', data: 'file-abc123' },
            ]),
            boundary,
          ),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'invalid_model' });
    }
    expect(() =>
      parseMultipartBody(
        multipart([
          { name: 'prompt', data: 'panel' },
          { name: 'model', data: 'sam-3.1' },
          { name: 'model', data: 'zeta-model' },
          { name: 'file_id', data: 'file-abc123' },
        ]),
        boundary,
      ),
    ).toThrow(/repeats a field/i);
  });

  it('finalizes text lanes from content_part.done and drops duplicate finalizers', async () => {
    const lane = { item_id: 'msg', output_index: 0, content_index: 0 };
    expect(
      projectResponsesEvent({
        type: 'response.content_part.done',
        ...lane,
        part: { type: 'output_text', text: '<0f>a\n' },
      }),
    ).toEqual({ type: 'response.output_text.done', text: '<0f>a\n', ...lane });
    expect(
      projectResponsesEvent({
        type: 'response.content_part.done',
        ...lane,
        part: { type: 'refusal', refusal: 'no' },
      }),
    ).toEqual({ type: 'response.refusal.done', refusal: 'no', ...lane });
    expect(
      projectResponsesEvent({ type: 'response.content_part.added', ...lane, part: {} }),
    ).toBeNull();

    const upstream = new Response(
      [
        { type: 'response.output_text.delta', delta: '<0f>a\n', ...lane },
        {
          type: 'response.content_part.done',
          ...lane,
          part: { type: 'output_text', text: '<0f>a\n' },
        },
        { type: 'response.output_text.done', text: '<0f>a\n', ...lane },
        { type: 'response.completed' },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    let written = '';
    const downstream = writeOnlyResponse((chunk) => {
      written += String(chunk);
      return true;
    });
    await relayResponsesEvents(upstream, downstream, new AbortController().signal);
    const types = written
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);
    expect(types).toEqual([
      'response.output_text.delta',
      'response.output_text.done',
      'response.completed',
    ]);
  });

  it('enforces the per-event size limit on an unterminated upstream tail', async () => {
    const payload = JSON.stringify({
      type: 'response.completed',
      padding: 'x'.repeat(2 * 1024 * 1024),
    });
    const upstream = new Response(payload, {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
    const downstream = writeOnlyResponse(() => true);
    await expect(
      relayResponsesEvents(upstream, downstream, new AbortController().signal, {
        eventLimit: 1024 * 1024,
      }),
    ).rejects.toThrow(/event too large/i);
  });

  it('relays a multi-megabyte output_text.done that echoes the whole output', async () => {
    // "person" on a 1280x720 clip streams ~4 MB of output text, and the
    // terminal events repeat all of it; the old 2 MiB per-event cap failed
    // the run at the very end.
    const lane = { item_id: 'msg', output_index: 0, content_index: 0 };
    const text = `<0f>0<|box;x1=0;y1=0;x2=1;y2=1;w=1;h=1|><|mask;x=0;y=0;data=1,1,!!|>${'\n<1f>0'.repeat(1)}${'x'.repeat(4 * 1024 * 1024)}\n`;
    const upstream = new Response(
      [
        { type: 'response.output_text.delta', delta: text, ...lane },
        {
          type: 'response.content_part.done',
          ...lane,
          part: { type: 'output_text', text },
        },
        {
          type: 'response.completed',
          response: { output: [{ content: [{ type: 'output_text', text }] }] },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    let written = '';
    const downstream = writeOnlyResponse((chunk) => {
      written += String(chunk);
      return true;
    });
    await relayResponsesEvents(upstream, downstream, new AbortController().signal);
    const events = written
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.type)).toEqual([
      'response.output_text.delta',
      'response.output_text.done',
      'response.completed',
    ]);
    expect(events[1].text).toBe(text);
  });

  it('projects upstream failures to generic structural events', () => {
    expect(
      projectResponsesEvent({
        type: 'response.failed',
        response: { error: { message: 'sensitive upstream detail' } },
      }),
    ).toEqual({
      type: 'response.failed',
      response: { error: { message: 'The segmentation request failed.' } },
    });
  });

  it('returns only an opaque handle and byte count from POST /api/files', async () => {
    const uploads: ValidatedMedia[] = [];
    const handler = createApiHandler({
      config: liveConfig(),
      createResponsesStream() {
        throw new Error('must not be called');
      },
      uploadMedia(media) {
        uploads.push(media);
        return Promise.resolve('file-abc123');
      },
    });
    const response = responseRecorder();
    await handler(
      postRequest(
        '/api/files',
        multipart([
          {
            name: 'media',
            filename: 'clip.mp4',
            contentType: 'video/mp4',
            data: mediaBytes['video/mp4'],
          },
        ]),
      ),
      response,
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      file_id: 'file-abc123',
      bytes: mediaBytes['video/mp4'].length,
    });
    expect(response.body).not.toContain('private-value');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ kind: 'video', mimeType: 'video/mp4' });
  });

  it('refuses an image, a malformed handle, and an unconfigured upload', async () => {
    const handler = createApiHandler({
      config: liveConfig(),
      createResponsesStream() {
        throw new Error('must not be called');
      },
      uploadMedia() {
        return Promise.resolve('nope');
      },
    });
    const image = responseRecorder();
    await handler(
      postRequest(
        '/api/files',
        multipart([
          { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
        ]),
      ),
      image,
    );
    expect(image.status).toBe(415);
    expect(image.body).toContain('unsupported_media');

    const malformed = responseRecorder();
    await handler(
      postRequest(
        '/api/files',
        multipart([
          { name: 'media', filename: 'clip.mp4', data: mediaBytes['video/mp4'] },
        ]),
      ),
      malformed,
    );
    expect(malformed.status).toBe(502);
    expect(malformed.body).toContain('upstream_error');

    const unconfigured = createApiHandler({
      config: readServerConfig({}),
      createResponsesStream() {
        throw new Error('must not be called');
      },
    });
    const offline = responseRecorder();
    await handler(postRequest('/api/files', Buffer.from('garbage')), offline);
    expect(offline.status).toBe(400);
    const notConfigured = responseRecorder();
    await unconfigured(
      postRequest(
        '/api/files',
        multipart([
          { name: 'media', filename: 'clip.mp4', data: mediaBytes['video/mp4'] },
        ]),
      ),
      notConfigured,
    );
    expect(notConfigured.status).toBe(503);
    expect(notConfigured.body).toContain('not_configured');
  });

  it('reports an upstream rejection of a video handle as recoverable', async () => {
    const handlerFor = (status: number) =>
      createApiHandler({
        config: liveConfig(),
        createResponsesStream() {
          return Promise.reject(Object.assign(new Error('rejected'), { status }));
        },
        uploadMedia() {
          throw new Error('must not be called');
        },
      });
    const videoBody = multipart([
      { name: 'prompt', data: 'apple' },
      { name: 'file_id', data: 'file-abc123' },
    ]);

    const stale = responseRecorder();
    await handlerFor(404)(postRequest('/api/responses', videoBody), stale);
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body).error.code).toBe('stale_file_handle');

    const denied = responseRecorder();
    await handlerFor(401)(postRequest('/api/responses', videoBody), denied);
    expect(denied.status).toBe(502);
    expect(JSON.parse(denied.body).error.code).toBe('upstream_error');

    const incompatibleModel = responseRecorder();
    await handlerFor(400)(postRequest('/api/responses', videoBody), incompatibleModel);
    expect(incompatibleModel.status).toBe(502);
    expect(JSON.parse(incompatibleModel.body).error.code).toBe('upstream_error');

    const image = responseRecorder();
    await handlerFor(404)(
      postRequest(
        '/api/responses',
        multipart([
          { name: 'prompt', data: 'panel' },
          { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
        ]),
      ),
      image,
    );
    expect(image.status).toBe(502);
    expect(JSON.parse(image.body).error.code).toBe('upstream_error');
  });

  it('passes a selected model through the responses route', async () => {
    const inputs: RelayInput[] = [];
    const handler = createApiHandler({
      config: liveConfig(),
      createResponsesStream(input) {
        inputs.push(input);
        return Promise.resolve(
          new Response('{"type":"response.completed"}\n', {
            headers: { 'Content-Type': 'application/x-ndjson' },
          }),
        );
      },
    });
    const response = responseRecorder();
    await handler(
      postRequest(
        '/api/responses',
        multipart([
          { name: 'prompt', data: 'panel' },
          { name: 'model', data: 'sam-3.1' },
          { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
        ]),
      ),
      response,
    );
    expect(response.status).toBe(200);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      kind: 'image',
      prompt: 'panel',
      model: 'sam-3.1',
    });
  });

  it('rejects a responses request that carries both bytes and a handle', async () => {
    const handler = createApiHandler({
      config: liveConfig(),
      createResponsesStream() {
        throw new Error('must not be called');
      },
      uploadMedia() {
        throw new Error('must not be called');
      },
    });
    const both = responseRecorder();
    await handler(
      postRequest(
        '/api/responses',
        multipart([
          { name: 'prompt', data: 'panel' },
          { name: 'file_id', data: 'file-abc123' },
          { name: 'media', filename: 'a.png', data: mediaBytes['image/png'] },
        ]),
      ),
      both,
    );
    expect(both.status).toBe(400);
    expect(JSON.parse(both.body).error.code).toBe('invalid_request');

    const neither = responseRecorder();
    await handler(
      postRequest('/api/responses', multipart([{ name: 'prompt', data: 'panel' }])),
      neither,
    );
    expect(neither.status).toBe(400);
    expect(JSON.parse(neither.body).error.code).toBe('invalid_media');
  });
});
