/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

'use client';

import { useEffect, useRef, type RefObject } from 'react';
import {
  createMediaPlayer,
  type CustomRenderFunction,
  type IMediaPlayer,
  type MediaPlayerAudioError,
  type MediaPlayerAudioStatus,
  type MediaPlayerEventMap,
  type MediaPlayerOptions,
  type MediaResource,
} from '@meta-sam/video';

export type MediaPlayerLoadedMetadata = MediaPlayerEventMap['loadedmetadata'];
export type MediaPlayerFrame = MediaPlayerEventMap['frame'];

export interface MediaPlayerCallbacks {
  readonly onTimeChange?: (time: number) => void;
  readonly onPlayingChange?: (playing: boolean) => void;
  readonly onDurationChange?: (duration: number) => void;
  readonly onLoadedMetadata?: (metadata: MediaPlayerLoadedMetadata) => void;
  readonly onFrame?: (frame: MediaPlayerFrame) => void;
  readonly onAudioStatusChange?: (status: MediaPlayerAudioStatus) => void;
  readonly onAudioWarning?: (warning: MediaPlayerAudioError) => void;
  readonly onError?: (error: Error) => void;
  readonly onPlayerReady?: (player: IMediaPlayer) => void;
}

export interface UseMediaPlayerOptions extends MediaPlayerCallbacks {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly src: MediaResource;
  /** Applied when this source is first opened. Later changes do not seek it again. */
  readonly initialSeekTime?: number;
  readonly loop?: boolean;
  readonly playbackRate?: number;
  readonly volume?: number;
  readonly muted?: boolean;
  readonly autoPlay?: boolean;
  readonly renderFrame?: CustomRenderFunction;
  /** Construction-only options, read when a canvas receives its player. */
  readonly playerOptions?: MediaPlayerOptions;
}

interface OwnedPlayer {
  readonly player: IMediaPlayer;
  readonly canvas: HTMLCanvasElement;
  readonly renderFrame: CustomRenderFunction;
  source: MediaResource | typeof noSource;
  openingSource: MediaResource | typeof noSource;
  openGeneration: number;
  customRendering: boolean;
  lastRenderFrame: CustomRenderFunction | undefined;
}

const noSource = Symbol('no-source');

function isCancelled(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'operation_cancelled' || error.code === 'player_disposed')
  );
}

/**
 * Owns a Canvas-only @meta-sam/video player for a caller-owned canvas.
 *
 * The returned ref is stable. The hook owns and disposes every player it creates.
 */
