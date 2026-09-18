/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  DuplicatePresentationTimestampError,
  FrameLookupOutOfRangeError,
  FrameMetadataUnavailableError,
} from './media-errors.js';

export interface VideoPacketMetadata {
  /** Zero-based presentation-order index. */
  readonly frameIndex: number;
  /** Presentation timestamp in seconds. */
  readonly timestamp: number;
  /** Packet display duration in seconds. */
  readonly duration: number;
  /** Decode-order sequence number reported by Mediabunny. */
  readonly sequenceNumber: number;
  /** Container-reported packet type; this is not a bitstream verification result. */
  readonly type: 'key' | 'delta';
  readonly byteLength: number;
}

export type VideoPacketTimeline = readonly VideoPacketMetadata[];

export type VideoPacketMetadataInput = Omit<VideoPacketMetadata, 'frameIndex'>;

function requireMetadata(timeline: VideoPacketTimeline): void {
  if (timeline.length === 0) {
    throw new FrameMetadataUnavailableError('The video has no packet metadata.');
  }

  let previousTimestamp = -Infinity;
  for (let index = 0; index < timeline.length; index += 1) {
    const packet = timeline[index]!;
    if (packet.frameIndex !== index) {
      throw new FrameMetadataUnavailableError(
        'Video packet frame indexes must match presentation order.',
      );
    }
    if (!Number.isFinite(packet.timestamp)) {
      throw new FrameMetadataUnavailableError(
        'Video packet timestamps must be finite.',
      );
    }
    if (packet.timestamp === previousTimestamp) {
      throw new DuplicatePresentationTimestampError(packet.timestamp);
    }
    if (packet.timestamp < previousTimestamp) {
      throw new FrameMetadataUnavailableError(
        'Video packets must be sorted in presentation order.',
      );
    }
    if (!Number.isFinite(packet.duration) || packet.duration <= 0) {
      throw new FrameMetadataUnavailableError(
        'Video packet durations must be finite and positive.',
      );
    }
    if (!Number.isSafeInteger(packet.sequenceNumber)) {
      throw new FrameMetadataUnavailableError(
        'Video packet sequence numbers must be safe integers.',
      );
    }
    if (!Number.isSafeInteger(packet.byteLength) || packet.byteLength < 0) {
      throw new FrameMetadataUnavailableError(
        'Video packet byte lengths must be non-negative safe integers.',
      );
    }
    if (packet.type !== 'key' && packet.type !== 'delta') {
      throw new FrameMetadataUnavailableError('Video packet types are invalid.');
    }
    previousTimestamp = packet.timestamp;
  }

  for (let index = 0; index < timeline.length - 1; index += 1) {
    const packet = timeline[index]!;
    const next = timeline[index + 1]!;
    const overlap = packet.timestamp + packet.duration - next.timestamp;
    if (overlap > 1e-9) {
      throw new FrameMetadataUnavailableError(
        'Video packet presentation intervals must not overlap.',
      );
    }
  }
}

export function createVideoPacketTimeline(
  packets: Iterable<VideoPacketMetadataInput>,
): VideoPacketTimeline {
  const ordered = [...packets].sort(
    (left, right) =>
      left.timestamp - right.timestamp || left.sequenceNumber - right.sequenceNumber,
  );
  const timeline = ordered.map((packet, frameIndex) =>
    Object.freeze({ ...packet, frameIndex }),
  );
  requireMetadata(timeline);
  return Object.freeze(timeline);
}

export function getFrameIndexAtTimeExact(
  timeline: VideoPacketTimeline,
  seconds: number,
): number {
  requireMetadata(timeline);
  if (!Number.isFinite(seconds)) {
    throw new TypeError('seconds must be finite.');
  }

  const first = timeline[0]!;
  const last = timeline[timeline.length - 1]!;
  if (seconds < first.timestamp || seconds >= last.timestamp + last.duration) {
    throw new FrameLookupOutOfRangeError('time', seconds);
  }

  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (timeline[middle]!.timestamp <= seconds) low = middle + 1;
    else high = middle;
  }

  const packet = timeline[low - 1]!;
  if (seconds >= packet.timestamp + packet.duration) {
    throw new FrameMetadataUnavailableError(
      `No video packet covers presentation time ${seconds}.`,
    );
  }
  return packet.frameIndex;
}

export function getTimeAtFrameIndexExact(
  timeline: VideoPacketTimeline,
  frameIndex: number,
): number {
  requireMetadata(timeline);
  if (!Number.isSafeInteger(frameIndex)) {
    throw new TypeError('frameIndex must be a safe integer.');
  }
  const packet = timeline[frameIndex];
  if (packet === undefined) {
    throw new FrameLookupOutOfRangeError('frame', frameIndex);
  }
  return packet.timestamp;
}

export function getPacketAtTimeExact(
  timeline: VideoPacketTimeline,
  seconds: number,
): VideoPacketMetadata {
  return timeline[getFrameIndexAtTimeExact(timeline, seconds)]!;
}

export function getTimelineEnd(timeline: VideoPacketTimeline): number {
  requireMetadata(timeline);
  const last = timeline[timeline.length - 1]!;
  return last.timestamp + last.duration;
}
