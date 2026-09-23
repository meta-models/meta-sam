/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server: ChildProcess;
let baseURL: string;

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a development-server port.');
  }
  await new Promise<void>((resolveClose, rejectClose) =>
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  return address.port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Development server did not start: ${String(lastError)}`);
}

beforeAll(async () => {
  const port = await availablePort();
  baseURL = `http://127.0.0.1:${port}`;
  server = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: root,
      env: { ...process.env, SAM_API_KEY: '', SAM_MODEL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await waitForServer(`${baseURL}/api/config`);
}, 60_000);

afterAll(async () => {
  if (server?.exitCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit');
  }
});

test('uses the standard Vite development server', async () => {
  const response = await fetch(`${baseURL}/`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toBeNull();
  expect(await response.text()).toContain('/@vite/client');
});

test('does not opt API routes into cross-origin requests', async () => {
  for (const method of ['GET', 'OPTIONS']) {
    const response = await fetch(`${baseURL}/api/config`, {
      method,
      headers: {
        Origin: 'http://evil.localhost:3000',
        ...(method === 'OPTIONS'
          ? {
              'Access-Control-Request-Method': 'GET',
              'Access-Control-Request-Headers': 'content-type',
            }
          : {}),
      },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBeNull();
  }
});

test('serves API requests through the TypeScript Vite plugin', async () => {
  const response = await fetch(`${baseURL}/api/config`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    configured: false,
    endpointOrigin: 'https://api.meta.ai',
    model: null,
  });
});
