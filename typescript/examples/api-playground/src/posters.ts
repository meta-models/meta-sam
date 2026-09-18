/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/** Thumbnail size in CSS pixels; posters are captured at twice this. */
export const POSTER_WIDTH = 56;
export const POSTER_HEIGHT = 32;
const POSTER_TIME_SECONDS = 0.5;
const POSTER_TIMEOUT_MS = 15_000;

const posters = new Map<string, string>();
const failures = new Set<string>();
/**
 * Poster extraction is serialized: five videos decoding at once would compete
 * with the stage player for decoder capacity on a slow machine.
 */
let queue: Promise<unknown> = Promise.resolve();

export function cachedPoster(url: string): string | null {
  return posters.get(url) ?? null;
}

export function posterFailed(url: string): boolean {
  return failures.has(url);
}

function settleOnce(
  video: HTMLVideoElement,
  event: 'loadeddata' | 'seeked',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`The poster frame timed out waiting for ${event}.`));
    }, POSTER_TIMEOUT_MS);
    const settle = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('The poster frame could not be decoded.'));
    };
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener(event, settle);
      video.removeEventListener('error', fail);
    }
    video.addEventListener(event, settle, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

/** Cover-fits the decoded frame into the poster canvas. */
function coverSource(
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const target = POSTER_WIDTH / POSTER_HEIGHT;
  const source = width / height;
  if (source > target) {
    const cropped = height * target;
    return { x: (width - cropped) / 2, y: 0, width: cropped, height };
  }
  const cropped = width / target;
  return { x: 0, y: (height - cropped) / 2, width, height: cropped };
}

function whenVisible(): Promise<void> {
  // Chrome defers media loading in hidden tabs, so a poster requested while
  // the tab is backgrounded would time out and be recorded as a failure.
  if (document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onChange);
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

async function decodePoster(url: string): Promise<string> {
  await whenVisible();
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await settleOnce(video, 'loadeddata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const at = duration > 0 ? Math.min(POSTER_TIME_SECONDS, duration / 2) : 0;
    if (at > 0 && Math.abs(video.currentTime - at) > 0.001) {
      const seeked = settleOnce(video, 'seeked');
      video.currentTime = at;
      await seeked;
    }
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new Error('The poster frame has no dimensions.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = POSTER_WIDTH * 2;
    canvas.height = POSTER_HEIGHT * 2;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas 2D is unavailable.');
    const source = coverSource(video.videoWidth, video.videoHeight);
    context.drawImage(
      video,
      source.x,
      source.y,
      source.width,
      source.height,
      0,
      0,
      canvas.width,
      canvas.height,
    );
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * Resolves the cached poster for a video, extracting it once. Callers get
 * `null` when extraction failed; nothing retries within the session.
 */
export function loadPoster(url: string): Promise<string | null> {
  const cached = posters.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  if (failures.has(url)) return Promise.resolve(null);
  const next = queue.then(async () => {
    const known = posters.get(url);
    if (known !== undefined) return known;
    if (failures.has(url)) return null;
    try {
      const poster = await decodePoster(url);
      posters.set(url, poster);
      return poster;
    } catch {
      failures.add(url);
      return null;
    }
  });
  queue = next.catch(() => undefined);
  return next;
}
