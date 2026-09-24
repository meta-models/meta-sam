# @meta-sam/react

## 0.1.12

### Patch Changes

- 479fe51: Add opt-in box labels. With the new `boxLabels: true` renderer option, each visible box gets a label at its top-left corner: the `boxLabel` render option, the box's object ID, then its parser `confidence` with three decimals in parentheses, as `pillow 3 (0.945)`. The label and the confidence appear only when present, so the object ID is always shown. Labels are white text on a fill in the object color, sized in target CSS pixels; a label sits above its box when the target has room and inside it otherwise, and it shifts left to stay inside the target. Hidden objects and boxes from other video frames get no label. `render()` and `renderVideoFrame()` accept `boxLabel`, and the `@meta-sam/react` `Video` component forwards a new `boxLabel` prop. The new `formatBoxLabel` and `formatConfidence` exports return the label text, so legends can match the canvas. A box confidence outside 0 through 1 now rejects the update with `InvalidRenderOptionsError`.
- Updated dependencies [479fe51]
  - @meta-sam/graphics@0.1.11

## 0.1.11

### Patch Changes

- Updated dependencies [e8c74a3]
  - @meta-sam/parser@0.0.13
  - @meta-sam/graphics@0.1.10

## 0.1.10

### Patch Changes

- Updated dependencies [97c6bc5]
  - @meta-sam/video@0.1.5

## 0.1.9

### Patch Changes

- 15113c0: Point the package `homepage` at https://dev.meta.ai/, the home of the Model API and its SAM documentation.
- Updated dependencies [15113c0]
  - @meta-sam/parser@0.0.12
  - @meta-sam/graphics@0.1.9
  - @meta-sam/video@0.1.4

## 0.1.8

### Patch Changes

- Updated dependencies [89991bd]
  - @meta-sam/parser@0.0.11
  - @meta-sam/graphics@0.1.8

## 0.1.7

### Patch Changes

- 9f68f67: Parse only the SAM API wire grammar. The line-oriented `object=…` grammar with named fields, which the SAM API never emitted, is removed along with point records: `SegmentationPointRecord` and the `'point'` record kind are gone, `SegmentationMaskRecord.bounds` is now required (every API mask carries its box), and `SegmentationMask.encoding` is the new `SegmentationMaskEncoding` union (`'lossless' | 'one_bit'`). A line that starts with `<` but is not a valid API line is a `malformed_record` diagnostic; other non-empty lines remain text records. Graphics places every mask at its `bounds` and no longer has a full-frame fallback. The protocol and READMEs document the base85 mask payload alphabet.
- Updated dependencies [9f68f67]
  - @meta-sam/parser@0.0.10
  - @meta-sam/graphics@0.1.7
  - @meta-sam/video@0.1.3

## 0.1.6

### Patch Changes

- 6f91fc2: Document the SAM API wire grammar as the primary input in the parser and graphics READMEs, with examples that run against real API output; correct the graphics README's mask-encoding claim and list `objectColor`; drop the pre-release migration table from the React README.
- Updated dependencies [6f91fc2]
  - @meta-sam/parser@0.0.9
  - @meta-sam/graphics@0.1.6

## 0.1.5

### Patch Changes

- 1b8d142: Publish to the public npm registry. Package manifests now declare the public repository, issue tracker, and public access.
- aa428d7: Remove the pre-release status notice from each package README.
- Updated dependencies [1b8d142]
- Updated dependencies [aa428d7]
- Updated dependencies [389ea04]
  - @meta-sam/parser@0.0.8
  - @meta-sam/graphics@0.1.5
  - @meta-sam/video@0.1.2

## 0.1.4

### Patch Changes

- Updated dependencies [4b67776]
  - @meta-sam/parser@0.0.6
  - @meta-sam/graphics@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [26727c3]
- Updated dependencies [341dd33]
- Updated dependencies [ec4714d]
  - @meta-sam/parser@0.0.5
  - @meta-sam/graphics@0.1.3

## 0.1.2

### Patch Changes

- 116de26: Migrate all first-party packages and release artifacts to the SAM License.
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [116de26]
- Updated dependencies [f7a3683]
  - @meta-sam/graphics@0.1.2
  - @meta-sam/parser@0.0.4
  - @meta-sam/video@0.1.1

## 0.1.1

### Patch Changes

- Updated dependencies [aa2e12b]
  - @meta-sam/parser@0.0.3
  - @meta-sam/graphics@0.1.1

## 0.1.0

### Minor Changes

- b5b13eb: Remove the legacy element-backed video API and migrate the React bindings to the Canvas-only Mediabunny player, including exact packet controls, audio state, composited segmentation, frame capture, and caller-owned Canvas support.

### Patch Changes

- cdec811: Add bounded playback performance statistics, fail-open Web Audio resume timeouts, and deterministic browser performance gates for Canvas video playback and React refs.
- Updated dependencies [f84f63d]
- Updated dependencies [b5b13eb]
- Updated dependencies [9d971dc]
- Updated dependencies [a248942]
- Updated dependencies [cdec811]
  - @meta-sam/video@0.1.0
  - @meta-sam/graphics@0.1.0

## 0.0.2

### Patch Changes

- d04b8dc: Add standalone React documentation and package-root component and hook usage coverage.
- Updated dependencies [53710e2]
- Updated dependencies [bced16d]
- Updated dependencies [443c142]
  - @meta-sam/parser@0.0.2
  - @meta-sam/graphics@0.0.2
  - @meta-sam/video@0.0.2
