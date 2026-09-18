/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { Text } from '@astryxdesign/core/Text';
import { ArrowDown, Download } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import type { StreamState } from './model';
import { countRender } from './render-counts';
import { VirtualRows, type ScrollMetrics } from './VirtualRows';
import { isPinnedToEnd } from './virtual';

export interface StreamLogProps {
  readonly stream: StreamState;
}

/** Fixed row height, in CSS pixels; the windowing math depends on it. */
const STREAM_ROW_HEIGHT = 26;

function formatMs(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`;
}

function download(filename: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function StreamLog({ stream }: StreamLogProps): React.JSX.Element {
  countRender('StreamLog');
  const viewportRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const entries = stream.entries;
  const total = entries.length;
  const streamElapsed = stream.endedMs ?? entries.at(-1)?.atMs ?? null;

  // While the log is followed, the newest row stays in view — including on the
  // first render, so opening the tab after a run lands on the latest event.
  useLayoutEffect(() => {
    if (!following) return;
    const element = viewportRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [following, total]);

  const onScrollMetrics = useCallback((metrics: ScrollMetrics) => {
    setFollowing(
      isPinnedToEnd(metrics.scrollTop, metrics.viewportHeight, metrics.contentHeight),
    );
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = viewportRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
    setFollowing(true);
  }, []);

  const renderRow = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry === undefined) return null;
      return (
        <div className="stream__content">
          <Text type="supporting" color="secondary" hasTabularNumbers>
            +{Math.round(entry.atMs)} ms
          </Text>
          <Text type="supporting" color="secondary">
            {entry.kind}
          </Text>
          <Text type="supporting" color="secondary" hasTabularNumbers>
            {entry.text.length}
          </Text>
          <Text type="supporting" maxLines={1}>
            {entry.text}
          </Text>
        </div>
      );
    },
    [entries],
  );

  return (
    <div className="inspector__section inspector__section--fill">
      <MetadataList columns={2} label={{ position: 'top' }}>
        <MetadataListItem label="Events">
          <Text type="body" hasTabularNumbers>
            {total + stream.droppedEntries}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="Characters">
          <Text type="body" hasTabularNumbers>
            {stream.characters.toLocaleString()}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="First delta">
          <Text type="body" hasTabularNumbers>
            {formatMs(stream.firstDeltaMs)}
          </Text>
        </MetadataListItem>
        <MetadataListItem label="Elapsed">
          <Text type="body" hasTabularNumbers>
            {formatMs(streamElapsed)}
          </Text>
        </MetadataListItem>
      </MetadataList>
      <div className="inspector__toolbar">
        {stream.droppedEntries > 0 ? (
          <Text type="supporting" color="secondary">
            {stream.droppedEntries.toLocaleString()} earlier events were trimmed from
            view.
          </Text>
        ) : null}
        <Button
          label="Download JSONL"
          variant="ghost"
          size="sm"
          icon={<Download size={16} />}
          isDisabled={total === 0}
          onClick={() =>
            download(
              'sam-stream.jsonl',
              'application/x-ndjson',
              entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
            )
          }
        />
      </div>
      {total === 0 ? (
        <EmptyState
          isCompact
          title="No stream events"
          description="Each output_text delta is logged here with its arrival time."
        />
      ) : (
        <div className="stream-log__viewport">
          <VirtualRows
            containerRef={viewportRef}
            total={total}
            rowHeight={STREAM_ROW_HEIGHT}
            label="Stream events"
            className="stream-log__rows"
            rowClassName="virtual-rows__row stream__row"
            rowKey={(index) => entries[index]?.sequence ?? index}
            renderRow={renderRow}
            onScrollMetrics={onScrollMetrics}
          />
          {following ? null : (
            <div className="stream-log__jump">
              <Button
                label="Jump to latest"
                variant="primary"
                size="sm"
                elevation="med"
                icon={<ArrowDown size={16} />}
                onClick={jumpToLatest}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
