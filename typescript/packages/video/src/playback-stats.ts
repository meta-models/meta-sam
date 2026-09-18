/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export interface PlaybackTimingStats {
  readonly sampleCount: number;
  readonly averageMilliseconds: number;
  readonly p95Milliseconds: number;
  readonly maxMilliseconds: number;
}

export interface PlaybackQueueDepthStats {
  readonly current: number;
  readonly max: number;
}

export interface PlaybackPresentationErrorStats {
  /** Signed distance from the active audio clock to the current frame interval. */
  readonly currentSeconds: number | null;
  readonly maxAbsoluteSeconds: number | null;
}

export interface PlaybackDurationDiagnostics {
  readonly count: number;
  readonly totalSeconds: number;
  readonly maxSeconds: number;
}

export function getPresentationWindowError(
  clockTime: number,
  frameTimestamp: number,
  frameDuration: number,
): number {
  const frameEnd = frameTimestamp + frameDuration;
  if (clockTime < frameTimestamp) return clockTime - frameTimestamp;
  if (clockTime >= frameEnd) return clockTime - frameEnd;
  return 0;
}

/**
 * Point-in-time playback telemetry accumulated since construction or resetStats().
 * Timing percentiles use only the most recent sampleWindowSize observations.
 */
export interface PlaybackStats {
  readonly sampleWindowSize: number;
  readonly renderLoopTicks: number;
  readonly uniqueVideoFramesRendered: number;
  readonly duplicateRedraws: number;
  readonly lateFramesSkipped: number;
  readonly decodeTime: PlaybackTimingStats;
  readonly overlayRenderTime: PlaybackTimingStats;
  readonly videoQueueDepth: PlaybackQueueDepthStats;
  readonly audioQueueDepth: PlaybackQueueDepthStats;
  readonly avPresentationError: PlaybackPresentationErrorStats;
  readonly audioUnderruns: PlaybackDurationDiagnostics;
  readonly audioGaps: PlaybackDurationDiagnostics;
  readonly droppedAudioBuffers: PlaybackDurationDiagnostics;
}

export interface PlaybackStatsResetState {
  readonly videoQueueDepth: number;
  readonly audioQueueDepth: number;
  readonly currentAvPresentationErrorSeconds: number | null;
  readonly sourceGeneration: number | null;
  readonly frameIndex: number | null;
}

class SampleWindow {
  readonly #capacity: number;
  readonly #values: number[] = [];
  #next = 0;

  public constructor(capacity: number) {
    this.#capacity = capacity;
  }

  public add(value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    if (this.#values.length < this.#capacity) {
      this.#values.push(value);
      return;
    }
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % this.#capacity;
  }

  public clear(): void {
    this.#values.length = 0;
    this.#next = 0;
  }

  public summarize(): PlaybackTimingStats {
    if (this.#values.length === 0) {
      return Object.freeze({
        sampleCount: 0,
        averageMilliseconds: 0,
        p95Milliseconds: 0,
        maxMilliseconds: 0,
      });
    }
    const sorted = [...this.#values].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    return Object.freeze({
      sampleCount: sorted.length,
      averageMilliseconds: total / sorted.length,
      p95Milliseconds: sorted[p95Index]!,
      maxMilliseconds: sorted[sorted.length - 1]!,
    });
  }
}

interface MutableDurationDiagnostics {
  count: number;
  totalSeconds: number;
  maxSeconds: number;
}

function emptyDurationDiagnostics(): MutableDurationDiagnostics {
  return { count: 0, totalSeconds: 0, maxSeconds: 0 };
}

function snapshotDurationDiagnostics(
  value: MutableDurationDiagnostics,
): PlaybackDurationDiagnostics {
  return Object.freeze({ ...value });
}

function snapshotQueueDepth(current: number, max: number): PlaybackQueueDepthStats {
  return Object.freeze({ current, max });
}

export class PlaybackStatsRecorder {
  readonly #sampleWindowSize: number;
  readonly #decodeTime: SampleWindow;
  readonly #overlayRenderTime: SampleWindow;

  #renderLoopTicks = 0;
  #uniqueVideoFramesRendered = 0;
  #duplicateRedraws = 0;
  #lateFramesSkipped = 0;
  #videoQueueDepth = 0;
  #maxVideoQueueDepth = 0;
  #audioQueueDepth = 0;
  #maxAudioQueueDepth = 0;
  #currentAvPresentationErrorSeconds: number | null = null;
  #maxAbsoluteAvPresentationErrorSeconds: number | null = null;
  #audioUnderruns = emptyDurationDiagnostics();
  #audioGaps = emptyDurationDiagnostics();
  #droppedAudioBuffers = emptyDurationDiagnostics();
  #lastRenderedSourceGeneration: number | null = null;
  #lastRenderedFrameIndex: number | null = null;

  public constructor(sampleWindowSize: number) {
    this.#sampleWindowSize = sampleWindowSize;
    this.#decodeTime = new SampleWindow(sampleWindowSize);
    this.#overlayRenderTime = new SampleWindow(sampleWindowSize);
  }

