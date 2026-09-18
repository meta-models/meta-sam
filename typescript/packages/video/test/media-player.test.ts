/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Packet = {
  readonly timestamp: number;
  readonly duration: number;
  readonly sequenceNumber: number;
  readonly type: 'key' | 'delta';
  readonly byteLength: number;
};

type AudioBufferPacket = {
  readonly timestamp: number;
  readonly duration: number;
  readonly bufferDuration?: number;
};

type AudioDataset = {
  readonly buffers: readonly AudioBufferPacket[];
  readonly canDecode?: boolean;
  readonly codec?: string | null;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  readonly firstTimestamp?: number;
  readonly duration?: number;
};

type Dataset = {
  readonly packets: readonly Packet[];
  readonly width?: number;
  readonly height?: number;
  readonly canDecode?: boolean;
  readonly audio?: AudioDataset;
};

const fakeMedia = vi.hoisted(() => ({
  datasets: new Map<unknown, Dataset>(),
  openGates: new Map<unknown, Promise<void>>(),
  frameGates: new Map<number, Promise<void>>(),
  frameFailures: new Map<number, Error>(),
  frameRequests: [] as number[],
  audioBufferRequests: [] as number[],
  audioBufferGates: new Map<number, Promise<void>>(),
  audioIteratorReturns: 0,
  sourceKinds: [] as string[],
  canvasSinkOptions: [] as unknown[],
}));

