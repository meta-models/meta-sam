/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  EncodedPacketSink,
  Input,
  UrlSource,
  type InputAudioTrack,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';
import {
  FrameMetadataUnavailableError,
  MediaPlayerDisposedError,
  MediaPlayerAudioError,
  MediaPlayerAudioResumeTimeoutError,
  MediaPlayerError,
  MediaPlayerOperationCancelledError,
  MediaPlayerSourceError,
} from './media-errors.js';
import {
  createVideoPacketTimeline,
  getFrameIndexAtTimeExact,
  getPacketAtTimeExact,
  getTimeAtFrameIndexExact,
  getTimelineEnd,
  type VideoPacketMetadata,
  type VideoPacketMetadataInput,
  type VideoPacketTimeline,
} from './packet-timeline.js';
import {
  getPresentationWindowError,
  PlaybackStatsRecorder,
  type PlaybackStats,
} from './playback-stats.js';

export type MediaCanvas = HTMLCanvasElement | OffscreenCanvas;
export type MediaCanvasContext =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type MediaResource = string | URL | Blob;

export type MediaPlayerAudioCapability =
  'unknown' | 'none' | 'supported' | 'unsupported' | 'unavailable';
export type MediaPlayerClockSource = 'not-created' | 'audio-context' | 'performance';
export type MediaPlayerAudioContextState =
  AudioContextState | 'not-created' | 'unavailable';

export interface MediaPlayerAudioMetadata {
  readonly capability: MediaPlayerAudioCapability;
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly numberOfChannels: number | null;
  readonly firstTimestamp: number | null;
  readonly duration: number | null;
}

export interface MediaPlayerAudioStatus {
  readonly capability: MediaPlayerAudioCapability;
  readonly clockSource: MediaPlayerClockSource;
  readonly contextState: MediaPlayerAudioContextState;
  readonly scheduledBufferCount: number;
  readonly volume: number;
  readonly muted: boolean;
}

export interface MediaPlayerOptions {
  /** Factory used lazily by play(). It may throw when Web Audio is unavailable. */
  readonly createAudioContext?: () => AudioContext;
  /** Maximum amount of Web Audio time kept scheduled ahead. */
  readonly audioLookaheadSeconds?: number;
  /** Small delay used to prime decoded audio before the clock starts. */
  readonly audioSchedulingLeadSeconds?: number;
  /** Hard bound on scheduled AudioBufferSourceNode instances. */
  readonly maxScheduledAudioBuffers?: number;
  /** Maximum wait for AudioContext.resume() before silent playback fallback. */
  readonly audioContextResumeTimeoutMilliseconds?: number;
  /** Number of recent decode and overlay timings retained for percentile summaries. */
  readonly statsSampleWindowSize?: number;
}

export type MediaPlayerEventType =
  | 'play'
  | 'pause'
  | 'ended'
  | 'timeupdate'
  | 'durationchange'
  | 'loadedmetadata'
  | 'audiostatuschange'
  | 'audiowarning'
  | 'frame'
  | 'error'
  | 'dispose';

export interface MediaPlayerEventMap {
  readonly play: { readonly time: number };
  readonly pause: { readonly time: number };
  readonly ended: { readonly time: number };
  readonly timeupdate: { readonly time: number };
  readonly durationchange: { readonly duration: number };
  readonly loadedmetadata: {
    readonly duration: number;
    readonly width: number;
    readonly height: number;
    readonly numFrames: number;
    readonly fps: number;
    readonly videoPackets: VideoPacketTimeline;
    readonly audio: MediaPlayerAudioMetadata;
  };
  readonly audiostatuschange: MediaPlayerAudioStatus;
  readonly audiowarning: { readonly warning: MediaPlayerAudioError };
  readonly frame: { readonly time: number; readonly frameIndex: number };
  readonly error: { readonly error: Error };
  readonly dispose: Record<string, never>;
}

export type MediaPlayerEventCallback<T extends MediaPlayerEventType> = (
  event: MediaPlayerEventMap[T],
) => void;

export interface MediaPlayerRenderContext {
  /** Timestamp supplied by the playback scheduler, when rendering during playback. */
  readonly animationTimestamp?: DOMHighResTimeStamp;
  /** Decoded source frame. */
  readonly frame: MediaCanvas;
  readonly frameIndex: number;
  readonly timestamp: number;
  readonly duration: number;
  /** Isolated composition canvas. It is committed only if this render remains current. */
  readonly canvas: MediaCanvas;
  readonly ctx: MediaCanvasContext;
  /**
   * Isolated bare-frame fallback. The player commits it when asynchronous composition
   * misses the final packet deadline.
   */
  readonly fallbackCanvas: MediaCanvas;
  readonly fallbackCtx: MediaCanvasContext;
  readonly signal: AbortSignal;
}

export type CustomRenderFunction = (
  context: MediaPlayerRenderContext,
) => void | Promise<void>;

export interface IMediaPlayer {
  on<T extends MediaPlayerEventType>(
    event: T,
    callback: MediaPlayerEventCallback<T>,
  ): () => void;
  off<T extends MediaPlayerEventType>(
    event: T,
    callback: MediaPlayerEventCallback<T>,
  ): void;
  removeAllListeners(event?: MediaPlayerEventType): void;

  open(resource: MediaResource, startTimeInSeconds?: number): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  seekToFrame(frameIndex: number): Promise<void>;
  nextFrame(): Promise<void>;
  previousFrame(): Promise<void>;
  forceRender(): Promise<void>;
  setCustomRender(render: CustomRenderFunction | null): void;
  dispose(): void;

  getFrameIndexAtTimeExact(seconds: number): number;
  getTimeAtFrameIndexExact(frameIndex: number): number;
  getVideoPackets(): VideoPacketTimeline;
  getCurrentFrame(): MediaCanvas | null;
  getStats(): PlaybackStats;
  resetStats(): void;

  currentTime: number;
  readonly currentFrameIndex: number;
  readonly duration: number;
  readonly paused: boolean;
  loop: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  readonly audioMetadata: MediaPlayerAudioMetadata;
  readonly audioStatus: MediaPlayerAudioStatus;
  readonly videoFps: number;
}

interface ClockSource {
  readonly kind: Exclude<MediaPlayerClockSource, 'not-created'>;
  now(): number;
}

interface PlaybackClock {
  readonly running: boolean;
  readonly sourceKind: Exclude<MediaPlayerClockSource, 'not-created'>;
  currentTime(): number;
  play(mediaTime: number, playbackRate: number, clockStartTime?: number): void;
  pause(): number;
  seek(mediaTime: number): void;
  setPlaybackRate(playbackRate: number): void;
  useSource(source: ClockSource): void;
}

class AnchoredPlaybackClock implements PlaybackClock {
  #running = false;
  #anchorMediaTime = 0;
  #anchorClockTime = 0;
  #playbackRate = 1;
  #source: ClockSource;

  public constructor(source: ClockSource) {
    this.#source = source;
    this.#anchorClockTime = source.now();
  }

  public get running(): boolean {
    return this.#running;
  }

  public get sourceKind(): Exclude<MediaPlayerClockSource, 'not-created'> {
    return this.#source.kind;
  }