  public recordRenderLoopTick(): void {
    this.#renderLoopTicks += 1;
  }

  public recordFrameRendered(sourceGeneration: number, frameIndex: number): void {
    if (
      this.#lastRenderedSourceGeneration === sourceGeneration &&
      this.#lastRenderedFrameIndex === frameIndex
    ) {
      this.#duplicateRedraws += 1;
    } else {
      this.#uniqueVideoFramesRendered += 1;
    }
    this.#lastRenderedSourceGeneration = sourceGeneration;
    this.#lastRenderedFrameIndex = frameIndex;
  }

  public recordLateFrameSkipped(): void {
    this.#lateFramesSkipped += 1;
  }

  public recordDecode(milliseconds: number): void {
    this.#decodeTime.add(milliseconds);
  }

  public recordOverlayRender(milliseconds: number): void {
    this.#overlayRenderTime.add(milliseconds);
  }

  public recordVideoQueueDepth(depth: number): void {
    this.#videoQueueDepth = depth;
    this.#maxVideoQueueDepth = Math.max(this.#maxVideoQueueDepth, depth);
  }

  public recordAudioQueueDepth(depth: number): void {
    this.#audioQueueDepth = depth;
    this.#maxAudioQueueDepth = Math.max(this.#maxAudioQueueDepth, depth);
  }

  public recordAvPresentationError(seconds: number | null): void {
    if (seconds === null || !Number.isFinite(seconds)) {
      this.#currentAvPresentationErrorSeconds = null;
      return;
    }
    this.#currentAvPresentationErrorSeconds = seconds;
    this.#maxAbsoluteAvPresentationErrorSeconds = Math.max(
      this.#maxAbsoluteAvPresentationErrorSeconds ?? 0,
      Math.abs(seconds),
    );
  }

  public recordAudioUnderrun(seconds: number): void {
    this.#recordDuration(this.#audioUnderruns, seconds);
  }

  public recordAudioGap(seconds: number): void {
    this.#recordDuration(this.#audioGaps, seconds);
  }

  public recordDroppedAudioBuffer(seconds: number): void {
    this.#recordDuration(this.#droppedAudioBuffers, seconds);
  }

  public reset(state: PlaybackStatsResetState): void {
    this.#renderLoopTicks = 0;
    this.#uniqueVideoFramesRendered = 0;
    this.#duplicateRedraws = 0;
    this.#lateFramesSkipped = 0;
    this.#decodeTime.clear();
    this.#overlayRenderTime.clear();
    this.#videoQueueDepth = state.videoQueueDepth;
    this.#maxVideoQueueDepth = state.videoQueueDepth;
    this.#audioQueueDepth = state.audioQueueDepth;
    this.#maxAudioQueueDepth = state.audioQueueDepth;
    this.#currentAvPresentationErrorSeconds = state.currentAvPresentationErrorSeconds;
    this.#maxAbsoluteAvPresentationErrorSeconds =
      state.currentAvPresentationErrorSeconds === null
        ? null
        : Math.abs(state.currentAvPresentationErrorSeconds);
    this.#audioUnderruns = emptyDurationDiagnostics();
    this.#audioGaps = emptyDurationDiagnostics();
    this.#droppedAudioBuffers = emptyDurationDiagnostics();
    this.#lastRenderedSourceGeneration = state.sourceGeneration;
    this.#lastRenderedFrameIndex = state.frameIndex;
  }

  public snapshot(): PlaybackStats {
    // JavaScript cannot interleave another task with this synchronous snapshot, so
    // every nested value belongs to the same instrumentation state transition.
    return Object.freeze({
      sampleWindowSize: this.#sampleWindowSize,
      renderLoopTicks: this.#renderLoopTicks,
      uniqueVideoFramesRendered: this.#uniqueVideoFramesRendered,
      duplicateRedraws: this.#duplicateRedraws,
      lateFramesSkipped: this.#lateFramesSkipped,
      decodeTime: this.#decodeTime.summarize(),
      overlayRenderTime: this.#overlayRenderTime.summarize(),
      videoQueueDepth: snapshotQueueDepth(
        this.#videoQueueDepth,
        this.#maxVideoQueueDepth,
      ),
      audioQueueDepth: snapshotQueueDepth(
        this.#audioQueueDepth,
        this.#maxAudioQueueDepth,
      ),
      avPresentationError: Object.freeze({
        currentSeconds: this.#currentAvPresentationErrorSeconds,
        maxAbsoluteSeconds: this.#maxAbsoluteAvPresentationErrorSeconds,
      }),
      audioUnderruns: snapshotDurationDiagnostics(this.#audioUnderruns),
      audioGaps: snapshotDurationDiagnostics(this.#audioGaps),
      droppedAudioBuffers: snapshotDurationDiagnostics(this.#droppedAudioBuffers),
    });
  }

  #recordDuration(target: MutableDurationDiagnostics, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    target.count += 1;
    target.totalSeconds += seconds;
    target.maxSeconds = Math.max(target.maxSeconds, seconds);
  }
}
