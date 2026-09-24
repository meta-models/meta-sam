# @meta-sam/react

`@meta-sam/react` provides Canvas-only React bindings for Mediabunny playback and
SAM 3 video segmentation. `Video` owns a media player and segmentation renderer;
`useMediaPlayer` connects the same player to a caller-owned canvas. The package
ships no global CSS.

## Installation

```sh
npm install @meta-sam/react @meta-sam/parser react react-dom
```

React and React DOM `>=18.2 <20` are peer dependencies. Applications that import
parser or video types directly should also declare those packages as direct
dependencies.

## `Video` quick start

`Video` renders one canvas inside a wrapper. It accepts a URL string, `URL`, or
`Blob`, discovers exact packet metadata through Mediabunny, and composites the
decoded frame and segmentation into that canvas.

<!-- readme-example -->

```tsx
'use client';

import { useRef } from 'react';
import { Video, type VideoRef } from '@meta-sam/react';
import type { VideoSegmentationResult } from '@meta-sam/parser';

declare const result: VideoSegmentationResult;

export function SegmentedVideo() {
  const videoRef = useRef<VideoRef>(null);

  return (
    <div>
      <button type="button" onClick={() => void videoRef.current?.play()}>
        Play
      </button>
      <button type="button" onClick={() => videoRef.current?.pause()}>
        Pause
      </button>
      <button type="button" onClick={() => void videoRef.current?.seekToFrame(10)}>
        Go to frame 10
      </button>

      <Video
        ref={videoRef}
        src="/media/clip.webm"
        result={result}
        objectFit="contain"
        devicePixelRatio={() => window.devicePixelRatio || 1}
        volume={0.8}
        style={{ width: 640 }}
        canvasProps={{ 'aria-label': 'Segmented video' }}
        onTimeChange={(time) => console.log('time', time)}
        onError={(error) => console.error('Video failed', error)}
      />
    </div>
  );
}
```

`result` accepts either a cumulative `VideoSegmentationSnapshot` while parsing is
in progress or the final `VideoSegmentationResult`. Updating `result`,
`hiddenIds`, `boxLabel`, `objectFit`, or `devicePixelRatio` recomposes the retained decoded
frame without replacing the player or reopening the source.

## Props

