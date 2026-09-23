/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Card } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Slider } from '@astryxdesign/core/Slider';
import { StackItem } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import {
  SegmentationRenderer,
  SegmentationGraphicsError,
  SegmentationResourceLimitError,
} from '@meta-sam/graphics';
import {
  frameIndexOf,
  type ImageSegmentationResult,
  type ImageSegmentationSnapshot,
  type SegmentationRecord,
  type SegmentationResult,
  type SegmentationSnapshot,
  type VideoSegmentationResult,
  type VideoSegmentationSnapshot,
} from '@meta-sam/parser';
import { Video, type VideoRef } from '@meta-sam/react';
import {
  MediaPlayerDisposedError,
  MediaPlayerOperationCancelledError,
  MediaPlayerSourceError,
  type VideoPacketTimeline,
} from '@meta-sam/video';
import {
  ChevronLeft,
  ChevronRight,
  ImageUp,
  Pause,
  Play,
  Repeat,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { MediaState, RunStatus } from './model';
import { countRender } from './render-counts';

type ImageSnapshot = ImageSegmentationSnapshot | ImageSegmentationResult;
type VideoSnapshot = VideoSegmentationSnapshot | VideoSegmentationResult;

export interface StageProps {
  readonly media: MediaState;
  readonly snapshot: SegmentationSnapshot | SegmentationResult | null;
  readonly hiddenObjectIds: readonly string[];
  readonly showOverlay: boolean;
  readonly showMasks: boolean;
  readonly showBoxes: boolean;
  readonly showOutlines: boolean;
  readonly status: RunStatus;
  readonly runId: number;
  readonly rendererAttempt: number;
  readonly onMediaMetadata: (runId: number, width: number, height: number) => void;
  readonly onRendererInitializing: (runId: number, attempt: number) => void;
  readonly onRendererReady: (
    runId: number,
    attempt: number,
    renderedRevision: number | null,
  ) => void;
  readonly onRendererError: (runId: number, attempt: number, message: string) => void;
  readonly onFrameChange?: (frameIndex: number) => void;
  /** While streaming, the newest predicted frame; the paused player follows it. */
  readonly followFrame?: number | null;
}

interface RendererHandle {
  readonly renderer: SegmentationRenderer;
  readonly runId: number;
  readonly attempt: number;
}

interface RendererStore {
  current: RendererHandle | null;
  readonly listeners: Set<() => void>;
}

const RENDER_ERROR = 'The segmentation visualization could not be rendered.';
const IMAGE_ERROR = 'The selected image could not be decoded.';
const VIDEO_ERROR = 'The selected video could not be opened.';

/**
 * Headroom for 1280×720 video with several full-body objects across a few
 * thousand frames: masks are retained by identity and traced per frame, so the
 * cache budget covers a handful of frames rather than the whole timeline.
 */
const RENDERER_OPTIONS = {
  maxRecords: 200_000,
  maxMasks: 65_536,
  maxBoxes: 131_072,
  maxMaskArea: 16_777_216,
  maxMaskPayloadLength: 4_000_000,
  maxPathComplexity: 1_000_000,
  maxRetainedComplexity: 8_000_000,
  maxCachedPaths: 512,
  maxCachedComplexity: 4_000_000,
} as const;

/**
 * Mask contours are a renderer-construction setting, so toggling them rebuilds
 * the renderer and re-traces the retained snapshot for the current frame.
 */
function rendererOptions(showOutlines: boolean) {
  return { ...RENDERER_OPTIONS, maskOutline: showOutlines };
}

/** Names the limit that stopped the render instead of the generic sentence. */
function renderErrorMessage(error: unknown): string {
  if (error instanceof SegmentationResourceLimitError) {
    return `${RENDER_ERROR} It exceeded the ${error.limit} limit.`;
  }
  if (error instanceof SegmentationGraphicsError) {
    return `${RENDER_ERROR} (${error.code})`;
  }
  return RENDER_ERROR;
}

function useRendererHandle(
  runId: number,
  attempt: number,
  showOutlines: boolean,
  onInitializing: (runId: number, attempt: number) => void,
  onError: (runId: number, attempt: number, message: string) => void,
): RendererHandle | null {
  const store = useRef<RendererStore>({ current: null, listeners: new Set() });
  const subscribe = useCallback((listener: () => void) => {
    store.current.listeners.add(listener);
    return () => store.current.listeners.delete(listener);
  }, []);
  const getSnapshot = useCallback(() => store.current.current, []);

  useEffect(() => {
    const currentStore = store.current;
    onInitializing(runId, attempt);
    let renderer: SegmentationRenderer;
    try {
      renderer = new SegmentationRenderer(rendererOptions(showOutlines));
    } catch (error) {
      onError(runId, attempt, renderErrorMessage(error));
      return;
    }
    const handle = { renderer, runId, attempt };
    currentStore.current = handle;
    for (const listener of currentStore.listeners) listener();
    return () => {
      if (currentStore.current === handle) {
        currentStore.current = null;
        for (const listener of currentStore.listeners) listener();
      }
      renderer.dispose();
    };
  }, [attempt, onError, onInitializing, runId, showOutlines]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function isLifecycleCancellation(error: unknown): boolean {
  return (
    error instanceof MediaPlayerDisposedError ||
    error instanceof MediaPlayerOperationCancelledError ||
    (error instanceof DOMException && error.name === 'AbortError')
  );
}

function filterRecords<T extends SegmentationSnapshot | SegmentationResult>(
  snapshot: T,
  showMasks: boolean,
  showBoxes: boolean,
): T {
  if (showMasks && showBoxes) return snapshot;
  const records = snapshot.records.filter(
    (record: SegmentationRecord) =>
      (record.kind !== 'mask' || showMasks) && (record.kind !== 'box' || showBoxes),
  );
  return Object.freeze({
    ...snapshot,
    records: Object.freeze(records),
  }) as unknown as T;
}

function aspectStyle(width: number, height: number): React.CSSProperties {
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  return { '--media-aspect': String(aspect) } as React.CSSProperties;
}

function formatSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}s`;
}

export function Stage(props: StageProps): React.JSX.Element {
  countRender('Stage');
  const { media } = props;
  if (media.kind === 'video' && media.sourceUrl !== null) {
    return <VideoStage key={`video:${props.runId}`} {...props} />;
  }
  if (media.kind === 'image' && media.sourceUrl !== null) {
    return <ImageStage key={`image:${media.sourceUrl}`} {...props} />;
  }
  return (
    <div className="stage-frame stage-frame--empty" data-run-status={props.status}>
      <EmptyState
        icon={<ImageUp size={20} />}
        headingLevel={2}
        title="Drop an image or video, or pick an example"
        description="PNG, JPEG, WebP, GIF, or MP4 up to 20 MB. Segmentation runs against the live SAM 3 API and streams onto this canvas."
      />
    </div>
  );
}

function ImageStage({
  media,
  snapshot,
  hiddenObjectIds,
  showOverlay,
  showMasks,
  showBoxes,
  showOutlines,
  status,
  runId,
  rendererAttempt,
  onRendererInitializing,
  onRendererReady,
  onRendererError,
}: StageProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastResetKey = useRef<string | null>(null);
  const lastSnapshot = useRef<ImageSnapshot | null>(null);
  // Counts completed paints so tests can wait for the paint after a change.
  const paints = useRef(0);
  const rendererHandle = useRendererHandle(
    runId,
    rendererAttempt,
    showOutlines,
    onRendererInitializing,
    onRendererError,
  );
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const sourceUrl = media.sourceUrl;
  const sourceWidth = media.sourceWidth;
  const sourceHeight = media.sourceHeight;
  const visibleSnapshot = useMemo(
    () =>
      snapshot === null || snapshot.media !== 'image'
        ? null
        : filterRecords(snapshot as ImageSnapshot, showMasks, showBoxes),
    [showBoxes, showMasks, snapshot],
  );
  const hiddenKey = useMemo(
    () => [...hiddenObjectIds].sort().join('\u0000'),
    [hiddenObjectIds],
  );

  useEffect(() => {
    lastResetKey.current = null;
    lastSnapshot.current = null;
    const canvas = canvasRef.current;
    if (canvas !== null) {
      canvas.width = 1;
      canvas.height = 1;
      delete canvas.dataset.revision;
    }
  }, [rendererHandle]);

  useEffect(() => {
    let active = true;
    if (sourceUrl === null) return;
    const element = new Image();
    element.onload = () => {
      if (active) setImage(element);
    };
    element.onerror = () => {
      if (!active) return;
      setLoadError(true);
      onRendererError(runId, rendererAttempt, IMAGE_ERROR);
    };
    element.src = sourceUrl;
    return () => {
      active = false;
      element.onload = null;
      element.onerror = null;
    };
  }, [onRendererError, rendererAttempt, runId, sourceUrl]);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    let active = true;
    const update = () => {
      if (!active) return;
      const rect = frame.getBoundingClientRect();
      setSize({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const handle = rendererHandle;
    if (
      canvas === null ||
      handle === null ||
      handle.runId !== runId ||
      handle.attempt !== rendererAttempt ||
      image === null ||
      sourceWidth <= 0 ||
      sourceHeight <= 0
    ) {
      return;
    }
    let cancelled = false;
    const render = async () => {
      try {
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.max(1, Math.round(size.width * dpr));
        canvas.height = Math.max(1, Math.round(size.height * dpr));
        const context = canvas.getContext('2d');
        if (context === null) throw new Error('Canvas 2D is unavailable.');
        const scale = Math.min(size.width / sourceWidth, size.height / sourceHeight);
        const target = {
          x: (size.width - sourceWidth * scale) / 2,
          y: (size.height - sourceHeight * scale) / 2,
          width: sourceWidth * scale,
          height: sourceHeight * scale,
        };
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, size.width, size.height);
        context.drawImage(image, target.x, target.y, target.width, target.height);
        if (visibleSnapshot === null || !showOverlay) {
          handle.renderer.clear();
          lastResetKey.current = null;
          lastSnapshot.current = null;
        } else {
          const resetKey = `${runId}\u0000${sourceUrl ?? ''}`;
          const reset = lastResetKey.current !== resetKey;
          if (reset || lastSnapshot.current !== visibleSnapshot) {
            await handle.renderer.update(visibleSnapshot, { reset });
            if (cancelled) return;
            lastResetKey.current = resetKey;
            lastSnapshot.current = visibleSnapshot;
          }
          context.save();
          try {
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
            handle.renderer.render(context, {
              media: 'image',
              source: { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
              target,
              hiddenIds: hiddenObjectIds,
            });
          } finally {
            context.restore();
          }
        }
        if (cancelled) return;
        const revision = showOverlay ? (visibleSnapshot?.revision ?? null) : null;
        if (revision === null) delete canvas.dataset.revision;
        else canvas.dataset.revision = String(revision);
        paints.current += 1;
        canvas.dataset.paint = String(paints.current);
        onRendererReady(runId, rendererAttempt, revision);
      } catch (error) {
        if (!cancelled)
          onRendererError(runId, rendererAttempt, renderErrorMessage(error));
      }
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [
    hiddenKey,
    hiddenObjectIds,
    image,
    onRendererError,
    onRendererReady,
    rendererAttempt,
    rendererHandle,
    runId,
    showOverlay,
    size,
    sourceHeight,
    sourceUrl,
    sourceWidth,
    visibleSnapshot,
  ]);

  const label = media.sourceName
    ? `Segmentation visualization for ${media.sourceName}`
    : 'Segmentation visualization';

  return (
    <div
      className="stage-frame stage-frame--fit"
      ref={frameRef}
      data-run-status={status}
      style={aspectStyle(sourceWidth, sourceHeight)}
    >
      {loadError ? (
        <div className="stage-empty">
          <Text type="supporting" color="secondary">
            {IMAGE_ERROR}
          </Text>
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          className="stage-canvas"
          data-testid="media-canvas"
          role="img"
          aria-label={label}
        >
          {label}. Use the records panel for a text alternative.
        </canvas>
      )}
    </div>
  );
}

const playbackRates = ['0.25', '0.5', '1', '2'] as const;

function VideoStage({
  media,
  snapshot,
  hiddenObjectIds,
  showOverlay,
  showMasks,
  showBoxes,
  showOutlines,
  status,
  runId,
  rendererAttempt,
  onMediaMetadata,
  onRendererInitializing,
  onRendererReady,
  onRendererError,
  onFrameChange,
  followFrame,
}: StageProps): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoRef>(null);
  const followedFrame = useRef<number | null>(null);
  const paints = useRef(0);
  const renderGeneration = useRef(0);
  const committedUpdate = useRef(false);
  const reportedFailure = useRef<number | null>(null);
  const rendererHandle = useRendererHandle(
    runId,
    rendererAttempt,
    showOutlines,
    onRendererInitializing,
    onRendererError,
  );
  const [loaded, setLoaded] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<VideoPacketTimeline>(Object.freeze([]));
  const [currentTime, setCurrentTime] = useState(0);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState<(typeof playbackRates)[number]>('1');
  const [playerError, setPlayerError] = useState<string | null>(null);
  const source = media.file ?? media.sourceUrl;
  const frameCount = timeline.length;

  const visibleSnapshot = useMemo(
    () =>
      snapshot === null || snapshot.media !== 'video'
        ? null
        : filterRecords(snapshot as VideoSnapshot, showMasks, showBoxes),
    [showBoxes, showMasks, snapshot],
  );
  const hiddenKey = useMemo(
    () => [...hiddenObjectIds].sort().join('\u0000'),
    [hiddenObjectIds],
  );
  const predictedFrames = useMemo(() => {
    const frames = new Set<number>();
    for (const record of snapshot?.records ?? []) {
      const frameIndex = frameIndexOf(record);
      if (frameIndex !== undefined) frames.add(frameIndex);
    }
    return frames;
  }, [snapshot]);

  const reportFailure = useCallback(
    (generation: number, message: string = RENDER_ERROR) => {
      if (
        generation !== renderGeneration.current ||
        reportedFailure.current === generation
      ) {
        return;
      }
      reportedFailure.current = generation;
      onRendererError(runId, rendererAttempt, message);
    },
    [onRendererError, rendererAttempt, runId],
  );

  const handleVideoError = useCallback(
    (error: unknown) => {
      if (isLifecycleCancellation(error)) return;
      if (error instanceof MediaPlayerSourceError) {
        const message = `${VIDEO_ERROR} ${error.message}`;
        setPlayerError(message);
        onRendererError(runId, rendererAttempt, message);
        return;
      }
      if (error instanceof SegmentationGraphicsError) {
        reportFailure(renderGeneration.current, renderErrorMessage(error));
        return;
      }
      setPlayerError(error instanceof Error ? error.message : String(error));
    },
    [onRendererError, rendererAttempt, reportFailure, runId],
  );

  useEffect(() => {
    renderGeneration.current += 1;
    committedUpdate.current = false;
  }, [rendererHandle]);

  useEffect(() => {
    const handle = rendererHandle;
    if (
      handle === null ||
      handle.runId !== runId ||
      handle.attempt !== rendererAttempt ||
      !loaded
    ) {
      return;
    }
    const generation = ++renderGeneration.current;
    onRendererInitializing(runId, rendererAttempt);
    let cancelled = false;
    const render = async () => {
      const revision = showOverlay ? (visibleSnapshot?.revision ?? null) : null;
      const canvas = frameRef.current?.querySelector('canvas') ?? null;
      if (canvas === null) {
        reportFailure(generation);
        return;
      }
      delete canvas.dataset.revision;
      try {
        if (!showOverlay || visibleSnapshot === null) {
          handle.renderer.clear();
          committedUpdate.current = false;
        } else {
          // Cumulative snapshots extend the retained state; only the first
          // update for a renderer resets it, so traced frames stay cached.
          await handle.renderer.update(visibleSnapshot, {
            reset: !committedUpdate.current,
          });
          committedUpdate.current = true;
        }
        if (cancelled || generation !== renderGeneration.current) return;
        await videoRef.current?.forceRender();
      } catch (error) {
        if (!cancelled && !isLifecycleCancellation(error)) {
          reportFailure(generation, renderErrorMessage(error));
        }
        return;
      }
      if (cancelled || generation !== renderGeneration.current) return;
      if (revision === null) delete canvas.dataset.revision;
      else canvas.dataset.revision = String(revision);
      paints.current += 1;
      canvas.dataset.paint = String(paints.current);
      onRendererReady(runId, rendererAttempt, revision);
    };
    void render();
    return () => {
      cancelled = true;
    };
  }, [
    hiddenKey,
    loaded,
    onRendererInitializing,
    onRendererReady,
    rendererAttempt,
    rendererHandle,
    reportFailure,
    runId,
    showOverlay,
    visibleSnapshot,
  ]);

  useEffect(() => {
    if (
      followFrame === undefined ||
      followFrame === null ||
      !loaded ||
      playing ||
      followFrame === followedFrame.current ||
      followFrame < 0 ||
      followFrame >= frameCount
    ) {
      return;
    }
    followedFrame.current = followFrame;
    setCurrentFrame(followFrame);
    void Promise.resolve()
      .then(() => videoRef.current?.seekToFrame(followFrame))
      .catch((error: unknown) => {
        if (!isLifecycleCancellation(error)) handleVideoError(error);
      });
  }, [followFrame, frameCount, handleVideoError, loaded, playing]);

  const perform = (operation: () => Promise<void> | void) => {
    void Promise.resolve()
      .then(operation)
      .catch((error: unknown) => {
        if (!isLifecycleCancellation(error)) handleVideoError(error);
      });
  };

  const seekFrame = (frameIndex: number) => {
    const exact = Math.max(0, Math.min(frameCount - 1, Math.round(frameIndex)));
    setCurrentFrame(exact);
    perform(() => videoRef.current?.seekToFrame(exact));
  };

  const marks = useMemo(() => {
    if (frameCount === 0 || predictedFrames.size === 0) return undefined;
    const step = Math.max(1, Math.ceil(frameCount / 60));
    const values: { value: number }[] = [];
    for (let index = 0; index < frameCount; index += step) {
      if (predictedFrames.has(index)) values.push({ value: index });
    }
    return values.length > 0 ? values : undefined;
  }, [frameCount, predictedFrames]);

  const label = `Video segmentation visualization for ${media.sourceName ?? 'video'}`;

  return (
    <VStack className="stage-shell" gap={3} align="center" justify="center">
      <div
        className="stage-frame stage-frame--fit stage-frame--video"
        ref={frameRef}
        data-run-status={status}
        style={aspectStyle(media.sourceWidth, media.sourceHeight)}
      >
        {rendererHandle !== null && source !== null && playerError === null ? (
          <Video
            ref={videoRef}
            src={source}
            renderer={rendererHandle.renderer}
            hiddenIds={hiddenObjectIds}
            loop={loop}
            muted={muted}
            playbackRate={Number(rate)}
            className="stage-video"
            canvasProps={{
              className: 'stage-canvas',
              role: 'img',
              'aria-label': label,
              ...({ 'data-testid': 'media-canvas' } as Record<string, string>),
            }}
            onLoadedMetadata={(metadata) => {
              setLoaded(true);
              setTimeline(metadata.videoPackets);
              setDuration(metadata.duration);
              setCurrentFrame(0);
              setCurrentTime(metadata.videoPackets[0]?.timestamp ?? 0);
              onMediaMetadata(runId, metadata.width, metadata.height);
              onFrameChange?.(0);
            }}
            onDurationChange={setDuration}
            onTimeChange={setCurrentTime}
            onPlayingChange={setPlaying}
            onFrame={({ time, frameIndex }) => {
              setCurrentTime(time);
              setCurrentFrame(frameIndex);
              onFrameChange?.(frameIndex);
            }}
            onError={handleVideoError}
          />
        ) : playerError !== null ? (
          <div className="stage-empty">
            <Text type="supporting" color="secondary">
              {playerError}
            </Text>
          </div>
        ) : null}
      </div>
      <Card width="100%" padding={2}>
        <HStack
          gap={3}
          align="center"
          wrap="wrap"
          aria-label="Video transport"
          role="group"
        >
          <HStack gap={1} align="center">
            <Tooltip content={playing ? 'Pause' : 'Play'}>
              <IconButton
                label={playing ? 'Pause' : 'Play'}
                variant="primary"
                size="sm"
                icon={playing ? <Pause size={16} /> : <Play size={16} />}
                isDisabled={!loaded}
                onClick={() =>
                  perform(() =>
                    playing ? videoRef.current?.pause() : videoRef.current?.play(),
                  )
                }
              />
            </Tooltip>
            <Tooltip content="Previous frame">
              <IconButton
                label="Previous frame"
                variant="ghost"
                size="sm"
                icon={<ChevronLeft size={16} />}
                isDisabled={!loaded || currentFrame <= 0}
                onClick={() => seekFrame(currentFrame - 1)}
              />
            </Tooltip>
            <Tooltip content="Next frame">
              <IconButton
                label="Next frame"
                variant="ghost"
                size="sm"
                icon={<ChevronRight size={16} />}
                isDisabled={!loaded || currentFrame >= frameCount - 1}
                onClick={() => seekFrame(currentFrame + 1)}
              />
            </Tooltip>
          </HStack>
          <StackItem size="fill" className="transport__scrubber">
            <Slider
              label="Frame"
              isLabelHidden
              value={Math.min(currentFrame, Math.max(0, frameCount - 1))}
              min={0}
              max={Math.max(0, frameCount - 1)}
              step={1}
              isDisabled={!loaded}
              {...(marks === undefined ? {} : { marks })}
              valueDisplay="none"
              onChange={seekFrame}
              data-testid="frame-slider"
            />
          </StackItem>
          <Text
            type="supporting"
            color="secondary"
            hasTabularNumbers
            textWrap="nowrap"
            data-testid="video-time"
          >
            {formatSeconds(currentTime)} / {formatSeconds(duration)}
          </Text>
          <Text
            type="supporting"
            color="secondary"
            hasTabularNumbers
            textWrap="nowrap"
            data-testid="video-frame-count"
          >
            {frameCount === 0 ? 'frame —' : `frame ${currentFrame} / ${frameCount - 1}`}
          </Text>
          <HStack gap={1} align="center">
            <SegmentedControl
              label="Playback rate"
              size="sm"
              value={rate}
              onChange={(value) => {
                setRate(value as (typeof playbackRates)[number]);
                perform(() => videoRef.current?.setPlaybackRate(Number(value)));
              }}
            >
              {playbackRates.map((value) => (
                <SegmentedControlItem key={value} value={value} label={`${value}×`} />
              ))}
            </SegmentedControl>
            <Tooltip content={loop ? 'Loop on' : 'Loop off'}>
              <IconButton
                label="Loop"
                aria-pressed={loop}
                variant={loop ? 'secondary' : 'ghost'}
                size="sm"
                icon={<Repeat size={16} />}
                onClick={() => setLoop((value) => !value)}
              />
            </Tooltip>
            <Tooltip content={muted ? 'Unmute' : 'Mute'}>
              <IconButton
                label={muted ? 'Unmute' : 'Mute'}
                aria-pressed={muted}
                variant="ghost"
                size="sm"
                icon={muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                onClick={() => setMuted((value) => !value)}
              />
            </Tooltip>
          </HStack>
        </HStack>
      </Card>
    </VStack>
  );
}
