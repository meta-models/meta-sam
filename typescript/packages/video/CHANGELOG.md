# @meta-sam/video

## 0.1.5

### Patch Changes

- 97c6bc5: Exclude negative-timestamp decode preroll from presented video frame indexes so frame-qualified overlays remain aligned.

## 0.1.4

### Patch Changes

- 15113c0: Point the package `homepage` at https://dev.meta.ai/, the home of the Model API and its SAM documentation.

## 0.1.3

### Patch Changes

- 9f68f67: Parse only the SAM API wire grammar. The line-oriented `object=…` grammar with named fields, which the SAM API never emitted, is removed along with point records: `SegmentationPointRecord` and the `'point'` record kind are gone, `SegmentationMaskRecord.bounds` is now required (every API mask carries its box), and `SegmentationMask.encoding` is the new `SegmentationMaskEncoding` union (`'lossless' | 'one_bit'`). A line that starts with `<` but is not a valid API line is a `malformed_record` diagnostic; other non-empty lines remain text records. Graphics places every mask at its `bounds` and no longer has a full-frame fallback. The protocol and READMEs document the base85 mask payload alphabet.

## 0.1.2

### Patch Changes

- 1b8d142: Publish to the public npm registry. Package manifests now declare the public repository, issue tracker, and public access.
- aa428d7: Remove the pre-release status notice from each package README.

## 0.1.1

### Patch Changes

- 116de26: Migrate all first-party packages and release artifacts to the SAM License.

## 0.1.0

### Minor Changes

- f84f63d: Add the preferred Canvas-only Mediabunny media player with exact packet timing, owned decoded-frame snapshots, typed events, generation-fenced playback, custom rendering, and frame navigation. Keep default strict TypeScript consumers compatible with Mediabunny's WebCodecs declarations.
- b5b13eb: Remove the legacy element-backed video API and migrate the React bindings to the Canvas-only Mediabunny player, including exact packet controls, audio state, composited segmentation, frame capture, and caller-owned Canvas support.

### Patch Changes

- 9d971dc: Compose decoded Mediabunny frames and packet-exact SAM overlays on one Canvas with explicit fit, DPR, resize, visibility, and stale-render behavior.
- a248942: Add Mediabunny audio decoding and bounded Web Audio scheduling to the Canvas-only media player, with an AudioContext-backed master clock, explicit audio capability status, controls, and real AAC/Opus browser coverage.
- cdec811: Add bounded playback performance statistics, fail-open Web Audio resume timeouts, and deterministic browser performance gates for Canvas video playback and React refs.

## 0.0.2

### Patch Changes

- 443c142: Add standalone video documentation and a compile-tested package-root composition example.
