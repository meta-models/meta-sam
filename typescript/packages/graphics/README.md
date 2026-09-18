# @meta-sam/graphics

`@meta-sam/graphics` is an ESM-only, framework-neutral Canvas 2D renderer for
SAM 3 segmentation results. It retains complete masks and boxes from
`@meta-sam/parser`, traces masks during asynchronous updates, and creates browser
`Path2D` objects lazily while rendering.

## Installation

```sh
npm install @meta-sam/graphics @meta-sam/parser @meta-sam/video
```

## Image quick start

The renderer accepts image or video results and snapshots from `@meta-sam/parser`.
Call and await `update()` before `render()`; rendering is synchronous and sees only
the last successfully committed update. The example parses one frame of SAM API
output for a 320×334 image and draws it onto a canvas:

<!-- readme-example -->

```ts
import { SegmentationRenderer } from '@meta-sam/graphics';
import { parseImageStream, type ResponsesEvent } from '@meta-sam/parser';

// One SAM API line: object 0 with its box and mask, in a 320×334 source image.
const outputText =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";

async function* responseEvents(): AsyncIterable<ResponsesEvent> {
  const lane = { item_id: 'message-1', output_index: 0, content_index: 0 };
  yield { type: 'response.output_text.delta', ...lane, delta: outputText };
  yield { type: 'response.output_text.done', ...lane, text: outputText };
  yield { type: 'response.completed' };
}

const result = await parseImageStream(responseEvents()).finalResult;

const canvas = document.querySelector<HTMLCanvasElement>('#overlay');
if (canvas === null) throw new Error('Missing overlay canvas.');

const context = canvas.getContext('2d');
if (context === null) throw new Error('Canvas 2D is unavailable.');

const renderer = new SegmentationRenderer();
await renderer.update(result);
renderer.render(context, {
  media: 'image',
  // The source rectangle is the frame the API reported as `w` × `h`; each mask
  // is placed at its own box (`bounds`) inside that frame.
  source: { x: 0, y: 0, width: 320, height: 334 },
  target: { x: 0, y: 0, width: canvas.width, height: canvas.height },
});

// Remove retained overlays while keeping the renderer reusable.
renderer.clear();
// Permanently release the renderer when ownership ends.
renderer.dispose();
```

A real application passes parser snapshots to `update()` as they arrive and then
passes the final result when parsing completes. The renderer does not need the
request, the media bytes, or the transport.

## Video and frame selection

Use video results with `media: 'video'` and select the frame to draw with
`frameIndex`:

```ts
await renderer.update(videoResult);
renderer.render(context, {
  media: 'video',
  frameIndex: 42,
  source: { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight },
  target: { x: 0, y: 0, width: canvas.width, height: canvas.height },
});
```

`frameIndex` must be a non-negative safe integer. Records with the same frame index
are drawn; records without a frame reference are global and are drawn on every
video frame. The retained result media must match the render options.

## Same-canvas decoded video composition

`renderVideoFrame()` is a small structural adapter for Canvas media players. Its
context matches the frame, composition/fallback canvases and contexts, frame-index,
and abort fields supplied by `@meta-sam/video`'s `MediaPlayerRenderContext`, but
graphics does not import or depend on the video package. It clears the isolated
composition canvas, draws the decoded frame first, then draws the exact frame-indexed
SAM overlay. When the media player supplies `fallbackCanvas`/`fallbackCtx`, the helper
also draws the same decoded frame with the same fit and DPR but without overlays, ready
for a missed final-frame deadline.

<!-- readme-example -->

```ts
import {
  SegmentationRenderer,
  type VideoFrameCompositionOptions,
} from '@meta-sam/graphics';
import type { VideoSegmentationResult } from '@meta-sam/parser';
import type { IMediaPlayer } from '@meta-sam/video';

declare const player: IMediaPlayer;
declare const result: VideoSegmentationResult;

const renderer = new SegmentationRenderer();
await renderer.update(result);

const hiddenIds = new Set<string>();
let pixelRatio = window.devicePixelRatio || 1;
const composition: VideoFrameCompositionOptions = {
  fit: 'contain',
  devicePixelRatio: () => pixelRatio,
  hiddenIds,
};

player.setCustomRender((context) => {
  renderer.renderVideoFrame(context, composition);
});

// The visible canvas backing store owns resize policy. After changing its width or
// height, update pixelRatio if needed and re-render the retained decoded frame.
pixelRatio = 2;
await player.forceRender();
```

`fit` may be `contain` (the default), `cover`, or `fill`. The helper uses the decoded
frame dimensions as `source`, derives a logical display rectangle from
`composition.canvas.width / devicePixelRatio` and height, and recomputes `target` on
every render. Set the visible output canvas backing width and height to the rounded
logical size times the same DPR before opening or forcing a render. This makes resize
behavior explicit and also works for offscreen canvases, where CSS dimensions and the
global device pixel ratio are unavailable.

