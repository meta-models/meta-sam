/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export type VideoPacketMetadataErrorCode =
  | 'duplicate_presentation_timestamp'
  | 'frame_lookup_out_of_range'
  | 'frame_metadata_unavailable';

export type MediaPlayerOperation = 'open' | 'play' | 'seek' | 'source';

export class MediaPlayerError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class VideoPacketMetadataError extends MediaPlayerError {
  public constructor(
    message: string,
    code: VideoPacketMetadataErrorCode,
    options?: ErrorOptions,
  ) {
    super(message, code, options);
  }
}

export class DuplicatePresentationTimestampError extends VideoPacketMetadataError {
  public constructor(public readonly timestamp: number) {
    super(
      `Video packets contain a duplicate presentation timestamp at ${timestamp} seconds.`,
      'duplicate_presentation_timestamp',
    );
  }
}

export class FrameLookupOutOfRangeError extends VideoPacketMetadataError {
  public constructor(
    public readonly lookup: 'frame' | 'time',
    public readonly value: number,
  ) {
    super(
      `${lookup === 'frame' ? 'Frame index' : 'Presentation time'} ${value} is outside the video packet timeline.`,
      'frame_lookup_out_of_range',
    );
  }
}

export class FrameMetadataUnavailableError extends VideoPacketMetadataError {
  public constructor(message = 'Exact video packet metadata is unavailable.') {
    super(message, 'frame_metadata_unavailable');
  }
}

export class MediaPlayerDisposedError extends MediaPlayerError {
  public constructor() {
    super('The media player has been disposed.', 'player_disposed');
  }
}

export class MediaPlayerOperationCancelledError extends MediaPlayerError {
  public constructor(public readonly operation: MediaPlayerOperation) {
    super(
      `The media player ${operation} operation was cancelled.`,
      'operation_cancelled',
    );
  }
}

export class MediaPlayerAudioError extends MediaPlayerError {
  public constructor(
    message: string,
    options?: ErrorOptions,
    code = 'audio_playback_error',
  ) {
    super(message, code, options);
  }
}

export class MediaPlayerAudioResumeTimeoutError extends MediaPlayerAudioError {
  public constructor(public readonly timeoutMilliseconds: number) {
    super(
      `Resuming Web Audio exceeded ${timeoutMilliseconds} milliseconds; playing silently.`,
      undefined,
      'audio_resume_timeout',
    );
  }
}

export class MediaPlayerSourceError extends MediaPlayerError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'media_source_error', options);
  }
}
