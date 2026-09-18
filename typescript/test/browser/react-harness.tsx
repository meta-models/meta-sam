/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  StrictMode,
  createElement,
  createRef,
  useRef,
  type ComponentProps,
  type ReactElement,
} from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SegmentationRenderer } from '@meta-sam/graphics';
import type { VideoSegmentationResult } from '../../packages/parser/src/index.js';
import {
  Video,
  useMediaPlayer,
  type VideoRef,
} from '../../packages/react/src/index.js';
import type {
  IMediaPlayer,
  MediaPlayerAudioStatus,
} from '../../packages/video/src/index.js';
import type {
  CompositionPixel,
  ReactAudioExerciseReport,
  ReactFailurePrecedenceReport,
  ReactHookExerciseReport,
  ReactLifecycleReport,
  ReactVideoExerciseReport,
} from './types.js';

const reactCompositionResult: VideoSegmentationResult = {
  media: 'video',
  revision: 1,
  records: [
    {
      kind: 'mask',
      order: 0,
      objectId: 'frame-one',
      identity: 'video:1:frame-one',
      revision: 1,
      frame: { frameIndex: 1 },
      mask: {
        encoding: 'one_bit',
        width: 96,
        height: 64,
        payload: '!!!!!046ryYMMl__pCDu@!!',
      },
      // Full-frame raster: the mask covers the whole 96×64 source.
      bounds: { left: 0, top: 0, right: 96, bottom: 64 },
    },
  ],
  diagnostics: [],
  rawOutput: '',
  outcome: { status: 'completed' },
};

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
}

function isUnsupportedVideo(error: unknown): boolean {
  return (
    errorCode(error) === 'media_source_error' &&
    error instanceof Error &&
    error.message.includes('cannot decode')
  );
}

interface ReactFailures {
  fatalFailure?: Error;
  unsupportedCapability?: Error;
}

function recordReactFailure(failures: ReactFailures, error: Error): void {
  if (isUnsupportedVideo(error)) {
    failures.unsupportedCapability ??= error;
  } else {
    failures.fatalFailure ??= error;
  }
}

function selectedReactFailure(failures: ReactFailures): Error | undefined {
  return failures.fatalFailure ?? failures.unsupportedCapability;
}

export function exerciseReactFailurePrecedence(): ReactFailurePrecedenceReport {
  const failures: ReactFailures = {};
  const fatal = new Error('fatal-before-unsupported');
  const unsupported = Object.assign(new Error('The browser cannot decode video.'), {
    code: 'media_source_error',
  });
  recordReactFailure(failures, fatal);
  recordReactFailure(failures, unsupported);
  return {
    fatalMessage: failures.fatalFailure?.message ?? null,
    unsupportedCode: failures.unsupportedCapability
      ? errorCode(failures.unsupportedCapability)
      : null,
    selectedMessage: selectedReactFailure(failures)?.message ?? null,
  };
}