The helper checks an already-aborted signal before touching the composition canvas and
returns `false`; otherwise it returns `true` after synchronous composition. The media
player's isolated canvas and generation fence prevent a render aborted during later
asynchronous custom work from reaching the visible canvas. `hiddenIds` contains object
IDs, not mask identities. Callers still own and await `update()` separately, so a render
while an update is pending sees the prior committed segmentation state.

The lower-level `render()` API remains available for overlay-only canvases and custom
source/target rectangles.

## Results, records, and updates

Parser snapshots and final results are **cumulative views**, not deltas. Pass the
complete current view to every `update()` call.

- `update()` calls are serialized in invocation order. Always await the update that
  must be visible before calling `render()`.
- Masks and boxes are retained. Text records are accepted but are not drawn.
- Mask records are collapsed by `identity`; the greatest per-mask `revision` wins.
  At the same revision, conflicting mask data is rejected.
- Boxes are collapsed by frame and `objectId`; the last box in the accepted view
  wins.
- Masks are always drawn before boxes, regardless of record order. An all-zero mask
  has no path and is skipped.
- For the same media, a snapshot revision older than the committed snapshot is
  ignored. At an accepted equal or newer snapshot revision, identities omitted from
  the cumulative view are removed. A present mask with an older per-mask revision
  keeps its retained geometry.
- Changing media starts a fresh retained view even without `{ reset: true }`.

All records in an input count toward resource limits before masks and boxes are
collapsed.

## Complete mask payloads

Graphics accepts only complete masks with this shape, where `encoding` is
`lossless` (the SAM API default, payloads starting with `~`) or `one_bit`
(payloads starting with `!`) and `payload` is the opaque base85 text from the
wire, passed through unchanged:

```ts
{
  encoding: 'one_bit',
  width: 5,
  height: 5,
  payload: '!!!!!(QO(0lu8?'
}
```

A mask record parsed from SAM API output also carries `bounds`, the half-open box
the raster covers in source pixels; the renderer scales the `width × height`
raster into that box. A mask without `bounds` is drawn as a full-frame raster.

`width` and `height` must be positive safe integers, their area must be within the
configured and codec limits, and `payload` must be within the configured and codec
length limits. During `update()`, the renderer strictly decodes the entire payload,
verifies decoder finalization, verifies that a `one_bit` representation is
canonical, and traces the resulting binary raster. Partial, truncated, trailing,
and invalid payloads reject the update, as does any other encoding.

Use `@meta-sam/parser` to produce complete mask records. Graphics does not accept
streaming mask fragments.

## Source and target rectangles

`source` selects the coordinate-space rectangle to map, and `target` is the canvas
rectangle to fill. Both require finite coordinates and strictly positive width and
height; origins may be negative. Graphics clips to `target` and applies this mapping:

```text
scaleX  = target.width / source.width
scaleY  = target.height / source.height
offsetX = target.x - source.x * scaleX
offsetY = target.y - source.y * scaleY
```

The axes scale independently; the renderer does not choose a contain or cover fit.
Use a `source` rectangle in the same coordinate space as mask pixels and box edges.
Canvas state is enclosed by `save()` and `restore()`, including when drawing throws.

## Visibility and styling

Hide an object without changing retained state by passing its `objectId` in an array
or `ReadonlySet`:

```ts
renderer.render(context, {
  media: 'image',
  source,
  target,
  hiddenIds: new Set(['background', 'person-2']),
});
```

A hidden object contributes neither its mask nor its box, and its mask `Path2D` is
not created. Colors and geometry are intentionally fixed; fill and outline opacity
are configurable:

- Each `objectId` hashes deterministically to one of eight colors; `objectColor(id)`
  returns the same color so legends can match the overlay.
- Every mask is traced once into a marching-squares contour: its vertices are the
  midpoints of the edges between neighbouring pixel centers, so a straight
  boundary follows the pixel edge while corners and diagonals are cut at 45°
  instead of stepping. One closed subpath is emitted per region, holes included.
- Each closed polygon is then decimated and smoothed. Decimation drops every
  vertex the boundary passes straight through, so a straight run — or one 45°
  diagonal — collapses to its two endpoints. The result is emitted as a uniform
  quadratic B-spline: for the polygon `p₀…pₙ₋₁` the subpath is
  `M m₀ Q p₁ m₁ Q p₂ m₂ … Q p₀ m₀ Z`, where `mᵢ` is the midpoint of `pᵢpᵢ₊₁`.
  The curve therefore runs through every edge midpoint and takes each vertex as
  a control point rather than passing through it. A 1-pixel staircase — what a
  mask at native video resolution actually is — becomes a curve within about a
  tenth of a pixel of the line it approximates instead of a visible step; a long
  edge keeps its own tangent at its midpoint, so decimated straight runs stay
  straight; and a genuine right-angle corner, which marching squares has already
  bevelled at 45°, rounds by under half a source pixel. Coordinates are emitted
  with at most one decimal, exact for the half-pixel vertex lattice and within
  0.05 pixels for the quarter-pixel midpoints.
