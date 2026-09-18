/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/** @vitest-environment jsdom */

import { StrictMode, act, createRef, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { SegmentationRenderer } from '@meta-sam/graphics';
import type { VideoSegmentationSnapshot } from '@meta-sam/parser';
import type {
  CustomRenderFunction,
  IMediaPlayer,
  MediaPlayerEventMap,
  MediaPlayerEventType,
  MediaResource,
  VideoPacketMetadata,
} from '@meta-sam/video';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => {
  type Listener = (event: never) => void;
  const openFailures = new Map<MediaResource, Error>();

  class FakePlayer {
    readonly canvas: HTMLCanvasElement;
    readonly rawFrame: HTMLCanvasElement;
    readonly listeners = new Map<string, Set<Listener>>();
    readonly open = vi.fn(async (src: MediaResource, initialSeekTime?: number) => {
      const failure = openFailures.get(src);
      if (failure !== undefined) {
        openFailures.delete(src);
        this.emit('error', { error: failure });
        throw failure;
      }
      this.source = src;
      this.currentTime = initialSeekTime ?? 0;
      this.currentFrameIndex = this.currentTime >= 0.5 ? 1 : 0;
      this.duration = 1;
      this.videoFps = 2;
      this.loaded = true;
      this.emit('durationchange', { duration: this.duration });
      this.emit('loadedmetadata', {
        duration: this.duration,
        width: 96,
        height: 64,
        numFrames: 2,
        fps: this.videoFps,
        videoPackets: this.packets,
        audio: this.audioMetadata,
      });
      this.emit('timeupdate', { time: this.currentTime });
      await this.forceRender();
      this.emit('frame', {
        time: this.currentTime,
        frameIndex: this.currentFrameIndex,
      });
    });
    readonly play = vi.fn(async () => {
      this.assertActive();
      this.paused = false;
      this.emit('play', { time: this.currentTime });
    });
    readonly pause = vi.fn(() => {
      this.assertActive();
      if (this.paused) return;
      this.paused = true;
      this.emit('pause', { time: this.currentTime });
    });
    readonly seek = vi.fn(async (time: number) => {
      this.assertActive();
      this.currentTime = time;
      this.currentFrameIndex = time >= 0.5 ? 1 : 0;
      await this.forceRender();
      this.emit('timeupdate', { time });
      this.emit('frame', { time, frameIndex: this.currentFrameIndex });
    });
    readonly seekToFrame = vi.fn(async (frameIndex: number) => {
      await this.seek(this.getTimeAtFrameIndexExact(frameIndex));
    });
    readonly nextFrame = vi.fn(async () => {
      await this.seekToFrame(this.currentFrameIndex + 1);
    });
    readonly previousFrame = vi.fn(async () => {
      await this.seekToFrame(this.currentFrameIndex - 1);
    });
    readonly forceRender = vi.fn(async () => {
      this.assertActive();
      if (!this.loaded) {
        const error = Object.assign(new Error('No frame'), {
          code: 'frame_metadata_unavailable',
        });
        throw error;
      }
      if (this.renderFrame === null) {
        this.canvas
          .getContext('2d')
          ?.drawImage(this.rawFrame, 0, 0, this.canvas.width, this.canvas.height);
        return;
      }
      const composition = this.canvas.ownerDocument.createElement('canvas');
      composition.width = this.canvas.width;
      composition.height = this.canvas.height;
      const fallback = this.canvas.ownerDocument.createElement('canvas');
      fallback.width = this.canvas.width;
      fallback.height = this.canvas.height;
      const context = composition.getContext('2d');
      const fallbackContext = fallback.getContext('2d');
      if (context === null || fallbackContext === null)
        throw new Error('Missing context');
      await this.renderFrame({
        frame: this.rawFrame,
        frameIndex: this.currentFrameIndex,
        timestamp: this.currentTime,
        duration: 0.5,
        canvas: composition,
        ctx: context,
        fallbackCanvas: fallback,
        fallbackCtx: fallbackContext,
        signal: new AbortController().signal,
      });
      this.canvas
        .getContext('2d')
        ?.drawImage(composition, 0, 0, this.canvas.width, this.canvas.height);
    });
    readonly setCustomRender = vi.fn((render: CustomRenderFunction | null) => {
      this.assertActive();
      this.renderFrame = render;
    });
    readonly dispose = vi.fn(() => {
      if (this.disposed) return;
      this.disposed = true;
      this.emit('dispose', {});
      this.listeners.clear();
    });
    readonly packets: readonly VideoPacketMetadata[] = Object.freeze([
      Object.freeze({
        frameIndex: 0,
        timestamp: 0,
        duration: 0.5,
        sequenceNumber: 0,
        type: 'key' as const,
        byteLength: 10,
      }),
      Object.freeze({
        frameIndex: 1,
        timestamp: 0.5,
        duration: 0.5,
        sequenceNumber: 1,
        type: 'delta' as const,
        byteLength: 8,
      }),
    ]);
    source: MediaResource | undefined;
    renderFrame: CustomRenderFunction | null = null;
    disposed = false;
    loaded = false;
    currentTime = 0;
    currentFrameIndex = -1;
    duration = 0;
    paused = true;
    loop = false;
    playbackRate = 1;
    volume = 1;
    muted = false;
    videoFps = 0;
    readonly audioMetadata = Object.freeze({
      capability: 'supported' as const,
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
      firstTimestamp: 0,
      duration: 1,
    });
    get audioStatus() {
      return Object.freeze({
        capability: 'supported' as const,
        clockSource: 'audio-context' as const,
        contextState: 'running' as const,
        scheduledBufferCount: 1,
        volume: this.volume,
        muted: this.muted,
      });
    }

    constructor(canvas: HTMLCanvasElement) {
      this.canvas = canvas;
      this.rawFrame = canvas.ownerDocument.createElement('canvas');
      this.rawFrame.width = 96;
      this.rawFrame.height = 64;
    }

    on(event: string, callback: Listener): () => void {
      const listeners = this.listeners.get(event) ?? new Set<Listener>();
      listeners.add(callback);
      this.listeners.set(event, listeners);
      return () => listeners.delete(callback);
    }

    off(event: string, callback: Listener): void {
      this.listeners.get(event)?.delete(callback);
    }

    removeAllListeners(event?: string): void {
      if (event === undefined) this.listeners.clear();
      else this.listeners.delete(event);
    }

    emit<T extends MediaPlayerEventType>(
      event: T,
      payload: MediaPlayerEventMap[T],
    ): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(payload as never);
      }
    }

    getFrameIndexAtTimeExact(time: number): number {
      return time >= 0.5 ? 1 : 0;
    }

    getTimeAtFrameIndexExact(frameIndex: number): number {
      const packet = this.packets[frameIndex];
      if (packet === undefined) throw new RangeError('frame');
      return packet.timestamp;
    }

    getVideoPackets(): readonly VideoPacketMetadata[] {
      return this.packets;
    }

    getCurrentFrame(): HTMLCanvasElement | null {
      return this.loaded ? this.rawFrame : null;
    }

    readonly resetStats = vi.fn();
    readonly getStats = vi.fn(() =>
      Object.freeze({
        sampleWindowSize: 256,
        renderLoopTicks: 4,
        uniqueVideoFramesRendered: 2,
        duplicateRedraws: 1,
        lateFramesSkipped: 1,
        decodeTime: Object.freeze({
          sampleCount: 2,
          averageMilliseconds: 1,
          p95Milliseconds: 2,
          maxMilliseconds: 2,
        }),
        overlayRenderTime: Object.freeze({
          sampleCount: 2,
          averageMilliseconds: 3,
          p95Milliseconds: 4,
          maxMilliseconds: 4,
        }),
        videoQueueDepth: Object.freeze({ current: 2, max: 2 }),
        audioQueueDepth: Object.freeze({ current: 1, max: 3 }),
        avPresentationError: Object.freeze({
          currentSeconds: 0.01,
          maxAbsoluteSeconds: 0.02,
        }),
        audioUnderruns: Object.freeze({ count: 0, totalSeconds: 0, maxSeconds: 0 }),
        audioGaps: Object.freeze({ count: 1, totalSeconds: 0.05, maxSeconds: 0.05 }),
        droppedAudioBuffers: Object.freeze({
          count: 0,
          totalSeconds: 0,
          maxSeconds: 0,
        }),
      }),
    );

    assertActive(): void {
      if (this.disposed) throw new Error('The media player has been disposed.');
    }
  }

  const players: FakePlayer[] = [];
  const createMediaPlayer = vi.fn((canvas: HTMLCanvasElement) => {
    const player = new FakePlayer(canvas);
    players.push(player);
    return player;
  });

  return { FakePlayer, createMediaPlayer, openFailures, players };
});

