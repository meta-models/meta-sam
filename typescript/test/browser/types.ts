/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type {
  MediaPlayerAudioMetadata,
  MediaPlayerAudioStatus,
  PlaybackStats,
} from '../../packages/video/src/index.js';

export type DecodeStatus =
  | { readonly status: 'decoded'; readonly sampleCount: number }
  | { readonly status: 'unsupported'; readonly sampleCount: 0 };

export type PacketReport = {
  readonly count: number;
  readonly timestamps: readonly number[];
  readonly durations: readonly number[];
  readonly sequenceNumbers: readonly number[];
  readonly byteLengths: readonly number[];
  readonly types: readonly string[];
};

export type TrackReport = {
  readonly id: number;
  readonly type: 'video' | 'audio';
  readonly codec: string | null;
  readonly codecParameterString: string | null;
  readonly internalCodecId: string | number | null;
  readonly firstTimestamp: number;
  readonly duration: number;
  readonly canDecode: boolean;
  readonly nativeCanDecode: boolean;
  readonly packets: PacketReport;
  readonly decoded: DecodeStatus;
  readonly sampleTimestamps: readonly number[];
  readonly sampleDurations: readonly number[];
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
};

export type FixtureReport = {
  readonly file: string;
  readonly userAgent: string;
  readonly webCodecs: {
    readonly videoDecoder: boolean;
    readonly audioDecoder: boolean;
  };
  readonly canRead: boolean;
  readonly container: string;
  readonly mimeType: string;
  readonly firstTimestamp: number;
  readonly duration: number;
  readonly tracks: readonly TrackReport[];
};

export type PlayerExerciseReport =
  | {
      readonly status: 'played';
      readonly events: readonly string[];
      readonly frameIndexes: readonly number[];
      readonly packetTimestamps: readonly number[];
      readonly customRenderCount: number;
      readonly finalFrameIndex: number;
    }
  | {
      readonly status: 'unsupported';
      readonly errorCode: string;
    };

export type AudioExerciseReport =
  | {
      readonly status: 'played';
      readonly audioMetadata: MediaPlayerAudioMetadata;
      readonly finalAudioStatus: MediaPlayerAudioStatus;
      readonly audioStatusEvents: readonly MediaPlayerAudioStatus[];
      readonly peakScheduledBufferCount: number;
      readonly frameSkewSeconds: readonly number[];
      readonly endedTime: number;
    }
  | {
      readonly status: 'unsupported-video';
      readonly errorCode: string;
    };

export type CompositionPixel = readonly [number, number, number, number];

export type CompositionSample = {
  readonly baseline: CompositionPixel;
  readonly overlay: CompositionPixel;
};

export type CompositionFrameReport = {
  readonly frameIndex: number;
  readonly renderFrameIndex: number;
  readonly global: CompositionSample;
  readonly specificInterior: CompositionSample;
  readonly specificBox: CompositionSample;
  readonly exterior: CompositionSample;
};

export type CompositionGeometryReport = {
  readonly fit: 'contain' | 'cover' | 'fill';
  readonly devicePixelRatio: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly frameIndex: number;
  readonly renderFrameIndex: number;
  readonly target: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly specificInterior: CompositionSample;
  readonly exterior: CompositionSample;
  readonly clipped: CompositionPixel;
};

export type CompositionExerciseReport = {
  readonly frames: readonly CompositionFrameReport[];
  readonly geometry: readonly CompositionGeometryReport[];
  readonly staleSeek: {
    readonly cancelledCode: string;
    readonly aborted: boolean;
    readonly finalFrameIndex: number;
    readonly staleSpecificPixel: CompositionSample;
  };
  readonly staleSource: {
    readonly cancelledCode: string;
    readonly aborted: boolean;
    readonly finalFrameIndex: number;
    readonly staleSpecificPixel: CompositionSample;
  };
  readonly playbackSupersession: {
    readonly attemptedFrameIndexes: readonly number[];
    readonly committedFrameIndexes: readonly number[];
    readonly aborted: boolean;
    readonly finalFrameIndex: number;
    readonly staleSpecificPixel: CompositionSample;
  };
  readonly finalDeadline: {
    readonly aborted: boolean;
    readonly finalFrameIndex: number;
    readonly bareGlobalPixel: CompositionSample;
    readonly clipped: CompositionPixel;
  };
  readonly offscreen: {
    readonly frameIndex: number;
    readonly interior: CompositionSample;
    readonly finalFrameIndex: number;
    readonly finalAborted: boolean;
    readonly finalBareGlobal: CompositionSample;
    readonly clipped: CompositionPixel;
  };
};

export type ReactVideoStats = PlaybackStats;

export type ReactFailurePrecedenceReport = {
  readonly fatalMessage: string | null;
  readonly unsupportedCode: string | null;
  readonly selectedMessage: string | null;
};

export type ReactHookExerciseReport =
  | {
      readonly status: 'played';
      readonly canvasCount: number;
      readonly videoCount: number;
      readonly readyCount: number;
      readonly renderCount: number;
      readonly staleTimeCallsAfterUpdate: number;
      readonly freshTimeCalls: number;
      readonly frameIndex: number;
      readonly replacementFrameIndex: number;
      readonly pixel: CompositionPixel;
    }
  | {
      readonly status: 'unsupported';
      readonly errorCode: string;
    };

