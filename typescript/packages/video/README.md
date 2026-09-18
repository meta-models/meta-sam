# @meta-sam/video

`@meta-sam/video` provides a framework-neutral, Canvas-only video player backed
by Mediabunny, WebCodecs, and Web Audio. It decodes video frames into a caller's
canvas, schedules decoded audio through an `AudioContext`, and exposes exact
packet metadata for seeking and overlays.

## Installation

```sh
npm install @meta-sam/video @meta-sam/graphics @meta-sam/parser
```

The package carries exact runtime dependencies on `mediabunny@1.55.7` and
`@types/dom-webcodecs@0.1.19`.

## Quick start

<!-- readme-example -->

```ts
import { SegmentationRenderer } from '@meta-sam/graphics';
import type { VideoSegmentationResult } from '@meta-sam/parser';
import { createMediaPlayer } from '@meta-sam/video';

declare const segmentation: VideoSegmentationResult;

const canvas = document.querySelector<HTMLCanvasElement>('#video');
if (canvas === null) throw new Error('Missing video canvas.');

let pixelRatio = window.devicePixelRatio || 1;
const resizeCanvas = (width: number, height: number): void => {
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
};
resizeCanvas(640, 360);

const player = createMediaPlayer(canvas);
const renderer = new SegmentationRenderer();
const hiddenIds = new Set<string>();
await renderer.update(segmentation);

const removeErrorListener = player.on('error', ({ error }) => {
  console.error('Video playback failed', error);
});
const removeAudioStatusListener = player.on('audiostatuschange', (status) => {
  console.log('Audio capability and clock', status);
});

player.volume = 0.8;
player.setCustomRender((context) => {
  renderer.renderVideoFrame(context, {
    fit: 'contain',
    devicePixelRatio: () => pixelRatio,
    hiddenIds,
  });
});

await player.open('/media/clip.webm');
await player.seekToFrame(10);
await player.play();

player.pause();
pixelRatio = window.devicePixelRatio || 1;
resizeCanvas(800, 450);
await player.forceRender();

removeAudioStatusListener();
removeErrorListener();
player.dispose();
renderer.dispose();
```

`open()` accepts a URL string, `URL`, or `Blob`. URL inputs use Mediabunny's
`UrlSource`; blobs use `BlobSource`. The player validates the primary video
track, records exact packet metadata through `EncodedPacketSink`, decodes frames
through `CanvasSink`, and decodes supported audio through `AudioBufferSink`.
Unsupported video is a fatal open error. Missing or unsupported audio is
reported explicitly and plays as silent video.

## Media player contract

`createMediaPlayer(canvas)` returns `IMediaPlayer`. `MediaPlayer` is also
exported for consumers that need the concrete class.

| Member                            | Behavior                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `open(resource, startTime?)`      | Replaces the source, builds packet metadata, decodes, and renders the exact frame covering `startTime`. |
| `play()`                          | Uses Web Audio for supported audio, otherwise starts silent video on the performance clock.             |
| `pause()`                         | Stops the playback clock without discarding the retained decoded frame.                                 |
| `seek(time)`                      | Renders the packet whose exact presentation interval contains `time`.                                   |
| `seekToFrame(index)`              | Renders a zero-based presentation-order frame.                                                          |
| `nextFrame()` / `previousFrame()` | Step exactly one presentation-order packet and fail at either boundary.                                 |
| `forceRender()`                   | Re-renders the current decoded frame through the active custom renderer.                                |
| `setCustomRender(fn)`             | Replaces default full-canvas drawing; pass `null` to restore it.                                        |
| `getCurrentFrame()`               | Returns the retained raw decoded canvas, or `null` before a frame is available.                         |
| `getStats()`                      | Returns one frozen snapshot of bounded timings, queues, signed A/V presentation error, and diagnostics. |
| `resetStats()`                    | Clears counters and timing windows while preserving current gauge values and playback.                  |
| `dispose()`                       | Idempotently cancels work, disposes the input, clears the canvas, and releases listeners.               |

Current state is available through `currentTime`, `currentFrameIndex`,
`duration`, `paused`, `loop`, `playbackRate`, `volume`, `muted`, `videoFps`,
`audioMetadata`, and `audioStatus`. `volume` accepts finite values between `0` and
`1`, inclusive. Assigning `currentTime` begins an asynchronous exact seek; prefer
`await player.seek(time)` when completion matters.

## Playback statistics

`getStats()` returns `PlaybackStats`, a deeply frozen snapshot accumulated since
construction or `resetStats()`. It distinguishes render-loop ticks, new frame
presentations, duplicate redraws, and late skipped frames. Decode and custom
render timing summaries include average, p95, and maximum milliseconds over the
most recent bounded sample window. Queue summaries expose current and maximum
video/audio depth. `avPresentationError` is zero while the audio clock is in the
current frame interval, negative when audio is behind, and positive when audio
is ahead; it also retains the maximum absolute error. Audio underrun,
encoded-gap, and fully dropped-buffer diagnostics include count, total seconds,
and maximum seconds.