| Prop                                      | Behavior                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src`                                     | Required media source: string, `URL`, or `Blob`. A new value replaces the source on the existing player.    |
| `result`                                  | Cumulative video segmentation snapshot or final result. Image results are rejected at runtime.              |
| `renderer`                                | Optional caller-owned `SegmentationRenderer`. When omitted, `Video` creates and disposes one.               |
| `hiddenIds`                               | Object IDs omitted from the composition without changing retained segmentation state.                       |
| `boxLabel`                                | Text shown before the object ID in box labels, when the renderer was created with `boxLabels: true`.        |
| `objectFit`                               | `contain` (default), `cover`, or `fill` for both frame and overlay geometry.                                |
| `devicePixelRatio`                        | Positive number or function read while sizing and rendering the canvas.                                     |
| `loop`, `playbackRate`, `volume`, `muted` | Controlled playback and audio settings.                                                                     |
| `initialSeekTime`                         | Initial time used when each new source opens. Changing it alone does not reopen or seek the current source. |
| `autoPlay`                                | Starts playback after a source opens. Browser user-activation policy still applies.                         |
| `playerOptions`                           | Construction-only `MediaPlayerOptions` for advanced audio configuration.                                    |
| `className`, `style`                      | Configure the wrapper. The default wrapper is positioned, clipped, and full width.                          |
| `canvasProps`                             | Canvas attributes and styles except `ref`, children, and backing width/height, which the component owns.    |

The wrapper adopts the decoded video's aspect ratio after metadata loads unless
`style.aspectRatio` overrides it. The canvas backing dimensions track its CSS
size and DPR. A `ResizeObserver` is used when available.

`autoPlay` runs after asynchronous source initialization and therefore cannot preserve
a caller's user-activation token. Browsers may block Web Audio startup and the player
will report the fallback through `onAudioWarning`. For reliable audible playback, call
`videoRef.current?.play()` directly from a trusted click or key handler.

## Callbacks

Callbacks always use the newest committed prop without reconstructing the player:

- `onTimeChange(time)`
- `onPlayingChange(playing)`
- `onDurationChange(duration)`
- `onLoadedMetadata(metadata)`
- `onFrame({time, frameIndex})`
- `onAudioStatusChange(status)`
- `onAudioWarning(warning)`
- `onError(error)`
- `onPlayerReady(player)`

`onPlayerReady` reports construction, not source readiness. Use
`onLoadedMetadata` for a successfully opened source. In development StrictMode,
more than one short-lived player may be reported; each is disposed by its
matching effect cleanup.

## `VideoRef`

The imperative ref exposes the Canvas player without exposing a media-element
reference:

```ts
interface VideoRef {
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
  captureFrame(source?: 'composited' | 'raw'): HTMLCanvasElement;
  getStats(): VideoStats;
  resetStats(): void;
}
```

`captureFrame()` returns a detached canvas owned by the caller. The default
captures the visible composited frame; `raw` captures the retained decoded frame.
Canvas security rules still apply if callers later export pixels from that
snapshot. `getStats()` forwards the player's frozen `PlaybackStats` snapshot,
including bounded decode/overlay timings, scheduler counters, queue depths,
signed A/V presentation-window error, and audio gap/underrun/drop diagnostics.
`resetStats()` clears that measurement interval without changing playback.

Async methods (`play`, both seek forms, frame stepping, and `forceRender`) return
rejected promises when called through a retained handle after unmount; they never throw
before returning. Synchronous controls, lookups, capture, and stats throw when no player
is mounted. React clears a normally attached ref on unmount, so prefer checking
`ref.current` at the call site.

## Caller-owned canvas with `useMediaPlayer`

Use the hook for custom composition or controls while retaining React lifecycle
ownership:

<!-- readme-example -->

```tsx
'use client';

import { useRef } from 'react';
import { useMediaPlayer } from '@meta-sam/react';

export function CanvasPlayer({ src }: { src: string | URL | Blob }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useMediaPlayer({
    canvasRef,
    src,
    volume: 0.5,
    renderFrame({ ctx, canvas, frame }) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    },
    onError(error) {
      console.error('Playback failed', error);
    },
  });

  return (
    <div>
      <button type="button" onClick={() => void playerRef.current?.play()}>
        Play
      </button>
      <canvas ref={canvasRef} width={640} height={360} />
    </div>
  );
}
```

The returned `RefObject<IMediaPlayer | null>` is stable. The hook creates a player after
the canvas is attached, replaces it only when that canvas node changes, opens a changed
`src` on the existing player, and disposes owned players on replacement and unmount.
Failed opens are retryable when the component renders that source again. `renderFrame`
and all callbacks are read through current refs, so callback changes do not recreate the
player.

The hook owns the player. Do not dispose a player received through
`onPlayerReady`; use the component lifecycle instead.

## Renderer ownership and update ordering

When `renderer` is omitted, every effect setup owns one renderer and disposes it
exactly once. A supplied renderer always remains caller-owned and is never
disposed by `Video`.

Accepted segmentation values are applied with `{reset: true}` because parser
snapshots are cumulative. Result work is generation-fenced: a late update from a
replaced result or renderer cannot trigger a stale redraw. Source replacement is
independently generation-fenced by `@meta-sam/video`.

## Runtime and package map

The package is ESM-only and side-effect-free. Importing it does not construct
browser objects. Mounted players require Canvas 2D, Fetch for URL sources,
WebCodecs for video decoding, and Web Audio for supported audio playback.
Missing or unsupported audio degrades to explicit silent playback as described
by `onAudioStatusChange` and `onAudioWarning`.

Only the package root is public; deep imports are unsupported.

## License

The source is licensed under the SAM License. See `LICENSE` in this package or
the repository root for the license text.