- A contour of at most four vertices — a lone pixel, a two-pixel sliver — keeps
  its straight segments, so a single pixel still renders as a full half-pixel
  diamond instead of being smoothed inward.
- That single path is both filled and stroked, so the body and the edge can never
  disagree: filled in the object color with the `evenodd` rule, then stroked in the
  same color with round joins and caps. Fill opacity defaults to `0.35`; contour
  opacity defaults to `0.8`. The path is cached per mask and counts toward the cache
  and `maxPathComplexity` limits, which measure the emitted path string; smoothing
  roughly doubles that string for the same polygon, since a curve carries a control
  point as well as an endpoint.
- The contour width defaults to `0.003 × min(source.width, source.height)` — about
  2.2 pixels for 720p media — expressed in source pixels, so it scales with the
  source-to-target transform and tracks the media resolution rather than a fixed
  pixel count. Turn the contour off with `maskOutline: false`, or configure its
  source-pixel weight and opacity with `maskOutline: { width: 2, opacity: 0.9 }`.
- Boxes use the same color at `globalAlpha = 1` and a source-coordinate line width
  of `2 / max(abs(scaleX), abs(scaleY))`.
- Masks render before boxes.

The renderer does not mutate records. Object colors, contour geometry, box styling,
draw order, and source transforms are not configurable.

## Lifecycle and transactional behavior

State changes are transactional. Mask validation, decoding, tracing, and aggregate
limit checks complete before a candidate state commits. If an update rejects, the
previous retained state and path cache remain available.

- `update(result, { reset: true })` ignores retained media and revisions. The old
  state and cache are dropped only after the replacement commits successfully.
- `clear()` removes committed state and cached `Path2D` objects while keeping the
  renderer reusable. It also fences already queued stale updates before they decode
  or commit.
- `dispose()` is idempotent, clears state and cache, and permanently fences queued
  work. Later `render()` calls throw `RendererDisposedError`; later `update()` calls
  reject with it. `clear()` after disposal is a no-op.

`render()` never waits for a pending update. It draws the previous committed state
until that update resolves.

## Browser requirements

Importing the package and calling `update()` do not access `Path2D`. Rendering
requires a Canvas 2D context and a browser-compatible `globalThis.Path2D` constructor.
If `Path2D` is absent, `render()` throws `Path2DUnavailableError` before mutating the
canvas context. Mask `Path2D` objects are created lazily and retained in a bounded
least-recently-used cache; each render also creates an uncached path for target
clipping.

## Configuration

<!-- readme-example -->

```ts
import {
  SegmentationRenderer,
  type SegmentationRendererOptions,
} from '@meta-sam/graphics';

const options: SegmentationRendererOptions = {
  maskFillOpacity: 0.5,
  maskOutline: { width: 2, opacity: 0.9 },
  maxCachedPaths: 128,
  maxCachedComplexity: 250_000,
  maxRecords: 20_000,
  maxMasks: 4_096,
  maxBoxes: 8_192,
  maxMaskArea: 16_777_216,
  maxMaskPayloadLength: 2_000_000,
  maxPathComplexity: 250_000,
  maxRetainedComplexity: 1_000_000,
};
const renderer = new SegmentationRenderer(options);
```

| Option                  | Default                                    |
| ----------------------- | ------------------------------------------ |
| `maskFillOpacity`       | `0.35`                                     |
| `maskOutline`           | `true`                                     |
| `maskOutline.width`     | `0.003 × min(source.width, source.height)` |
| `maskOutline.opacity`   | `0.8`                                      |
| `maxCachedPaths`        | `128`                                      |
| `maxCachedComplexity`   | `250_000`                                  |
| `maxRecords`            | `20_000`                                   |
| `maxMasks`              | `4_096`                                    |
| `maxBoxes`              | `8_192`                                    |
| `maxMaskArea`           | `16_777_216`                               |
| `maxMaskPayloadLength`  | `2_000_000`                                |
| `maxPathComplexity`     | `250_000`                                  |
| `maxRetainedComplexity` | `1_000_000`                                |

