/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { Switch } from '@astryxdesign/core/Switch';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { objectColor } from '@meta-sam/graphics';
import {
  frameIndexOf,
  type SegmentationDiagnostic,
  type SegmentationRecord,
  type SegmentationResult,
  type SegmentationSnapshot,
} from '@meta-sam/parser';
import { Eye, EyeOff } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { InspectorTab, MediaKind, RunStatus, StreamState } from './model';
import { countRender } from './render-counts';
import { RawOutput } from './RawOutput';
import { StreamLog } from './StreamLog';

export interface InspectorProps {
  readonly tab: InspectorTab;
  readonly onTabChange: (tab: InspectorTab) => void;
  readonly mediaKind: MediaKind | null;
  readonly status: RunStatus;
  readonly snapshot: SegmentationSnapshot | SegmentationResult | null;
  readonly stream: StreamState;
  readonly hiddenObjectIds: readonly string[];
  readonly showOverlay: boolean;
  readonly showMasks: boolean;
  readonly showBoxes: boolean;
  readonly showOutlines: boolean;
  readonly currentFrame: number | null;
  readonly onToggleObject: (objectId: string) => void;
  readonly onShowAllObjects: () => void;
  readonly onSetView: (
    key: 'showOverlay' | 'showMasks' | 'showBoxes' | 'showOutlines',
    value: boolean,
  ) => void;
}

interface ObjectSummary {
  readonly objectId: string;
  readonly boxes: number;
  readonly masks: number;
  readonly frames: number;
}

const RECORD_DISPLAY_LIMIT = 400;

function summarizeObjects(records: readonly SegmentationRecord[]): ObjectSummary[] {
  const map = new Map<string, { boxes: number; masks: number; frames: Set<number> }>();
  for (const record of records) {
    if (record.kind === 'text') continue;
    let entry = map.get(record.objectId);
    if (entry === undefined) {
      entry = { boxes: 0, masks: 0, frames: new Set() };
      map.set(record.objectId, entry);
    }
    if (record.kind === 'box') entry.boxes += 1;
    if (record.kind === 'mask') entry.masks += 1;
    const frameIndex = frameIndexOf(record);
    if (frameIndex !== undefined) entry.frames.add(frameIndex);
  }
  return [...map.entries()].map(([objectId, entry]) => ({
    objectId,
    boxes: entry.boxes,
    masks: entry.masks,
    frames: entry.frames.size,
  }));
}

export function recordSummary(record: SegmentationRecord): string {
  switch (record.kind) {
    case 'text':
      return record.text.length > 80 ? `${record.text.slice(0, 77)}…` : record.text;
    case 'box':
      return `box (${record.left}, ${record.top}) → (${record.right}, ${record.bottom})`;
    case 'mask':
      return `mask ${record.mask.width}×${record.mask.height} · ${record.mask.encoding} · rev ${record.revision}`;
  }
}

function frameOf(record: SegmentationRecord): number | null {
  return frameIndexOf(record) ?? null;
}

