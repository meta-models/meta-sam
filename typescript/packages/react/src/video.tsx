/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type CanvasHTMLAttributes,
} from 'react';
import { SegmentationRenderer, type VideoFrameFit } from '@meta-sam/graphics';
import type {
  VideoSegmentationResult,
  VideoSegmentationSnapshot,
} from '@meta-sam/parser';
import {
  getPacketAtTimeExact,
  type IMediaPlayer,
  type MediaCanvas,
  type MediaPlayerOptions,
  type MediaPlayerRenderContext,
  type MediaResource,
  type PlaybackStats,
  type VideoPacketMetadata,
  type VideoPacketTimeline,
} from '@meta-sam/video';
import {
  useMediaPlayer,
  type MediaPlayerCallbacks,
  type MediaPlayerLoadedMetadata,
} from './use-media-player.js';

export type VideoCaptureSource = 'composited' | 'raw';

export type VideoStats = PlaybackStats;

export interface VideoRef {
  play(): Promise<void>;
  pause(): void;
  seek(time: number): Promise<void>;
  seekToFrame(frameIndex: number): Promise<void>;
  nextFrame(): Promise<void>;
  previousFrame(): Promise<void>;
  getFrameIndexAtTimeExact(time: number): number;
  getTimeAtFrameIndexExact(frameIndex: number): number;
  getPacketAtTimeExact(time: number): VideoPacketMetadata;
  getVideoPackets(): VideoPacketTimeline;
  setPlaybackRate(playbackRate: number): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  setLoop(loop: boolean): void;
  forceRender(): Promise<void>;
  /** Returns a detached canvas snapshot that the caller owns. */
  captureFrame(source?: VideoCaptureSource): HTMLCanvasElement;
  getStats(): VideoStats;
  resetStats(): void;
}

export interface VideoProps extends MediaPlayerCallbacks {
  readonly src: MediaResource;
  readonly result?: VideoSegmentationResult | VideoSegmentationSnapshot;
  readonly renderer?: SegmentationRenderer;
  readonly hiddenIds?: ReadonlySet<string> | readonly string[];
  readonly objectFit?: VideoFrameFit;
  readonly devicePixelRatio?: number | (() => number);
  readonly loop?: boolean;
  readonly playbackRate?: number;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly autoPlay?: boolean;
  readonly initialSeekTime?: number;
  readonly playerOptions?: MediaPlayerOptions;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly canvasProps?: Omit<
    CanvasHTMLAttributes<HTMLCanvasElement>,
    'children' | 'ref' | 'width' | 'height'
  >;
}

function isExpectedRenderMiss(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'frame_metadata_unavailable' ||
      error.code === 'operation_cancelled' ||
      error.code === 'player_disposed')
  );
}

function resolvePixelRatio(value: number | (() => number) | undefined): number {
  const ratio =
    typeof value === 'function' ? value() : (value ?? globalThis.devicePixelRatio ?? 1);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new TypeError('devicePixelRatio must be finite and greater than zero.');
  }
  return ratio;
}

function unavailable(): never {
  throw new Error('The video player is not mounted.');
}

function rejectUnavailable(): Promise<never> {
  return Promise.reject(new Error('The video player is not mounted.'));
}

function runPlayerOperation(
  player: IMediaPlayer | null,
  operation: (activePlayer: IMediaPlayer) => Promise<void>,
): Promise<void> {
  if (player === null) return rejectUnavailable();
  try {
    return operation(player);
  } catch (error) {
    return Promise.reject(error);
  }
}

function requirePlayer(player: IMediaPlayer | null): IMediaPlayer {
  return player ?? unavailable();
}

function captureCanvas(
  visibleCanvas: HTMLCanvasElement | null,
  player: IMediaPlayer | null,
  source: VideoCaptureSource,
): HTMLCanvasElement {
  const canvas = visibleCanvas ?? unavailable();
  const media: MediaCanvas =
    source === 'composited'
      ? canvas
      : (requirePlayer(player).getCurrentFrame() ??
        (() => {
          throw new Error('No decoded video frame is available.');
        })());
  const snapshot = canvas.ownerDocument.createElement('canvas');
  snapshot.width = media.width;
  snapshot.height = media.height;
  const context = snapshot.getContext('2d');
  if (context === null) throw new Error('A Canvas 2D context is required.');
  context.drawImage(media, 0, 0, media.width, media.height);
  return snapshot;
}

