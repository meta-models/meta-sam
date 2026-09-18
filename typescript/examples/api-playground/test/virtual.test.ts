/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import { isPinnedToEnd, rowWindow, splitLines } from '../src/virtual';

describe('rowWindow', () => {
  it('renders only the viewport plus the overscan', () => {
    // 400px of viewport over 26px rows is 16 rows, plus 10 either side.
    expect(rowWindow(0, 400, 26, 3_000, 10)).toEqual({ start: 0, end: 26 });
    const scrolled = rowWindow(26_000, 400, 26, 3_000, 10);
    expect(scrolled.start).toBe(990);
    expect(scrolled.end).toBe(1_026);
    expect(scrolled.end - scrolled.start).toBeLessThan(100);
  });

  it('clamps to the ends of the list', () => {
    expect(rowWindow(-50, 400, 26, 3_000, 10)).toEqual({ start: 0, end: 26 });
    expect(rowWindow(10_000_000, 400, 26, 3_000, 10)).toEqual({
      start: 3_000,
      end: 3_000,
    });
    expect(rowWindow(0, 400, 26, 4, 10)).toEqual({ start: 0, end: 4 });
  });

  it('still renders rows before the container has been measured', () => {
    expect(rowWindow(0, 0, 26, 3_000, 10)).toEqual({ start: 0, end: 10 });
  });

  it('renders nothing for an empty or unmeasurable list', () => {
    expect(rowWindow(0, 400, 26, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(rowWindow(0, 400, 0, 100, 10)).toEqual({ start: 0, end: 0 });
  });
});

describe('isPinnedToEnd', () => {
  it('follows at the bottom and stops after scrolling up', () => {
    expect(isPinnedToEnd(600, 400, 1_000)).toBe(true);
    expect(isPinnedToEnd(598, 400, 1_000)).toBe(true);
    expect(isPinnedToEnd(0, 400, 1_000)).toBe(false);
    expect(isPinnedToEnd(560, 400, 1_000)).toBe(false);
  });

  it('keeps following when the content fits the viewport', () => {
    expect(isPinnedToEnd(0, 400, 120)).toBe(true);
  });
});

describe('splitLines', () => {
  it('splits records and drops the final terminator', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
  });

  it('keeps interior blank lines', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });

  it('has no lines for empty output', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });
});
