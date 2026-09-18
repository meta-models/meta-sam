/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Text } from '@astryxdesign/core/Text';
import { Copy } from 'lucide-react';
import { useCallback, useMemo } from 'react';

import type { StreamState } from './model';
import { countRender } from './render-counts';
import { VirtualRows } from './VirtualRows';
import { splitLines } from './virtual';

export interface RawOutputProps {
  readonly stream: StreamState;
}

/** Fixed row height, in CSS pixels; the windowing math depends on it. */
const RAW_ROW_HEIGHT = 20;

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function RawOutput({ stream }: RawOutputProps): React.JSX.Element {
  countRender('RawOutput');
  // One pass over megabytes of text, charged only when the text itself grows.
  const lines = useMemo(() => splitLines(stream.text), [stream.text]);

  const renderRow = useCallback(
    (index: number) => (
      <Text type="code" color="secondary">
        {lines[index] ?? ''}
      </Text>
    ),
    [lines],
  );

  return (
    <div className="inspector__section inspector__section--fill">
      <div className="inspector__toolbar">
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {lines.length.toLocaleString()} lines · {stream.characters.toLocaleString()}{' '}
          characters of output_text
        </Text>
        <Button
          label="Copy"
          variant="ghost"
          size="sm"
          icon={<Copy size={16} />}
          isDisabled={stream.text.length === 0}
          onClick={() => copyText(stream.text)}
        />
      </div>
      {stream.text.length === 0 ? (
        <EmptyState
          isCompact
          title="No output yet"
          description="The concatenated output_text stream appears here verbatim."
        />
      ) : (
        <VirtualRows
          testId="raw-output"
          total={lines.length}
          rowHeight={RAW_ROW_HEIGHT}
          label="Raw output lines"
          className="raw-output"
          rowClassName="virtual-rows__row raw-output__line"
          renderRow={renderRow}
        />
      )}
    </div>
  );
}