export function useMediaPlayer(
  options: UseMediaPlayerOptions,
): RefObject<IMediaPlayer | null> {
  const playerRef = useRef<IMediaPlayer | null>(null);
  const ownedRef = useRef<OwnedPlayer | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const report = (error: unknown): void => {
      const normalized =
        error instanceof Error
          ? error
          : new Error('The media player failed with a non-Error value.', {
              cause: error,
            });
      try {
        optionsRef.current.onError?.(normalized);
      } catch {
        // Error callbacks are terminal observers and must not break lifecycle cleanup.
      }
    };

    const dispose = (owned: OwnedPlayer): void => {
      owned.openGeneration += 1;
      if (ownedRef.current === owned) ownedRef.current = null;
      if (playerRef.current === owned.player) playerRef.current = null;
      owned.player.dispose();
    };

    const canvas = optionsRef.current.canvasRef.current;
    let owned = ownedRef.current;
    if (owned !== null && owned.canvas !== canvas) {
      dispose(owned);
      owned = null;
    }
    if (canvas === null) return;

    if (owned === null) {
      try {
        const player = createMediaPlayer(canvas, optionsRef.current.playerOptions);
        let created!: OwnedPlayer;
        const renderFrame: CustomRenderFunction = (context) =>
          optionsRef.current.renderFrame?.(context);
        created = {
          player,
          canvas,
          renderFrame,
          source: noSource,
          openingSource: noSource,
          openGeneration: 0,
          customRendering: false,
          lastRenderFrame: undefined,
        };
        ownedRef.current = created;
        playerRef.current = player;
        owned = created;

        const current = (): boolean => ownedRef.current === created;
        player.on('timeupdate', ({ time }) => {
          if (current()) optionsRef.current.onTimeChange?.(time);
        });
        player.on('play', () => {
          if (current()) optionsRef.current.onPlayingChange?.(true);
        });
        player.on('pause', () => {
          if (current()) optionsRef.current.onPlayingChange?.(false);
        });
        player.on('ended', () => {
          if (current()) optionsRef.current.onPlayingChange?.(false);
        });
        player.on('durationchange', ({ duration }) => {
          if (current()) optionsRef.current.onDurationChange?.(duration);
        });
        player.on('loadedmetadata', (metadata) => {
          if (current()) optionsRef.current.onLoadedMetadata?.(metadata);
        });
        player.on('frame', (frame) => {
          if (current()) optionsRef.current.onFrame?.(frame);
        });
        player.on('audiostatuschange', (status) => {
          if (current()) optionsRef.current.onAudioStatusChange?.(status);
        });
        player.on('audiowarning', ({ warning }) => {
          if (current()) optionsRef.current.onAudioWarning?.(warning);
        });
        player.on('error', ({ error }) => {
          if (!current()) return;
          try {
            optionsRef.current.onError?.(error);
          } catch {
            // MediaPlayer treats error listeners as terminal observers.
          }
        });

        try {
          optionsRef.current.onPlayerReady?.(player);
        } catch (error) {
          report(error);
        }
      } catch (error) {
        report(error);
        return;
      }
    }

    const currentOptions = optionsRef.current;
    const useCustomRendering = currentOptions.renderFrame !== undefined;
    if (owned.customRendering !== useCustomRendering) {
      owned.customRendering = useCustomRendering;
      owned.lastRenderFrame = currentOptions.renderFrame;
      owned.player.setCustomRender(useCustomRendering ? owned.renderFrame : null);
    } else if (
      useCustomRendering &&
      owned.lastRenderFrame !== currentOptions.renderFrame
    ) {
      owned.lastRenderFrame = currentOptions.renderFrame;
      void owned.player.forceRender().catch(() => undefined);
    }

    if (
      currentOptions.loop !== undefined &&
      owned.player.loop !== currentOptions.loop
    ) {
      owned.player.loop = currentOptions.loop;
    }
    if (
      currentOptions.playbackRate !== undefined &&
      owned.player.playbackRate !== currentOptions.playbackRate
    ) {
      owned.player.playbackRate = currentOptions.playbackRate;
    }
    if (
      currentOptions.volume !== undefined &&
      owned.player.volume !== currentOptions.volume
    ) {
      owned.player.volume = currentOptions.volume;
    }
    if (
      currentOptions.muted !== undefined &&
      owned.player.muted !== currentOptions.muted
    ) {
      owned.player.muted = currentOptions.muted;
    }

    if (
      !Object.is(owned.source, currentOptions.src) &&
      !Object.is(owned.openingSource, currentOptions.src)
    ) {
      owned.source = noSource;
      owned.openingSource = currentOptions.src;
      const generation = ++owned.openGeneration;
      const player = owned.player;
      const source = currentOptions.src;
      const startTime = currentOptions.initialSeekTime;
      void Promise.resolve()
        .then(() => player.open(source, startTime))
        .then(() => {
          if (ownedRef.current !== owned || generation !== owned.openGeneration) {
            return;
          }
          owned.openingSource = noSource;
          owned.source = source;
          if (optionsRef.current.autoPlay === true) {
            void Promise.resolve()
              .then(() => player.play())
              .catch(() => {
                // MediaPlayer reports fatal play failures through its error event.
              });
          }
        })
        .catch((error: unknown) => {
          if (ownedRef.current !== owned || generation !== owned.openGeneration) {
            return;
          }
          owned.openingSource = noSource;
          owned.source = noSource;
          if (isCancelled(error)) return;
          // MediaPlayer emits fatal open and play failures through its error event.
        });
    }
  });

  useEffect(
    () => () => {
      const owned = ownedRef.current;
      ownedRef.current = null;
      if (playerRef.current === owned?.player) playerRef.current = null;
      if (owned !== null) {
        owned.openGeneration += 1;
        owned.player.dispose();
      }
    },
    [],
  );

  return playerRef;
}
