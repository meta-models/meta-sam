/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  DuplicatePresentationTimestampError,
  FrameLookupOutOfRangeError,
  FrameMetadataUnavailableError,
  createVideoPacketTimeline,
  getFrameIndexAtTimeExact,
  getTimeAtFrameIndexExact,
} from '../src/index.js';

const packets = createVideoPacketTimeline([
  {
    timestamp: 0.25,
    duration: 0.125,
    sequenceNumber: 1,
    type: 'delta',
    byteLength: 20,
  },
  {
    timestamp: 0,
    duration: 0.125,
    sequenceNumber: 0,
    type: 'key',
    byteLength: 10,
  },
  {
    timestamp: 0.125,
    duration: 0.125,
    sequenceNumber: 2,
    type: 'delta',
    byteLength: 15,
  },
]);

describe('video packet timeline', () => {
  it('freezes packet metadata in presentation order', () => {
    expect(packets.map(({ timestamp }) => timestamp)).toEqual([0, 0.125, 0.25]);
    expect(packets.map(({ frameIndex }) => frameIndex)).toEqual([0, 1, 2]);
    expect(Object.isFrozen(packets)).toBe(true);
    expect(packets.every(Object.isFrozen)).toBe(true);
  });

  it('fails closed on duplicate presentation timestamps', () => {
    expect(() =>
      createVideoPacketTimeline([
        {
          timestamp: 0,
          duration: 0.1,
          sequenceNumber: 1,
          type: 'key',
          byteLength: 10,
        },
        {
          timestamp: 0,
          duration: 0.1,
          sequenceNumber: 2,
          type: 'delta',
          byteLength: 10,
        },
      ]),
    ).toThrow(DuplicatePresentationTimestampError);
  });

  it('uses packet intervals for exact lookups', () => {
    expect(getFrameIndexAtTimeExact(packets, 0)).toBe(0);
    expect(getFrameIndexAtTimeExact(packets, 0.249)).toBe(1);
    expect(getFrameIndexAtTimeExact(packets, 0.25)).toBe(2);
    expect(getTimeAtFrameIndexExact(packets, 2)).toBe(0.25);
  });

  it('throws typed errors for out-of-range and uncovered lookups', () => {
    expect(() => getFrameIndexAtTimeExact(packets, -0.001)).toThrow(
      FrameLookupOutOfRangeError,
    );
    expect(() => getFrameIndexAtTimeExact(packets, 0.375)).toThrow(
      FrameLookupOutOfRangeError,
    );
    expect(() => getTimeAtFrameIndexExact(packets, 3)).toThrow(
      FrameLookupOutOfRangeError,
    );

    const gap = createVideoPacketTimeline([
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
        byteLength: 10,
      },
    ]);
    expect(() => getFrameIndexAtTimeExact(gap, 0.15)).toThrow(
      FrameMetadataUnavailableError,
    );
  });

  it('rejects missing or incomplete packet metadata', () => {
    expect(() => createVideoPacketTimeline([])).toThrow(FrameMetadataUnavailableError);
    expect(() =>
      createVideoPacketTimeline([
        {
          timestamp: 0,
          duration: 0,
          sequenceNumber: 0,
          type: 'key',
          byteLength: 10,
        },
      ]),
    ).toThrow(FrameMetadataUnavailableError);
  });
});