export const Video = forwardRef<VideoRef, VideoProps>(function Video(props, ref) {
  const {
    src,
    result,
    renderer: suppliedRenderer,
    hiddenIds,
    objectFit,
    devicePixelRatio,
    loop,
    playbackRate,
    volume,
    muted,
    autoPlay,
    initialSeekTime,
    playerOptions,
    className,
    style,
    canvasProps,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SegmentationRenderer | null>(null);
  const propsRef = useRef(props);
  const updateGenerationRef = useRef(0);
  const metadataRef = useRef<MediaPlayerLoadedMetadata | null>(null);
  const [aspectRatio, setAspectRatio] = useState<string>();
  propsRef.current = props;

  const reportError = useCallback((error: unknown): void => {
    const normalized =
      error instanceof Error
        ? error
        : new Error('Video failed with a non-Error value.', { cause: error });
    propsRef.current.onError?.(normalized);
  }, []);

  useEffect(() => {
    const renderer = suppliedRenderer ?? new SegmentationRenderer();
    rendererRef.current = renderer;
    return () => {
      updateGenerationRef.current += 1;
      if (rendererRef.current === renderer) rendererRef.current = null;
      if (suppliedRenderer === undefined) renderer.dispose();
    };
  }, [suppliedRenderer]);

  const renderFrame = useCallback((context: MediaPlayerRenderContext): void => {
    const current = propsRef.current;
    rendererRef.current?.renderVideoFrame(context, {
      ...(current.objectFit === undefined ? {} : { fit: current.objectFit }),
      devicePixelRatio: () => resolvePixelRatio(current.devicePixelRatio),
      ...(current.hiddenIds === undefined ? {} : { hiddenIds: current.hiddenIds }),
    });
  }, []);

  const onLoadedMetadata = useCallback((metadata: MediaPlayerLoadedMetadata): void => {
    metadataRef.current = metadata;
    setAspectRatio(`${metadata.width} / ${metadata.height}`);
    propsRef.current.onLoadedMetadata?.(metadata);
  }, []);

  const playerRef = useMediaPlayer({
    canvasRef,
    src,
    ...(initialSeekTime === undefined ? {} : { initialSeekTime }),
    ...(loop === undefined ? {} : { loop }),
    ...(playbackRate === undefined ? {} : { playbackRate }),
    ...(volume === undefined ? {} : { volume }),
    ...(muted === undefined ? {} : { muted }),
    ...(autoPlay === undefined ? {} : { autoPlay }),
    ...(playerOptions === undefined ? {} : { playerOptions }),
    renderFrame,
    onLoadedMetadata,
    onTimeChange: (time) => propsRef.current.onTimeChange?.(time),
    onPlayingChange: (playing) => propsRef.current.onPlayingChange?.(playing),
    onDurationChange: (duration) => propsRef.current.onDurationChange?.(duration),
    onFrame: (frame) => propsRef.current.onFrame?.(frame),
    onAudioStatusChange: (status) => propsRef.current.onAudioStatusChange?.(status),
    onAudioWarning: (warning) => propsRef.current.onAudioWarning?.(warning),
    onError: reportError,
    onPlayerReady: (player) => propsRef.current.onPlayerReady?.(player),
  });

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null) return;
    if (result !== undefined && result.media !== 'video') {
      reportError(new TypeError('Video accepts only video segmentation results.'));
      return;
    }
    let active = true;
    const generation = ++updateGenerationRef.current;
    const update =
      result === undefined
        ? (renderer.clear(), Promise.resolve())
        : renderer.update(result, { reset: true });
    void update
      .then(async () => {
        if (
          !active ||
          generation !== updateGenerationRef.current ||
          rendererRef.current !== renderer
        ) {
          return;
        }
        try {
          await playerRef.current?.forceRender();
        } catch (error) {
          if (!isExpectedRenderMiss(error)) reportError(error);
        }
      })
      .catch((error: unknown) => {
        if (
          active &&
          generation === updateGenerationRef.current &&
          rendererRef.current === renderer
        ) {
          reportError(error);
        }
      });
    return () => {
      active = false;
    };
  }, [playerRef, reportError, result, suppliedRenderer]);

  useEffect(() => {
    const player = playerRef.current;
    if (player === null) return;
    void player.forceRender().catch((error: unknown) => {
      if (!isExpectedRenderMiss(error)) reportError(error);
    });
  }, [devicePixelRatio, hiddenIds, objectFit, playerRef, reportError]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const resize = (): void => {
      try {
        const metadata = metadataRef.current;
        const logicalWidth = canvas.clientWidth || metadata?.width || 0;
        const logicalHeight = canvas.clientHeight || metadata?.height || 0;
        if (logicalWidth <= 0 || logicalHeight <= 0) return;
        const ratio = resolvePixelRatio(propsRef.current.devicePixelRatio);
        const width = Math.round(logicalWidth * ratio);
        const height = Math.round(logicalHeight * ratio);
        if (canvas.width === width && canvas.height === height) return;
        canvas.width = width;
        canvas.height = height;
        void playerRef.current?.forceRender().catch((error: unknown) => {
          if (!isExpectedRenderMiss(error)) reportError(error);
        });
      } catch (error) {
        reportError(error);
      }
    };
    resize();
    const Observer = globalThis.ResizeObserver;
    if (Observer === undefined) return;
    const observer = new Observer(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [aspectRatio, devicePixelRatio, playerRef, reportError]);

  useImperativeHandle(
    ref,
    (): VideoRef => ({
      play: () => runPlayerOperation(playerRef.current, (player) => player.play()),
      pause: () => requirePlayer(playerRef.current).pause(),
      seek: (time) =>
        runPlayerOperation(playerRef.current, (player) => player.seek(time)),
      seekToFrame: (frameIndex) =>
        runPlayerOperation(playerRef.current, (player) =>
          player.seekToFrame(frameIndex),
        ),
      nextFrame: () =>
        runPlayerOperation(playerRef.current, (player) => player.nextFrame()),
      previousFrame: () =>
        runPlayerOperation(playerRef.current, (player) => player.previousFrame()),
      getFrameIndexAtTimeExact: (time) =>
        requirePlayer(playerRef.current).getFrameIndexAtTimeExact(time),
      getTimeAtFrameIndexExact: (frameIndex) =>
        requirePlayer(playerRef.current).getTimeAtFrameIndexExact(frameIndex),
      getPacketAtTimeExact: (time) => {
        const player = requirePlayer(playerRef.current);
        return getPacketAtTimeExact(player.getVideoPackets(), time);
      },
      getVideoPackets: () => requirePlayer(playerRef.current).getVideoPackets(),
      setPlaybackRate: (value) => {
        requirePlayer(playerRef.current).playbackRate = value;
      },
      setVolume: (value) => {
        requirePlayer(playerRef.current).volume = value;
      },
      setMuted: (value) => {
        requirePlayer(playerRef.current).muted = value;
      },
      setLoop: (value) => {
        requirePlayer(playerRef.current).loop = value;
      },
      forceRender: () =>
        runPlayerOperation(playerRef.current, (player) => player.forceRender()),
      captureFrame: (source = 'composited') =>
        captureCanvas(canvasRef.current, playerRef.current, source),
      getStats: () => requirePlayer(playerRef.current).getStats(),
      resetStats: () => requirePlayer(playerRef.current).resetStats(),
    }),
    [playerRef],
  );

  const rootStyle: CSSProperties = {
    position: 'relative',
    display: 'inline-block',
    overflow: 'hidden',
    width: '100%',
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    ...style,
  };
  const canvasStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    height: '100%',
    ...canvasProps?.style,
  };

  return (
    <span className={className} style={rootStyle}>
      <canvas {...canvasProps} ref={canvasRef} style={canvasStyle} />
    </span>
  );
});
