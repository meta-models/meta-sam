/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { List, ListItem } from '@astryxdesign/core/List';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { VStack } from '@astryxdesign/core/VStack';
import { objectColor } from '@meta-sam/graphics';
import { X } from 'lucide-react';

import {
  describeObjectPrompt,
  MAX_PROMPT_OBJECTS,
  promptFrames,
  type ObjectPromptAction,
  type ObjectPromptState,
  type PromptTool,
} from './object-prompts';

export interface ObjectPromptPanelProps {
  readonly prompts: ObjectPromptState;
  readonly promptText: string | null;
  readonly mediaKind: 'image' | 'video';
  /** The video frame the stage shows; new prompts go on it. */
  readonly currentFrame: number;
  readonly isDisabled: boolean;
  readonly dispatch: (action: ObjectPromptAction) => void;
  /** Shows a video frame; absent for images. */
  readonly onSeekFrame?: (frameIndex: number) => void;
}

const toolHints: Record<PromptTool, string> = {
  positive:
    'Drag on the canvas to draw a box around the object. Click to add a positive point, part of the object; Option-click or right-click to add a negative point, a region that is not.',
  negative:
    'Drag on the canvas to draw a box around the object. Click to add a negative point, a region that is not part of the object.',
};

/**
 * The rail controls for box and click prompts: the drawing tool, the objects
 * being prompted, and the exact text the request sends.
 */
export function ObjectPromptPanel({
  prompts,
  promptText,
  mediaKind,
  currentFrame,
  isDisabled,
  dispatch,
  onSeekFrame,
}: ObjectPromptPanelProps): React.JSX.Element {
  const isVideo = mediaKind === 'video';
  const hasEmptyObject = prompts.objects.some((object) => object.frames.length === 0);
  const frames = promptFrames(prompts);
  const currentHasPrompts = frames.includes(currentFrame);
  const frameNote = isVideo
    ? ` New prompts go on frame ${currentFrame}. Move to another frame to correct an object there or to start a new one.`
    : '';

  return (
    <VStack gap={2} data-testid="object-prompts">
      <SegmentedControl
        label="Click adds"
        size="sm"
        value={prompts.tool}
        isDisabled={isDisabled}
        onChange={(tool) =>
          dispatch({ type: 'setPromptTool', tool: tool as PromptTool })
        }
      >
        <SegmentedControlItem value="positive" label="Positive point" />
        <SegmentedControlItem value="negative" label="Negative point" />
      </SegmentedControl>
      <Text type="supporting" color="secondary">
        {toolHints[prompts.tool]}
        {frameNote}
      </Text>
      {prompts.objects.length === 0 ? null : (
        <List aria-label="Prompted objects" density="compact" hasDividers>
          {prompts.objects.map((object) => (
            <ListItem
              key={object.id}
              isSelected={object.id === prompts.selectedId}
              isDisabled={isDisabled}
              onClick={() => dispatch({ type: 'selectPromptObject', id: object.id })}
              startContent={
                <span
                  className="legend__swatch"
                  style={{ background: objectColor(String(object.id)) }}
                  aria-hidden="true"
                />
              }
              label={<Text type="body">Object {object.id}</Text>}
              description={
                <Text type="supporting" color="secondary">
                  {describeObjectPrompt(object, isVideo)}
                </Text>
              }
              endContent={
                <IconButton
                  label={`Remove object ${object.id}`}
                  variant="ghost"
                  size="sm"
                  icon={<X size={14} />}
                  isDisabled={isDisabled}
                  onClick={() =>
                    dispatch({ type: 'removePromptObject', id: object.id })
                  }
                />
              }
            />
          ))}
        </List>
      )}
      {isVideo && frames.length > 0 ? (
        <VStack gap={1}>
          <Text type="supporting" color="secondary">
            Frames with prompts
          </Text>
          <HStack gap={1} wrap="wrap" data-testid="prompt-frames">
            {frames.map((frame) => (
              <Button
                key={frame}
                label={`Frame ${frame}`}
                variant={frame === currentFrame ? 'primary' : 'secondary'}
                size="sm"
                isDisabled={onSeekFrame === undefined}
                onClick={() => onSeekFrame?.(frame)}
              />
            ))}
          </HStack>
        </VStack>
      ) : null}
      <HStack gap={2} wrap="wrap">
        <Button
          label="New object"
          variant="secondary"
          size="sm"
          isDisabled={
            isDisabled || hasEmptyObject || prompts.objects.length >= MAX_PROMPT_OBJECTS
          }
          onClick={() => dispatch({ type: 'addPromptObject' })}
        />
        {isVideo ? (
          <Button
            label={`Clear frame ${currentFrame}`}
            variant="ghost"
            size="sm"
            isDisabled={isDisabled || !currentHasPrompts}
            onClick={() =>
              dispatch({ type: 'clearPromptFrame', frameIndex: currentFrame })
            }
          />
        ) : null}
        <Button
          label="Clear prompts"
          variant="ghost"
          size="sm"
          isDisabled={isDisabled || prompts.objects.length === 0}
          onClick={() => dispatch({ type: 'clearPromptObjects' })}
        />
      </HStack>
      <TextArea
        label="Prompt text"
        description="Sent as the input text in place of a noun phrase."
        value={promptText ?? ''}
        placeholder="Draw a box or add a point"
        rows={3}
        isReadOnly
      />
    </VStack>
  );
}
