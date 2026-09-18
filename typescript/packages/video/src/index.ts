/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export {
  DuplicatePresentationTimestampError,
  FrameLookupOutOfRangeError,
  FrameMetadataUnavailableError,
  MediaPlayerAudioError,
  MediaPlayerAudioResumeTimeoutError,
  MediaPlayerDisposedError,
  MediaPlayerError,
  MediaPlayerOperationCancelledError,
  MediaPlayerSourceError,
  VideoPacketMetadataError,
} from './media-errors.js';
export type {
  MediaPlayerOperation,
  VideoPacketMetadataErrorCode,
} from './media-errors.js';
export { createMediaPlayer, MediaPlayer } from './media-player.js';
export type {
  CustomRenderFunction,
  IMediaPlayer,
  MediaCanvas,
  MediaCanvasContext,
  MediaPlayerAudioCapability,
  MediaPlayerAudioContextState,
  MediaPlayerAudioMetadata,
  MediaPlayerAudioStatus,
  MediaPlayerClockSource,
  MediaPlayerEventCallback,
  MediaPlayerEventMap,
  MediaPlayerEventType,
  MediaPlayerOptions,
  MediaPlayerRenderContext,
  MediaResource,
} from './media-player.js';
export type {
  PlaybackDurationDiagnostics,
  PlaybackPresentationErrorStats,
  PlaybackQueueDepthStats,
  PlaybackStats,
  PlaybackTimingStats,
} from './playback-stats.js';
export {
  createVideoPacketTimeline,
  getFrameIndexAtTimeExact,
  getPacketAtTimeExact,
  getTimeAtFrameIndexExact,
} from './packet-timeline.js';
export type {
  VideoPacketMetadata,
  VideoPacketMetadataInput,
  VideoPacketTimeline,
} from './packet-timeline.js';
