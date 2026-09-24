# @meta-sam/parser

## 0.0.13

### Patch Changes

- e8c74a3: Read SAM API records tolerantly and expose the optional detection confidence. Box and mask fields may appear in any order, with whitespace around keys and values and empty fields. Keys and tokens the parser does not know, and fields in the frame header, no longer reject the line: the record is kept and an `ignored_field` or `ignored_token` diagnostic with `severity: 'warning'` is reported once per stream. The optional `c` field on each token becomes `confidence` on `SegmentationBoxRecord` and `SegmentationMaskRecord`; it is absent when the API omits `c`, and a value that is not a number from 0 through 1 is ignored with an `ignored_confidence` warning while the box and mask are kept. A repeated field other than `c`, a missing required field, or a record without exactly one box and one mask token remains a `malformed_record` error. Shared conformance cases cover the new rules in both the TypeScript and Python parsers.

## 0.0.12

### Patch Changes

- 15113c0: Point the package `homepage` at https://dev.meta.ai/, the home of the Model API and its SAM documentation.

## 0.0.11

### Patch Changes

- 89991bd: Finalize the output-text lane from `response.content_part.done` as well as `response.output_text.done`. The live SAM Model API emits only the former, so every real stream previously ended in `ResponsesStreamLaneError: The response completed before finalizing one output text lane.` Both events are accepted for one lane when their text is identical; a `refusal` part is a `ResponsesStreamRefusalError`; `reasoning_text` parts are ignored. Captured `sam-3.1` image and video streams are now test fixtures and three shared conformance cases. Both finalizer events are each accepted at most once per lane, so a repeated finalizer is a lane error in TypeScript exactly as in Python.

## 0.0.10

### Patch Changes

- 9f68f67: Parse only the SAM API wire grammar. The line-oriented `object=…` grammar with named fields, which the SAM API never emitted, is removed along with point records: `SegmentationPointRecord` and the `'point'` record kind are gone, `SegmentationMaskRecord.bounds` is now required (every API mask carries its box), and `SegmentationMask.encoding` is the new `SegmentationMaskEncoding` union (`'lossless' | 'one_bit'`). A line that starts with `<` but is not a valid API line is a `malformed_record` diagnostic; other non-empty lines remain text records. Graphics places every mask at its `bounds` and no longer has a full-frame fallback. The protocol and READMEs document the base85 mask payload alphabet.

## 0.0.9

### Patch Changes

- 6f91fc2: Document the SAM API wire grammar as the primary input in the parser and graphics READMEs, with examples that run against real API output; correct the graphics README's mask-encoding claim and list `objectColor`; drop the pre-release migration table from the React README.

## 0.0.8

### Patch Changes

- aa428d7: Remove the pre-release status notice from each package README.

## 0.0.7

### Patch Changes

- 1b8d142: Publish to the public npm registry. Package manifests now declare the public repository, issue tracker, and public access.
- 389ea04: Rename the internal SVG path tracing module; the public API is unchanged.

## 0.0.6

### Patch Changes

- 4b67776: Normalize signed zero consistently across compact coordinates and stream lanes, and preserve explicitly empty terminal error messages across TypeScript and Python.

## 0.0.5

### Patch Changes

- 26727c3: Clarify that the documented `object=...` line grammar remains the package protocol while compact box-first SAM API output uses decimal object IDs and is accepted as production compatibility input.
- 341dd33: Add a captured compact SAM API image response, containing only protocol output, to the shared cross-language conformance corpus.
- ec4714d: Require ASCII-decimal object IDs in compact SAM API responses, while preserving string identifiers in the documented `object=...` package grammar.

## 0.0.4

### Patch Changes

- 116de26: Standardize raster conversion naming and add exact COCO compressed RLE and polygonal SVG path conversions in TypeScript and Python. Update graphics to consume the renamed raster API.
- 116de26: Migrate all first-party packages and release artifacts to the SAM License.
- 116de26: Add `parseImageStream` and `parseVideoStream` convenience entry points that apply
  the matching segmentation format, plus
  `recordsOfKind` and `frameIndexOf` for selecting one record kind and reading a
  record's frame index. `parseResponsesStream` and `formats` remain public for
  reused or custom formats.
- 116de26: Remove parser quota options and errors, and make parser-driven and direct mask decoding use the same structural validation without fixed area or payload ceilings.
- f7a3683: Make streamed segmentation parsing chunk-linear and chunk-invariant, close sources consistently, diagnose malformed canonical records, and expand cross-language conformance coverage.

## 0.0.3

### Patch Changes

- aa2e12b: Support canonical box-first SAM responses and lossless masks from the SAM video API, and export `objectColor()` from `@meta-sam/graphics` so legends can match the overlay palette. `SegmentationRenderer` now retains masks by identity and traces their SVG paths lazily for the frame being rendered, caching them in the existing LRU, so long videos with large per-frame masks no longer exhaust `maxRetainedComplexity` while a single oversized mask still fails with `maxPathComplexity`. Every visible mask is now traced once into a marching-squares contour whose vertices sit at the midpoints between neighbouring pixel centers, so straight boundaries follow the pixel edge while corners and diagonals are cut at 45° rather than stepping. That single cached path is both filled (object color, `globalAlpha` 0.35, `evenodd`) and stroked (same color, `globalAlpha` 0.8, round joins and caps), so the body and the edge cannot disagree, and it replaces the previous per-row rectangle fill path plus separate pixel-edge outline. The `maskOutline` renderer option (`boolean | { width }`, default on, exported as `MaskOutlineOptions`) still turns the contour off or reweights it, but `width` is now given in source pixels and defaults to `0.003 × min(source.width, source.height)` — about 2.2 pixels for 720p media — so the contour tracks the media resolution and scales with the source-to-target transform. The fill of a contour differs from the old per-row path by half-pixel bevels at the boundary. Each closed polygon is then decimated and smoothed before it is emitted, because a mask at native video resolution has a genuine 1-pixel staircase for a boundary and marching squares alone renders that staircase faithfully. Decimation drops every vertex the boundary passes straight through, so a straight run — or one 45° diagonal — collapses to its two endpoints; on a 600×630 sample mask that is 3,348 marching-squares vertices down to 968. The decimated polygon is emitted as a uniform quadratic B-spline, `M m₀ Q p₁ m₁ Q p₂ m₂ … Q p₀ m₀ Z` with `mᵢ` the midpoint of `pᵢpᵢ₊₁`: the curve runs through every edge midpoint and treats each vertex as a control point rather than passing through it. A 1-pixel step becomes a curve that stays within about a tenth of a pixel of the line it approximates — half the deviation of the staircase itself — a decimated straight run stays straight because the curve meets each long edge's midpoint along that edge's own tangent, and a right-angle corner, already bevelled at 45° by marching squares, rounds by under half a source pixel. A contour of at most four vertices keeps its straight segments, so a lone pixel still renders as a full half-pixel diamond. Coordinates carry at most one decimal, exact on the half-pixel vertex lattice and within 0.05 pixels on the quarter-pixel midpoints. `traceContour` takes an optional `{ smooth }` argument that defaults to on. `TracedContour.complexity` is still the emitted string length, and a curve carries a control point as well as an endpoint, so the same polygon costs about twice the characters: that sample mask traces to 18,148 characters where the polygon was 9,368 — still well inside the 250,000-character `maxPathComplexity` default, and little more than half of the ~32,000 an undecimated polyline would need. Tracing and smoothing the mask together take about 3.2 ms on a development machine, against 2.8 ms for tracing alone.

## 0.0.2

### Patch Changes

- 53710e2: Add standalone parser documentation and compile-tested public API usage examples.