vi.mock('mediabunny', () => {
  class FakeUrlSource {
    public constructor(public readonly resource: string | URL) {
      fakeMedia.sourceKinds.push('url');
    }
  }

  class FakeBlobSource {
    public constructor(public readonly resource: Blob) {
      fakeMedia.sourceKinds.push('blob');
    }
  }

  class FakeInput {
    public disposed = false;
    readonly #resource: unknown;
    readonly #dataset: Dataset;

    public constructor(options: { source: FakeUrlSource | FakeBlobSource }) {
      this.#resource = options.source.resource;
      const dataset = fakeMedia.datasets.get(this.#resource);
      if (dataset === undefined) throw new Error('Unknown fake media source.');
      this.#dataset = dataset;
    }

    public async canRead(): Promise<boolean> {
      await fakeMedia.openGates.get(this.#resource);
      if (this.disposed) throw new Error('Input disposed.');
      return true;
    }

    public async getPrimaryVideoTrack(): Promise<FakeTrack> {
      if (this.disposed) throw new Error('Input disposed.');
      return new FakeTrack(this, this.#dataset);
    }

    public async getPrimaryAudioTrack(): Promise<FakeAudioTrack | null> {
      if (this.disposed) throw new Error('Input disposed.');
      return this.#dataset.audio === undefined
        ? null
        : new FakeAudioTrack(this, this.#dataset.audio);
    }

    public dispose(): void {
      this.disposed = true;
    }
  }

  class FakeTrack {
    public constructor(
      public readonly input: FakeInput,
      public readonly dataset: Dataset,
    ) {}

    public async canDecode(): Promise<boolean> {
      return this.dataset.canDecode ?? true;
    }

    public async getDisplayWidth(): Promise<number> {
      return this.dataset.width ?? 96;
    }

    public async getDisplayHeight(): Promise<number> {
      return this.dataset.height ?? 64;
    }
  }

  class FakeAudioTrack {
    public constructor(
      public readonly input: FakeInput,
      public readonly dataset: AudioDataset,
    ) {}

    public async canDecode(): Promise<boolean> {
      return this.dataset.canDecode ?? true;
    }

    public async getCodec(): Promise<string | null> {
      return this.dataset.codec ?? 'opus';
    }

    public async getSampleRate(): Promise<number> {
      return this.dataset.sampleRate ?? 48_000;
    }

    public async getNumberOfChannels(): Promise<number> {
      return this.dataset.numberOfChannels ?? 1;
    }

    public async getFirstTimestamp(): Promise<number> {
      return this.dataset.firstTimestamp ?? this.dataset.buffers[0]?.timestamp ?? 0;
    }

    public async computeDuration(): Promise<number> {
      return (
        this.dataset.duration ??
        Math.max(
          0,
          ...this.dataset.buffers.map((buffer) => buffer.timestamp + buffer.duration),
        )
      );
    }
  }

  class FakeEncodedPacketSink {
    public constructor(private readonly track: FakeTrack) {}

    public async *packets(): AsyncGenerator<Packet> {
      for (const packet of this.track.dataset.packets) {
        if (this.track.input.disposed) throw new Error('Input disposed.');
        yield packet;
      }
    }
  }

  class FakeCanvasSink {
    readonly #pool: Array<
      { width: number; height: number; timestamp: number } | undefined
    >;
    #nextCanvasIndex = 0;

    public constructor(
      private readonly track: FakeTrack,
      options: { poolSize?: number },
    ) {
      fakeMedia.canvasSinkOptions.push(options);
      this.#pool = Array.from({ length: options.poolSize ?? 0 });
    }

    public async *canvases(startTimestamp = -Infinity): AsyncGenerator<{
      canvas: { width: number; height: number; timestamp: number };
      timestamp: number;
      duration: number;
    }> {
      const packets = [...this.track.dataset.packets].sort(
        (left, right) => left.timestamp - right.timestamp,
      );
      for (const packet of packets) {
        if (packet.timestamp < startTimestamp) continue;
        fakeMedia.frameRequests.push(packet.timestamp);
        await fakeMedia.frameGates.get(packet.timestamp);
        const failure = fakeMedia.frameFailures.get(packet.timestamp);
        if (failure !== undefined) throw failure;
        if (this.track.input.disposed) throw new Error('Input disposed.');
        let canvas = this.#pool[this.#nextCanvasIndex];
        if (canvas === undefined) {
          canvas = { width: 96, height: 64, timestamp: packet.timestamp };
          if (this.#pool.length > 0) this.#pool[this.#nextCanvasIndex] = canvas;
        }
        canvas.timestamp = packet.timestamp;
        if (this.#pool.length > 0) {
          this.#nextCanvasIndex = (this.#nextCanvasIndex + 1) % this.#pool.length;
        }
        yield {
          canvas,
          timestamp: packet.timestamp,
          duration: packet.duration,
        };
      }
    }
  }

  class FakeAudioBufferSink {
    public constructor(private readonly track: FakeAudioTrack) {}

    public buffers(startTimestamp = -Infinity, endTimestamp = Infinity) {
      const buffers = [...this.track.dataset.buffers]
        .sort((left, right) => left.timestamp - right.timestamp)
        .filter(
          (buffer) =>
            buffer.timestamp + buffer.duration > startTimestamp &&
            buffer.timestamp < endTimestamp,
        );
      let index = 0;
      let returned = false;
      return {
        async next() {
          if (returned || index >= buffers.length) {
            return { value: undefined, done: true as const };
          }
          const value = buffers[index++]!;
          fakeMedia.audioBufferRequests.push(value.timestamp);
          await fakeMedia.audioBufferGates.get(value.timestamp);
          return {
            value: {
              timestamp: value.timestamp,
              duration: value.duration,
              buffer: { duration: value.bufferDuration ?? value.duration },
            },
            done: false as const,
          };
        },
        async return() {
          if (!returned) fakeMedia.audioIteratorReturns += 1;
          returned = true;
          return { value: undefined, done: true as const };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
  }

  return {
    ALL_FORMATS: [],
    AudioBufferSink: FakeAudioBufferSink,
    BlobSource: FakeBlobSource,
    CanvasSink: FakeCanvasSink,
    EncodedPacketSink: FakeEncodedPacketSink,
    Input: FakeInput,
    UrlSource: FakeUrlSource,
  };
});

import {
  MediaPlayerAudioResumeTimeoutError,
  MediaPlayerDisposedError,
  MediaPlayerOperationCancelledError,
  createMediaPlayer,
  type MediaPlayerOptions,
} from '../src/index.js';
import {
  getPresentationWindowError,
  PlaybackStatsRecorder,
} from '../src/playback-stats.js';

class MockContext {
  readonly setTransform = vi.fn();
  readonly clearRect = vi.fn();
  readonly drawImage: ReturnType<typeof vi.fn>;

  public constructor(canvas: MockCanvas) {
    this.drawImage = vi.fn((source: { timestamp?: number }) => {
      if (source.timestamp !== undefined) canvas.timestamp = source.timestamp;
    });
  }
}

class MockDocument {
  readonly canvases: MockCanvas[] = [];

  public createElement(tag: string): MockCanvas {
    if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`);
    const canvas = new MockCanvas(this);
    this.canvases.push(canvas);
    return canvas;
  }
}

class MockCanvas {
  width = 96;
  height = 64;
  timestamp = -1;
  readonly context: MockContext;

  public constructor(readonly ownerDocument: MockDocument) {
    this.context = new MockContext(this);
  }

  public getContext(kind: string): MockContext | null {
    return kind === '2d' ? this.context : null;
  }
}

class FakeAudioBufferSource {
  buffer: AudioBuffer | null = null;
  readonly playbackRate = { value: 1 } as AudioParam;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly stop = vi.fn();
  readonly start = vi.fn(
    (_when?: number, _offset?: number, _duration?: number) => undefined,
  );
}

class FakeGainNode {
  readonly gain = { value: 1 } as AudioParam;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAudioContext {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly destination = {} as AudioDestinationNode;
  readonly sources: FakeAudioBufferSource[] = [];
  readonly gain = new FakeGainNode();
  readonly resume: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;

  public constructor(
    private readonly failures: {
      readonly resume?: Error;
      readonly resumeGate?: Promise<void>;
      readonly gain?: Error;
    } = {},
  ) {
    this.resume = vi.fn(async () => {
      await this.failures.resumeGate;
      if (this.failures.resume !== undefined) throw this.failures.resume;
      this.state = 'running';
    });
    this.close = vi.fn(async () => {
      this.state = 'closed';
    });
  }

  public createGain(): GainNode {
    if (this.failures.gain !== undefined) throw this.failures.gain;
    return this.gain as unknown as GainNode;
  }

  public createBufferSource(): AudioBufferSourceNode {
    const source = new FakeAudioBufferSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

const source = 'https://example.test/video.webm';
const otherSource = 'https://example.test/other.webm';
const packets: readonly Packet[] = [
  {
    timestamp: 0,
    duration: 0.1,
    sequenceNumber: 0,
    type: 'key',
    byteLength: 10,
  },
  {
    timestamp: 0.2,
    duration: 0.1,
    sequenceNumber: 1,
    type: 'delta',
    byteLength: 12,
  },
  {
    timestamp: 0.1,
    duration: 0.1,
    sequenceNumber: 2,
    type: 'delta',
    byteLength: 11,
  },
  {
    timestamp: 0.3,
    duration: 0.1,
    sequenceNumber: 3,
    type: 'delta',
    byteLength: 13,
  },
];

const audioBuffers: readonly AudioBufferPacket[] = [
  { timestamp: 0, duration: 0.1 },
  { timestamp: 0.1, duration: 0.1 },
  { timestamp: 0.2, duration: 0.1 },
  { timestamp: 0.3, duration: 0.1 },
];

let animationCallbacks: Map<number, FrameRequestCallback>;
let nextAnimationHandle: number;
let now: number;

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  audioContext?: FakeAudioContext,
  createAudioContext?: () => AudioContext,
  options: Partial<MediaPlayerOptions> = {},
) {
  const document = new MockDocument();
  const canvas = new MockCanvas(document);
  const audioContextFactory =
    createAudioContext ??
    (audioContext === undefined
      ? undefined
      : () => audioContext as unknown as AudioContext);
  const player = createMediaPlayer(canvas as unknown as HTMLCanvasElement, {
    ...(audioContextFactory === undefined
      ? {}
      : {
          createAudioContext: audioContextFactory,
          audioSchedulingLeadSeconds: 0,
        }),
    audioLookaheadSeconds: 0.15,
    maxScheduledAudioBuffers: 3,
    ...options,
  });
  return { audioContext, canvas, document, player };
}

beforeEach(() => {
  fakeMedia.datasets.clear();
  fakeMedia.datasets.set(source, { packets });
  fakeMedia.datasets.set(otherSource, { packets });
  fakeMedia.openGates.clear();
  fakeMedia.frameGates.clear();
  fakeMedia.frameFailures.clear();
  fakeMedia.frameRequests.length = 0;
  fakeMedia.audioBufferRequests.length = 0;
  fakeMedia.audioBufferGates.clear();
  fakeMedia.audioIteratorReturns = 0;
  fakeMedia.sourceKinds.length = 0;
  fakeMedia.canvasSinkOptions.length = 0;
  animationCallbacks = new Map();
  nextAnimationHandle = 1;
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextAnimationHandle++;
    animationCallbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    animationCallbacks.delete(handle);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MediaPlayer', () => {
  it('opens URL and Blob sources with frozen presentation-ordered metadata', async () => {
    const { player } = setup();
    const loaded = vi.fn();
    player.on('loadedmetadata', loaded);

    await player.open(source);
    expect(fakeMedia.sourceKinds).toEqual(['url']);
    expect(player.duration).toBeCloseTo(0.4);
    expect(player.videoFps).toBeCloseTo(10);
    expect(player.currentFrameIndex).toBe(0);
    expect(player.getFrameIndexAtTimeExact(0.19)).toBe(1);
    expect(player.getTimeAtFrameIndexExact(2)).toBe(0.2);
    expect(player.getVideoPackets().map(({ timestamp }) => timestamp)).toEqual([
      0, 0.1, 0.2, 0.3,
    ]);
    expect(Object.isFrozen(player.getVideoPackets())).toBe(true);
    expect(fakeMedia.canvasSinkOptions).toEqual([{ poolSize: 2 }]);
    expect(loaded).toHaveBeenCalledWith(
      expect.objectContaining({ width: 96, height: 64, numFrames: 4 }),
    );

    const blob = new Blob(['video']);
    fakeMedia.datasets.set(blob, { packets });
    await player.open(blob);
    expect(fakeMedia.sourceKinds).toEqual(['url', 'blob']);
    player.dispose();
  });

  it('keeps atomic playback statistics within the configured sample window', async () => {
    const { player } = setup(undefined, undefined, { statsSampleWindowSize: 2 });
    let renderCostMilliseconds = 1;
    player.setCustomRender(({ ctx, frame }) => {
      now += renderCostMilliseconds;
      renderCostMilliseconds += 1;
      ctx.drawImage(frame, 0, 0);
    });

    await player.open(source);
    await player.forceRender();
    await player.seekToFrame(1);
    await player.forceRender();

    const stats = player.getStats();
    expect(Object.isFrozen(stats)).toBe(true);
    expect(Object.isFrozen(stats.overlayRenderTime)).toBe(true);
    expect(stats).toMatchObject({
      sampleWindowSize: 2,
      renderLoopTicks: 0,
      uniqueVideoFramesRendered: 2,
      duplicateRedraws: 2,
      lateFramesSkipped: 0,
      overlayRenderTime: {
        sampleCount: 2,
        averageMilliseconds: 3.5,
        p95Milliseconds: 4,
        maxMilliseconds: 4,
      },
      videoQueueDepth: { current: 2, max: 2 },
      audioQueueDepth: { current: 0, max: 0 },
      avPresentationError: { currentSeconds: null, maxAbsoluteSeconds: null },
    });
    expect(stats.decodeTime.sampleCount).toBe(2);

    player.resetStats();
    expect(player.getStats()).toMatchObject({
      renderLoopTicks: 0,
      uniqueVideoFramesRendered: 0,
      duplicateRedraws: 0,
      lateFramesSkipped: 0,
      decodeTime: { sampleCount: 0 },
      overlayRenderTime: { sampleCount: 0 },
      videoQueueDepth: { current: 2, max: 2 },
    });
    await player.forceRender();
    expect(player.getStats()).toMatchObject({
      uniqueVideoFramesRendered: 0,
      duplicateRedraws: 1,
      overlayRenderTime: { sampleCount: 1 },
    });
    player.dispose();
  });

  it('measures decode latency around each bounded decoder pull', async () => {
    const first = deferred();
    const second = deferred();
    fakeMedia.frameGates.set(0, first.promise);
    fakeMedia.frameGates.set(0.1, second.promise);
    const { player } = setup();

    const opening = player.open(source);
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toEqual([0]));
    now = 5;
    first.resolve();
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toEqual([0, 0.1]));
    now = 12;
    second.resolve();
    await opening;

    expect(player.getStats().decodeTime).toEqual({
      sampleCount: 2,
      averageMilliseconds: 6,
      p95Milliseconds: 7,
      maxMilliseconds: 7,
    });
    player.dispose();
  });

  it('rejects unbounded statistics windows', () => {
    expect(() => setup(undefined, undefined, { statsSampleWindowSize: 4_097 })).toThrow(
      RangeError,
    );
    expect(() => setup(undefined, undefined, { statsSampleWindowSize: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      setup(undefined, undefined, {
        audioContextResumeTimeoutMilliseconds: 2_147_483_648,
      }),
    ).toThrow(RangeError);
  });

  it('supports exact seeking, frame navigation, and isolated custom rendering', async () => {
    const { canvas, document, player } = setup();
    const rendered: number[] = [];
    player.setCustomRender(({ canvas: composition, ctx, frame, frameIndex }) => {
      expect(composition).not.toBe(canvas);
      rendered.push(frameIndex);
      ctx.drawImage(frame, 0, 0);
    });

    await player.open(source);
    await player.seek(0.15);
    expect(player.currentFrameIndex).toBe(1);
    await player.nextFrame();
    expect(player.currentFrameIndex).toBe(2);
    await player.previousFrame();
    expect(player.currentFrameIndex).toBe(1);
    await player.forceRender();

    expect(rendered).toEqual([0, 1, 2, 1, 1]);
    expect(document.canvases).toHaveLength(18);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(5);
    player.dispose();
  });

  it('cancels an older open when its source is replaced', async () => {
    let release!: () => void;
    fakeMedia.openGates.set(
      source,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const { player } = setup();
    const first = player.open(source).catch((error: unknown) => error);
    await Promise.resolve();
    await player.open(otherSource);
    release();

    await expect(first).resolves.toBeInstanceOf(MediaPlayerOperationCancelledError);
    expect(player.currentFrameIndex).toBe(0);
    player.dispose();
  });

  it('cancels an older seek and preserves the newer exact frame', async () => {
    const { player } = setup();
    await player.open(source);
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.1,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const first = player.seekToFrame(1).catch((error: unknown) => error);
    await Promise.resolve();
    await player.seekToFrame(2);
    release();

    await expect(first).resolves.toBeInstanceOf(MediaPlayerOperationCancelledError);
    expect(player.currentFrameIndex).toBe(2);
    player.dispose();
  });

  it('cancels an in-flight seek without stopping a newer rate restart', async () => {
    const { canvas, player } = setup();
    const errors: Error[] = [];
    player.on('error', ({ error }) => errors.push(error));
    await player.open(source);
    await player.play();
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.1,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const seeking = player.seekToFrame(1).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toContain(0.1));
    player.playbackRate = 2;
    await vi.waitFor(() => expect(player.paused).toBe(false));
    release();

    await expect(seeking).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'seek',
    });
    expect(player.paused).toBe(false);
    expect(player.playbackRate).toBe(2);
    expect(player.currentFrameIndex).toBe(0);
    expect(canvas.timestamp).toBe(0);
    expect(errors).toEqual([]);
    player.pause();
    player.dispose();
  });

  it('cancels an in-flight seek cleanly when pause wins the race', async () => {
    const { canvas, player } = setup();
    const errors: Error[] = [];
    player.on('error', ({ error }) => errors.push(error));
    await player.open(source);
    await player.play();
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.1,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const seeking = player.seekToFrame(1).catch((error: unknown) => error);
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toContain(0.1));
    player.pause();
    release();

    await expect(seeking).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'seek',
    });
    expect(player.paused).toBe(true);
    expect(player.currentFrameIndex).toBe(0);
    expect(canvas.timestamp).toBe(0);
    expect(animationCallbacks).toHaveLength(0);
    expect(errors).toEqual([]);
    player.dispose();
  });

  it('turns disposal during a seek into a typed disposal failure', async () => {
    const { player } = setup();
    await player.open(source);
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.1,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const seek = player.seekToFrame(1).catch((error: unknown) => error);
    await Promise.resolve();
    player.dispose();
    release();

    await expect(seek).resolves.toBeInstanceOf(MediaPlayerDisposedError);
    await expect(player.play()).rejects.toBeInstanceOf(MediaPlayerDisposedError);
  });

  it('uses the performance clock and skips late frames without rendering them', async () => {
    const { canvas, player } = setup();
    const frames: number[] = [];
    player.on('frame', ({ frameIndex }) => frames.push(frameIndex));
    await player.open(source);
    await player.play();
    expect(player.audioStatus).toMatchObject({
      clockSource: 'performance',
      contextState: 'not-created',
    });
    expect(animationCallbacks).toHaveLength(1);

    now = 250;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined)
      throw new Error('Expected a scheduled animation frame.');
    animationCallbacks.clear();
    callback(now);

    await vi.waitFor(() => expect(player.currentFrameIndex).toBe(2));
    expect(frames).toEqual([0, 2]);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    expect(player.currentTime).toBeCloseTo(0.25);
    expect(player.getStats()).toMatchObject({
      renderLoopTicks: 1,
      uniqueVideoFramesRendered: 2,
      duplicateRedraws: 0,
      lateFramesSkipped: 1,
      videoQueueDepth: { current: 2, max: 2 },
    });
    player.pause();
    player.dispose();
  });

  it('re-samples the performance clock after a delayed decode', async () => {
    const { player } = setup();
    const frames: number[] = [];
    player.on('frame', ({ frameIndex }) => frames.push(frameIndex));
    await player.open(source);
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.2,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await player.play();

    now = 150;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toContain(0.2));
    now = 350;
    release();

    await vi.waitFor(() => expect(player.currentFrameIndex).toBe(3));
    expect(frames).toEqual([0, 3]);
    player.pause();
    player.dispose();
  });

  it('does not commit a stalled playback frame after pause', async () => {
    const { player } = setup();
    const events: string[] = [];
    player.on('frame', ({ frameIndex }) => events.push(`frame:${frameIndex}`));
    player.on('timeupdate', () => events.push('time'));
    player.on('pause', () => events.push('pause'));
    await player.open(source);
    let release!: () => void;
    fakeMedia.frameGates.set(
      0.2,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await player.play();

    now = 250;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);
    await vi.waitFor(() => expect(fakeMedia.frameRequests).toContain(0.2));
    player.pause();
    const eventsAtPause = [...events];
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(eventsAtPause);
    expect(events.at(-1)).toBe('pause');
    player.dispose();
  });

  it('stops after a failed in-flight seek and can restart cleanly', async () => {
    const { player } = setup();
    const pauseEvents: number[] = [];
    player.on('pause', ({ time }) => pauseEvents.push(time));
    await player.open(source);
    await player.play();
    fakeMedia.frameFailures.set(0.1, new Error('decode failed'));

    await expect(player.seekToFrame(1)).rejects.toThrow('decode failed');
    expect(player.paused).toBe(true);
    expect(pauseEvents).toHaveLength(1);
    expect(animationCallbacks).toHaveLength(0);

    fakeMedia.frameFailures.delete(0.1);
    await player.play();
    expect(player.paused).toBe(false);
    expect(animationCallbacks).toHaveLength(1);
    player.pause();
    player.dispose();
  });

  it('presents the final frame before ending after a delayed tick', async () => {
    const { player } = setup();
    const events: string[] = [];
    player.on('frame', ({ frameIndex }) => events.push(`frame:${frameIndex}`));
    player.on('ended', () => events.push('ended'));
    await player.open(source);
    await player.play();

    now = 500;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);

    await vi.waitFor(() => expect(player.paused).toBe(true));
    expect(player.currentFrameIndex).toBe(3);
    expect(events.at(-2)).toBe('frame:3');
    expect(events.at(-1)).toBe('ended');
    player.dispose();
  });

  it('catches up to the final frame when the clock reaches the end during rendering', async () => {
    const { player } = setup();
    const frames: number[] = [];
    player.on('frame', ({ frameIndex }) => frames.push(frameIndex));
    player.setCustomRender(({ ctx, frame, frameIndex }) => {
      ctx.drawImage(frame, 0, 0);
      if (frameIndex === 2) now = 500;
    });
    await player.open(source);
    await player.play();

    now = 250;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);

    await vi.waitFor(() => expect(player.paused).toBe(true));
    expect(player.currentFrameIndex).toBe(3);
    expect(frames.at(-1)).toBe(3);
    player.dispose();
  });

  it('commits a synchronous final-frame composition on a late final tick', async () => {
    const { canvas, player } = setup();
    const events: string[] = [];
    player.on('frame', ({ frameIndex }) => events.push(`frame:${frameIndex}`));
    player.on('ended', () => events.push('ended'));
    player.setCustomRender(({ canvas: composition, ctx, frame, frameIndex }) => {
      ctx.drawImage(frame, 0, 0);
      if (frameIndex === 3) (composition as unknown as MockCanvas).timestamp = 99;
    });
    await player.open(source);
    await player.play();

    now = 500;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);

    await vi.waitFor(() => expect(player.paused).toBe(true));
    expect(player.currentFrameIndex).toBe(3);
    expect(canvas.timestamp).toBe(99);
    expect(events).toEqual(['frame:0', 'frame:3', 'ended']);
    player.dispose();
  });

  it('commits an async final composition that settled before its deadline', async () => {
    const { canvas, player } = setup();
    const started = deferred();
    const finish = deferred();
    player.setCustomRender(({ canvas: composition, ctx, frame, frameIndex }) => {
      ctx.drawImage(frame, 0, 0);
      if (frameIndex !== 3) return;
      (composition as unknown as MockCanvas).timestamp = 98;
      started.resolve();
      return finish.promise;
    });
    await player.open(source);
    await player.play();

    now = 350;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);
    await started.promise;

    now = 390;
    finish.resolve();
    now = 500;
    await vi.waitFor(() => expect(player.paused).toBe(true));

    expect(player.currentFrameIndex).toBe(3);
    expect(canvas.timestamp).toBe(98);
    player.dispose();
  });

  it('uses an independent timer to end with a bare final frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { canvas, player } = setup();
    const started = deferred();
    let finalSignal: AbortSignal | undefined;
    const events: string[] = [];
    player.on('frame', ({ frameIndex }) => events.push(`frame:${frameIndex}`));
    player.on('ended', () => events.push('ended'));
    player.setCustomRender(({ ctx, frame, frameIndex, signal }) => {
      ctx.drawImage(frame, 0, 0);
      if (frameIndex !== 3) return;
      finalSignal = signal;
      started.resolve();
      return new Promise<void>(() => undefined);
    });
    await player.open(source);
    await player.play();

    now = 350;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);

    await started.promise;
    expect(animationCallbacks).toHaveLength(0);
    now = 400;
    await vi.runOnlyPendingTimersAsync();

    expect(finalSignal?.aborted).toBe(true);
    expect(player.paused).toBe(true);
    expect(player.currentFrameIndex).toBe(3);
    expect(canvas.timestamp).toBe(0.3);
    expect(events).toEqual(['frame:0', 'frame:3', 'ended']);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    player.dispose();
  });

  it('preserves an opening source when the custom renderer changes', async () => {
    const { canvas, player } = setup();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    player.setCustomRender(async ({ frameIndex }) => {
      if (frameIndex === 0) {
        markStarted();
        await gate;
      }
    });

    const opening = player.open(source);
    await started;
    player.setCustomRender(({ ctx, frame }) => {
      ctx.drawImage(frame, 0, 0);
    });
    release();
    await opening;

    expect(player.currentFrameIndex).toBe(0);
    expect(canvas.context.drawImage).toHaveBeenCalledOnce();
    player.dispose();
  });

  it('preserves the decode queue across pause and resume', async () => {
    const { player } = setup();
    const frames: number[] = [];
    player.on('frame', ({ frameIndex }) => frames.push(frameIndex));
    await player.open(source);
    await player.play();
    player.pause();
    expect(animationCallbacks).toHaveLength(0);

    await player.play();
    now = 150;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected a resumed animation frame.');
    animationCallbacks.clear();
    callback(now);

    await vi.waitFor(() => expect(player.currentFrameIndex).toBe(1));
    expect(frames).toEqual([0, 1]);
    player.pause();
    player.dispose();
  });

  it('never commits an asynchronous custom render after a newer seek', async () => {
    const { canvas, player } = setup();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    player.setCustomRender(async ({ ctx, frame, frameIndex }) => {
      if (frameIndex === 1) {
        markStarted();
        await gate;
      }
      ctx.drawImage(frame, 0, 0);
    });
    await player.open(source);

    const stale = player.seekToFrame(1).catch((error: unknown) => error);
    await started;
    await player.seekToFrame(2);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    release();

    await expect(stale).resolves.toBeInstanceOf(MediaPlayerOperationCancelledError);
    await Promise.resolve();
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    player.dispose();
  });

  it('supersedes a nonsettling playback render without another animation frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { canvas, player } = setup();
    const started = deferred();
    const frames: number[] = [];
    let stalledSignal: AbortSignal | undefined;
    player.on('frame', ({ frameIndex }) => frames.push(frameIndex));
    player.setCustomRender(({ ctx, frame, frameIndex, signal }) => {
      if (frameIndex === 1) {
        stalledSignal = signal;
        started.resolve();
        return new Promise<void>(() => undefined);
      }
      ctx.drawImage(frame, 0, 0);
    });
    await player.open(source);
    await player.play();

    now = 150;
    const presentation = animationCallbacks.values().next().value;
    if (presentation === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    presentation(now);
    await started.promise;
    expect(animationCallbacks).toHaveLength(0);

    now = 250;
    await vi.runOnlyPendingTimersAsync();

    expect(stalledSignal?.aborted).toBe(true);
    expect(player.currentFrameIndex).toBe(2);
    expect(frames).toEqual([0, 2]);
    expect(canvas.timestamp).toBe(0.2);
    expect(canvas.context.drawImage).toHaveBeenCalledTimes(2);
    player.pause();
    player.dispose();
  });

  it('keeps owned snapshots stable when the two-canvas decoder pool wraps', async () => {
    const { player } = setup();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let stalledFrame: MockCanvas | undefined;
    player.setCustomRender(async ({ ctx, frame, frameIndex }) => {
      if (frameIndex === 1) {
        stalledFrame = frame as unknown as MockCanvas;
        markStarted();
        await gate;
      }
      ctx.drawImage(frame, 0, 0);
    });
    await player.open(source);

    const stale = player.seekToFrame(1).catch((error: unknown) => error);
    await started;
    await player.seekToFrame(2);
    await player.seekToFrame(3);
    await player.forceRender();

    expect(stalledFrame?.timestamp).toBe(0.1);
    expect((player.getCurrentFrame() as unknown as MockCanvas).timestamp).toBe(0.3);
    release();
    await expect(stale).resolves.toBeInstanceOf(MediaPlayerOperationCancelledError);
    expect(stalledFrame?.timestamp).toBe(0.1);
    player.dispose();
  });

  it('keeps pause authoritative while play is seeking back from the end', async () => {
    const { player } = setup();
    await player.open(source);
    await player.play();
    now = 500;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(now);
    await vi.waitFor(() => expect(player.paused).toBe(true));

    let release!: () => void;
    fakeMedia.frameGates.set(
      0,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const requestCount = fakeMedia.frameRequests.length;
    const restarting = player.play().catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(fakeMedia.frameRequests.length).toBeGreaterThan(requestCount),
    );
    player.pause();
    release();

    await expect(restarting).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(player.paused).toBe(true);
    expect(animationCallbacks).toHaveLength(0);
    player.dispose();
  });

  it('reports the stopped source time when replacement pauses playback', async () => {
    const { player } = setup();
    const pauses: number[] = [];
    player.on('pause', ({ time }) => pauses.push(time));
    await player.open(source);
    await player.play();
    now = 175;

    await player.open(otherSource);

    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toBeCloseTo(0.175);
    player.dispose();
  });

  it('schedules audio from the exact media offset on the AudioContext clock', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    audioContext.currentTime = 10;
    const { player } = setup(audioContext);
    const statuses: string[] = [];
    player.on('audiostatuschange', (status) => {
      statuses.push(
        `${status.capability}:${status.clockSource}:${status.scheduledBufferCount}`,
      );
    });

    await player.open(source, 0.05);
    expect(player.audioMetadata).toEqual({
      capability: 'supported',
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
      firstTimestamp: 0,
      duration: 0.4,
    });
    await player.play();

    expect(audioContext.resume).toHaveBeenCalledOnce();
    expect(audioContext.sources[0]?.start).toHaveBeenCalledWith(10, 0.05, 0.05);
    expect(audioContext.sources[0]?.playbackRate.value).toBe(1);
    expect(player.audioStatus).toMatchObject({
      capability: 'supported',
      clockSource: 'audio-context',
      contextState: 'running',
    });
    expect(statuses).toContain('supported:audio-context:1');

    player.volume = 0.25;
    expect(audioContext.gain.gain.value).toBe(0.25);
    player.muted = true;
    expect(audioContext.gain.gain.value).toBe(0);
    player.muted = false;
    expect(audioContext.gain.gain.value).toBe(0.25);
    expect(() => {
      player.volume = 1.01;
    }).toThrow(RangeError);

    audioContext.currentTime = 10.05;
    expect(player.currentTime).toBeCloseTo(0.1);
    player.pause();
    player.dispose();
  });

  it('reports signed audio-clock error against the current frame window', async () => {
    expect(getPresentationWindowError(0.05, 0.1, 0.1)).toBeCloseTo(-0.05);
    expect(getPresentationWindowError(0.1, 0.1, 0.1)).toBe(0);
    expect(getPresentationWindowError(0.199, 0.1, 0.1)).toBe(0);
    expect(getPresentationWindowError(0.25, 0.1, 0.1)).toBeCloseTo(0.05);
    const recorder = new PlaybackStatsRecorder(4);
    recorder.recordAvPresentationError(-0.05);
    expect(recorder.snapshot().avPresentationError).toEqual({
      currentSeconds: -0.05,
      maxAbsoluteSeconds: 0.05,
    });

    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.seekToFrame(1);
    await player.play();

    audioContext.currentTime = 0.05;
    expect(player.getStats().avPresentationError).toEqual({
      currentSeconds: 0,
      maxAbsoluteSeconds: 0,
    });

    audioContext.currentTime = 0.25;
    expect(player.getStats().avPresentationError.currentSeconds).toBeCloseTo(0.15);
    expect(player.getStats().avPresentationError.maxAbsoluteSeconds).toBeCloseTo(0.15);

    player.resetStats();
    const resetError = player.getStats().avPresentationError;
    expect(resetError.currentSeconds).toBeCloseTo(0.15);
    expect(resetError.maxAbsoluteSeconds).toBeCloseTo(0.15);
    player.pause();
    expect(player.getStats().avPresentationError.currentSeconds).toBeNull();
    player.dispose();
  });

  it('defers a first audio buffer across a large gap until it enters lookahead', async () => {
    fakeMedia.datasets.set(source, {
      packets,
      audio: { buffers: [{ timestamp: 0.3, duration: 0.05 }] },
    });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();

    expect(fakeMedia.audioBufferRequests).toEqual([0.3]);
    expect(audioContext.sources).toHaveLength(0);

    audioContext.currentTime = 0.14;
    let callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(140);
    await vi.waitFor(() => expect(animationCallbacks.size).toBeGreaterThan(0));
    expect(audioContext.sources).toHaveLength(0);

    audioContext.currentTime = 0.15;
    callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(150);
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(1));
    const firstStart = audioContext.sources[0]!.start.mock.calls[0]!;
    expect(firstStart[0]).toBeCloseTo(0.3);
    expect(firstStart[1]).toBeCloseTo(0);
    expect(firstStart[2]).toBeCloseTo(0.05);
    player.pause();
    player.dispose();
  });

  it('preserves a later buffer across a large gap without scheduling past lookahead', async () => {
    fakeMedia.datasets.set(source, {
      packets,
      audio: {
        buffers: [
          { timestamp: 0, duration: 0.05 },
          { timestamp: 0.3, duration: 0.05 },
        ],
      },
    });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(fakeMedia.audioBufferRequests).toEqual([0, 0.3]));
    expect(audioContext.sources).toHaveLength(1);

    audioContext.currentTime = 0.149;
    let callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(149);
    await vi.waitFor(() => expect(animationCallbacks.size).toBeGreaterThan(0));
    expect(audioContext.sources).toHaveLength(1);

    audioContext.currentTime = 0.15;
    callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(150);
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const laterStart = audioContext.sources[1]!.start.mock.calls[0]!;
    expect(laterStart[0]).toBeCloseTo(0.3);
    expect(laterStart[1]).toBeCloseTo(0);
    expect(laterStart[2]).toBeCloseTo(0.05);
    player.pause();
    player.dispose();
  });

  it('preserves encoded audio gaps and overlaps with monotonic start times', async () => {
    fakeMedia.datasets.set(source, {
      packets,
      audio: {
        buffers: [
          { timestamp: 0, duration: 0.12, bufferDuration: 0.05 },
          { timestamp: 0.1, duration: 0.04 },
          { timestamp: 0.2, duration: 0.05 },
        ],
      },
    });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    audioContext.currentTime = 0.05;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(50);
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(3));

    const starts = audioContext.sources.map((node) => node.start.mock.calls[0]!);
    expect(starts.map(([when]) => when)).toEqual([0, 0.1, 0.2]);
    const durations = starts.map(([, , duration]) => duration);
    expect(durations[0]).toBeCloseTo(0.05);
    expect(durations[1]).toBeCloseTo(0.04);
    expect(durations[2]).toBeCloseTo(0.05);
    expect(starts[2]![0]! - starts[1]![0]!).toBeGreaterThan(starts[1]![2]!);
    expect(player.getStats()).toMatchObject({
      audioQueueDepth: { current: 3, max: 3 },
      audioUnderruns: { count: 0 },
      audioGaps: { count: 1 },
    });
    expect(player.getStats().audioGaps.totalSeconds).toBeCloseTo(0.06);
    player.pause();
    player.dispose();
  });

  it('records measurable audio underruns when scheduling catches up late', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(fakeMedia.audioBufferRequests).toEqual([0, 0.1]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    audioContext.currentTime = 0.25;
    for (const sourceNode of [...audioContext.sources]) sourceNode.onended?.();
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(250);
    await vi.waitFor(() => expect(audioContext.sources.length).toBeGreaterThan(2));

    expect(player.getStats().audioUnderruns).toMatchObject({ count: 1 });
    expect(player.getStats().audioUnderruns.totalSeconds).toBeCloseTo(0.05);
    expect(player.getStats().audioGaps.count).toBe(0);
    player.pause();
    player.dispose();
  });

  it('counts fully expired audio separately from scheduled underruns', async () => {
    fakeMedia.datasets.set(source, {
      packets,
      audio: {
        buffers: [
          { timestamp: 0, duration: 0.1 },
          { timestamp: 0.1, duration: 0.1 },
        ],
      },
    });
    const second = deferred();
    fakeMedia.audioBufferGates.set(0.1, second.promise);
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(fakeMedia.audioBufferRequests).toEqual([0, 0.1]));

    audioContext.currentTime = 0.25;
    second.resolve();
    await vi.waitFor(() => expect(player.getStats().droppedAudioBuffers.count).toBe(1));

    expect(audioContext.sources).toHaveLength(1);
    expect(player.getStats().audioUnderruns.count).toBe(0);
    expect(player.getStats().droppedAudioBuffers).toEqual({
      count: 1,
      totalSeconds: expect.closeTo(0.1),
      maxSeconds: expect.closeTo(0.1),
    });
    player.pause();
    player.dispose();
  });

  it('reanchors and reschedules audio when playbackRate changes', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const previousSources = audioContext.sources.length;

    audioContext.currentTime = 0.04;
    player.playbackRate = 2;
    await vi.waitFor(() =>
      expect(audioContext.sources.length).toBeGreaterThan(previousSources),
    );

    const restarted = audioContext.sources[previousSources]!;
    const restartedCall = restarted.start.mock.calls[0]!;
    expect(restartedCall[0]).toBeCloseTo(0.04);
    expect(restartedCall[1]).toBeCloseTo(0.04);
    expect(restartedCall[2]).toBeCloseTo(0.06);
    expect(restarted.playbackRate.value).toBe(2);
    audioContext.currentTime = 0.09;
    expect(player.currentTime).toBeCloseTo(0.14);
    expect(
      audioContext.sources
        .slice(0, previousSources)
        .every((node) => node.stop.mock.calls.length > 0),
    ).toBe(true);
    player.pause();
    player.dispose();
  });

  it('stops and returns audio work across pause and resumes at one target', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const previousSources = audioContext.sources.length;
    audioContext.currentTime = 0.04;

    player.pause();
    expect(player.currentTime).toBeCloseTo(0.04);
    expect(fakeMedia.audioIteratorReturns).toBeGreaterThan(0);
    expect(audioContext.sources.every((node) => node.stop.mock.calls.length > 0)).toBe(
      true,
    );

    audioContext.currentTime = 1;
    await player.play();
    const resumed = audioContext.sources[previousSources]!;
    const resumedCall = resumed.start.mock.calls[0]!;
    expect(resumedCall[0]).toBeCloseTo(1);
    expect(resumedCall[1]).toBeCloseTo(0.04);
    expect(resumedCall[2]).toBeCloseTo(0.06);
    player.pause();
    player.dispose();
  });

  it('restarts audio and video from the same seek target', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const previousSources = audioContext.sources.length;
    audioContext.currentTime = 2;

    await player.seek(0.15);

    expect(player.currentFrameIndex).toBe(1);
    expect(player.currentTime).toBeCloseTo(0.15);
    const sought = audioContext.sources[previousSources]!;
    const soughtCall = sought.start.mock.calls[0]!;
    expect(soughtCall[0]).toBeCloseTo(2);
    expect(soughtCall[1]).toBeCloseTo(0.05);
    expect(soughtCall[2]).toBeCloseTo(0.05);
    player.pause();
    player.dispose();
  });

  it('loops with a fresh bounded audio schedule at the loop target', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    player.loop = true;
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const previousSources = audioContext.sources.length;

    audioContext.currentTime = 0.41;
    const callback = animationCallbacks.values().next().value;
    if (callback === undefined) throw new Error('Expected an animation frame.');
    animationCallbacks.clear();
    callback(410);

    await vi.waitFor(() =>
      expect(audioContext.sources.length).toBeGreaterThan(previousSources),
    );
    expect(player.paused).toBe(false);
    expect(player.currentFrameIndex).toBe(0);
    expect(audioContext.sources[previousSources]?.start).toHaveBeenCalledWith(
      0.41,
      0,
      0.1,
    );
    player.pause();
    player.dispose();
  });

  it('stops queued audio and returns iterators on open and dispose', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    fakeMedia.datasets.set(otherSource, {
      packets,
      audio: { buffers: audioBuffers, codec: 'aac' },
    });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    const firstSourceNodes = [...audioContext.sources];
    const returnsBeforeOpen = fakeMedia.audioIteratorReturns;

    await player.open(otherSource);
    expect(firstSourceNodes.every((node) => node.stop.mock.calls.length > 0)).toBe(
      true,
    );
    expect(fakeMedia.audioIteratorReturns).toBeGreaterThan(returnsBeforeOpen);
    expect(player.paused).toBe(true);

    audioContext.currentTime = 1;
    await player.play();
    const replacementNodes = audioContext.sources.slice(firstSourceNodes.length);
    expect(replacementNodes.length).toBeGreaterThan(0);
    const returnsBeforeDispose = fakeMedia.audioIteratorReturns;
    player.dispose();
    expect(replacementNodes.every((node) => node.stop.mock.calls.length > 0)).toBe(
      true,
    );
    expect(fakeMedia.audioIteratorReturns).toBeGreaterThan(returnsBeforeDispose);
    expect(audioContext.close).toHaveBeenCalledOnce();
  });

  it('generation-fences delayed audio while replacing the source', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    fakeMedia.datasets.set(otherSource, {
      packets,
      audio: { buffers: audioBuffers, codec: 'aac' },
    });
    let release!: () => void;
    fakeMedia.audioBufferGates.set(
      0,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(fakeMedia.audioBufferRequests).toContain(0));
    await player.open(otherSource);
    release();

    await expect(playing).resolves.toBeInstanceOf(MediaPlayerOperationCancelledError);
    expect(audioContext.sources).toHaveLength(0);
    expect(fakeMedia.audioIteratorReturns).toBeGreaterThan(0);
    expect(player.audioMetadata.codec).toBe('aac');
    audioContext.currentTime = 2;
    await player.play();
    expect(audioContext.sources[0]?.start).toHaveBeenCalledWith(2, 0, 0.1);
    player.pause();
    player.dispose();
  });

  it('closes an unpublished candidate when pause supersedes deferred resume', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const resume = deferred();
    const candidate = new FakeAudioContext({ resumeGate: resume.promise });
    const { player } = setup(candidate);
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    expect(player.audioStatus.contextState).toBe('not-created');
    player.pause();
    resume.resolve();

    await expect(playing).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    expect(candidate.sources).toHaveLength(0);
    expect(fakeMedia.audioBufferRequests).toEqual([]);
    expect(player.audioStatus).toMatchObject({
      contextState: 'not-created',
      scheduledBufferCount: 0,
    });
    expect(player.paused).toBe(true);
    player.dispose();
  });

  it('closes an unpublished candidate when source replacement wins deferred resume', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    fakeMedia.datasets.set(otherSource, {
      packets,
      audio: { buffers: audioBuffers, codec: 'aac' },
    });
    const resume = deferred();
    const candidate = new FakeAudioContext({ resumeGate: resume.promise });
    const winner = new FakeAudioContext();
    winner.currentTime = 2;
    const contexts = [candidate, winner];
    const factory = vi.fn(() => contexts.shift()! as unknown as AudioContext);
    const { player } = setup(undefined, factory);
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    await player.open(otherSource);
    expect(player.audioMetadata.codec).toBe('aac');
    expect(player.audioStatus.contextState).toBe('not-created');
    resume.resolve();

    await expect(playing).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    await player.play();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(candidate.sources).toHaveLength(0);
    expect(winner.sources.length).toBeGreaterThan(0);
    expect(winner.close).not.toHaveBeenCalled();
    expect(player.audioStatus).toMatchObject({
      capability: 'supported',
      clockSource: 'audio-context',
      contextState: 'running',
    });
    player.pause();
    player.dispose();
    expect(winner.close).toHaveBeenCalledOnce();
  });

  it('closes an unpublished candidate when dispose wins deferred resume', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const resume = deferred();
    const candidate = new FakeAudioContext({ resumeGate: resume.promise });
    const { player } = setup(candidate);
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    player.dispose();
    resume.resolve();

    await expect(playing).resolves.toBeInstanceOf(MediaPlayerDisposedError);
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    expect(candidate.sources).toHaveLength(0);
    expect(fakeMedia.audioBufferRequests).toEqual([]);
    expect(player.audioStatus.contextState).toBe('not-created');
  });

  it('lets one concurrent play own Web Audio and closes the stale candidate', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const firstResume = deferred();
    const secondResume = deferred();
    const stale = new FakeAudioContext({ resumeGate: firstResume.promise });
    const winner = new FakeAudioContext({ resumeGate: secondResume.promise });
    winner.currentTime = 3;
    const contexts = [stale, winner];
    const factory = vi.fn(() => contexts.shift()! as unknown as AudioContext);
    const { player } = setup(undefined, factory);
    await player.open(source);

    const first = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(stale.resume).toHaveBeenCalledOnce());
    const second = player.play();
    await vi.waitFor(() => expect(winner.resume).toHaveBeenCalledOnce());
    expect(player.audioStatus.contextState).toBe('not-created');

    secondResume.resolve();
    await second;
    expect(winner.sources.length).toBeGreaterThan(0);
    expect(winner.close).not.toHaveBeenCalled();
    firstResume.resolve();

    await expect(first).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.gain.disconnect).toHaveBeenCalledOnce();
    expect(stale.sources).toHaveLength(0);
    expect(winner.close).not.toHaveBeenCalled();
    expect(player.audioStatus).toMatchObject({
      clockSource: 'audio-context',
      contextState: 'running',
      capability: 'supported',
    });
    expect(player.paused).toBe(false);
    player.pause();
    player.dispose();
    expect(winner.close).toHaveBeenCalledOnce();
  });

  it('does not create or resume Web Audio for video without audio', async () => {
    const audioContext = new FakeAudioContext({ resume: new Error('blocked') });
    const { player } = setup(audioContext);
    await player.open(source);
    await player.play();

    expect(audioContext.resume).not.toHaveBeenCalled();
    expect(audioContext.sources).toHaveLength(0);
    expect(player.audioStatus).toMatchObject({
      capability: 'none',
      clockSource: 'performance',
      contextState: 'not-created',
    });
    now = 100;
    expect(player.currentTime).toBeCloseTo(0.1);
    player.pause();
    player.dispose();
  });

  it('times out blocked AudioContext resume and starts silent playback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const blocked = deferred();
    const audioContext = new FakeAudioContext({ resumeGate: blocked.promise });
    const { player } = setup(audioContext, undefined, {
      audioContextResumeTimeoutMilliseconds: 25,
    });
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    const playing = player.play();
    await vi.waitFor(() => expect(audioContext.resume).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(25);
    await playing;

    expect(player.paused).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeInstanceOf(MediaPlayerAudioResumeTimeoutError);
    expect(warnings[0]).toMatchObject({
      code: 'audio_resume_timeout',
      timeoutMilliseconds: 25,
    });
    expect(player.audioStatus).toMatchObject({
      capability: 'unavailable',
      clockSource: 'performance',
      contextState: 'unavailable',
    });
    now = 100;
    expect(player.currentTime).toBeCloseTo(0.1);
    player.pause();
    player.dispose();
    blocked.resolve();
  });

  it('turns a timeout that loses to pause into typed cancellation only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const blocked = deferred();
    const candidate = new FakeAudioContext({ resumeGate: blocked.promise });
    const { player } = setup(candidate, undefined, {
      audioContextResumeTimeoutMilliseconds: 25,
    });
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    player.pause();
    await vi.advanceTimersByTimeAsync(25);

    await expect(playing).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    expect(player.audioStatus.contextState).toBe('not-created');
    expect(player.audioStatus.capability).toBe('supported');
    expect(warnings).toEqual([]);
    player.dispose();
    blocked.resolve();
  });

  it('turns a timeout that loses to source replacement into typed cancellation only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    fakeMedia.datasets.set(otherSource, {
      packets,
      audio: { buffers: audioBuffers, codec: 'aac' },
    });
    const blocked = deferred();
    const candidate = new FakeAudioContext({ resumeGate: blocked.promise });
    const { player } = setup(candidate, undefined, {
      audioContextResumeTimeoutMilliseconds: 25,
    });
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    await player.open(otherSource);
    await vi.advanceTimersByTimeAsync(25);

    await expect(playing).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    expect(player.audioMetadata.codec).toBe('aac');
    expect(player.audioStatus.contextState).toBe('not-created');
    expect(player.audioStatus.capability).toBe('supported');
    expect(warnings).toEqual([]);
    player.dispose();
    blocked.resolve();
  });

  it('turns a timeout that loses to disposal into typed disposal only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const blocked = deferred();
    const candidate = new FakeAudioContext({ resumeGate: blocked.promise });
    const { player } = setup(candidate, undefined, {
      audioContextResumeTimeoutMilliseconds: 25,
    });
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    const playing = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(candidate.resume).toHaveBeenCalledOnce());
    player.dispose();
    await vi.advanceTimersByTimeAsync(25);

    await expect(playing).resolves.toBeInstanceOf(MediaPlayerDisposedError);
    expect(candidate.close).toHaveBeenCalledOnce();
    expect(candidate.gain.disconnect).toHaveBeenCalledOnce();
    expect(player.audioStatus.contextState).toBe('not-created');
    expect(warnings).toEqual([]);
    blocked.resolve();
  });

  it('does not let a stale timeout disturb a concurrent winning play', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const blocked = deferred();
    const stale = new FakeAudioContext({ resumeGate: blocked.promise });
    const winner = new FakeAudioContext();
    const contexts = [stale, winner];
    const factory = vi.fn(() => contexts.shift()! as unknown as AudioContext);
    const { player } = setup(undefined, factory, {
      audioContextResumeTimeoutMilliseconds: 25,
    });
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    const first = player.play().catch((error: unknown) => error);
    await vi.waitFor(() => expect(stale.resume).toHaveBeenCalledOnce());
    await player.play();
    expect(player.audioStatus).toMatchObject({
      capability: 'supported',
      clockSource: 'audio-context',
      contextState: 'running',
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(first).resolves.toMatchObject({
      code: 'operation_cancelled',
      operation: 'play',
    });
    expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.gain.disconnect).toHaveBeenCalledOnce();
    expect(winner.close).not.toHaveBeenCalled();
    expect(player.audioStatus).toMatchObject({
      capability: 'supported',
      clockSource: 'audio-context',
      contextState: 'running',
    });
    expect(warnings).toEqual([]);
    player.pause();
    player.dispose();
    blocked.resolve();
  });

  it('falls back to silent performance-clock video when AudioContext resume fails', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext({ resume: new Error('blocked') });
    const { player } = setup(audioContext);
    const warnings: Error[] = [];
    const errors: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    player.on('error', ({ error }) => errors.push(error));
    await player.open(source);

    await player.play();

    expect(player.paused).toBe(false);
    expect(player.audioStatus).toMatchObject({
      capability: 'unavailable',
      clockSource: 'performance',
      contextState: 'unavailable',
      scheduledBufferCount: 0,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'audio_playback_error' });
    expect(errors).toEqual([]);
    expect(fakeMedia.audioBufferRequests).toEqual([]);
    expect(audioContext.sources).toHaveLength(0);
    expect(audioContext.close).toHaveBeenCalledOnce();
    now = 100;
    expect(player.currentTime).toBeCloseTo(0.1);
    player.pause();
    player.dispose();
  });

  it('rolls back a failed gain stage and retries atomically on the next play', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const failedContext = new FakeAudioContext({ gain: new Error('gain failed') });
    const recoveredContext = new FakeAudioContext();
    const contexts = [failedContext, recoveredContext];
    const factory = vi.fn(() => contexts.shift()! as unknown as AudioContext);
    const { player } = setup(undefined, factory);
    const warnings: Error[] = [];
    player.on('audiowarning', ({ warning }) => warnings.push(warning));
    await player.open(source);

    await player.play();
    expect(player.audioStatus).toMatchObject({
      capability: 'unavailable',
      clockSource: 'performance',
      contextState: 'unavailable',
    });
    expect(fakeMedia.audioBufferRequests).toEqual([]);
    expect(failedContext.close).toHaveBeenCalledOnce();
    expect(failedContext.gain.connect).not.toHaveBeenCalled();
    player.pause();

    recoveredContext.currentTime = 1;
    await player.play();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(recoveredContext.sources.length).toBeGreaterThan(0);
    expect(player.audioStatus).toMatchObject({
      capability: 'supported',
      clockSource: 'audio-context',
      contextState: 'running',
    });
    expect(warnings).toHaveLength(1);
    player.pause();
    player.dispose();
  });

  it('emits audio status when a scheduled node completes naturally', async () => {
    fakeMedia.datasets.set(source, { packets, audio: { buffers: audioBuffers } });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    const scheduledCounts: number[] = [];
    player.on('audiostatuschange', ({ scheduledBufferCount }) => {
      scheduledCounts.push(scheduledBufferCount);
    });
    await player.open(source);
    await player.play();
    await vi.waitFor(() => expect(audioContext.sources).toHaveLength(2));
    scheduledCounts.length = 0;

    audioContext.sources[0]!.onended?.();

    expect(scheduledCounts[0]).toBe(1);
    player.pause();
    player.dispose();
  });

  it('degrades unsupported audio to explicit silent playback', async () => {
    fakeMedia.datasets.set(source, {
      packets,
      audio: { buffers: audioBuffers, canDecode: false, codec: 'aac' },
    });
    const audioContext = new FakeAudioContext();
    const { player } = setup(audioContext);
    const capabilities: string[] = [];
    const loaded = vi.fn();
    player.on('audiostatuschange', ({ capability }) => capabilities.push(capability));
    player.on('loadedmetadata', loaded);

    await player.open(source);
    expect(loaded).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.objectContaining({ capability: 'unsupported', codec: 'aac' }),
      }),
    );
    expect(capabilities).toContain('unsupported');
    await player.play();
    expect(audioContext.resume).not.toHaveBeenCalled();
    expect(audioContext.sources).toHaveLength(0);
    expect(player.paused).toBe(false);
    now = 120;
    expect(player.currentTime).toBeCloseTo(0.12);
    expect(player.audioStatus).toMatchObject({
      capability: 'unsupported',
      clockSource: 'performance',
      contextState: 'not-created',
      scheduledBufferCount: 0,
    });
    player.pause();
    player.dispose();
  });

  it('emits control events with event-driven listener removal', async () => {
    const { player } = setup();
    const events: string[] = [];
    const removeTimeListener = player.on('timeupdate', () => events.push('time'));
    player.on('play', () => events.push('play'));
    player.on('pause', () => events.push('pause'));
    await player.open(source);
    await player.play();
    player.pause();
    removeTimeListener();
    await player.seekToFrame(1);

    expect(events).toEqual(['time', 'play', 'pause']);
    player.dispose();
  });
});
