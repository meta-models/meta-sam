/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { createElement, createRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Video, type VideoRef } from '../../packages/react/src/index.js';
import {
  createMediaPlayer,
  type CustomRenderFunction,
  type IMediaPlayer,
  type MediaPlayerEventMap,
  type MediaPlayerEventType,
  type PlaybackStats,
} from '../../packages/video/src/index.js';
import type {
  BlockedAudioResumeReport,
  MediaPerformanceReport,
  PerformancePlaybackRun,
  PlaybackChurnReport,
  ReactMountStressReport,
  VfrSteppingReport,
} from './types.js';

const vfrFixture = '/fixtures/webm-vp9-opus-vfr.webm';
const stressFixture = '/fixtures/webm-vp9-opus-cfr30-8s.webm';
const comparisonRepetitions = 3;
const stallDurations = [10, 25, 50, 100, 250] as const;

function round(value: number): number {
  return Number.parseFloat(value.toFixed(6));
}

function once<T extends MediaPlayerEventType>(
  player: IMediaPlayer,
  event: T,
): Promise<MediaPlayerEventMap[T]> {
  return new Promise((resolve) => {
    const remove = player.on(event, (payload) => {
      remove();
      resolve(payload);
    });
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMilliseconds = 20_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function readOverlayMarker(canvas: HTMLCanvasElement): number | null {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable.');
  const pixel = context.getImageData(0, 0, 1, 1).data;
  return pixel[1] === 231 && pixel[2] === 77 && pixel[3] === 255 ? pixel[0]! - 1 : null;
}

function drawOverlayMarker(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  frameIndex: number,
): void {
  context.fillStyle = `rgb(${frameIndex + 1} 231 77)`;
  context.fillRect(0, 0, 2, 2);
}

function representativeOverlay(): CustomRenderFunction {
  return ({ ctx, canvas, frame, frameIndex }) => {
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let index = 0; index < 48; index += 1) {
      ctx.fillStyle = index % 2 === 0 ? '#cf1322' : '#c41d7f';
      ctx.fillRect((index * 17) % canvas.width, (index * 11) % canvas.height, 12, 8);
    }
    ctx.restore();
    drawOverlayMarker(ctx, frameIndex);
  };
}

async function runPlayback(
  player: IMediaPlayer,
  canvas: HTMLCanvasElement,
): Promise<PerformancePlaybackRun> {
  const frameIndexes: number[] = [];
  const clockSamples: number[] = [];
  const overlayFrameIndexes: number[] = [];
  let overlayMismatches = 0;
  const removeFrame = player.on('frame', ({ frameIndex }) => {
    frameIndexes.push(frameIndex);
    const marker = readOverlayMarker(canvas);
    if (marker !== null) {
      overlayFrameIndexes.push(marker);
      if (marker !== frameIndex) overlayMismatches += 1;
    }
  });
  const removeTime = player.on('timeupdate', () => {
    clockSamples.push(round(player.currentTime));
  });
  const ended = once(player, 'ended');
  const startedAt = performance.now();
  // This call is intentionally synchronous with the caller's trusted click for
  // the first run. Later runs reuse the already-running AudioContext.
  const playing = player.play();
  try {
    await playing;
    await ended;
    return {
      wallMilliseconds: performance.now() - startedAt,
      audioClockSource: player.audioStatus.clockSource,
      frameIndexes,
      clockSamples,
      overlayFrameIndexes,
      overlayMismatches,
      finalFrameIndex: player.currentFrameIndex,
      stats: player.getStats(),
    };
  } finally {
    removeFrame();
    removeTime();
  }
}

async function configureAndRun(
  player: IMediaPlayer,
  canvas: HTMLCanvasElement,
  render: CustomRenderFunction | null,
  playbackRate: number,
): Promise<PerformancePlaybackRun> {
  player.setCustomRender(render);
  await player.seekToFrame(0);
  player.playbackRate = playbackRate;
  player.resetStats();
  return await runPlayback(player, canvas);
}

export async function exerciseVfrStepping(): Promise<VfrSteppingReport> {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  document.body.append(canvas);
  const player = createMediaPlayer(canvas, {
    createAudioContext: () => {
      throw new Error('VFR stepping uses the deterministic performance clock.');
    },
  });
  try {
    await player.open(vfrFixture);
    const packets = player.getVideoPackets();
    const forwardFrameIndexes = [player.currentFrameIndex];
    while (forwardFrameIndexes.length < packets.length) {
      await player.nextFrame();
      forwardFrameIndexes.push(player.currentFrameIndex);
    }
    const reverseFrameIndexes = [player.currentFrameIndex];
    while (reverseFrameIndexes.length < packets.length) {
      await player.previousFrame();
      reverseFrameIndexes.push(player.currentFrameIndex);
    }
    return {
      timestamps: packets.map(({ timestamp }) => round(timestamp)),
      durations: packets.map(({ duration }) => round(duration)),
      forwardFrameIndexes,
      reverseFrameIndexes,
    };
  } finally {
    player.dispose();
    canvas.remove();
  }
}

let pendingPerformanceExercise: Promise<MediaPerformanceReport> | undefined;

export async function prepareMediaPerformanceExercise(): Promise<string> {
  if (pendingPerformanceExercise !== undefined) {
    throw new Error('A media performance exercise is already pending.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  document.body.append(canvas);
  const player = createMediaPlayer(canvas, { statsSampleWindowSize: 512 });
  player.volume = 0;
  await player.open(stressFixture);

  const button = document.createElement('button');
  button.id = 'media-performance-start';
  button.type = 'button';
  button.textContent = 'Run media performance exercise';
  document.body.append(button);

  pendingPerformanceExercise = new Promise<MediaPerformanceReport>(
    (resolve, reject) => {
      button.addEventListener(
        'click',
        () => {
          button.remove();
          player.playbackRate = 1;
          player.resetStats();
          const firstRun = runPlayback(player, canvas);
          void (async () => {
            try {
              const realTime = await firstRun;
              const noOverlay: PerformancePlaybackRun[] = [];
              const overlay: PerformancePlaybackRun[] = [];
              for (
                let repetition = 0;
                repetition < comparisonRepetitions;
                repetition += 1
              ) {
                noOverlay.push(await configureAndRun(player, canvas, null, 4));
                overlay.push(
                  await configureAndRun(player, canvas, representativeOverlay(), 4),
                );
              }

              player.setCustomRender(null);
              await player.open(vfrFixture);
              const stalls: MediaPerformanceReport['stalls'][number][] = [];
              for (const stallMilliseconds of stallDurations) {
                const attemptedFrameIndexes: number[] = [];
                const abortedFrameIndexes: number[] = [];
                const render: CustomRenderFunction = async ({
                  ctx,
                  canvas: composition,
                  frame,
                  frameIndex,
                  signal,
                }) => {
                  attemptedFrameIndexes.push(frameIndex);
                  await new Promise<void>((done) => {
                    const timeout = setTimeout(done, stallMilliseconds);
                    const abort = () => {
                      clearTimeout(timeout);
                      abortedFrameIndexes.push(frameIndex);
                      done();
                    };
                    if (signal.aborted) abort();
                    else signal.addEventListener('abort', abort, { once: true });
                  });
                  if (signal.aborted) return;
                  ctx.drawImage(frame, 0, 0, composition.width, composition.height);
                  drawOverlayMarker(ctx, frameIndex);
                };
                const run = await configureAndRun(player, canvas, render, 1);
                stalls.push({
                  ...run,
                  stallMilliseconds,
                  abortedFrameIndexes,
                });
                if (attemptedFrameIndexes.length === 0) {
                  throw new Error(
                    `The ${stallMilliseconds} ms stall was not injected.`,
                  );
                }
              }

              resolve({
                fixture: stressFixture.slice('/fixtures/'.length),
                repetitions: comparisonRepetitions,
                realTime,
                noOverlay,
                overlay,
                stalls,
              });
            } catch (error) {
              reject(error);
            } finally {
              player.dispose();
              canvas.remove();
            }
          })();
        },
        { once: true },
      );
    },
  );
  return `#${button.id}`;
}

export async function waitForMediaPerformanceExercise(): Promise<MediaPerformanceReport> {
  const pending = pendingPerformanceExercise;
  if (pending === undefined)
    throw new Error('No media performance exercise is pending.');
  try {
    return await pending;
  } finally {
    pendingPerformanceExercise = undefined;
  }
}

export async function exercisePlaybackChurn(
  iterations: number,
): Promise<PlaybackChurnReport> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100) {
    throw new RangeError('iterations must be an integer between 1 and 100.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  document.body.append(canvas);
  const player = createMediaPlayer(canvas, {
    createAudioContext: () => {
      throw new Error('Playback churn uses the deterministic performance clock.');
    },
  });
  const expectedFrameIndexes: number[] = [];
  const committedFrameIndexes: number[] = [];
  const widths: number[] = [];
  player.setCustomRender(async ({ ctx, canvas: composition, frame }) => {
    await Promise.resolve();
    ctx.drawImage(frame, 0, 0, composition.width, composition.height);
  });

  try {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const source = iteration % 2 === 0 ? vfrFixture : '/fixtures/webm-vp9-opus.webm';
      await player.open(source);
      const frameIndex = iteration % player.getVideoPackets().length;
      await player.seekToFrame(frameIndex);
      const width = 96 + (iteration % 4) * 8;
      canvas.width = width;
      canvas.height = 64 + (iteration % 3) * 4;
      await player.forceRender();
      expectedFrameIndexes.push(frameIndex);
      committedFrameIndexes.push(player.currentFrameIndex);
      widths.push(width);
    }
    return {
      iterations,
      expectedFrameIndexes,
      committedFrameIndexes,
      widths,
      stats: player.getStats(),
    };
  } finally {
    player.dispose();
    canvas.remove();
  }
}

export async function exerciseBlockedAudioResume(): Promise<BlockedAudioResumeReport> {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  document.body.append(canvas);
  let state: AudioContextState = 'suspended';
  const context = {
    get state() {
      return state;
    },
    currentTime: 0,
    destination: {},
    createGain() {
      return {
        gain: { value: 1 },
        connect() {},
        disconnect() {},
      };
    },
    resume: () => new Promise<void>(() => undefined),
    async close() {
      state = 'closed';
    },
  } as unknown as AudioContext;
  const player = createMediaPlayer(canvas, {
    createAudioContext: () => context,
    audioContextResumeTimeoutMilliseconds: 25,
  });
  player.volume = 0;
  player.playbackRate = 4;
  let warning: Error | undefined;
  const clockSamples: number[] = [];
  player.on('audiowarning', ({ warning: nextWarning }) => {
    warning = nextWarning;
  });
  player.on('timeupdate', () => clockSamples.push(round(player.currentTime)));

  try {
    await player.open(vfrFixture);
    const ended = once(player, 'ended');
    await player.play();
    await ended;
    return {
      warningCode:
        warning !== undefined && 'code' in warning && typeof warning.code === 'string'
          ? warning.code
          : null,
      warningName: warning?.name ?? null,
      timeoutMilliseconds:
        warning !== undefined &&
        'timeoutMilliseconds' in warning &&
        typeof warning.timeoutMilliseconds === 'number'
          ? warning.timeoutMilliseconds
          : null,
      clockSamples,
      stats: player.getStats(),
    };
  } finally {
    player.dispose();
    canvas.remove();
  }
}

export async function exerciseReactMountStress(
  cycles: number,
): Promise<ReactMountStressReport> {
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) {
    throw new RangeError('cycles must be an integer between 1 and 100.');
  }
  const host = document.createElement('div');
  document.body.append(host);
  const disposeCounts: number[] = [];
  let readyCount = 0;

  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const root = createRoot(host);
      const ref = createRef<VideoRef>();
      let resolveLoaded!: () => void;
      let rejectLoaded!: (error: Error) => void;
      const loaded = new Promise<void>((resolve, reject) => {
        resolveLoaded = resolve;
        rejectLoaded = reject;
      });
      flushSync(() =>
        root.render(
          createElement(Video, {
            ref,
            src: vfrFixture,
            muted: true,
            volume: 0,
            style: { width: 96, height: 64 },
            onPlayerReady(player) {
              const disposalIndex = disposeCounts.length;
              disposeCounts.push(0);
              readyCount += 1;
              player.on('dispose', () => {
                disposeCounts[disposalIndex] = disposeCounts[disposalIndex]! + 1;
              });
            },
            onLoadedMetadata: resolveLoaded,
            onError(error) {
              if (!('code' in error) || error.code !== 'operation_cancelled') {
                rejectLoaded(error);
              }
            },
          }),
        ),
      );
      await withTimeout(loaded, `React mount cycle ${cycle} did not load.`);
      if (ref.current === null)
        throw new Error(`React mount cycle ${cycle} lost its ref.`);
      ref.current.getStats();
      flushSync(() => root.unmount());
      await Promise.resolve();
    }
    return {
      cycles,
      readyCount,
      disposeCounts,
      remainingCanvasCount: host.querySelectorAll('canvas').length,
      remainingVideoCount: host.querySelectorAll('video').length,
    };
  } finally {
    host.remove();
  }
}