  public currentTime(): number {
    if (!this.#running) return this.#anchorMediaTime;
    return (
      this.#anchorMediaTime +
      Math.max(0, this.#source.now() - this.#anchorClockTime) * this.#playbackRate
    );
  }

  public play(
    mediaTime: number,
    playbackRate: number,
    clockStartTime = this.#source.now(),
  ): void {
    this.#anchorMediaTime = mediaTime;
    this.#anchorClockTime = clockStartTime;
    this.#playbackRate = playbackRate;
    this.#running = true;
  }

  public pause(): number {
    const mediaTime = this.currentTime();
    this.#anchorMediaTime = mediaTime;
    this.#running = false;
    return mediaTime;
  }

  public seek(mediaTime: number): void {
    this.#anchorMediaTime = mediaTime;
    this.#anchorClockTime = this.#source.now();
  }

  public setPlaybackRate(playbackRate: number): void {
    const mediaTime = this.currentTime();
    this.#anchorMediaTime = mediaTime;
    this.#anchorClockTime = this.#source.now();
    this.#playbackRate = playbackRate;
  }

  public useSource(source: ClockSource): void {
    if (source === this.#source) return;
    const mediaTime = this.currentTime();
    this.#source = source;
    this.#anchorMediaTime = mediaTime;
    this.#anchorClockTime = source.now();
  }
}

interface DecodedFrame {
  readonly canvas: MediaCanvas;
  readonly metadata: VideoPacketMetadata;
}

interface ScheduledFrame {
  readonly kind: 'animation' | 'timeout';
  readonly handle: number | ReturnType<typeof setTimeout>;
}

interface ScheduledAudioNode {
  readonly source: AudioBufferSourceNode;
  readonly startTime: number;
  readonly endTime: number;
  readonly generation: number;
}

interface PreparedPlayback {
  readonly context: AudioContext | undefined;
  readonly audioGeneration: number;
  readonly firstBuffer: WrappedAudioBuffer | undefined;
  readonly warning: MediaPlayerAudioError | undefined;
}

interface AudioContextPreparation {
  readonly context: AudioContext | undefined;
  readonly warning: MediaPlayerAudioError | undefined;
}

type AudioScheduleResult = 'scheduled' | 'discarded' | 'deferred';

const cancelledRender = Symbol('cancelled-render');
const expiredRender = Symbol('expired-render');
const maximumQueueLength = 2;
const defaultAudioLookaheadSeconds = 0.25;
const defaultAudioSchedulingLeadSeconds = 0.02;
const defaultMaximumScheduledAudioBuffers = 16;
const defaultAudioContextResumeTimeoutMilliseconds = 1_000;
const defaultStatsSampleWindowSize = 256;
const maximumStatsSampleWindowSize = 4_096;
const audioDiscontinuityToleranceSeconds = 0.001;
const maximumTimerDelay = 2_147_483_647;
const unknownAudioMetadata: MediaPlayerAudioMetadata = Object.freeze({
  capability: 'unknown',
  codec: null,
  sampleRate: null,
  numberOfChannels: null,
  firstTimestamp: null,
  duration: null,
});

class RenderSupersededError extends Error {}
class PlaybackSupersededError extends Error {}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error('The media player failed with a non-Error value.', { cause: error });
}

function getContext(canvas: MediaCanvas): MediaCanvasContext {
  const context = canvas.getContext('2d');
  if (context === null || context === undefined) {
    throw new MediaPlayerSourceError('A Canvas 2D context is required.');
  }
  return context as MediaCanvasContext;
}

function createOwnedCanvas(
  target: MediaCanvas,
  width: number,
  height: number,
): MediaCanvas {
  let canvas: MediaCanvas;
  if ('ownerDocument' in target) {
    canvas = target.ownerDocument.createElement('canvas');
  } else {
    const Constructor = globalThis.OffscreenCanvas;
    if (Constructor === undefined) {
      throw new MediaPlayerSourceError(
        'OffscreenCanvas is required to create an isolated render surface.',
      );
    }
    canvas = new Constructor(width, height);
  }
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createCompositionCanvas(target: MediaCanvas): {
  readonly canvas: MediaCanvas;
  readonly context: MediaCanvasContext;
} {
  const canvas = createOwnedCanvas(target, target.width, target.height);
  return { canvas, context: getContext(canvas) };
}

function snapshotDecodedFrame(source: MediaCanvas, target: MediaCanvas): MediaCanvas {
  const canvas = createOwnedCanvas(target, source.width, source.height);
  const context = getContext(canvas);
  context.drawImage(source, 0, 0, source.width, source.height);
  return canvas;
}

function drawFrameToCanvas(
  context: MediaCanvasContext,
  canvas: MediaCanvas,
  frame: MediaCanvas,
): void {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(
    frame,
    0,
    0,
    frame.width,
    frame.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function requirePlaybackRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('playbackRate must be finite and greater than zero.');
  }
  return value;
}

function requireVolume(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('volume must be finite and between zero and one.');
  }
  return value;
}

function requirePositiveOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and greater than zero.`);
  }
  return value;
}

function requireNonnegativeOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and nonnegative.`);
  }
  return value;
}