export function Inspector({
  tab,
  onTabChange,
  mediaKind,
  status,
  snapshot,
  stream,
  hiddenObjectIds,
  showOverlay,
  showMasks,
  showBoxes,
  showOutlines,
  currentFrame,
  onToggleObject,
  onShowAllObjects,
  onSetView,
}: InspectorProps): React.JSX.Element {
  countRender('Inspector');
  const records = snapshot?.records ?? [];
  const diagnostics: readonly SegmentationDiagnostic[] = snapshot?.diagnostics ?? [];
  const objects = useMemo(() => summarizeObjects(records), [records]);
  const [frameOnly, setFrameOnly] = useState(true);
  const hidden = useMemo(() => new Set(hiddenObjectIds), [hiddenObjectIds]);
  const displayedRecords = useMemo(() => {
    const filtered =
      mediaKind === 'video' && frameOnly && currentFrame !== null
        ? records.filter((record) => {
            const frame = frameOf(record);
            return frame === null || frame === currentFrame;
          })
        : records;
    return filtered;
  }, [currentFrame, frameOnly, mediaKind, records]);

  return (
    <div className="inspector">
      <div className="inspector__tabs">
        <TabList
          value={tab}
          onChange={(value) => onTabChange(value as InspectorTab)}
          size="sm"
          role="tablist"
          aria-label="Inspector"
          hasDivider
        >
          <Tab
            value="objects"
            panelId="inspector-panel"
            label={`Objects (${objects.length})`}
          />
          <Tab
            value="records"
            panelId="inspector-panel"
            label={`Records (${records.length})`}
          />
          <Tab
            value="stream"
            panelId="inspector-panel"
            label={`Stream (${stream.entries.length})`}
          />
          <Tab value="raw" panelId="inspector-panel" label="Raw" />
        </TabList>
      </div>

      <div
        id="inspector-panel"
        className="inspector__body"
        role="tabpanel"
        aria-label={`${tab} panel`}
      >
        {tab === 'objects' ? (
          <VStack gap={3} padding={3}>
            <HStack gap={1} wrap="wrap">
              <ToggleButton
                label="Overlay"
                size="sm"
                isPressed={showOverlay}
                onPressedChange={(value) => onSetView('showOverlay', value)}
              >
                <Text type="body" color="inherit">
                  Overlay
                </Text>
              </ToggleButton>
              <ToggleButton
                label="Masks"
                size="sm"
                isPressed={showMasks}
                isDisabled={!showOverlay}
                onPressedChange={(value) => onSetView('showMasks', value)}
              >
                <Text type="body" color="inherit">
                  Masks
                </Text>
              </ToggleButton>
              <ToggleButton
                label="Boxes"
                size="sm"
                isPressed={showBoxes}
                isDisabled={!showOverlay}
                onPressedChange={(value) => onSetView('showBoxes', value)}
              >
                <Text type="body" color="inherit">
                  Boxes
                </Text>
              </ToggleButton>
              <ToggleButton
                label="Outlines"
                size="sm"
                isPressed={showOutlines}
                isDisabled={!showOverlay || !showMasks}
                onPressedChange={(value) => onSetView('showOutlines', value)}
              >
                <Text type="body" color="inherit">
                  Outlines
                </Text>
              </ToggleButton>
            </HStack>
            {objects.length === 0 ? (
              <EmptyState
                isCompact
                title="No objects yet"
                description={
                  status === 'streaming'
                    ? 'Objects appear as the model streams them.'
                    : 'Run segmentation to populate the legend.'
                }
              />
            ) : (
              <List
                className="legend"
                aria-label="Object legend"
                density="compact"
                hasDividers
              >
                {objects.map((object) => {
                  const isHidden = hidden.has(object.objectId);
                  return (
                    <ListItem
                      key={object.objectId}
                      className="legend__row"
                      data-hidden={isHidden}
                      startContent={
                        <span
                          className="legend__swatch"
                          style={{ background: objectColor(object.objectId) }}
                          aria-hidden="true"
                        />
                      }
                      label={<Text type="body">Object {object.objectId}</Text>}
                      description={
                        <Text type="supporting" color="secondary" hasTabularNumbers>
                          {mediaKind === 'video'
                            ? `${object.frames} frames · ${object.masks} masks · ${object.boxes} boxes`
                            : `${object.masks} mask${object.masks === 1 ? '' : 's'} · ${object.boxes} box${object.boxes === 1 ? '' : 'es'}`}
                        </Text>
                      }
                      endContent={
                        <ToggleButton
                          label={`Show object ${object.objectId}`}
                          isIconOnly
                          size="sm"
                          icon={<EyeOff />}
                          pressedIcon={<Eye />}
                          isPressed={!isHidden}
                          onPressedChange={() => onToggleObject(object.objectId)}
                        />
                      }
                    />
                  );
                })}
              </List>
            )}
            {hiddenObjectIds.length > 0 ? (
              <Button
                label="Show all objects"
                variant="ghost"
                size="sm"
                onClick={onShowAllObjects}
              />
            ) : null}
          </VStack>
        ) : null}

        {tab === 'records' ? (
          <VStack gap={3} padding={3}>
            {diagnostics.length > 0 ? (
              <Banner
                status="warning"
                title={`${diagnostics.length} parser diagnostic${diagnostics.length === 1 ? '' : 's'}`}
                description={diagnostics
                  .slice(0, 3)
                  .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
                  .join(' · ')}
              />
            ) : null}
            {mediaKind === 'video' ? (
              <HStack gap={3} align="center" justify="between" wrap="wrap">
                <Switch
                  label="Current frame only"
                  size="sm"
                  value={frameOnly}
                  onChange={setFrameOnly}
                />
                <Text type="supporting" color="secondary" hasTabularNumbers>
                  {displayedRecords.length} of {records.length}
                </Text>
              </HStack>
            ) : null}
            {displayedRecords.length === 0 ? (
              <EmptyState
                isCompact
                title="No records"
                description={
                  records.length > 0
                    ? 'Nothing was predicted for this frame.'
                    : 'Parsed boxes, masks, and text appear here.'
                }
              />
            ) : (
              <List
                className="records"
                aria-label="Output records"
                density="compact"
                hasDividers
              >
                {displayedRecords
                  .slice(0, RECORD_DISPLAY_LIMIT)
                  .map((record, index) => {
                    const frame = frameOf(record);
                    return (
                      <ListItem
                        key={`${record.order}-${index}`}
                        className="records__row"
                        startContent={
                          record.kind !== 'text' ? (
                            <span
                              className="legend__swatch legend__swatch--sm"
                              style={{ background: objectColor(record.objectId) }}
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="legend__swatch legend__swatch--sm legend__swatch--text" />
                          )
                        }
                        label={
                          <Text type="body" maxLines={1} hasTabularNumbers>
                            {frame !== null ? `f${frame} · ` : ''}
                            {record.kind !== 'text' ? `${record.objectId} · ` : ''}
                            {recordSummary(record)}
                          </Text>
                        }
                      />
                    );
                  })}
                {displayedRecords.length > RECORD_DISPLAY_LIMIT ? (
                  <ListItem
                    label={
                      <Text type="supporting" color="secondary">
                        Showing the first {RECORD_DISPLAY_LIMIT} of{' '}
                        {displayedRecords.length}. Download the raw stream for the full
                        set.
                      </Text>
                    }
                  />
                ) : null}
              </List>
            )}
          </VStack>
        ) : null}

        {tab === 'stream' ? <StreamLog stream={stream} /> : null}

        {tab === 'raw' ? <RawOutput stream={stream} /> : null}
      </div>
    </div>
  );
}
