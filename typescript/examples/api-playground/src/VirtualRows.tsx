/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import './inspector-virtual.css';
import { rowWindow } from './virtual';

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}

export interface VirtualRowsProps {
  readonly total: number;
  /** Every row is this tall; the windowing math depends on it. */
  readonly rowHeight: number;
  readonly overscan?: number;
  /** Accessible name of the list itself. */
  readonly label: string;
  readonly className?: string;
  readonly rowClassName?: string;
  readonly testId?: string;
  readonly containerRef?: React.RefObject<HTMLDivElement | null>;
  readonly rowKey?: (index: number) => React.Key;
  readonly renderRow: (index: number) => React.ReactNode;
  readonly onScrollMetrics?: (metrics: ScrollMetrics) => void;
}

interface Viewport {
  readonly scrollTop: number;
  readonly height: number;
}

const INITIAL_VIEWPORT: Viewport = { scrollTop: 0, height: 0 };

/**
 * A windowed list: only the rows near the viewport exist in the DOM, and the
 * rest are represented by padding above and below them. Rows keep their list
 * semantics and carry `aria-setsize`/`aria-posinset`, so the full length of
 * the list is announced even though most of it is not rendered.
 */
export function VirtualRows({
  total,
  rowHeight,
  overscan = 10,
  label,
  className,
  rowClassName,
  testId,
  containerRef,
  rowKey,
  renderRow,
  onScrollMetrics,
}: VirtualRowsProps): React.JSX.Element {
  const ownRef = useRef<HTMLDivElement>(null);
  const scrollRef = containerRef ?? ownRef;
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  // Held in a ref so a caller's inline callback cannot re-arm the observer.
  const report = useRef(onScrollMetrics);
  report.current = onScrollMetrics;

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const scrollTop = element.scrollTop;
    const height = element.clientHeight;
    setViewport((previous) =>
      previous.scrollTop === scrollTop && previous.height === height
        ? previous
        : { scrollTop, height },
    );
    report.current?.({
      scrollTop,
      viewportHeight: height,
      contentHeight: element.scrollHeight,
    });
  }, [scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    measure();
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, scrollRef]);

  const { start, end } = rowWindow(
    viewport.scrollTop,
    viewport.height,
    rowHeight,
    total,
    overscan,
  );
  const rows: React.JSX.Element[] = [];
  for (let index = start; index < end; index += 1) {
    rows.push(
      <li
        key={rowKey === undefined ? index : rowKey(index)}
        className={rowClassName === undefined ? 'virtual-rows__row' : rowClassName}
        style={{ height: `${rowHeight}px` }}
        data-index={index}
        aria-setsize={total}
        aria-posinset={index + 1}
      >
        {renderRow(index)}
      </li>,
    );
  }

  return (
    <div
      className={className === undefined ? 'virtual-rows' : `virtual-rows ${className}`}
      ref={scrollRef}
      onScroll={measure}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      <ul
        className="virtual-rows__list"
        aria-label={label}
        data-total={total}
        style={{
          paddingTop: `${start * rowHeight}px`,
          paddingBottom: `${Math.max(0, total - end) * rowHeight}px`,
        }}
      >
        {rows}
      </ul>
    </div>
  );
}