function requirePositiveIntegerOption(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function requireAudioContextResumeTimeout(value: number): number {
  const timeout = requirePositiveOption(value, 'audioContextResumeTimeoutMilliseconds');
  if (timeout > maximumTimerDelay) {
    throw new RangeError(
      `audioContextResumeTimeoutMilliseconds must not exceed ${maximumTimerDelay}.`,
    );
  }
  return timeout;
}

function requireStatsSampleWindowSize(value: number): number {
  const size = requirePositiveIntegerOption(value, 'statsSampleWindowSize');
  if (size > maximumStatsSampleWindowSize) {
    throw new RangeError(
      `statsSampleWindowSize must not exceed ${maximumStatsSampleWindowSize}.`,
    );
  }
  return size;
}

async function resumeAudioContextWithTimeout(
  context: AudioContext,
  timeoutMilliseconds: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.resume(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new MediaPlayerAudioResumeTimeoutError(timeoutMilliseconds)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function createDefaultAudioContext(): AudioContext {
  const Constructor = globalThis.AudioContext;
  if (Constructor === undefined) {
    throw new Error('AudioContext is unavailable.');
  }
  return new Constructor();
}

async function inspectAudioTrack(
  track: InputAudioTrack | null,
): Promise<MediaPlayerAudioMetadata> {
  if (track === null) {
    return Object.freeze({
      capability: 'none',
      codec: null,
      sampleRate: null,
      numberOfChannels: null,
      firstTimestamp: null,
      duration: null,
    });
  }
  const [canDecode, codec, sampleRate, numberOfChannels, firstTimestamp, duration] =
    await Promise.all([
      track.canDecode(),
      track.getCodec(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
      track.getFirstTimestamp(),
      track.computeDuration(),
    ]);
  return Object.freeze({
    capability: canDecode ? 'supported' : 'unsupported',
    codec,
    sampleRate,
    numberOfChannels,
    firstTimestamp,
    duration,
  });
}

function createInput(resource: MediaResource): Input {
  const source =
    typeof resource === 'string' || resource instanceof URL
      ? new UrlSource(resource)
      : new BlobSource(resource);
  return new Input({ source, formats: ALL_FORMATS });
}

function averagePacketRate(timeline: VideoPacketTimeline): number {
  const first = timeline[0]!;
  const span = getTimelineEnd(timeline) - first.timestamp;
  return span > 0 ? timeline.length / span : 0;
}

export class MediaPlayer implements IMediaPlayer {
  readonly #canvas: MediaCanvas;
  readonly #context: MediaCanvasContext;
  readonly #clock: PlaybackClock;
  readonly #performanceClockSource: ClockSource;
  readonly #createAudioContext: () => AudioContext;
  readonly #audioLookaheadSeconds: number;
  readonly #audioSchedulingLeadSeconds: number;
  readonly #maxScheduledAudioBuffers: number;
  readonly #audioContextResumeTimeoutMilliseconds: number;
  readonly #stats: PlaybackStatsRecorder;
  readonly #listeners = new Map<
    MediaPlayerEventType,
    Set<MediaPlayerEventCallback<MediaPlayerEventType>>
  >();

  #input: Input | undefined;
  #canvasSink: CanvasSink | undefined;
  #audioSink: AudioBufferSink | undefined;
  #timeline: VideoPacketTimeline | undefined;
  #packetIndexByTimestamp = new Map<number, number>();
  #iterator: AsyncIterator<WrappedCanvas> | undefined;
  #audioIterator: AsyncIterator<WrappedAudioBuffer> | undefined;
  #pendingAudioBuffer: WrappedAudioBuffer | undefined;
  #queue: DecodedFrame[] = [];
  #currentFrame: DecodedFrame | undefined;
  #customRender: CustomRenderFunction | null = null;
  #renderController: AbortController | undefined;
  #scheduled: ScheduledFrame | undefined;
  #scheduledAudioNodes = new Map<AudioBufferSourceNode, ScheduledAudioNode>();
  #audioContext: AudioContext | undefined;
  #audioGain: GainNode | undefined;
  #audioContextUnavailable = false;
  #audioPumpGeneration: number | undefined;
  #lastAudioStartTime = Number.NEGATIVE_INFINITY;
  #previousEncodedAudioEndTime: number | undefined;
  #audioAnchorMediaTime = 0;
  #audioAnchorContextTime = 0;
  #audioMetadata = unknownAudioMetadata;
  #audioRuntimeCapability: MediaPlayerAudioCapability = 'unknown';
  #lastAudioStatusKey = '';
  #tickRunning = false;

  #sourceGeneration = 0;
  #seekGeneration = 0;
  #decodeGeneration = 0;
  #audioGeneration = 0;
  #renderGeneration = 0;
  #playbackGeneration = 0;
  #disposed = false;
  #loaded = false;
  #paused = true;
  #currentTime = 0;
  #duration = 0;
  #width = 0;
  #height = 0;
  #videoFps = 0;
  #loop = false;
  #playbackRate = 1;
  #volume = 1;
  #muted = false;
  #clockSourceStatus: MediaPlayerClockSource = 'not-created';

  public constructor(canvas: MediaCanvas, options: MediaPlayerOptions = {}) {
    this.#canvas = canvas;
    this.#context = getContext(canvas);
    this.#performanceClockSource = {
      kind: 'performance',
      now: () => performance.now() / 1_000,
    };
    this.#clock = new AnchoredPlaybackClock(this.#performanceClockSource);
    this.#createAudioContext = options.createAudioContext ?? createDefaultAudioContext;
    this.#audioLookaheadSeconds = requirePositiveOption(
      options.audioLookaheadSeconds ?? defaultAudioLookaheadSeconds,
      'audioLookaheadSeconds',
    );
    this.#audioSchedulingLeadSeconds = requireNonnegativeOption(
      options.audioSchedulingLeadSeconds ?? defaultAudioSchedulingLeadSeconds,
      'audioSchedulingLeadSeconds',
    );
    this.#maxScheduledAudioBuffers = requirePositiveIntegerOption(
      options.maxScheduledAudioBuffers ?? defaultMaximumScheduledAudioBuffers,
      'maxScheduledAudioBuffers',
    );
    this.#audioContextResumeTimeoutMilliseconds = requireAudioContextResumeTimeout(
      options.audioContextResumeTimeoutMilliseconds ??
        defaultAudioContextResumeTimeoutMilliseconds,
    );
    this.#stats = new PlaybackStatsRecorder(
      requireStatsSampleWindowSize(
        options.statsSampleWindowSize ?? defaultStatsSampleWindowSize,
      ),
    );
  }

  public on<T extends MediaPlayerEventType>(
    event: T,
    callback: MediaPlayerEventCallback<T>,
  ): () => void {
    this.#assertActive();
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(callback as MediaPlayerEventCallback<MediaPlayerEventType>);
    this.#listeners.set(event, listeners);
    return () => this.off(event, callback);
  }

  public off<T extends MediaPlayerEventType>(
    event: T,
    callback: MediaPlayerEventCallback<T>,
  ): void {
    this.#listeners
      .get(event)
      ?.delete(callback as MediaPlayerEventCallback<MediaPlayerEventType>);
  }

  public removeAllListeners(event?: MediaPlayerEventType): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  public async open(
    resource: MediaResource,
    startTimeInSeconds?: number,
  ): Promise<void> {
    this.#assertActive();
    const sourceGeneration = this.#beginSourceChange();
    let input: Input;
    try {
      input = createInput(resource);
    } catch (error) {
      const wrapped = new MediaPlayerSourceError('The media source is invalid.', {
        cause: error,
      });
      this.#emitError(wrapped);
      throw wrapped;
    }
    this.#input = input;

    try {
      if (!(await input.canRead())) {
        throw new MediaPlayerSourceError('Mediabunny cannot read the media source.');
      }
      this.#assertSourceGeneration(sourceGeneration, 'open');
      const [track, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      this.#assertSourceGeneration(sourceGeneration, 'open');
      if (track === null) {
        throw new FrameMetadataUnavailableError(
          'The media source does not contain a video track.',
        );
      }

      const [canDecode, width, height, audioMetadata] = await Promise.all([
        track.canDecode(),
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        inspectAudioTrack(audioTrack),
      ]);
      this.#assertSourceGeneration(sourceGeneration, 'open');
      if (!canDecode) {
        throw new MediaPlayerSourceError('The browser cannot decode the video track.');
      }
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      ) {
        throw new FrameMetadataUnavailableError(
          'The video track has invalid display dimensions.',
        );
      }

      const packetInputs: VideoPacketMetadataInput[] = [];
      const packetSink = new EncodedPacketSink(track);
      for await (const packet of packetSink.packets(undefined, undefined, {
        metadataOnly: true,
      })) {
        this.#assertSourceGeneration(sourceGeneration, 'open');
        packetInputs.push({
          timestamp: packet.timestamp,
          duration: packet.duration,
          sequenceNumber: packet.sequenceNumber,
          type: packet.type,
          byteLength: packet.byteLength,
        });
      }
      const timeline = createVideoPacketTimeline(packetInputs);
      this.#assertSourceGeneration(sourceGeneration, 'open');

      this.#canvasSink = new CanvasSink(track, { poolSize: maximumQueueLength });
      this.#audioSink =
        audioTrack !== null && audioMetadata.capability === 'supported'
          ? new AudioBufferSink(audioTrack)
          : undefined;
      this.#audioMetadata = audioMetadata;
      this.#audioRuntimeCapability = audioMetadata.capability;
      this.#timeline = timeline;
      this.#packetIndexByTimestamp = new Map(
        timeline.map((packet) => [packet.timestamp, packet.frameIndex]),
      );
      this.#duration = getTimelineEnd(timeline);
      this.#width = width;
      this.#height = height;
      this.#videoFps = averagePacketRate(timeline);

      const startTime = startTimeInSeconds ?? timeline[0]!.timestamp;
      await this.#seekInternal(startTime, sourceGeneration, 'open', false);
      this.#assertSourceGeneration(sourceGeneration, 'open');
      this.#loaded = true;
      this.#emit('durationchange', { duration: this.#duration });
      this.#emit('loadedmetadata', {
        duration: this.#duration,
        width,
        height,
        numFrames: timeline.length,
        fps: this.#videoFps,
        videoPackets: timeline,
        audio: this.#audioMetadata,
      });
      this.#emitAudioStatus();
      this.#emitCurrentFrame();
    } catch (error) {
      if (this.#disposed) throw new MediaPlayerDisposedError();
      if (sourceGeneration !== this.#sourceGeneration) {
        throw new MediaPlayerOperationCancelledError('open');
      }
      if (this.#input === input) {
        this.#cancelDecode();
        input.dispose();
        this.#input = undefined;
        this.#resetLoadedState();
      }
      const wrapped =
        error instanceof MediaPlayerError
          ? error
          : new MediaPlayerSourceError('Opening the media source failed.', {
              cause: error,
            });
      this.#emitError(wrapped);
      throw wrapped;
    }
  }

  public async play(): Promise<void> {
    this.#assertReady();
    if (!this.#paused) return;
    const playbackGeneration = ++this.#playbackGeneration;
    try {
      if (this.#currentTime >= this.#duration) {
        await this.seek(this.#timeline![0]!.timestamp);
      } else if (this.#queue.length === 0) {
        await this.seek(this.#currentTime);
      }
      this.#assertPlayRequest(playbackGeneration);
      const sourceGeneration = this.#sourceGeneration;
      const seekGeneration = this.#seekGeneration;
      const prepared = await this.#preparePlayback(
        this.#currentTime,
        sourceGeneration,
        seekGeneration,
        playbackGeneration,
        'play',
      );
      this.#assertPlayRequest(playbackGeneration);
      this.#startPreparedPlayback(prepared, this.#currentTime);
      this.#paused = false;
      this.#emit('play', { time: this.#currentTime });
      this.#launchAudioPump(prepared.audioGeneration);
      this.#schedule();
    } catch (error) {
      if (playbackGeneration === this.#playbackGeneration) {
        this.#cancelAudioPlayback();
      }
      if (
        !(error instanceof MediaPlayerOperationCancelledError) &&
        !(error instanceof MediaPlayerDisposedError)
      ) {
        const wrapped =
          error instanceof MediaPlayerError
            ? error
            : new MediaPlayerAudioError('Starting media playback failed.', {
                cause: error,
              });
        this.#emitError(wrapped);
        throw wrapped;
      }
      throw error;
    }
  }

  public pause(): void {
    this.#assertActive();
    this.#playbackGeneration += 1;
    this.#cancelAudioPlayback();
    if (this.#paused) return;
    this.#paused = true;
    this.#currentTime = Math.min(this.#clock.pause(), this.#duration);
    this.#cancelScheduled();
    this.#cancelRender();
    this.#emit('pause', { time: this.#currentTime });
    this.#emitAudioStatus();
  }

  public async seek(seconds: number): Promise<void> {
    this.#assertReady();
    const sourceGeneration = this.#sourceGeneration;
    const expectedSeekGeneration = this.#seekGeneration + 1;
    const wasPlaying = !this.#paused;
    try {
      await this.#seekInternal(seconds, sourceGeneration, 'seek', true);
    } catch (error) {
      const normalized =
        error instanceof PlaybackSupersededError ||
        error instanceof RenderSupersededError
          ? new MediaPlayerOperationCancelledError('seek')
          : error;
      if (
        !(normalized instanceof MediaPlayerOperationCancelledError) &&
        !(normalized instanceof MediaPlayerDisposedError)
      ) {
        if (
          wasPlaying &&
          !this.#paused &&
          sourceGeneration === this.#sourceGeneration &&
          expectedSeekGeneration === this.#seekGeneration
        ) {
          this.#stopAfterPlaybackFailure();
        }
        this.#emitError(asError(normalized));
      }
      throw normalized;
    }
  }

  public async seekToFrame(frameIndex: number): Promise<void> {
    this.#assertReady();
    await this.seek(this.getTimeAtFrameIndexExact(frameIndex));
  }

  public async nextFrame(): Promise<void> {
    this.#assertReady();
    const frameIndex = this.#requireCurrentFrameIndex() + 1;
    await this.seekToFrame(frameIndex);
  }

  public async previousFrame(): Promise<void> {
    this.#assertReady();
    const frameIndex = this.#requireCurrentFrameIndex() - 1;
    await this.seekToFrame(frameIndex);
  }

  public async forceRender(): Promise<void> {
    this.#assertReady();
    const frame = this.#currentFrame;
    if (frame === undefined) {
      throw new FrameMetadataUnavailableError('No decoded video frame is available.');
    }
    try {
      const committed = await this.#renderFrame(
        frame,
        undefined,
        this.#sourceGeneration,
        this.#seekGeneration,
        'seek',
      );
      if (committed) {
        this.#stats.recordFrameRendered(
          this.#sourceGeneration,
          frame.metadata.frameIndex,
        );
        this.#refreshStatsGauges();
      }
    } catch (error) {
      if (error instanceof RenderSupersededError) {
        throw new MediaPlayerOperationCancelledError('seek');
      }
      if (
        !(error instanceof MediaPlayerOperationCancelledError) &&
        !(error instanceof MediaPlayerDisposedError)
      ) {
        this.#emitError(asError(error));
      }
      throw error;
    }
  }

  public setCustomRender(render: CustomRenderFunction | null): void {
    this.#assertActive();
    this.#customRender = render;
    this.#cancelRender();
    if (this.#loaded && this.#currentFrame !== undefined) {
      void this.forceRender().catch(() => undefined);
    }
  }

  public getFrameIndexAtTimeExact(seconds: number): number {
    this.#assertReady();
    return getFrameIndexAtTimeExact(this.#timeline!, seconds);
  }

  public getTimeAtFrameIndexExact(frameIndex: number): number {
    this.#assertReady();
    return getTimeAtFrameIndexExact(this.#timeline!, frameIndex);
  }

  public getVideoPackets(): VideoPacketTimeline {
    this.#assertReady();
    return this.#timeline!;
  }

  public getCurrentFrame(): MediaCanvas | null {
    this.#assertActive();
    return this.#currentFrame?.canvas ?? null;
  }

  public getStats(): PlaybackStats {
    this.#assertActive();
    this.#refreshStatsGauges();
    return this.#stats.snapshot();
  }

  public resetStats(): void {
    this.#assertActive();
    const frame = this.#currentFrame;
    this.#stats.reset({
      videoQueueDepth: this.#queue.length,
      audioQueueDepth: this.#scheduledAudioNodes.size,
      currentAvPresentationErrorSeconds: this.#currentAvPresentationError(),
      sourceGeneration: frame === undefined ? null : this.#sourceGeneration,
      frameIndex: frame?.metadata.frameIndex ?? null,
    });
  }

  public get currentTime(): number {
    if (!this.#paused && this.#loaded) {
      return Math.min(this.#clock.currentTime(), this.#duration);
    }
    return this.#currentTime;
  }

  public set currentTime(value: number) {
    void this.seek(value).catch(() => undefined);
  }

  public get currentFrameIndex(): number {
    return this.#currentFrame?.metadata.frameIndex ?? -1;
  }

  public get duration(): number {
    return this.#duration;
  }

  public get paused(): boolean {
    return this.#paused;
  }

  public get loop(): boolean {
    return this.#loop;
  }

  public set loop(value: boolean) {
    this.#assertActive();
    this.#loop = value;
  }

  public get playbackRate(): number {
    return this.#playbackRate;
  }

  public set playbackRate(value: number) {
    this.#assertActive();
    const playbackRate = requirePlaybackRate(value);
    if (playbackRate === this.#playbackRate) return;
    const wasPlaying = !this.#paused;
    const mediaTime = wasPlaying
      ? Math.min(this.#clock.pause(), this.#duration)
      : this.#currentTime;
    this.#currentTime = mediaTime;
    this.#playbackRate = playbackRate;
    this.#clock.setPlaybackRate(playbackRate);
    if (!wasPlaying) return;

    const playbackGeneration = ++this.#playbackGeneration;
    this.#cancelScheduled();
    this.#cancelAudioPlayback();
    void this.#restartPlaybackAt(mediaTime, playbackGeneration).catch(
      (error: unknown) => {
        if (
          error instanceof MediaPlayerOperationCancelledError ||
          error instanceof MediaPlayerDisposedError ||
          error instanceof PlaybackSupersededError
        ) {
          return;
        }
        this.#stopAfterPlaybackFailure();
        this.#emitError(asError(error));
      },
    );
  }

  public get volume(): number {
    return this.#volume;
  }

  public set volume(value: number) {
    this.#assertActive();
    this.#volume = requireVolume(value);
    this.#applyGain();
    this.#emitAudioStatus();
  }

  public get muted(): boolean {
    return this.#muted;
  }

  public set muted(value: boolean) {
    this.#assertActive();
    this.#muted = value;
    this.#applyGain();
    this.#emitAudioStatus();
  }

  public get audioMetadata(): MediaPlayerAudioMetadata {
    return this.#audioMetadata;
  }

  public get audioStatus(): MediaPlayerAudioStatus {
    const contextState: MediaPlayerAudioContextState = this.#audioContextUnavailable
      ? 'unavailable'
      : (this.#audioContext?.state ?? 'not-created');
    return Object.freeze({
      capability: this.#audioRuntimeCapability,
      clockSource: this.#clockSourceStatus,
      contextState,
      scheduledBufferCount: this.#scheduledAudioNodes.size,
      volume: this.#volume,
      muted: this.#muted,
    });
  }

  public get videoFps(): number {
    return this.#videoFps;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sourceGeneration += 1;
    this.#seekGeneration += 1;
    this.#decodeGeneration += 1;
    this.#playbackGeneration += 1;
    this.#cancelScheduled();
    this.#cancelRender();
    this.#cancelAudioPlayback();
    this.#closeIterator();
    this.#iterator = undefined;
    this.#input?.dispose();
    this.#input = undefined;
    this.#queue = [];
    this.#currentFrame = undefined;
    this.#audioGain?.disconnect();
    this.#audioGain = undefined;
    const closingContext = this.#audioContext?.close();
    if (closingContext !== undefined) {
      void closingContext.catch(() => undefined);
    }
    this.#audioContext = undefined;
    this.#clearCanvas();
    this.#emit('dispose', {});
    this.#listeners.clear();
  }

  async #seekInternal(
    seconds: number,
    sourceGeneration: number,
    operation: 'open' | 'seek',
    emitEvents: boolean,
  ): Promise<void> {
    const timeline = this.#timeline;
    const sink = this.#canvasSink;
    if (timeline === undefined || sink === undefined) {
      throw new FrameMetadataUnavailableError();
    }
    const target = getPacketAtTimeExact(timeline, seconds);
    const resumePlayback = !this.#paused;
    const playbackGeneration = this.#playbackGeneration;
    const seekGeneration = ++this.#seekGeneration;
    this.#cancelScheduled();
    this.#cancelDecode();
    this.#cancelAudioPlayback();
    if (this.#clock.running) this.#clock.pause();
    this.#clock.seek(seconds);
    this.#currentTime = seconds;

    const decodeGeneration = this.#decodeGeneration;
    const iterator = sink.canvases(target.timestamp)[Symbol.asyncIterator]();
    this.#iterator = iterator;
    await this.#fillQueue(
      maximumQueueLength,
      sourceGeneration,
      seekGeneration,
      decodeGeneration,
      operation,
    );
    this.#assertOperation(sourceGeneration, seekGeneration, operation);
    const decoded = this.#queue[0];
    if (decoded === undefined || decoded.metadata.frameIndex !== target.frameIndex) {
      throw new FrameMetadataUnavailableError(
        `Mediabunny did not decode exact frame ${target.frameIndex}.`,
      );
    }
    if (resumePlayback) {
      this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
    }
    while (true) {
      try {
        await this.#renderFrame(
          decoded,
          undefined,
          sourceGeneration,
          seekGeneration,
          operation,
          undefined,
          resumePlayback ? playbackGeneration : undefined,
        );
        break;
      } catch (error) {
        if (!(error instanceof RenderSupersededError)) throw error;
        this.#assertOperation(sourceGeneration, seekGeneration, operation);
        if (resumePlayback) {
          this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
        }
      }
    }
    this.#assertOperation(sourceGeneration, seekGeneration, operation);
    if (resumePlayback) {
      this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
    }
    this.#currentFrame = decoded;
    this.#stats.recordFrameRendered(sourceGeneration, decoded.metadata.frameIndex);
    this.#refreshStatsGauges();
    if (resumePlayback) {
      this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
      const prepared = await this.#preparePlayback(
        seconds,
        sourceGeneration,
        seekGeneration,
        playbackGeneration,
        operation,
      );
      this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
      this.#startPreparedPlayback(prepared, seconds);
      this.#launchAudioPump(prepared.audioGeneration);
      this.#schedule();
    }
    if (emitEvents) this.#emitCurrentFrame();
  }

  async #ensureAudioContext(
    sourceGeneration: number,
    seekGeneration: number,
    playbackGeneration: number,
    audioGeneration: number,
    operation: 'open' | 'play' | 'seek',
  ): Promise<AudioContextPreparation> {
    let context = this.#audioContext;
    let gain = this.#audioGain;
    const isCandidate = context === undefined;
    try {
      if (isCandidate) {
        context = this.#createAudioContext();
        gain = context.createGain();
        gain.gain.value = this.#muted ? 0 : this.#volume;
        gain.connect(context.destination);
      } else if (gain === undefined) {
        throw new MediaPlayerAudioError(
          'The Web Audio context is missing its gain stage.',
        );
      }
      if (context === undefined) {
        throw new MediaPlayerAudioError(
          'Web Audio context creation returned no context.',
        );
      }
      if (context.state !== 'running') {
        await resumeAudioContextWithTimeout(
          context,
          this.#audioContextResumeTimeoutMilliseconds,
        );
      }

      this.#assertPlaybackPreparation(
        sourceGeneration,
        seekGeneration,
        playbackGeneration,
        audioGeneration,
        operation,
      );
      if (isCandidate) {
        if (this.#audioContext !== undefined || this.#audioGain !== undefined) {
          throw new MediaPlayerOperationCancelledError(operation);
        }
        this.#audioContext = context;
        this.#audioGain = gain;
      }
      this.#audioContextUnavailable = false;
      return { context, warning: undefined };
    } catch (error) {
      let cancellation:
        MediaPlayerOperationCancelledError | MediaPlayerDisposedError | undefined;
      try {
        this.#assertPlaybackPreparation(
          sourceGeneration,
          seekGeneration,
          playbackGeneration,
          audioGeneration,
          operation,
        );
      } catch (generationError) {
        if (
          generationError instanceof MediaPlayerOperationCancelledError ||
          generationError instanceof MediaPlayerDisposedError
        ) {
          cancellation = generationError;
        } else {
          throw generationError;
        }
      }

      const originalSuperseded =
        error instanceof MediaPlayerOperationCancelledError ||
        error instanceof MediaPlayerDisposedError;
      const cleanCandidate = isCandidate;
      const cleanPublishedContext =
        !isCandidate && cancellation === undefined && !originalSuperseded;
      if (cleanCandidate || cleanPublishedContext) {
        try {
          gain?.disconnect();
        } catch {
          // Best-effort rollback for a partially connected gain stage.
        }
        if (cleanPublishedContext) {
          if (this.#audioContext === context) this.#audioContext = undefined;
          if (this.#audioGain === gain) this.#audioGain = undefined;
        }
        if (context !== undefined) {
          try {
            const closing = context.close();
            void closing.catch(() => undefined);
          } catch {
            // The original failure remains authoritative.
          }
        }
      }
      if (cancellation !== undefined) throw cancellation;
      if (originalSuperseded) throw error;

      this.#audioContextUnavailable = true;
      const warning =
        error instanceof MediaPlayerAudioError
          ? error
          : new MediaPlayerAudioError(
              context === undefined
                ? 'Creating the Web Audio context failed; playing silently.'
                : 'Initializing or resuming Web Audio failed; playing silently.',
              { cause: error },
            );
      return { context: undefined, warning };
    }
  }

  async #preparePlayback(
    mediaTime: number,
    sourceGeneration: number,
    seekGeneration: number,
    playbackGeneration: number,
    operation: 'open' | 'play' | 'seek',
  ): Promise<PreparedPlayback> {
    const audioGeneration = this.#cancelAudioPlayback();
    const sink = this.#audioSink;
    if (sink === undefined || this.#audioMetadata.capability !== 'supported') {
      this.#audioRuntimeCapability = this.#audioMetadata.capability;
      return {
        context: undefined,
        audioGeneration,
        firstBuffer: undefined,
        warning: undefined,
      };
    }

    const preparedContext = await this.#ensureAudioContext(
      sourceGeneration,
      seekGeneration,
      playbackGeneration,
      audioGeneration,
      operation,
    );
    this.#assertPlaybackPreparation(
      sourceGeneration,
      seekGeneration,
      playbackGeneration,
      audioGeneration,
      operation,
    );
    const context = preparedContext.context;
    if (context === undefined) {
      this.#audioRuntimeCapability = 'unavailable';
      return {
        context: undefined,
        audioGeneration,
        firstBuffer: undefined,
        warning: preparedContext.warning,
      };
    }
    this.#audioRuntimeCapability = 'supported';

    const iterator = sink.buffers(mediaTime, this.#duration)[Symbol.asyncIterator]();
    this.#audioIterator = iterator;
    let first: IteratorResult<WrappedAudioBuffer>;
    try {
      first = await iterator.next();
    } catch (error) {
      this.#assertPlaybackPreparation(
        sourceGeneration,
        seekGeneration,
        playbackGeneration,
        audioGeneration,
        operation,
      );
      throw new MediaPlayerAudioError('Decoding the first audio buffer failed.', {
        cause: error,
      });
    }
    this.#assertPlaybackPreparation(
      sourceGeneration,
      seekGeneration,
      playbackGeneration,
      audioGeneration,
      operation,
    );
    if (first.done) {
      this.#closeAudioIterator();
      return {
        context,
        audioGeneration,
        firstBuffer: undefined,
        warning: undefined,
      };
    }
    this.#recordDecodedAudioBuffer(first.value);
    return {
      context,
      audioGeneration,
      firstBuffer: first.value,
      warning: undefined,
    };
  }

  #startPreparedPlayback(prepared: PreparedPlayback, mediaTime: number): void {
    let clockStartTime: number;
    if (prepared.context === undefined) {
      this.#clock.useSource(this.#performanceClockSource);
      this.#clockSourceStatus = 'performance';
      this.#stats.recordAvPresentationError(null);
      clockStartTime = this.#performanceClockSource.now();
    } else {
      const context = prepared.context;
      this.#clock.useSource({
        kind: 'audio-context',
        now: () => context.currentTime,
      });
      this.#clockSourceStatus = 'audio-context';
      clockStartTime = context.currentTime + this.#audioSchedulingLeadSeconds;
      this.#audioAnchorContextTime = clockStartTime;
      this.#audioAnchorMediaTime = mediaTime;
    }
    this.#clock.play(mediaTime, this.#playbackRate, clockStartTime);
    this.#pendingAudioBuffer = prepared.firstBuffer;
    if (prepared.firstBuffer !== undefined) {
      this.#schedulePendingAudioBuffer(prepared.audioGeneration);
    }
    this.#emitAudioStatus();
    if (prepared.warning !== undefined) {
      this.#emit('audiowarning', { warning: prepared.warning });
    }
    this.#refreshStatsGauges();
  }

  async #restartPlaybackAt(
    mediaTime: number,
    playbackGeneration: number,
  ): Promise<void> {
    const sourceGeneration = this.#sourceGeneration;
    const seekGeneration = this.#seekGeneration;
    const prepared = await this.#preparePlayback(
      mediaTime,
      sourceGeneration,
      seekGeneration,
      playbackGeneration,
      'play',
    );
    this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
    this.#startPreparedPlayback(prepared, mediaTime);
    this.#launchAudioPump(prepared.audioGeneration);
    this.#schedule();
  }

  #recordDecodedAudioBuffer(buffer: WrappedAudioBuffer): void {
    if (
      !Number.isFinite(buffer.timestamp) ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration < 0
    ) {
      return;
    }
    const previousEnd = this.#previousEncodedAudioEndTime;
    if (previousEnd !== undefined) {
      const gapSeconds = buffer.timestamp - previousEnd;
      if (gapSeconds > audioDiscontinuityToleranceSeconds) {
        this.#stats.recordAudioGap(gapSeconds);
      }
    }
    this.#previousEncodedAudioEndTime = buffer.timestamp + buffer.duration;
  }

  #scheduleAudioBuffer(
    buffer: WrappedAudioBuffer,
    audioGeneration: number,
  ): AudioScheduleResult {
    const context = this.#audioContext;
    const gain = this.#audioGain;
    if (
      context === undefined ||
      gain === undefined ||
      audioGeneration !== this.#audioGeneration
    ) {
      return 'discarded';
    }
    if (
      !Number.isFinite(buffer.timestamp) ||
      !Number.isFinite(buffer.duration) ||
      buffer.duration < 0 ||
      !Number.isFinite(buffer.buffer.duration) ||
      buffer.buffer.duration < 0
    ) {
      throw new MediaPlayerAudioError('Decoded audio has invalid timing metadata.');
    }

    const packetEnd = Math.min(
      buffer.timestamp + buffer.duration,
      buffer.timestamp + buffer.buffer.duration,
      this.#duration,
    );
    const mediaStart = Math.max(buffer.timestamp, this.#audioAnchorMediaTime);
    const schedulableDuration = Math.max(0, packetEnd - mediaStart);
    if (schedulableDuration === 0) {
      this.#stats.recordDroppedAudioBuffer(Math.max(0, packetEnd - buffer.timestamp));
      return 'discarded';
    }

    const desiredStartTime =
      this.#audioAnchorContextTime +
      (mediaStart - this.#audioAnchorMediaTime) / this.#playbackRate;
    if (desiredStartTime > context.currentTime + this.#audioLookaheadSeconds) {
      return 'deferred';
    }
    const startTime = Math.max(
      desiredStartTime,
      context.currentTime,
      this.#lastAudioStartTime,
    );
    const underrunSeconds =
      Math.max(0, startTime - desiredStartTime) * this.#playbackRate;
    const scheduledMediaStart = mediaStart + underrunSeconds;
    if (packetEnd <= scheduledMediaStart) {
      this.#stats.recordDroppedAudioBuffer(schedulableDuration);
      return 'discarded';
    }
    if (underrunSeconds > audioDiscontinuityToleranceSeconds) {
      this.#stats.recordAudioUnderrun(underrunSeconds);
    }

    const offset = scheduledMediaStart - buffer.timestamp;
    const duration = packetEnd - scheduledMediaStart;
    const source = context.createBufferSource();
    source.buffer = buffer.buffer;
    source.playbackRate.value = this.#playbackRate;
    source.connect(gain);
    const scheduled: ScheduledAudioNode = {
      source,
      startTime,
      endTime: startTime + duration / this.#playbackRate,
      generation: audioGeneration,
    };
    source.onended = () => {
      source.disconnect();
      const current = this.#scheduledAudioNodes.get(source);
      if (current !== scheduled) return;
      this.#scheduledAudioNodes.delete(source);
      this.#stats.recordAudioQueueDepth(this.#scheduledAudioNodes.size);
      this.#emitAudioStatus();
      if (audioGeneration === this.#audioGeneration && !this.#paused) {
        this.#launchAudioPump(audioGeneration);
      }
    };
    try {
      source.start(startTime, offset, duration);
    } catch (error) {
      source.disconnect();
      throw new MediaPlayerAudioError('Scheduling a decoded audio buffer failed.', {
        cause: error,
      });
    }
    this.#scheduledAudioNodes.set(source, scheduled);
    this.#stats.recordAudioQueueDepth(this.#scheduledAudioNodes.size);
    this.#lastAudioStartTime = startTime;
    return 'scheduled';
  }

  #schedulePendingAudioBuffer(audioGeneration: number): boolean {
    const pending = this.#pendingAudioBuffer;
    if (pending === undefined) return true;
    const result = this.#scheduleAudioBuffer(pending, audioGeneration);
    if (result === 'deferred') return false;
    this.#pendingAudioBuffer = undefined;
    return true;
  }

  #launchAudioPump(audioGeneration: number): void {
    if (
      this.#audioPumpGeneration === audioGeneration ||
      (this.#audioIterator === undefined && this.#pendingAudioBuffer === undefined) ||
      this.#audioContext === undefined ||
      this.#paused
    ) {
      return;
    }
    this.#audioPumpGeneration = audioGeneration;
    void this.#pumpAudio(audioGeneration)
      .catch((error: unknown) => {
        if (
          error instanceof MediaPlayerOperationCancelledError ||
          error instanceof MediaPlayerDisposedError ||
          error instanceof PlaybackSupersededError
        ) {
          return;
        }
        const wrapped =
          error instanceof MediaPlayerError
            ? error
            : new MediaPlayerAudioError('Audio scheduling failed.', { cause: error });
        this.#stopAfterPlaybackFailure();
        this.#emitError(wrapped);
      })
      .finally(() => {
        if (this.#audioPumpGeneration === audioGeneration) {
          this.#audioPumpGeneration = undefined;
        }
        if (audioGeneration === this.#audioGeneration) {
          this.#emitAudioStatus();
        }
      });
  }

  async #pumpAudio(audioGeneration: number): Promise<void> {
    while (true) {
      this.#assertAudioPlayback(audioGeneration);
      const context = this.#audioContext!;
      if (!this.#schedulePendingAudioBuffer(audioGeneration)) return;

      const scheduledThrough = Math.max(
        context.currentTime,
        ...[...this.#scheduledAudioNodes.values()].map(({ endTime }) => endTime),
      );
      if (
        this.#scheduledAudioNodes.size >= this.#maxScheduledAudioBuffers ||
        (this.#scheduledAudioNodes.size > 0 &&
          scheduledThrough >= context.currentTime + this.#audioLookaheadSeconds)
      ) {
        return;
      }

      const iterator = this.#audioIterator;
      if (iterator === undefined) return;
      let next: IteratorResult<WrappedAudioBuffer>;
      try {
        next = await iterator.next();
      } catch (error) {
        this.#assertAudioPlayback(audioGeneration);
        throw new MediaPlayerAudioError('Decoding audio failed.', { cause: error });
      }
      this.#assertAudioPlayback(audioGeneration);
      if (next.done) {
        this.#closeAudioIterator();
        return;
      }
      this.#recordDecodedAudioBuffer(next.value);
      this.#pendingAudioBuffer = next.value;
    }
  }

  #cancelAudioPlayback(): number {
    const audioGeneration = ++this.#audioGeneration;
    this.#closeAudioIterator();
    for (const { source } of this.#scheduledAudioNodes.values()) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that has already ended cannot always be stopped again.
      }
      source.disconnect();
    }
    this.#scheduledAudioNodes.clear();
    this.#stats.recordAudioQueueDepth(0);
    this.#pendingAudioBuffer = undefined;
    this.#lastAudioStartTime = Number.NEGATIVE_INFINITY;
    this.#previousEncodedAudioEndTime = undefined;
    this.#emitAudioStatus();
    return audioGeneration;
  }

  #closeAudioIterator(): void {
    const iterator = this.#audioIterator;
    this.#audioIterator = undefined;
    const closing = iterator?.return?.();
    if (closing !== undefined) {
      void Promise.resolve(closing).catch(() => undefined);
    }
  }

  #applyGain(): void {
    if (this.#audioGain !== undefined) {
      this.#audioGain.gain.value = this.#muted ? 0 : this.#volume;
    }
  }

  #emitAudioStatus(): void {
    if (this.#disposed) return;
    const status = this.audioStatus;
    const key = JSON.stringify(status);
    if (key === this.#lastAudioStatusKey) return;
    this.#lastAudioStatusKey = key;
    this.#emit('audiostatuschange', status);
  }

  async #fillQueue(
    targetLength: number,
    sourceGeneration: number,
    seekGeneration: number,
    decodeGeneration: number,
    operation: 'open' | 'seek',
  ): Promise<void> {
    const iterator = this.#iterator;
    if (iterator === undefined) {
      throw new FrameMetadataUnavailableError('The video decoder is unavailable.');
    }
    while (this.#queue.length < targetLength) {
      let next: IteratorResult<WrappedCanvas>;
      const decodeStartedAt = performance.now();
      try {
        next = await iterator.next();
      } catch (error) {
        this.#assertOperation(sourceGeneration, seekGeneration, operation);
        throw error;
      }
      this.#assertOperation(sourceGeneration, seekGeneration, operation);
      if (decodeGeneration !== this.#decodeGeneration) {
        throw new MediaPlayerOperationCancelledError(operation);
      }
      if (next.done) break;
      this.#stats.recordDecode(performance.now() - decodeStartedAt);
      const frameIndex = this.#packetIndexByTimestamp.get(next.value.timestamp);
      if (frameIndex === undefined) {
        throw new FrameMetadataUnavailableError(
          `Decoded frame timestamp ${next.value.timestamp} has no exact packet metadata.`,
        );
      }
      const metadata = this.#timeline?.[frameIndex];
      if (metadata === undefined) {
        throw new FrameMetadataUnavailableError();
      }
      const ownedCanvas = snapshotDecodedFrame(next.value.canvas, this.#canvas);
      this.#queue.push({
        canvas: ownedCanvas,
        metadata,
      });
      this.#stats.recordVideoQueueDepth(this.#queue.length);
      if (this.#queue.length > maximumQueueLength) {
        throw new MediaPlayerSourceError('The decoded frame queue exceeded its bound.');
      }
    }
  }

  async #renderFrame(
    frame: DecodedFrame,
    animationTimestamp: DOMHighResTimeStamp | undefined,
    sourceGeneration: number,
    seekGeneration: number,
    operation: 'open' | 'seek',
    validUntil?: number,
    playbackGeneration?: number,
    fallbackOnExpiry = false,
  ): Promise<boolean> {
    const renderGeneration = ++this.#renderGeneration;
    this.#renderController?.abort();
    this.#renderController = undefined;

    const customRender = this.#customRender;
    if (customRender === null) {
      this.#assertOperation(sourceGeneration, seekGeneration, operation);
      if (playbackGeneration !== undefined) {
        this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
      }
      this.#drawFrame(frame.canvas);
      return true;
    }

    const controller = new AbortController();
    this.#renderController = controller;
    const composition = createCompositionCanvas(this.#canvas);
    const fallback = createCompositionCanvas(this.#canvas);
    drawFrameToCanvas(fallback.context, fallback.canvas, frame.canvas);
    let removeAbortListener: (() => void) | undefined;
    let renderDeadline: ReturnType<typeof setTimeout> | undefined;
    let renderDeadlineSettled = false;
    let overlayStartedAt: number | undefined;
    const cancelRenderDeadline = () => {
      renderDeadlineSettled = true;
      if (renderDeadline !== undefined) clearTimeout(renderDeadline);
      renderDeadline = undefined;
    };
    try {
      const aborted = new Promise<typeof cancelledRender>((resolve) => {
        const onAbort = () => resolve(cancelledRender);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () =>
          controller.signal.removeEventListener('abort', onAbort);
      });
      const expired =
        animationTimestamp === undefined || validUntil === undefined
          ? undefined
          : new Promise<typeof expiredRender>((resolve) => {
              const schedule = () => {
                if (renderDeadlineSettled || controller.signal.aborted) return;
                const remaining = validUntil - this.#clock.currentTime();
                const delay =
                  remaining <= 0
                    ? 0
                    : Math.min(
                        maximumTimerDelay,
                        Math.max(
                          1,
                          Math.ceil((remaining / this.#playbackRate) * 1_000),
                        ),
                      );
                renderDeadline = setTimeout(() => {
                  renderDeadline = undefined;
                  if (renderDeadlineSettled || controller.signal.aborted) return;
                  if (this.#clock.currentTime() >= validUntil) {
                    renderDeadlineSettled = true;
                    resolve(expiredRender);
                  } else {
                    schedule();
                  }
                }, delay);
              };
              schedule();
            });
      overlayStartedAt = performance.now();
      const rendered = Promise.resolve(
        customRender({
          ...(animationTimestamp === undefined ? {} : { animationTimestamp }),
          frame: frame.canvas,
          frameIndex: frame.metadata.frameIndex,
          timestamp: frame.metadata.timestamp,
          duration: frame.metadata.duration,
          canvas: composition.canvas,
          ctx: composition.context,
          fallbackCanvas: fallback.canvas,
          fallbackCtx: fallback.context,
          signal: controller.signal,
        }),
      );
      const outcome = await Promise.race(
        expired === undefined ? [rendered, aborted] : [rendered, aborted, expired],
      );
      if (outcome === expiredRender) {
        controller.abort();
        if (!fallbackOnExpiry) return false;
        this.#assertOperation(sourceGeneration, seekGeneration, operation);
        if (playbackGeneration !== undefined) {
          this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
        }
        this.#drawFrame(fallback.canvas);
        return true;
      }
      if (outcome === cancelledRender) {
        this.#assertOperation(sourceGeneration, seekGeneration, operation);
        if (playbackGeneration !== undefined) {
          this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
        }
        throw new RenderSupersededError();
      }
      this.#assertOperation(sourceGeneration, seekGeneration, operation);
      if (playbackGeneration !== undefined) {
        this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
      }
      if (renderGeneration !== this.#renderGeneration) {
        throw new RenderSupersededError();
      }
      this.#drawFrame(composition.canvas);
      return true;
    } finally {
      if (overlayStartedAt !== undefined) {
        this.#stats.recordOverlayRender(performance.now() - overlayStartedAt);
      }
      cancelRenderDeadline();
      removeAbortListener?.();
      if (this.#renderController === controller) this.#renderController = undefined;
    }
  }

  #drawFrame(frame: MediaCanvas): void {
    drawFrameToCanvas(this.#context, this.#canvas, frame);
  }

  #schedule(): void {
    if (
      this.#paused ||
      this.#disposed ||
      !this.#clock.running ||
      this.#scheduled !== undefined ||
      this.#tickRunning
    ) {
      return;
    }
    const sourceGeneration = this.#sourceGeneration;
    const seekGeneration = this.#seekGeneration;
    const playbackGeneration = this.#playbackGeneration;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const handle = globalThis.requestAnimationFrame((timestamp) => {
        this.#scheduled = undefined;
        void this.#tick(
          timestamp,
          sourceGeneration,
          seekGeneration,
          playbackGeneration,
        );
      });
      this.#scheduled = { kind: 'animation', handle };
      return;
    }
    const handle = setTimeout(() => {
      this.#scheduled = undefined;
      void this.#tick(
        performance.now(),
        sourceGeneration,
        seekGeneration,
        playbackGeneration,
      );
    }, 16);
    this.#scheduled = { kind: 'timeout', handle };
  }

  async #tick(
    animationTimestamp: DOMHighResTimeStamp,
    sourceGeneration: number,
    seekGeneration: number,
    playbackGeneration: number,
  ): Promise<void> {
    this.#tickRunning = true;
    this.#stats.recordRenderLoopTick();
    try {
      this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
      this.#launchAudioPump(this.#audioGeneration);
      const decodeGeneration = this.#decodeGeneration;
      let frameChanged = false;

      while (true) {
        await this.#fillQueue(
          maximumQueueLength,
          sourceGeneration,
          seekGeneration,
          decodeGeneration,
          'seek',
        );
        this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);

        const mediaTime = Math.min(this.#clock.currentTime(), this.#duration);
        const lastPacket = this.#timeline![this.#timeline!.length - 1]!;
        const presentationTime = Math.min(mediaTime, lastPacket.timestamp);
        const next = this.#queue[1];
        if (next !== undefined && next.metadata.timestamp <= presentationTime) {
          const skipped = this.#queue.shift();
          this.#stats.recordVideoQueueDepth(this.#queue.length);
          if (
            skipped !== undefined &&
            skipped.metadata.frameIndex !== this.currentFrameIndex
          ) {
            this.#stats.recordLateFrameSkipped();
          }
          frameChanged = true;
          continue;
        }

        const frame = this.#queue[0];
        if (
          frame !== undefined &&
          (frameChanged || frame.metadata.frameIndex !== this.currentFrameIndex)
        ) {
          const committed = await this.#renderFrame(
            frame,
            animationTimestamp,
            sourceGeneration,
            seekGeneration,
            'seek',
            next?.metadata.timestamp ?? this.#duration,
            playbackGeneration,
            next === undefined,
          );
          this.#assertPlayback(sourceGeneration, seekGeneration, playbackGeneration);
          if (!committed) {
            frameChanged = true;
            continue;
          }
          this.#currentFrame = frame;
          this.#stats.recordFrameRendered(sourceGeneration, frame.metadata.frameIndex);
          this.#refreshStatsGauges();
          this.#emit('frame', {
            time: frame.metadata.timestamp,
            frameIndex: frame.metadata.frameIndex,
          });
        }

        this.#currentTime = Math.min(this.#clock.currentTime(), this.#duration);
        this.#refreshStatsGauges();
        if (
          this.#currentTime >= this.#duration &&
          this.currentFrameIndex !== lastPacket.frameIndex &&
          this.#queue.some(
            ({ metadata }) => metadata.frameIndex === lastPacket.frameIndex,
          )
        ) {
          frameChanged = true;
          continue;
        }
        this.#emit('timeupdate', { time: this.#currentTime });
        if (this.#currentTime >= this.#duration) {
          if (this.#loop) {
            await this.#seekInternal(
              this.#timeline![0]!.timestamp,
              sourceGeneration,
              'seek',
              true,
            );
            return;
          }
          this.#clock.pause();
          this.#paused = true;
          this.#playbackGeneration += 1;
          this.#cancelAudioPlayback();
          this.#emit('ended', { time: this.#currentTime });
        }
        return;
      }
    } catch (error) {
      if (
        error instanceof MediaPlayerOperationCancelledError ||
        error instanceof MediaPlayerDisposedError ||
        error instanceof PlaybackSupersededError ||
        error instanceof RenderSupersededError
      ) {
        return;
      }
      this.#stopAfterPlaybackFailure();
      this.#emitError(asError(error));
    } finally {
      this.#tickRunning = false;
      if (!this.#disposed && !this.#paused) this.#schedule();
    }
  }

  #beginSourceChange(): number {
    const wasPlaying = !this.#paused;
    const pauseTime = this.#clock.running
      ? Math.min(this.#clock.pause(), this.#duration)
      : this.#currentTime;
    this.#currentTime = pauseTime;
    this.#paused = true;
    this.#playbackGeneration += 1;
    this.#sourceGeneration += 1;
    this.#seekGeneration += 1;
    this.#cancelScheduled();
    this.#cancelDecode();
    this.#cancelAudioPlayback();
    this.#input?.dispose();
    this.#input = undefined;
    this.#resetLoadedState();
    this.#clearCanvas();
    if (wasPlaying) this.#emit('pause', { time: pauseTime });
    return this.#sourceGeneration;
  }

  #cancelDecode(): void {
    this.#decodeGeneration += 1;
    this.#closeIterator();
    this.#iterator = undefined;
    this.#queue = [];
    this.#stats.recordVideoQueueDepth(0);
    this.#cancelRender();
  }

  #closeIterator(): void {
    const closing = this.#iterator?.return?.();
    if (closing !== undefined) {
      void Promise.resolve(closing).catch(() => undefined);
    }
  }

  #cancelRender(): void {
    this.#renderGeneration += 1;
    this.#renderController?.abort();
    this.#renderController = undefined;
  }

  #cancelScheduled(): void {
    const scheduled = this.#scheduled;
    if (scheduled === undefined) return;
    if (scheduled.kind === 'animation') {
      globalThis.cancelAnimationFrame?.(scheduled.handle as number);
    } else {
      clearTimeout(scheduled.handle as ReturnType<typeof setTimeout>);
    }
    this.#scheduled = undefined;
  }

  #stopAfterPlaybackFailure(): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#playbackGeneration += 1;
    this.#currentTime = Math.min(this.#clock.pause(), this.#duration);
    this.#cancelScheduled();
    this.#cancelDecode();
    this.#cancelAudioPlayback();
    this.#emit('pause', { time: this.#currentTime });
  }

  #assertPlayRequest(playbackGeneration: number): void {
    this.#assertActive();
    if (!this.#paused || playbackGeneration !== this.#playbackGeneration) {
      throw new MediaPlayerOperationCancelledError('play');
    }
  }

  #assertPlayback(
    sourceGeneration: number,
    seekGeneration: number,
    playbackGeneration: number,
  ): void {
    this.#assertOperation(sourceGeneration, seekGeneration, 'seek');
    if (this.#paused || playbackGeneration !== this.#playbackGeneration) {
      throw new PlaybackSupersededError();
    }
  }

  #assertPlaybackPreparation(
    sourceGeneration: number,
    seekGeneration: number,
    playbackGeneration: number,
    audioGeneration: number,
    operation: 'open' | 'play' | 'seek',
  ): void {
    this.#assertOperation(sourceGeneration, seekGeneration, operation);
    if (
      playbackGeneration !== this.#playbackGeneration ||
      audioGeneration !== this.#audioGeneration
    ) {
      throw new MediaPlayerOperationCancelledError(operation);
    }
  }

  #assertAudioPlayback(audioGeneration: number): void {
    if (this.#disposed) throw new MediaPlayerDisposedError();
    if (this.#paused || audioGeneration !== this.#audioGeneration) {
      throw new PlaybackSupersededError();
    }
  }

  #resetLoadedState(): void {
    this.#loaded = false;
    this.#canvasSink = undefined;
    this.#audioSink = undefined;
    this.#audioMetadata = unknownAudioMetadata;
    this.#audioRuntimeCapability = 'unknown';
    this.#timeline = undefined;
    this.#packetIndexByTimestamp.clear();
    this.#queue = [];
    this.#stats.recordVideoQueueDepth(0);
    this.#currentFrame = undefined;
    this.#currentTime = 0;
    this.#duration = 0;
    this.#width = 0;
    this.#height = 0;
    this.#videoFps = 0;
    this.#clock.seek(0);
  }

  #currentAvPresentationError(): number | null {
    const frame = this.#currentFrame;
    if (
      frame === undefined ||
      this.#paused ||
      this.#clockSourceStatus !== 'audio-context'
    ) {
      return null;
    }
    const audioTime = Math.min(this.#clock.currentTime(), this.#duration);
    const frameDuration = Math.min(
      frame.metadata.duration,
      this.#duration - frame.metadata.timestamp,
    );
    return getPresentationWindowError(
      audioTime,
      frame.metadata.timestamp,
      frameDuration,
    );
  }

  #refreshStatsGauges(): void {
    this.#stats.recordVideoQueueDepth(this.#queue.length);
    this.#stats.recordAudioQueueDepth(this.#scheduledAudioNodes.size);
    this.#stats.recordAvPresentationError(this.#currentAvPresentationError());
  }

  #clearCanvas(): void {
    this.#context.setTransform(1, 0, 0, 1, 0, 0);
    this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
  }

  #emitCurrentFrame(): void {
    const frame = this.#currentFrame;
    if (frame === undefined) return;
    this.#emit('timeupdate', { time: this.#currentTime });
    this.#emit('frame', {
      time: frame.metadata.timestamp,
      frameIndex: frame.metadata.frameIndex,
    });
  }

  #emit<T extends MediaPlayerEventType>(
    event: T,
    payload: MediaPlayerEventMap[T],
  ): void {
    const listeners = [...(this.#listeners.get(event) ?? [])];
    for (const listener of listeners) {
      try {
        (listener as MediaPlayerEventCallback<T>)(payload);
      } catch (error) {
        if (event !== 'error') this.#emitError(asError(error));
      }
    }
  }

  #emitError(error: Error): void {
    this.#emit('error', { error });
  }

  #requireCurrentFrameIndex(): number {
    const frame = this.#currentFrame;
    if (frame === undefined) {
      throw new FrameMetadataUnavailableError('No current video frame is available.');
    }
    return frame.metadata.frameIndex;
  }

  #assertSourceGeneration(
    sourceGeneration: number,
    operation: 'open' | 'play' | 'seek',
  ): void {
    if (this.#disposed) throw new MediaPlayerDisposedError();
    if (sourceGeneration !== this.#sourceGeneration) {
      throw new MediaPlayerOperationCancelledError(operation);
    }
  }

  #assertOperation(
    sourceGeneration: number,
    seekGeneration: number,
    operation: 'open' | 'play' | 'seek',
  ): void {
    this.#assertSourceGeneration(sourceGeneration, operation);
    if (seekGeneration !== this.#seekGeneration) {
      throw new MediaPlayerOperationCancelledError(operation);
    }
  }

  #assertReady(): void {
    this.#assertActive();
    if (!this.#loaded || this.#timeline === undefined) {
      throw new FrameMetadataUnavailableError('Open a video before using the player.');
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw new MediaPlayerDisposedError();
  }
}

export function createMediaPlayer(
  canvas: MediaCanvas,
  options?: MediaPlayerOptions,
): IMediaPlayer {
  return new MediaPlayer(canvas, options);
}