`maskFillOpacity` and `maskOutline.opacity` must be finite numbers in the inclusive
range from `0` through `1`. An outline with opacity `0` remains enabled and is still
stroked. `maskOutline` also accepts `true`, `false`, or `{ width }`; width is in source
pixels and must be finite and greater than zero. Every resource override must be a
positive safe integer. Invalid constructor options throw `TypeError`. Constructor
settings are resolved once, so later mutation of an options object has no effect.
Cache limits evict least-recently-used paths. Other resource limits reject an update
before it commits.

## Public API

Only the package root is public; deep imports are not supported.

### Runtime exports

| Export                           | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `SegmentationRenderer`           | Retain parser views and render masks and boxes.             |
| `objectColor`                    | The color assigned to an object ID, for legends and labels. |
| `SegmentationGraphicsError`      | Base class for package-specific errors.                     |
| `UnsupportedMaskEncodingError`   | Reject a mask encoding other than `lossless` or `one_bit`.  |
| `InvalidMaskPayloadError`        | Reject invalid mask data or a conflicting mask revision.    |
| `SegmentationResourceLimitError` | Reject an update that exceeds a configured resource limit.  |
| `InvalidRenderOptionsError`      | Reject invalid result, frame, rectangle, or transform data. |
| `RendererDisposedError`          | Reject operations after permanent disposal.                 |
| `Path2DUnavailableError`         | Report a missing browser `Path2D` implementation.           |

### Type exports

- `Rectangle`
- `SegmentationCanvasContext`
- `MaskOutlineOptions`
- `SegmentationRendererOptions`
- `SegmentationUpdateOptions`
- `ImageRenderOptions`
- `VideoRenderOptions`
- `SegmentationRenderOptions`
- `VideoFrameCompositionContext`
- `VideoFrameCompositionOptions`
- `VideoFrameFit`

Opacity configuration is declared on the renderer options:

```ts
interface MaskOutlineOptions {
  readonly width?: number;
  /** Contour opacity. Defaults to 0.8. */
  readonly opacity?: number;
}

interface SegmentationRendererOptions {
  /** Mask fill opacity. Defaults to 0.35. */
  readonly maskFillOpacity?: number;
  readonly maskOutline?: boolean | MaskOutlineOptions;
  // Resource limit options are unchanged.
}
```

The primary signatures are:

```ts
class SegmentationRenderer {
  constructor(options?: SegmentationRendererOptions);
  update(
    result: SegmentationResult | SegmentationSnapshot,
    options?: SegmentationUpdateOptions,
  ): Promise<void>;
  render(context: SegmentationCanvasContext, options: SegmentationRenderOptions): void;
  renderVideoFrame(
    context: VideoFrameCompositionContext,
    options?: VideoFrameCompositionOptions,
  ): boolean;
  clear(): void;
  dispose(): void;
}
```

`SegmentationResult` and `SegmentationSnapshot` are public types from
`@meta-sam/parser`.

## Errors

All package-specific errors extend `SegmentationGraphicsError` and expose a stable
`code`. Handle expected categories with `instanceof`:

```ts
import { SegmentationGraphicsError, SegmentationRenderer } from '@meta-sam/graphics';

const renderer = new SegmentationRenderer();

try {
  await renderer.update(result);
} catch (error) {
  if (error instanceof SegmentationGraphicsError) {
    console.error(error.code, error.message, error.cause);
  } else {
    throw error;
  }
}
```

| Error                            | `code`                   |
| -------------------------------- | ------------------------ |
| `UnsupportedMaskEncodingError`   | `unsupported_encoding`   |
| `InvalidMaskPayloadError`        | `invalid_mask_payload`   |
| `SegmentationResourceLimitError` | `resource_limit`         |
| `InvalidRenderOptionsError`      | `invalid_render_options` |
| `RendererDisposedError`          | `renderer_disposed`      |
| `Path2DUnavailableError`         | `path2d_unavailable`     |

Invalid constructor limits throw ordinary `TypeError`. Update failures reject the
returned promise; render failures throw synchronously.

## Runtime and compatibility

- ESM only. Use `import`; there is no CommonJS export.
- Supported Node.js versions are `^20.17.0 || >=22.9.0`.
- The package targets ES2022 and declares `@meta-sam/parser` as its only runtime
  dependency.
- Importing and updating are safe without browser globals. Rendering requires Canvas
  2D and `Path2D`.
- The package is side-effect-free and publishes only `dist` and this README.

## Related packages

| Package              | Role                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `@meta-sam/parser`   | Parse structural response events into segmentation snapshots and results. |
| `@meta-sam/graphics` | Retain mask paths and render Canvas 2D overlays.                          |
| `@meta-sam/video`    | Decode media into Canvas with packet-exact frame metadata and audio.      |
| `@meta-sam/react`    | Provide React bindings over the video and graphics packages.              |

## License

The source is licensed under the SAM License. See `LICENSE` in this package or the
repository root for the license text.