export type ReactVideoExerciseReport =
  | {
      readonly status: 'played';
      readonly canvasCount: number;
      readonly videoCount: number;
      readonly readyCount: number;
      readonly packetTimestamps: readonly number[];
      readonly exactPacketFrameIndex: number;
      readonly exactSeekFrameIndex: number;
      readonly staleTimeCallsAfterUpdate: number;
      readonly freshTimeCalls: number;
      readonly staleLoadedCallsAfterUpdate: number;
      readonly freshLoadedCalls: number;
      readonly compositedPixel: CompositionPixel;
      readonly rawPixel: CompositionPixel;
      readonly hiddenPixel: CompositionPixel;
      readonly replacementFrameIndex?: number;
      readonly stats: ReactVideoStats;
    }
  | {
      readonly status: 'unsupported';
      readonly errorCode: string;
    };

export type ReactLifecycleReport = {
  readonly readyCount: number;
  readonly disposeCounts: readonly number[];
  readonly canvasCount: number;
  readonly videoCount: number;
};

export type ReactAudioExerciseReport =
  | {
      readonly status: 'played';
      readonly audioMetadata: MediaPlayerAudioMetadata;
      readonly audioStatusEvents: readonly MediaPlayerAudioStatus[];
      readonly peakScheduledBufferCount: number;
      readonly audioStatus: MediaPlayerAudioStatus;
      readonly stats: ReactVideoStats;
    }
  | {
      readonly status: 'unsupported-video';
      readonly errorCode: string;
    };

export type PerformancePlaybackRun = {
  readonly wallMilliseconds: number;
  readonly audioClockSource: MediaPlayerAudioStatus['clockSource'];
  readonly frameIndexes: readonly number[];
  readonly clockSamples: readonly number[];
  readonly overlayFrameIndexes: readonly number[];
  readonly overlayMismatches: number;
  readonly finalFrameIndex: number;
  readonly stats: PlaybackStats;
};

export type MediaPerformanceReport = {
  readonly fixture: string;
  readonly repetitions: number;
  readonly realTime: PerformancePlaybackRun;
  readonly noOverlay: readonly PerformancePlaybackRun[];
  readonly overlay: readonly PerformancePlaybackRun[];
  readonly stalls: readonly ({
    readonly stallMilliseconds: number;
    readonly abortedFrameIndexes: readonly number[];
  } & PerformancePlaybackRun)[];
};

export type VfrSteppingReport = {
  readonly timestamps: readonly number[];
  readonly durations: readonly number[];
  readonly forwardFrameIndexes: readonly number[];
  readonly reverseFrameIndexes: readonly number[];
};

export type PlaybackChurnReport = {
  readonly iterations: number;
  readonly expectedFrameIndexes: readonly number[];
  readonly committedFrameIndexes: readonly number[];
  readonly widths: readonly number[];
  readonly stats: PlaybackStats;
};

export type BlockedAudioResumeReport = {
  readonly warningCode: string | null;
  readonly warningName: string | null;
  readonly timeoutMilliseconds: number | null;
  readonly clockSamples: readonly number[];
  readonly stats: PlaybackStats;
};

export type ReactMountStressReport = {
  readonly cycles: number;
  readonly readyCount: number;
  readonly disposeCounts: readonly number[];
  readonly remainingCanvasCount: number;
  readonly remainingVideoCount: number;
};

export type BrowserMediaHarness = {
  analyzeFixture(file: string): Promise<FixtureReport>;
  exercisePlayer(file: string): Promise<PlayerExerciseReport>;
  exerciseComposition(): Promise<CompositionExerciseReport>;
  prepareAudioExercise(file: string): Promise<string>;
  waitForAudioExercise(): Promise<AudioExerciseReport>;
  exerciseReactVideo(
    file: string,
    replacementFile?: string,
  ): Promise<ReactVideoExerciseReport>;
  exerciseReactHook(
    file: string,
    replacementFile: string,
  ): Promise<ReactHookExerciseReport>;
  exerciseReactFailurePrecedence(): ReactFailurePrecedenceReport;
  exerciseReactStrictMode(): Promise<ReactLifecycleReport>;
  prepareReactAudioExercise(file: string): Promise<string>;
  waitForReactAudioExercise(): Promise<ReactAudioExerciseReport>;
  exerciseVfrStepping(): Promise<VfrSteppingReport>;
  prepareMediaPerformanceExercise(): Promise<string>;
  waitForMediaPerformanceExercise(): Promise<MediaPerformanceReport>;
  exercisePlaybackChurn(iterations: number): Promise<PlaybackChurnReport>;
  exerciseBlockedAudioResume(): Promise<BlockedAudioResumeReport>;
  exerciseReactMountStress(cycles: number): Promise<ReactMountStressReport>;
};

declare global {
  interface Window {
    mediaHarness: BrowserMediaHarness;
  }
}
