/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const browserRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(browserRoot, '../..');
const generatedRoot = path.join(browserRoot, '.generated');
const fixturesRoot = path.join(browserRoot, 'fixtures');
const host = '127.0.0.1';
const port = Number.parseInt(process.env.BROWSER_TEST_PORT ?? '4173', 10);

const publicFiles = new Map([
  ['/', path.join(generatedRoot, 'index.html')],
  ['/harness.js', path.join(generatedRoot, 'harness.js')],
]);

function fixturePath(urlPath) {
  const prefix = '/fixtures/';
  if (!urlPath.startsWith(prefix)) return null;
  const fileName = decodeURIComponent(urlPath.slice(prefix.length));
  if (fileName.length === 0 || path.basename(fileName) !== fileName) return null;
  return path.join(fixturesRoot, fileName);
}

function parseRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === '' && match[2] === '')) return undefined;

  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number.parseInt(match[1], 10);
    end = match[2] === '' ? size - 1 : Number.parseInt(match[2], 10);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return undefined;
  }
  return { start, end: Math.min(end, size - 1) };
}

function contentType(filePath) {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

async function serveFile(request, response, filePath) {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    response.writeHead(404).end('Not found\n');
    return;
  }
  if (!fileStat.isFile()) {
    response.writeHead(404).end('Not found\n');
    return;
  }

  const range = parseRange(request.headers.range, fileStat.size);
  if (range === undefined) {
    response
      .writeHead(416, {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${fileStat.size}`,
      })
      .end();
    return;
  }

  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-type': contentType(filePath),
  };
  if (range === null) {
    response.writeHead(200, { ...headers, 'content-length': fileStat.size });
    if (request.method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
    return;
  }

  const length = range.end - range.start + 1;
  response.writeHead(206, {
    ...headers,
    'content-length': length,
    'content-range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
  });
  if (request.method === 'HEAD') response.end();
  else createReadStream(filePath, range).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}:${port}`);
    if (url.pathname === '/healthz') {
      response
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('ok\n');
      return;
    }
    const filePath = publicFiles.get(url.pathname) ?? fixturePath(url.pathname);
    if (filePath === null || !filePath.startsWith(repositoryRoot)) {
      response.writeHead(404).end('Not found\n');
      return;
    }
    await serveFile(request, response, filePath);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal server error\n');
  }
});

server.listen(port, host, () => {
  console.log(`Browser media test server listening at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