function readPixel(canvas: HTMLCanvasElement, x: number, y: number): CompositionPixel {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable.');
  const data = context.getImageData(x, y, 1, 1).data;
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeout = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function renderVideo(
  root: ReturnType<typeof createRoot>,
  props: ComponentProps<typeof Video>,
): void {
  flushSync(() => root.render(createElement(Video, props)));
}

export async function exerciseReactVideo(
  file: string,
  replacementFile?: string,
): Promise<ReactVideoExerciseReport> {
  if (!/^[a-z0-9.-]+$/.test(file)) throw new Error(`Invalid fixture name: ${file}`);
  if (replacementFile !== undefined && !/^[a-z0-9.-]+$/.test(replacementFile)) {
    throw new Error(`Invalid replacement fixture name: ${replacementFile}`);
  }

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<VideoRef>();
  const renderer = new SegmentationRenderer();
  await renderer.update(reactCompositionResult);
  let renderCount = 0;
  const originalRender = renderer.renderVideoFrame.bind(renderer);
  renderer.renderVideoFrame = (context, options) => {
    renderCount += 1;
    return originalRender(context, options);
  };

  const players = new Set<IMediaPlayer>();
  let activePlayer: IMediaPlayer | undefined;
  let loadedCount = 0;
  let staleLoadedCount = 0;
  let freshLoadedCount = 0;
  let staleTimeCount = 0;
  let freshTimeCount = 0;
  const failures: ReactFailures = {};
  let useFreshCallbacks = false;
  const onPlayerReady = (player: IMediaPlayer): void => {
    activePlayer = player;
    if (players.has(player)) return;
    players.add(player);
  };
  const staleLoaded = (): void => {
    staleLoadedCount += 1;
    loadedCount += 1;
  };
  const freshLoaded = (): void => {
    freshLoadedCount += 1;
    loadedCount += 1;
  };
  const staleTime = (): void => {
    staleTimeCount += 1;
  };
  const freshTime = (): void => {
    freshTimeCount += 1;
  };
  const onError = (error: Error): void => {
    recordReactFailure(failures, error);
  };
  const props = (
    src: string,
    hiddenIds: readonly string[] = [],
  ): ComponentProps<typeof Video> => ({
    ref,
    src: `/fixtures/${src}`,
    result: reactCompositionResult,
    renderer,
    hiddenIds,
    objectFit: 'fill',
    devicePixelRatio: 1,
    playbackRate: 1,
    volume: 0,
    muted: true,
    style: { width: 96, height: 64 },
    onPlayerReady,
    onLoadedMetadata: useFreshCallbacks ? freshLoaded : staleLoaded,
    onTimeChange: useFreshCallbacks ? freshTime : staleTime,
    onError,
  });

  try {
    renderVideo(root, props(file));
    await waitFor(
      () => loadedCount > 0 || selectedReactFailure(failures) !== undefined,
      `React Video did not load ${file}.`,
    );
    if (failures.fatalFailure !== undefined) throw failures.fatalFailure;
    if (failures.unsupportedCapability !== undefined) {
      return {
        status: 'unsupported',
        errorCode: errorCode(failures.unsupportedCapability),
      };
    }
    await waitFor(() => ref.current !== null, 'React Video ref was not attached.');
    const api = ref.current!;
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('React Video did not render a canvas.');

    const staleTimeBeforeUpdate = staleTimeCount;
    const staleLoadedBeforeUpdate = staleLoadedCount;
    useFreshCallbacks = true;
    renderVideo(root, props(file));

    const exactPacket = api.getPacketAtTimeExact(0.6);
    await api.seek(0.6);
    const exactSeekFrameIndex = activePlayer?.currentFrameIndex ?? -1;
    await api.seekToFrame(1);
    await waitFor(() => renderCount > 0, 'React overlay did not render.');
    const compositedCapture = api.captureFrame('composited');
    const rawCapture = api.captureFrame('raw');
    const compositedPixel = readPixel(compositedCapture, 48, 32);
    const rawPixel = readPixel(rawCapture, 48, 32);

    const renderBeforeHide = renderCount;
    renderVideo(root, props(file, ['frame-one']));
    await waitFor(() => {
      const pixel = readPixel(canvas, 48, 32);
      return (
        renderCount > renderBeforeHide &&
        pixel[3] > 0 &&
        pixel.every((channel, index) => channel === rawPixel[index])
      );
    }, 'React hiddenIds update did not commit its autonomous re-render.');
    const hiddenPixel = readPixel(canvas, 48, 32);

    let replacementFrameIndex: number | undefined;
    if (replacementFile !== undefined) {
      const loadedBeforeReplacement = loadedCount;
      renderVideo(root, props(replacementFile, ['frame-one']));
      await waitFor(
        () =>
          loadedCount > loadedBeforeReplacement ||
          selectedReactFailure(failures) !== undefined,
        'React source replacement did not settle.',
      );
      if (failures.fatalFailure !== undefined) throw failures.fatalFailure;
      if (failures.unsupportedCapability !== undefined) {
        throw failures.unsupportedCapability;
      }
      replacementFrameIndex = activePlayer?.currentFrameIndex ?? -1;
    }

    return {
      status: 'played',
      canvasCount: host.querySelectorAll('canvas').length,
      videoCount: host.querySelectorAll('video').length,
      readyCount: players.size,
      packetTimestamps: api
        .getVideoPackets()
        .map(({ timestamp }) => Number.parseFloat(timestamp.toFixed(6))),
      exactPacketFrameIndex: exactPacket.frameIndex,
      exactSeekFrameIndex,
      staleTimeCallsAfterUpdate: staleTimeCount - staleTimeBeforeUpdate,
      freshTimeCalls: freshTimeCount,
      staleLoadedCallsAfterUpdate: staleLoadedCount - staleLoadedBeforeUpdate,
      freshLoadedCalls: freshLoadedCount,
      compositedPixel,
      rawPixel,
      hiddenPixel,
      stats: api.getStats(),
      ...(replacementFrameIndex === undefined ? {} : { replacementFrameIndex }),
    };
  } finally {
    flushSync(() => root.unmount());
    renderer.dispose();
    host.remove();
  }
}

export async function exerciseReactHook(
  file: string,
  replacementFile: string,
): Promise<ReactHookExerciseReport> {
  for (const candidate of [file, replacementFile]) {
    if (!/^[a-z0-9.-]+$/.test(candidate)) {
      throw new Error(`Invalid fixture name: ${candidate}`);
    }
  }

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const players = new Set<IMediaPlayer>();
  const failures: ReactFailures = {};
  let player: IMediaPlayer | undefined;
  let loadedCount = 0;
  let renderCount = 0;
  let staleTimeCount = 0;
  let freshTimeCount = 0;

  function HookCanvas({
    source,
    fresh,
  }: {
    readonly source: string;
    readonly fresh: boolean;
  }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useMediaPlayer({
      canvasRef,
      src: `/fixtures/${source}`,
      volume: 0,
      muted: true,
      renderFrame({ ctx, canvas, frame }) {
        renderCount += 1;
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      },
      onPlayerReady(readyPlayer) {
        player = readyPlayer;
        players.add(readyPlayer);
      },
      onLoadedMetadata() {
        loadedCount += 1;
      },
      onTimeChange() {
        if (fresh) freshTimeCount += 1;
        else staleTimeCount += 1;
      },
      onError(error) {
        recordReactFailure(failures, error);
      },
    });
    return createElement('canvas', {
      ref: canvasRef,
      width: 96,
      height: 64,
    });
  }

  const render = (source: string, fresh: boolean): void => {
    flushSync(() => root.render(createElement(HookCanvas, { source, fresh })));
  };

  try {
    render(file, false);
    await waitFor(
      () => loadedCount > 0 || selectedReactFailure(failures) !== undefined,
      `useMediaPlayer did not load ${file}.`,
    );
    if (failures.fatalFailure !== undefined) throw failures.fatalFailure;
    if (failures.unsupportedCapability !== undefined) {
      return {
        status: 'unsupported',
        errorCode: errorCode(failures.unsupportedCapability),
      };
    }
    const activePlayer = player;
    if (activePlayer === undefined)
      throw new Error('useMediaPlayer did not report readiness.');
    await activePlayer.seekToFrame(1);
    await waitFor(() => renderCount > 0, 'useMediaPlayer did not render a frame.');
    const frameIndex = activePlayer.currentFrameIndex;
    const canvas = host.querySelector('canvas');
    if (canvas === null) throw new Error('useMediaPlayer did not retain its canvas.');
    const pixel = readPixel(canvas, 48, 32);

    const staleBeforeUpdate = staleTimeCount;
    render(file, true);
    await activePlayer.seekToFrame(2);

    const loadedBeforeReplacement = loadedCount;
    render(replacementFile, true);
    await waitFor(
      () =>
        loadedCount > loadedBeforeReplacement ||
        selectedReactFailure(failures) !== undefined,
      'useMediaPlayer source replacement did not settle.',
    );
    if (failures.fatalFailure !== undefined) throw failures.fatalFailure;
    if (failures.unsupportedCapability !== undefined) {
      return {
        status: 'unsupported',
        errorCode: errorCode(failures.unsupportedCapability),
      };
    }

    return {
      status: 'played',
      canvasCount: host.querySelectorAll('canvas').length,
      videoCount: host.querySelectorAll('video').length,
      readyCount: players.size,
      renderCount,
      staleTimeCallsAfterUpdate: staleTimeCount - staleBeforeUpdate,
      freshTimeCalls: freshTimeCount,
      frameIndex,
      replacementFrameIndex: activePlayer.currentFrameIndex,
      pixel,
    };
  } finally {
    flushSync(() => root.unmount());
    host.remove();
  }
}

export async function exerciseReactStrictMode(): Promise<ReactLifecycleReport> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const players = new Set<IMediaPlayer>();
  const disposals = new Map<IMediaPlayer, number>();
  let loaded = false;
  const failures: ReactFailures = {};
  const element: ReactElement = createElement(
    StrictMode,
    null,
    createElement(Video, {
      src: '/fixtures/webm-vp9-opus.webm',
      muted: true,
      volume: 0,
      style: { width: 96, height: 64 },
      onPlayerReady(player: IMediaPlayer) {
        if (players.has(player)) return;
        players.add(player);
        disposals.set(player, 0);
        player.on('dispose', () => {
          disposals.set(player, (disposals.get(player) ?? 0) + 1);
        });
      },
      onLoadedMetadata() {
        loaded = true;
      },
      onError(error: Error) {
        if (errorCode(error) !== 'operation_cancelled') {
          recordReactFailure(failures, error);
        }
      },
    }),
  );

  try {
    flushSync(() => root.render(element));
    await waitFor(
      () => loaded || selectedReactFailure(failures) !== undefined,
      'StrictMode React Video did not load.',
    );
    const failure = selectedReactFailure(failures);
    if (failure !== undefined) throw failure;
    const canvasCount = host.querySelectorAll('canvas').length;
    const videoCount = host.querySelectorAll('video').length;
    flushSync(() => root.unmount());
    await Promise.resolve();
    return {
      readyCount: players.size,
      disposeCounts: [...disposals.values()],
      canvasCount,
      videoCount,
    };
  } finally {
    try {
      flushSync(() => root.unmount());
    } catch {
      // The root was already unmounted after the assertions were captured.
    }
    host.remove();
  }
}

