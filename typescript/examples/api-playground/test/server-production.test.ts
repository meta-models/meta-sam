/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server: ChildProcess;
let baseURL: string;
let mediaLength: number;

async function availablePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Could not reserve a production smoke-test port.');
  }
  await new Promise<void>((resolveClose, rejectClose) =>
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
  return address.port;
}

async function waitForListening(url: string): Promise<void> {
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
  throw new Error(`Production server did not start: ${String(lastError)}`);
}

describe('production static server', () => {
  beforeAll(async () => {
    await execFileAsync('npm', ['run', 'build'], {
      cwd: root,
      env: process.env,
      timeout: 120_000,
    });
    const port = await availablePort();
    baseURL = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        resolve(root, 'node_modules/vite/bin/vite.js'),
        'preview',
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
    await waitForListening(`${baseURL}/api/config`);
    const media = await fetch(`${baseURL}/media/webm-vp9-opus.webm`);
    expect(media.status).toBe(200);
    mediaLength = Number(media.headers.get('content-length'));
    await media.arrayBuffer();
  }, 120_000);

  afterAll(async () => {
    if (server?.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  });

  it('serves the built HTML, assets, and HEAD representation directly', async () => {
    const page = await fetch(`${baseURL}/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy');
    expect(csp).toContain("connect-src 'self';");
    expect(csp).not.toMatch(/\bws:/);
    expect(csp).not.toMatch(/\bwss:/);
    expect(csp).not.toContain("'unsafe-inline'");
    const html = await page.text();
    expect(html).toContain('<div id="root"></div>');
    const asset = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    expect(asset).toBeDefined();
    const builtAsset = await fetch(`${baseURL}${asset}`);
    expect(builtAsset.status).toBe(200);
    expect((await builtAsset.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const head = await fetch(`${baseURL}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('does not opt API routes into cross-origin requests', async () => {
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

  it('applies production security headers to shared fixture media', async () => {
    const media = await fetch(`${baseURL}/media/webm-vp9-opus.webm`);
    expect(media.status).toBe(200);
    expect(media.headers.get('content-security-policy')).toContain(
      "default-src 'self';",
    );
    expect(media.headers.get('cache-control')).toBe('no-store');
    expect(media.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(media.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('returns a client error rather than 500 for a malformed decode path', async () => {
    const response = await fetch(`${baseURL}/bad%ZZ`);
    expect([400, 404]).toContain(response.status);
  });

  it('returns 405 with Allow for an unsupported method on existing media', async () => {
    const response = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
      method: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('honors one byte range and ignores unsupported or malformed ranges', async () => {
    const ranged = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
      headers: { Range: 'Bytes=0-9' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${mediaLength}`);
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);

    for (const range of ['items=0-9', 'bytes=invalid', 'bytes=0-1,4-5']) {
      const ignored = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
        headers: { Range: range },
      });
      expect(ignored.status).toBe(200);
      expect(ignored.headers.get('content-range')).toBeNull();
      expect((await ignored.arrayBuffer()).byteLength).toBe(mediaLength);
    }
  });

  it('returns 416 only for a valid unsatisfiable single range and preserves HEAD', async () => {
    const unsatisfiable = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
      headers: { Range: `bytes=${mediaLength}-` },
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${mediaLength}`);

    const rangedHead = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
      method: 'HEAD',
      headers: { Range: 'bytes=0-9' },
    });
    expect(rangedHead.status).toBe(206);
    expect(rangedHead.headers.get('content-length')).toBe('10');
    expect((await rangedHead.arrayBuffer()).byteLength).toBe(0);

    const ignoredHead = await fetch(`${baseURL}/media/webm-vp9-opus.webm`, {
      method: 'HEAD',
      headers: { Range: 'bytes=broken' },
    });
    expect(ignoredHead.status).toBe(200);
    expect(ignoredHead.headers.get('content-length')).toBe(String(mediaLength));
    expect((await ignoredHead.arrayBuffer()).byteLength).toBe(0);
  });
});
