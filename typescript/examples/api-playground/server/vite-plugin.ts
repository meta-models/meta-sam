/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { extname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadEnv, type Connect, type Plugin, type ResolvedConfig } from 'vite';

import {
  createSAMResponsesStream,
  fetchModelIds,
  uploadMediaFile,
} from './openai-request.ts';
import {
  applySecurityHeaders,
  createApiHandler,
  readServerConfig,
  type RelayInput,
  type ValidatedMedia,
} from './server-core.ts';
import { serveFile } from './static-files.ts';

const contentTypes = new Map([
  ['.webm', 'video/webm'],
  ['.mp4', 'video/mp4'],
]);

function bindHost(value: string | boolean | undefined): string {
  if (typeof value === 'string') return value;
  return value === true ? '0.0.0.0' : '127.0.0.1';
}

function installMiddleware(
  middlewares: Connect.Server,
  resolved: ResolvedConfig,
  preview: boolean,
): void {
  const options = preview ? resolved.preview : resolved.server;
  const environment = {
    ...loadEnv(resolved.mode, resolved.envDir, ''),
    ...process.env,
  };
  const config = readServerConfig(environment, {
    host: bindHost(options.host),
    port: options.port,
  });
  const api = createApiHandler({
    config,
    createResponsesStream(input: RelayInput, signal: AbortSignal) {
      return createSAMResponsesStream(config, input, signal);
    },
    uploadMedia(media: ValidatedMedia, signal: AbortSignal) {
      return uploadMediaFile(config, media, signal);
    },
    listModels(signal?: AbortSignal) {
      return fetchModelIds(config, signal);
    },
  });
  const fixtureRoot = resolve(resolved.root, '../../test/browser/fixtures');
  const sharedMedia = new Map([
    ['/media/webm-vp9-opus.webm', resolve(fixtureRoot, 'webm-vp9-opus.webm')],
    [
      '/media/webm-vp9-opus-cfr30-8s.webm',
      resolve(fixtureRoot, 'webm-vp9-opus-cfr30-8s.webm'),
    ],
  ]);

  middlewares.use(
    (
      request: IncomingMessage,
      response: ServerResponse,
      next: Connect.NextFunction,
    ) => {
      void (async () => {
        if (await api(request, response)) return;
        const url = new URL(request.url ?? '/', 'http://localhost');
        const file = sharedMedia.get(url.pathname);
        if (file !== undefined) {
          if (preview) applySecurityHeaders(response);
          if (
            await serveFile(request, response, file, {
              contentType:
                contentTypes.get(extname(file)) ?? 'application/octet-stream',
              allowRanges: true,
            })
          ) {
            return;
          }
        }
        if (preview) applySecurityHeaders(response);
        next();
      })().catch((error: unknown) => {
        if (response.headersSent || response.writableEnded || response.destroyed) {
          response.destroy(
            error instanceof Error ? error : new Error('Vite middleware failed.'),
          );
          return;
        }
        next(error);
      });
    },
  );
}

export function samApiPlugin(): Plugin {
  let resolved: ResolvedConfig;
  return {
    name: 'sam-api-relay',
    configResolved(config) {
      resolved = config;
    },
    configureServer(server) {
      installMiddleware(server.middlewares, resolved, false);
    },
    configurePreviewServer(server) {
      installMiddleware(server.middlewares, resolved, true);
    },
  };
}
