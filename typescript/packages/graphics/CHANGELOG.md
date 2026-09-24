# @meta-sam/graphics

## 0.1.11

### Patch Changes

- 479fe51: Add opt-in box labels. With the new `boxLabels: true` renderer option, each visible box gets a label at its top-left corner: the `boxLabel` render option, the box's object ID, then its parser `confidence` with three decimals in parentheses, as `pillow 3 (0.945)`. The label and the confidence appear only when present, so the object ID is always shown. Labels are white text on a fill in the object color, sized in target CSS pixels; a label sits above its box when the target has room and inside it otherwise, and it shifts left to stay inside the target. Hidden objects and boxes from other video frames get no label. `render()` and `renderVideoFrame()` accept `boxLabel`, and the `@meta-sam/react` `Video` component forwards a new `boxLabel` prop. The new `formatBoxLabel` and `formatConfidence` exports return the label text, so legends can match the canvas. A box confidence outside 0 through 1 now rejects the update with `InvalidRenderOptionsError`.

## 0.1.10

### Patch Changes

- Updated dependencies [e8c74a3]
  - @meta-sam/parser@0.0.13

## 0.1.9

### Patch Changes

- 15113c0: Point the package `homepage` at https://dev.meta.ai/, the home of the Model API and its SAM documentation.
- Updated dependencies [15113c0]
  - @meta-sam/parser@0.0.12

## 0.1.8

### Patch Changes

- Updated dependencies [89991bd]
  - @meta-sam/parser@0.0.11

## 0.1.7

### Patch Changes

- 9f68f67: Parse only the SAM API wire grammar. The line-oriented `object=…` grammar with named fields, which the SAM API never emitted, is removed along with point records: `SegmentationPointRecord` and the `'point'` record kind are gone, `SegmentationMaskRecord.bounds` is now required (every API mask carries its box), and `SegmentationMask.encoding` is the new `SegmentationMaskEncoding` union (`'lossless' | 'one_bit'`). A line that starts with `<` but is not a valid API line is a `malformed_record` diagnostic; other non-empty lines remain text records. Graphics places every mask at its `bounds` and no longer has a full-frame fallback. The protocol and READMEs document the base85 mask payload alphabet.
- Updated dependencies [9f68f67]
  - @meta-sam/parser@0.0.10

## 0.1.6

### Patch Changes

- 6f91fc2: Document the SAM API wire grammar as the primary input in the parser and graphics READMEs, with examples that run against real API output; correct the graphics README's mask-encoding claim and list `objectColor`; drop the pre-release migration table from the React README.
- Updated dependencies [6f91fc2]
  - @meta-sam/parser@0.0.9

## 0.1.5

### Patch Changes

- 1b8d142: Publish to the public npm registry. Package manifests now declare the public repository, issue tracker, and public access.
- aa428d7: Remove the pre-release status notice from each package README.
- Updated dependencies [1b8d142]
- Updated dependencies [aa428d7]
- Updated dependencies [389ea04]
  - @meta-sam/parser@0.0.8

## 0.1.4

### Patch Changes

- Updated dependencies [4b67776]
  - @meta-sam/parser@0.0.6

## 0.1.3

### Patch Changes

- Updated dependencies [26727c3]
- Updated dependencies [341dd33]
- Updated dependencies [ec4714d]
  - @meta-sam/parser@0.0.5

## 0.1.2

### Patch Changes

- 116de26: Allow callers to configure mask fill and contour opacity while preserving the existing defaults.
- 116de26: Standardize raster conversion naming and add exact COCO compressed RLE and polygonal SVG path conversions in TypeScript and Python. Update graphics to consume the renamed raster API.
- 116de26: Migrate all first-party packages and release artifacts to the SAM License.
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [f7a3683]
  - @meta-sam/parser@0.0.4

## 0.1.1

### Patch Changes

- aa2e12b: Support canonical box-first SAM responses and lossless masks from the SAM video API, and export `objectColor()` from `@meta-sam/graphics` so legends can match the overlay palette. `SegmentationRenderer` now retains masks by identity and traces their SVG paths lazily for the frame being rendered, caching them in the existing LRU, so long videos with large per-frame masks no longer exhaust `maxRetainedComplexity` while a single oversized mask still fails with `maxPathComplexity`. Every visible mask is now traced once into a marching-squares contour whose vertices sit at the midpoints between neighbouring pixel centers, so straight boundaries follow the pixel edge while corners and diagonals are cut at 45° rather than stepping. That single cached path is both filled (object color, `globalAlpha` 0.35, `evenodd`) and stroked (same color, `globalAlpha` 0.8, round joins and caps), so the body and the edge cannot disagree, and it replaces the previous per-row rectangle fill path plus separate pixel-edge outline. The `maskOutline` renderer option (`boolean | { width }`, default on, exported as `MaskOutlineOptions`) still turns the contour off or reweights it, but `width` is now given in source pixels and defaults to `0.003 × min(source.width, source.height)` — about 2.2 pixels for 720p media — so the contour tracks the media resolution and scales with the source-to-target transform. The fill of a contour differs from the old per-row path by half-pixel bevels at the boundary. Each closed polygon is then decimated and smoothed before it is emitted, because a mask at native video resolution has a genuine 1-pixel staircase for a boundary and marching squares alone renders that staircase faithfully. Decimation drops every vertex the boundary passes straight through, so a straight run — or one 45° diagonal — collapses to its two endpoints; on a 600×630 sample mask that is 3,348 marching-squares vertices down to 968. The decimated polygon is emitted as a uniform quadratic B-spline, `M m₀ Q p₁ m₁ Q p₂ m₂ … Q p₀ m₀ Z` with `mᵢ` the midpoint of `pᵢpᵢ₊₁`: the curve runs through every edge midpoint and treats each vertex as a control point rather than passing through it. A 1-pixel step becomes a curve that stays within about a tenth of a pixel of the line it approximates — half the deviation of the staircase itself — a decimated straight run stays straight because the curve meets each long edge's midpoint along that edge's own tangent, and a right-angle corner, already bevelled at 45° by marching squares, rounds by under half a source pixel. A contour of at most four vertices keeps its straight segments, so a lone pixel still renders as a full half-pixel diamond. Coordinates carry at most one decimal, exact on the half-pixel vertex lattice and within 0.05 pixels on the quarter-pixel midpoints. `traceContour` takes an optional `{ smooth }` argument that defaults to on. `TracedContour.complexity` is still the emitted string length, and a curve carries a control point as well as an endpoint, so the same polygon costs about twice the characters: that sample mask traces to 18,148 characters where the polygon was 9,368 — still well inside the 250,000-character `maxPathComplexity` default, and little more than half of the ~32,000 an undecimated polyline would need. Tracing and smoothing the mask together take about 3.2 ms on a development machine, against 2.8 ms for tracing alone.
- Updated dependencies [aa2e12b]
  - @meta-sam/parser@0.0.3

## 0.1.0

### Minor Changes

- 9d971dc: Compose decoded Mediabunny frames and packet-exact SAM overlays on one Canvas with explicit fit, DPR, resize, visibility, and stale-render behavior.

## 0.0.2

### Patch Changes

- bced16d: Add standalone graphics documentation and a compile-tested package-root usage example.
- Updated dependencies [53710e2]
  - @meta-sam/parser@0.0.2