vi.mock('@meta-sam/video', () => ({
  createMediaPlayer: media.createMediaPlayer,
  getPacketAtTimeExact: (
    packets: readonly VideoPacketMetadata[],
    time: number,
  ): VideoPacketMetadata => {
    const packet = packets.find(
      (candidate) =>
        candidate.timestamp <= time && time < candidate.timestamp + candidate.duration,
    );
    if (packet === undefined) throw new RangeError('time');
    return packet;
  },
}));

import { Video, useMediaPlayer, type VideoRef } from '../src/index.js';

class MockPath2D {
  public constructor(_path?: string) {}
  public rect(): void {}
}

const context = {
  fillStyle: '',
  globalAlpha: 1,
  lineWidth: 1,
  strokeStyle: '',
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  clip: vi.fn(),
  transform: vi.fn(),
  fill: vi.fn(),
  strokeRect: vi.fn(),
};

const emptyResult: VideoSegmentationSnapshot = Object.freeze({
  media: 'video',
  revision: 0,
  records: Object.freeze([]),
  diagnostics: Object.freeze([]),
  rawOutput: '',
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  media.players.length = 0;
  media.openFailures.clear();
  media.createMediaPlayer.mockClear();
  Object.defineProperty(globalThis, 'Path2D', {
    configurable: true,
    writable: true,
    value: MockPath2D,
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  Object.defineProperties(HTMLCanvasElement.prototype, {
    clientWidth: { configurable: true, get: () => 320 },
    clientHeight: { configurable: true, get: () => 180 },
  });
  for (const value of Object.values(context)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount(element: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return { host, root, render: (next: React.ReactNode) => root.render(next) };
}

describe('Video', () => {
  it('renders one Canvas and opens string, URL, and Blob sources with controlled playback options', async () => {
    const ready = vi.fn<(player: IMediaPlayer) => void>();
    const { host, root } = mount(null);
    const url = new URL('https://example.test/video.webm');
    await act(async () => {
      root.render(
        <Video
          src={url}
          initialSeekTime={0.5}
          loop
          playbackRate={1.5}
          volume={0.25}
          muted
          onPlayerReady={ready}
        />,
      );
    });

    expect(host.querySelectorAll('canvas')).toHaveLength(1);
    expect(host.querySelector('video')).toBeNull();
    const player = media.players[0]!;
    expect(player.open).toHaveBeenCalledWith(url, 0.5);
    expect(player.loop).toBe(true);
    expect(player.playbackRate).toBe(1.5);
    expect(player.volume).toBe(0.25);
    expect(player.muted).toBe(true);
    expect(ready).toHaveBeenCalledWith(player);

    const blob = new Blob(['video']);
    await act(async () => root.render(<Video src={blob} />));
    expect(media.players).toHaveLength(1);
    expect(player.open).toHaveBeenLastCalledWith(blob, undefined);
    await act(async () => root.unmount());
  });

  it('constructs and disposes every StrictMode player exactly once', async () => {
    const { root } = mount(null);
    await act(async () => {
      root.render(
        <StrictMode>
          <Video src="/strict.webm" />
        </StrictMode>,
      );
    });
    expect(media.players.length).toBeGreaterThanOrEqual(2);

    await act(async () => root.unmount());
    for (const player of media.players) expect(player.dispose).toHaveBeenCalledOnce();
  });

  it('never disposes a supplied renderer and disposes each owned renderer once', async () => {
    const dispose = vi.spyOn(SegmentationRenderer.prototype, 'dispose');
    const supplied = new SegmentationRenderer();
    const suppliedDispose = vi.spyOn(supplied, 'dispose');
    const first = mount(null);
    await act(async () =>
      first.root.render(<Video src="/supplied.webm" renderer={supplied} />),
    );
    await act(async () => first.root.unmount());
    expect(suppliedDispose).not.toHaveBeenCalled();

    const beforeOwned = dispose.mock.calls.length;
    const second = mount(null);
    await act(async () => second.root.render(<Video src="/owned.webm" />));
    await act(async () => second.root.unmount());
    expect(dispose.mock.calls.length - beforeOwned).toBe(1);
  });

  it('updates segmentation and render options without recreating the player', async () => {
    const renderer = new SegmentationRenderer();
    const update = vi.spyOn(renderer, 'update');
    const render = vi.spyOn(renderer, 'renderVideoFrame').mockReturnValue(true);
    const { root } = mount(null);
    await act(async () => {
      root.render(
        <Video
          src="/stable.webm"
          renderer={renderer}
          result={emptyResult}
          hiddenIds={[]}
          objectFit="contain"
          devicePixelRatio={1}
        />,
      );
    });
    const player = media.players[0]!;
    expect(update).toHaveBeenCalledWith(emptyResult, { reset: true });

    const nextResult = { ...emptyResult, revision: 1 };
    const forceRenderCount = player.forceRender.mock.calls.length;
    await act(async () => {
      root.render(
        <Video
          src="/stable.webm"
          renderer={renderer}
          result={nextResult}
          hiddenIds={['subject']}
          objectFit="cover"
          devicePixelRatio={2}
        />,
      );
    });

    expect(media.players).toHaveLength(1);
    expect(player.forceRender.mock.calls.length).toBeGreaterThan(forceRenderCount);
    expect(update).toHaveBeenLastCalledWith(nextResult, { reset: true });
    const renderOptions = render.mock.calls.at(-1)?.[1];
    expect(renderOptions).toMatchObject({
      fit: 'cover',
      hiddenIds: ['subject'],
    });
    expect(
      typeof renderOptions?.devicePixelRatio === 'function'
        ? renderOptions.devicePixelRatio()
        : renderOptions?.devicePixelRatio,
    ).toBe(2);
    await act(async () => root.unmount());
  });

  it('routes events to the newest callbacks without recreating the player', async () => {
    const staleTime = vi.fn();
    const freshTime = vi.fn();
    const stalePlaying = vi.fn();
    const freshPlaying = vi.fn();
    const loaded = vi.fn();
    const duration = vi.fn();
    const frame = vi.fn();
    const audio = vi.fn();
    const warning = vi.fn();
    const errors = vi.fn();
    const { root } = mount(null);
    await act(async () => {
      root.render(
        <Video
          src="/callbacks.webm"
          onTimeChange={staleTime}
          onPlayingChange={stalePlaying}
        />,
      );
    });
    const player = media.players[0]!;
    staleTime.mockClear();
    stalePlaying.mockClear();

    const audioWarning = Object.assign(new Error('audio'), {
      code: 'audio_playback_error',
    });
    await act(async () => {
      root.render(
        <Video
          src="/callbacks.webm"
          onTimeChange={freshTime}
          onPlayingChange={freshPlaying}
          onLoadedMetadata={loaded}
          onDurationChange={duration}
          onFrame={frame}
          onAudioStatusChange={audio}
          onAudioWarning={warning}
          onError={errors}
        />,
      );
    });
    await act(async () => {
      player.emit('timeupdate', { time: 0.75 });
      player.emit('play', { time: 0.75 });
      player.emit('durationchange', { duration: 2 });
      player.emit('loadedmetadata', {
        duration: 2,
        width: 96,
        height: 64,
        numFrames: 4,
        fps: 2,
        videoPackets: player.packets,
        audio: player.audioMetadata,
      });
      player.emit('frame', { time: 0.75, frameIndex: 1 });
      player.emit('audiostatuschange', player.audioStatus);
      player.emit('audiowarning', { warning: audioWarning as never });
      player.emit('error', { error: new Error('fatal') });
    });

    expect(staleTime).not.toHaveBeenCalled();
    expect(stalePlaying).not.toHaveBeenCalled();
    expect(freshTime).toHaveBeenCalledWith(0.75);
    expect(freshPlaying).toHaveBeenCalledWith(true);
    expect(duration).toHaveBeenCalledWith(2);
    expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ numFrames: 4 }));
    expect(frame).toHaveBeenCalledWith({ time: 0.75, frameIndex: 1 });
    expect(audio).toHaveBeenCalledWith(player.audioStatus);
    expect(warning).toHaveBeenCalledWith(audioWarning);
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: 'fatal' }));
    expect(media.players).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('exposes exact navigation, packet lookup, controls, capture, and stats through VideoRef', async () => {
    const videoRef = createRef<VideoRef>();
    const { root } = mount(null);
    await act(async () => root.render(<Video ref={videoRef} src="/ref.webm" />));
    const player = media.players[0]!;
    const api = videoRef.current!;

    await act(async () => api.play());
    await act(async () => api.seek(0.5));
    await act(async () => api.seekToFrame(0));
    await act(async () => api.nextFrame());
    await act(async () => api.previousFrame());
    await act(async () => api.forceRender());
    api.setPlaybackRate(2);
    api.setVolume(0.4);
    api.setMuted(true);
    api.setLoop(true);
    api.pause();
    api.resetStats();

    expect(player.play).toHaveBeenCalled();
    expect(player.seek).toHaveBeenCalledWith(0.5);
    expect(api.getFrameIndexAtTimeExact(0.75)).toBe(1);
    expect(api.getTimeAtFrameIndexExact(1)).toBe(0.5);
    expect(api.getPacketAtTimeExact(0.75).frameIndex).toBe(1);
    expect(api.getVideoPackets()).toBe(player.packets);
    expect(api.captureFrame('composited')).toBeInstanceOf(HTMLCanvasElement);
    expect(api.captureFrame('raw')).toBeInstanceOf(HTMLCanvasElement);
    expect(api.getStats()).toMatchObject({
      renderLoopTicks: 4,
      uniqueVideoFramesRendered: 2,
      duplicateRedraws: 1,
      lateFramesSkipped: 1,
      audioQueueDepth: { current: 1, max: 3 },
      avPresentationError: { currentSeconds: 0.01, maxAbsoluteSeconds: 0.02 },
    });
    expect(player.getStats).toHaveBeenCalledOnce();
    expect(player.resetStats).toHaveBeenCalledOnce();
    await act(async () => root.unmount());

    const rejected: unknown[] = [];
    const operations = [
      api.play().catch((error: unknown) => rejected.push(error)),
      api.seek(0).catch((error: unknown) => rejected.push(error)),
      api.seekToFrame(0).catch((error: unknown) => rejected.push(error)),
      api.nextFrame().catch((error: unknown) => rejected.push(error)),
      api.previousFrame().catch((error: unknown) => rejected.push(error)),
      api.forceRender().catch((error: unknown) => rejected.push(error)),
    ];
    await Promise.all(operations);
    expect(rejected).toHaveLength(operations.length);
    expect(rejected).toEqual(
      operations.map(() =>
        expect.objectContaining({ message: expect.stringContaining('not mounted') }),
      ),
    );
    expect(() => api.getStats()).toThrow('not mounted');
  });

  it('rejects image results and ignores stale renderer failures after unmount', async () => {
    let reject!: (reason: unknown) => void;
    const renderer = new SegmentationRenderer();
    vi.spyOn(renderer, 'update').mockReturnValue(
      new Promise<void>((_resolve, decline) => {
        reject = decline;
      }),
    );
    const errors = vi.fn();
    const { root } = mount(null);
    await act(async () =>
      root.render(
        <Video
          src="/result.webm"
          renderer={renderer}
          result={emptyResult}
          onError={errors}
        />,
      ),
    );
    await act(async () => root.unmount());
    reject(new Error('stale'));
    await act(async () => Promise.resolve());
    expect(errors).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'stale' }),
    );

    const invalid = mount(null);
    await act(async () =>
      invalid.root.render(
        <Video
          src="/invalid.webm"
          result={{ ...emptyResult, media: 'image' } as never}
          onError={errors}
        />,
      ),
    );
    expect(errors).toHaveBeenCalledWith(expect.any(TypeError));
    await act(async () => invalid.root.unmount());
  });
});

