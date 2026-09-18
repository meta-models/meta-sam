/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export interface RowWindow {
  /** First row to render, inclusive. */
  readonly start: number;
  /** Last row to render, exclusive. */
  readonly end: number;
}

/**
 * The rows a fixed-height list must render for a scroll position, padded by
 * `overscan` rows on each side.
 *
 * A viewport height of zero — the first render, before the container has been
 * measured — still yields the overscan window, so the list is never blank.
 */
export function rowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  total: number,
  overscan: number,
): RowWindow {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || total <= 0) {
    return { start: 0, end: 0 };
  }
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const padding = Math.max(0, Math.floor(overscan));
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + height) / rowHeight);
  return {
    start: Math.max(0, Math.min(first - padding, total)),
    end: Math.max(0, Math.min(last + padding, total)),
  };
}

/**
 * Whether a scroll container is resting at its end, within `tolerance` pixels.
 * A container whose content fits counts as pinned, so a short log keeps
 * following instead of offering a jump nobody needs.
 */
export function isPinnedToEnd(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
  tolerance = 4,
): boolean {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(contentHeight)) return true;
  return contentHeight - (scrollTop + viewportHeight) <= tolerance;
}

/**
 * Splits concatenated model output into display lines. The stream ends each
 * record with a newline, and that final terminator is not an empty last line.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
