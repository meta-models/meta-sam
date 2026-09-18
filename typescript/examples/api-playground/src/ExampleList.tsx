/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Film, Image as ImageIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { MediaExample } from './examples';
import { cachedPoster, loadPoster, posterFailed } from './posters';
import { countRender } from './render-counts';

export interface ExampleListProps {
  readonly examples: readonly MediaExample[];
  readonly selectedId: string | null;
  readonly isDisabled: boolean;
  readonly onSelect: (example: MediaExample) => void;
}

type PreviewState = 'off' | 'playing' | 'paused';

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function ExampleThumbnail({
  example,
  preview,
}: {
  readonly example: MediaExample;
  readonly preview: PreviewState;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [poster, setPoster] = useState<string | null>(() =>
    example.kind === 'video' ? cachedPoster(example.url) : null,
  );
  const [failed, setFailed] = useState(
    () => example.kind === 'video' && posterFailed(example.url),
  );

  useEffect(() => {
    if (example.kind !== 'video' || poster !== null || failed) return;
    let active = true;
    void loadPoster(example.url).then((value) => {
      if (!active) return;
      if (value === null) setFailed(true);
      else setPoster(value);
    });
    return () => {
      active = false;
    };
  }, [example.kind, example.url, failed, poster]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (preview === 'playing') {
      void video.play().catch(() => undefined);
      return;
    }
    video.pause();
    video.currentTime = 0;
  }, [preview]);

  const still =
    example.kind === 'image' ? (
      <img
        className="example-thumb__image"
        src={example.url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
      />
    ) : poster !== null ? (
      <img
        className="example-thumb__image"
        src={poster}
        alt=""
        decoding="async"
        draggable={false}
      />
    ) : (
      <span className="example-thumb__icon" aria-hidden="true">
        {example.kind === 'video' ? <Film size={16} /> : <ImageIcon size={16} />}
      </span>
    );

  return (
    <span className="example-thumb" data-kind={example.kind} aria-hidden="true">
      {still}
      {preview === 'off' ? null : (
        <video
          ref={videoRef}
          className="example-thumb__preview"
          src={example.url}
          muted
          loop
          playsInline
          preload="none"
          tabIndex={-1}
          data-testid={`example-preview-${example.id}`}
        />
      )}
    </span>
  );
}

/**
 * The example rail. One row at a time may hold a hover preview, so a single
 * `<video>` is mounted for the row the pointer or keyboard focus is on; leaving
 * pauses and rewinds it rather than starting a second one elsewhere.
 */
export function ExampleList({
  examples,
  selectedId,
  isDisabled,
  onSelect,
}: ExampleListProps): React.JSX.Element {
  countRender('ExampleList');
  const [preview, setPreview] = useState<{ id: string; playing: boolean } | null>(null);

  const start = (example: MediaExample) => {
    if (example.kind !== 'video' || prefersReducedMotion()) return;
    setPreview({ id: example.id, playing: true });
  };
  const stop = (example: MediaExample) => {
    setPreview((current) =>
      current === null || current.id !== example.id
        ? current
        : { ...current, playing: false },
    );
  };

  return (
    <List className="examples" aria-label="Examples" density="compact">
      {examples.map((example) => {
        const state: PreviewState =
          preview === null || preview.id !== example.id
            ? 'off'
            : preview.playing
              ? 'playing'
              : 'paused';
        return (
          <ListItem
            key={example.id}
            className="examples__row"
            label={<Text type="body">{example.title}</Text>}
            endContent={
              <Text type="supporting" color="secondary" hasTabularNumbers>
                {example.durationSeconds !== undefined
                  ? `${example.durationSeconds.toFixed(1)}s`
                  : 'image'}
              </Text>
            }
            startContent={<ExampleThumbnail example={example} preview={state} />}
            isSelected={selectedId === example.id}
            isDisabled={isDisabled}
            onClick={() => onSelect(example)}
            onPointerEnter={() => start(example)}
            onPointerLeave={() => stop(example)}
            onFocus={() => start(example)}
            onBlur={() => stop(example)}
          />
        );
      })}
    </List>
  );
}
