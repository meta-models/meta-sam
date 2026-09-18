# Browser media conformance tests

This harness tests the pinned `mediabunny` dependency, the Canvas-only
`@meta-sam/video` player, and the `@meta-sam/react` Canvas component in a real
browser. `build.mjs` creates a browser-only bundle; `server.mjs` serves it and
the fixtures with HTTP byte-range support.

`npm run test:browser` runs the functional Playwright Chromium project with one
worker. `npm run test:media-performance -- --project=chromium` runs the dedicated
VFR, sustained-playback, custom-stall, churn, audio-timeout, and React lifecycle
gates. Every fixture test attaches a JSON capability report containing the
browser's WebCodecs support decision and actual decode result for each track.
Player and performance tests await events rather than polling playback.

The React suite mounts the real component and verifies:

- one canvas and no hidden media element;
- VP9 and capability-dependent H.264 decoding;
- exact packet lookup, time seek, and frame seek;
- real segmentation pixels, raw/composited capture, and hidden-ID redraws;
- source replacement without player reconstruction;
- current callback delivery after rerenders;
- trusted-click Opus and capability-dependent AAC controls;
- development StrictMode construction and exactly-once disposal counters.

jsdom tests separately cover deterministic prop, ref, ownership, and stale-work
lifecycle contracts. Media decoding, pixel output, codec support, and Web Audio
are asserted only in this real-browser harness.

Dedicated AAC and Opus exercises call `play()` directly from a trusted button
click, assert actual `AudioBufferSourceNode` scheduling through public status,
and record final control state. VP9/Opus playback is required. H.264/AAC playback
is required whenever the browser reports matching decoder support. Unsupported
codecs are asserted as explicit results; tests are not skipped.

Set `PLAYWRIGHT_BRANDED_CHROME=1` to add Playwright's `chrome` channel, or set
`PLAYWRIGHT_CHROME_EXECUTABLE_PATH` to a branded Chrome executable. The Chrome
project requires H.264/AAC decode for the H.264 fixture. Default Chromium
requires VP9/Opus.

The committed fixtures include one-second codec probes, an exact-timestamp VFR
VP9/Opus stream, and an eight-second 30 fps VP9/Opus stress clip. They are
generated from fixed FFmpeg lavfi inputs. `npm run fixtures:verify` checks byte
length, SHA-256, clean ffprobe inspection, and a full FFmpeg decode. WebM/Opus
fixtures are decoded by the independently installed system FFmpeg when present.
The manifest records the generator versions used for those bytes; it does not
pin or enforce a system FFmpeg version. Regeneration requires FFmpeg and ffprobe
with libx264, libx265, libvpx, and libopus. Performance thresholds and the
anti-flake policy are documented in
[`docs/media-performance.md`](../../docs/media-performance.md).