let pendingReactAudioExercise: Promise<ReactAudioExerciseReport> | undefined;

export async function prepareReactAudioExercise(file: string): Promise<string> {
  if (!/^[a-z0-9.-]+$/.test(file)) throw new Error(`Invalid fixture name: ${file}`);
  if (pendingReactAudioExercise !== undefined) {
    throw new Error('A React audio exercise is already pending.');
  }

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<VideoRef>();
  let player: IMediaPlayer | undefined;
  let loaded = false;
  const failures: ReactFailures = {};
  const audioStatuses: MediaPlayerAudioStatus[] = [];
  renderVideo(root, {
    ref,
    src: `/fixtures/${file}`,
    volume: 0.5,
    muted: true,
    style: { width: 96, height: 64 },
    onPlayerReady(readyPlayer) {
      player = readyPlayer;
    },
    onLoadedMetadata() {
      loaded = true;
    },
    onAudioStatusChange(status) {
      audioStatuses.push({ ...status });
    },
    onError(error) {
      recordReactFailure(failures, error);
    },
  });
  await waitFor(
    () => loaded || selectedReactFailure(failures) !== undefined,
    `React audio source ${file} did not settle.`,
  );

  const button = document.createElement('button');
  button.id = 'react-audio-exercise-start';
  button.type = 'button';
  button.textContent = `Play React ${file}`;
  document.body.append(button);

  pendingReactAudioExercise = new Promise<ReactAudioExerciseReport>(
    (resolve, reject) => {
      button.addEventListener(
        'click',
        () => {
          button.remove();
          const fatalFailure = failures.fatalFailure;
          const unsupportedCapability = failures.unsupportedCapability;
          if (fatalFailure !== undefined || unsupportedCapability !== undefined) {
            flushSync(() => root.unmount());
            host.remove();
            if (fatalFailure !== undefined) reject(fatalFailure);
            else {
              resolve({
                status: 'unsupported-video',
                errorCode: errorCode(unsupportedCapability),
              });
            }
            return;
          }
          const api = ref.current;
          const activePlayer = player;
          if (api === null || activePlayer === undefined) {
            reject(new Error('React audio player is unavailable.'));
            return;
          }
          api.setVolume(0);
          api.setMuted(false);
          api.setPlaybackRate(4);
          const ended = new Promise<void>((done) => {
            const remove = activePlayer.on('ended', () => {
              remove();
              done();
            });
          });
          // Keep play() synchronously inside the trusted click handler.
          const playing = api.play();
          void (async () => {
            try {
              await playing;
              await ended;
              resolve({
                status: 'played',
                audioMetadata: activePlayer.audioMetadata,
                audioStatusEvents: audioStatuses,
                peakScheduledBufferCount: Math.max(
                  0,
                  ...audioStatuses.map(
                    ({ scheduledBufferCount }) => scheduledBufferCount,
                  ),
                ),
                audioStatus: activePlayer.audioStatus,
                stats: api.getStats(),
              });
            } catch (error) {
              reject(error);
            } finally {
              flushSync(() => root.unmount());
              host.remove();
            }
          })();
        },
        { once: true },
      );
    },
  );
  return `#${button.id}`;
}

export async function waitForReactAudioExercise(): Promise<ReactAudioExerciseReport> {
  const pending = pendingReactAudioExercise;
  if (pending === undefined) throw new Error('No React audio exercise is pending.');
  try {
    return await pending;
  } finally {
    pendingReactAudioExercise = undefined;
  }
}
