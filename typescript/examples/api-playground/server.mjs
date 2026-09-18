/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSAMResponsesStream,
  fetchModelIds,
  uploadMediaFile,
} from './openai-request.mjs';
import {
  applySecurityHeaders,
  createApiHandler,
  readServerConfig,
} from './server-core.mjs';
import { serveFile } from './static-files.mjs';

const root = dirname(fileURLToPath(import.meta.url));

async function loadLocalEnvironment() {
  let text;
  try {
    text = await readFile(resolve(root, '.env.local'), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(SAM_API_KEY|SAM_API_BASE_URL|SAM_MODEL)=(.*)$/.exec(line);
    if (match === null || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function parseArguments(argv) {
  let host = '127.0.0.1';
  let port;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') host = argv[++index] ?? host;
    else if (argument.startsWith('--host=')) host = argument.slice('--host='.length);
    else if (argument === '--port') port = argv[++index];
    else if (argument.startsWith('--port=')) port = argument.slice('--port='.length);
    else throw new TypeError(`Unknown argument: ${argument}`);
  }
  if (host.trim().length === 0 || /[\s/]/.test(host)) {
    throw new TypeError('--host must be a hostname or address.');
  }
  return { host, port };
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.webm', 'video/webm'],
  ['.mp4', 'video/mp4'],
]);

const fixtureRoot = resolve(root, '../../test/browser/fixtures');
const sharedMedia = new Map([
  ['/media/webm-vp9-opus.webm', resolve(fixtureRoot, 'webm-vp9-opus.webm')],
  [
    '/media/webm-vp9-opus-cfr30-8s.webm',
    resolve(fixtureRoot, 'webm-vp9-opus-cfr30-8s.webm'),
  ],
]);

const exampleMedia = new Map(
  ['bedroom.mp4', 'truck.jpg', 'groceries.jpg'].map((name) => [
    `/media/${name}`,
    resolve(root, 'public/media', name),
  ]),
);

async function serveSharedMedia(request, response) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const file = sharedMedia.get(url.pathname) ?? exampleMedia.get(url.pathname);
  if (file === undefined) return false;
  return await serveFile(request, response, file, {
    contentType:
      contentTypes.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    allowRanges: true,
  });
}

async function serveBuilt(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found.\n');
    return;
  }
  const dist = resolve(root, 'dist');
  let requested;
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requested = decodeURIComponent(url.pathname);
  } catch {
    const body = 'Bad request.\n';
    response.writeHead(400, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return;
  }
  const candidate = resolve(dist, `.${requested === '/' ? '/index.html' : requested}`);
  let file = candidate;
  if (relative(dist, candidate).startsWith('..')) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found.\n');
    return;
  }
  try {
    const metadata = await stat(file);
    if (!metadata.isFile())
      throw Object.assign(new Error('Not a file.'), { code: 'ENOENT' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    file = resolve(dist, 'index.html');
  }
  const body = await readFile(file);
  response.writeHead(200, {
    'Content-Type':
      contentTypes.get(extname(file).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': body.length,
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function main() {
  await loadLocalEnvironment();
  const development = process.env.NODE_ENV !== 'production';
  const config = readServerConfig(process.env, parseArguments(process.argv.slice(2)));
  let vite;
  let server;
  const api = createApiHandler({
    config,
    createResponsesStream(input, signal) {
      return createSAMResponsesStream(config, input, signal);
    },
    uploadMedia(media, signal) {
      return uploadMediaFile(config, media, signal);
    },
    listModels(signal) {
      return fetchModelIds(config, signal);
    },
  });

  server = createServer((request, response) => {
    void (async () => {
      if (await api(request, response)) return;
      applySecurityHeaders(response, development);
      if (await serveSharedMedia(request, response)) return;
      if (development) {
        await new Promise((resolveMiddleware, rejectMiddleware) => {
          const cleanup = () => {
            response.off('finish', onFinished);
            response.off('close', onFinished);
          };
          const onFinished = () => {
            cleanup();
            resolveMiddleware();
          };
          response.once('finish', onFinished);
          response.once('close', onFinished);
          vite.middlewares(request, response, (error) => {
            cleanup();
            if (error) rejectMiddleware(error);
            else resolveMiddleware();
          });
        });
        if (!response.writableEnded && !response.destroyed) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          response.end('Not found.\n');
        }
      } else {
        await serveBuilt(request, response);
      }
    })().catch(() => {
      if (!response.headersSent) {
        applySecurityHeaders(response, development);
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Internal server error.\n');
      } else {
        response.destroy();
      }
    });
  });

  if (development) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      root,
      appType: 'spa',
      clearScreen: false,
      server: { middlewareMode: true, hmr: { server } },
    });
  }

  server.requestTimeout = 600_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, resolveListen);
  });
  process.stdout.write(
    `SAM 3 API playground listening on http://${config.host}:${config.port} (${development ? 'development' : 'preview'}, live ${config.apiKey === null ? 'unconfigured' : 'configured'})\n`,
  );

  const shutdown = () => {
    server.closeIdleConnections();
    server.close(() => process.exit(0));
    setTimeout(() => server.closeAllConnections(), 5_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Startup failed.';
  process.stderr.write(`Unable to start the API playground: ${message}\n`);
  process.exitCode = 1;
});
