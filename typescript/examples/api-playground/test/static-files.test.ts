/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import { parseByteRange } from '../server/static-files.ts';

describe('parseByteRange', () => {
  it('parses bounded, open-ended, suffix, and case-insensitive byte ranges', () => {
    expect(parseByteRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseByteRange('Bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('BYTES=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=-999999999999999999999999', 10)).toEqual({
      start: 0,
      end: 9,
    });
    expect(parseByteRange(undefined, 10)).toBeNull();
  });

  it('ignores malformed, unsupported, and multi-range headers', () => {
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseByteRange('items=0-1', 10)).toBeNull();
    expect(parseByteRange('bytes=', 10)).toBeNull();
    expect(parseByteRange('bytes=abc-def', 10)).toBeNull();
  });

  it('distinguishes syntactically valid unsatisfiable single ranges', () => {
    expect(parseByteRange('bytes=8-99', 10)).toEqual({ start: 8, end: 9 });
    expect(parseByteRange('bytes=10-', 10)).toBeUndefined();
    expect(parseByteRange('bytes=999999999999999999999999-', 10)).toBeUndefined();
    expect(parseByteRange('bytes=5-2', 10)).toBeUndefined();
    expect(parseByteRange('bytes=-0', 10)).toBeUndefined();
    expect(parseByteRange('bytes=0-', 0)).toBeUndefined();
  });
});