describe('useMediaPlayer', () => {
  it('retries a failed open when the same source is rendered again', async () => {
    const source = '/retry.webm';
    const failure = new Error('first open failed');
    media.openFailures.set(source, failure);
    const errors = vi.fn();

    function Harness({ revision }: { readonly revision: number }) {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      useMediaPlayer({
        canvasRef,
        src: source,
        onError: revision === 0 ? errors : () => undefined,
      });
      return <canvas ref={canvasRef} />;
    }

    const { root } = mount(null);
    await act(async () => root.render(<Harness revision={0} />));
    const player = media.players[0]!;
    await vi.waitFor(() => expect(errors).toHaveBeenCalledWith(failure));
    expect(player.open).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness revision={1} />));
    await vi.waitFor(() => expect(player.open).toHaveBeenCalledTimes(2));
    expect(player.source).toBe(source);
    await act(async () => root.unmount());
  });

  it('owns a caller canvas, discovers late elements, and replaces the player only with the canvas', async () => {
    const ready = vi.fn<(player: IMediaPlayer) => void>();
    function Harness({ show, generation }: { show: boolean; generation: number }) {
      const canvasRef = useRef<HTMLCanvasElement>(null);
      useMediaPlayer({ canvasRef, src: '/hook.webm', onPlayerReady: ready });
      return show ? <canvas key={generation} ref={canvasRef} /> : null;
    }

    const { root } = mount(null);
    await act(async () => root.render(<Harness show={false} generation={0} />));
    expect(ready).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness show generation={1} />));
    expect(ready).toHaveBeenCalledTimes(1);
    const first = media.players[0]!;
    await act(async () => root.render(<Harness show generation={2} />));
    expect(ready).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    expect(media.players[1]?.dispose).toHaveBeenCalledOnce();
  });
});