The timing window defaults to 256 samples and can be set from 1 through 4096 with
`statsSampleWindowSize`. `resetStats()` clears counters and samples atomically,
keeps playback running, and uses current queue and presentation-error values as
the new maxima.
See [media performance](https://github.com/meta-models/meta-sam/blob/main/typescript/docs/media-performance.md) for metric
semantics, required thresholds, and the anti-flake policy.

## Packet-exact metadata

`getVideoPackets()` returns a deeply frozen, presentation-ordered array of
`VideoPacketMetadata`. Every entry has a zero-based `frameIndex`, exact
`timestamp` and `duration`, decode-order `sequenceNumber`, container-reported
packet `type`, and `byteLength`.

- `getFrameIndexAtTimeExact(time)` succeeds only when one packet interval covers
  the requested time.
- `getTimeAtFrameIndexExact(frameIndex)` succeeds only for an existing index.
- `getPacketAtTimeExact(timeline, time)` returns the exact packet from a supplied
  timeline.
- Duplicate timestamps, invalid fields, gaps, and out-of-range lookups fail
  closed with typed errors.

The pure `createVideoPacketTimeline`, `getFrameIndexAtTimeExact`,
`getTimeAtFrameIndexExact`, and `getPacketAtTimeExact` helpers are exported.

## Events

`on(event, callback)` returns an unsubscribe function. `off()` and
`removeAllListeners()` support explicit ownership.

| Event                    | Payload                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `loadedmetadata`         | Video dimensions, duration, frame count, frame rate, packet timeline, and audio metadata |
| `audiostatuschange`      | Audio capability, clock source/context state, controls, and scheduled-buffer count       |
| `audiowarning`           | Typed non-fatal `MediaPlayerAudioError` when playback falls back to silent video         |
| `durationchange`         | `{duration}`                                                                             |
| `frame`                  | `{time, frameIndex}` for a committed frame                                               |
| `timeupdate`             | `{time}` from exact seeks and the playback clock                                         |
| `play`, `pause`, `ended` | `{time}`                                                                                 |
| `error`                  | `{error}`                                                                                |
| `dispose`                | `{}`                                                                                     |

Listener exceptions are isolated and reported through `error`; exceptions from
an `error` listener are swallowed.

## Custom rendering

A custom renderer receives the decoded `frame`, exact packet timing and index,
an `AbortSignal`, an isolated composition `canvas`/`ctx`, and an isolated bare-
frame `fallbackCanvas`/`fallbackCtx`. A completed composition reaches the
visible canvas only if the render is still current. Late work cannot overwrite a
newer seek, source, or playback frame.

For SAM overlays, pass the context to
`SegmentationRenderer.renderVideoFrame()`. It draws the decoded frame and then
renders global and exact-frame records with one source-to-target transform. It
supports `contain`, `cover`, `fill`, DPR, and hidden object IDs. Size the visible
canvas backing store to logical size times DPR and call `forceRender()` after a
resize.

Custom rendering may be asynchronous and should stop promptly when `signal` is
aborted. During playback, a media-clock deadline discards work that misses the
next packet. At timeline end, an expired composition falls back to the bare
final frame before ending or looping.

## Playback, audio, and cancellation

`play()` lazily creates and resumes an `AudioContext` only for a supported audio
track. Its clock becomes the master clock. `AudioContext.resume()` is bounded by
`audioContextResumeTimeoutMilliseconds` (1,000 ms by default). Missing,
unsupported, unavailable, or timed-out audio uses the performance clock and
emits explicit status plus a typed `audiowarning`; initialization failure can be
retried by a later play.

Decoded audio is scheduled through one gain stage with bounded time lookahead
and source-node count. Packet timestamps preserve encoded gaps and overlaps.
Seeks and playback-rate changes reanchor audio and video at one target.

The video queue contains only the current and next frame. Decoded frames are
copied into player-owned snapshots so Mediabunny's canvas pool cannot overwrite
a retained or asynchronously composed frame. Playback skips expired frames
instead of rendering a backlog.

Opening or replacing a source, seeking, pausing pending playback, and disposal
advance generation fences. Superseded work rejects with
`MediaPlayerOperationCancelledError`; disposal rejects pending work with
`MediaPlayerDisposedError`.

## Errors

All player errors extend `MediaPlayerError` and expose a stable `code`.

| Error                                 | `code`                             |
| ------------------------------------- | ---------------------------------- |
| `DuplicatePresentationTimestampError` | `duplicate_presentation_timestamp` |
| `FrameLookupOutOfRangeError`          | `frame_lookup_out_of_range`        |
| `FrameMetadataUnavailableError`       | `frame_metadata_unavailable`       |
| `MediaPlayerOperationCancelledError`  | `operation_cancelled`              |
| `MediaPlayerDisposedError`            | `player_disposed`                  |
| `MediaPlayerAudioError`               | `audio_playback_error`             |
| `MediaPlayerAudioResumeTimeoutError`  | `audio_resume_timeout`             |
| `MediaPlayerSourceError`              | `media_source_error`               |

`VideoPacketMetadataError` is the base class for packet lookup and metadata
failures.

## Browser and package requirements

Playback requires Canvas 2D, Fetch for URL inputs, and WebCodecs support for the
selected video codec. Supported audio additionally uses Web Audio. Call
`play()` from a user gesture when browser policy requires activation.

The package is ESM-only, side-effect-free, and supports Node.js
`^20.17.0 || >=22.9.0` for tooling and server-safe imports. Only the package
root is public; deep imports are unsupported.

## License

The source is licensed under the SAM License. Mediabunny is a runtime dependency
under its own MPL-2.0 license. See the package and repository license files.
