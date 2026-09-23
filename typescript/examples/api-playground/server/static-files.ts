/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export type ByteRange = Readonly<{ start: number; end: number }>;

export function parseByteRange(
  value: string | string[] | undefined,
  size: number,
): ByteRange | null | undefined {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('size is invalid.');
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (match === null || (match[1] === '' && match[2] === '')) return null;

  const sizeValue = BigInt(size);
  if (sizeValue === 0n) return undefined;
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n) return undefined;
    start = suffixLength >= sizeValue ? 0n : sizeValue - suffixLength;
    end = sizeValue - 1n;
  } else {
    start = BigInt(match[1]);
    if (start >= sizeValue) return undefined;
    if (match[2] === '') {
      end = sizeValue - 1n;
    } else {
      end = BigInt(match[2]);
      if (end < start) return undefined;
      if (end >= sizeValue) end = sizeValue - 1n;
    }
  }
  return Object.freeze({ start: Number(start), end: Number(end) });
}

export async function serveFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  {
    contentType = 'application/octet-stream',
    allowRanges = false,
  }: { contentType?: string; allowRanges?: boolean } = {},
): Promise<boolean> {
  const metadata = await stat(file);
  if (!metadata.isFile()) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, {
      Allow: 'GET, HEAD',
      'Content-Length': 0,
    });
    response.end();
    return true;
  }

  const range = allowRanges
    ? parseByteRange(request.headers.range, metadata.size)
    : null;
  if (range === undefined) {
    response.writeHead(416, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${metadata.size}`,
      'Content-Length': 0,
    });
    response.end();
    return true;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, metadata.size - 1);
  const contentLength = metadata.size === 0 ? 0 : end - start + 1;
  const headers = {
    'Content-Type': contentType,
    'Content-Length': contentLength,
    ...(allowRanges ? { 'Accept-Ranges': 'bytes' } : {}),
    ...(range === null
      ? {}
      : { 'Content-Range': `bytes ${start}-${end}/${metadata.size}` }),
  };
  response.writeHead(range === null ? 200 : 206, headers);
  if (request.method === 'HEAD' || metadata.size === 0) {
    response.end();
    return true;
  }

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file, { start, end });
    stream.once('error', reject);
    response.once('error', reject);
    response.once('finish', resolve);
    stream.pipe(response);
  });
  return true;
}
