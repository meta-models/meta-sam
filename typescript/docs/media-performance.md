# Media performance gates

`@meta-sam/video` exposes bounded, point-in-time `PlaybackStats` through
`player.getStats()`. `VideoRef.getStats()` returns that same snapshot and
`resetStats()` starts a new measurement interval without changing playback.

## Metrics

- `renderLoopTicks`, `uniqueVideoFramesRendered`, `duplicateRedraws`, and
  `lateFramesSkipped` separate scheduler activity from useful presentations.
- `decodeTime` and `overlayRenderTime` report sample count, average, p95, and
  maximum milliseconds. Only the most recent `statsSampleWindowSize` samples
  are retained (256 by default, configurable from 1 through 4096).
- `videoQueueDepth` and `audioQueueDepth` report current and maximum depth. The
  video queue is bounded at 2 frames and the audio queue at
  `maxScheduledAudioBuffers` (16 by default).
- `avPresentationError.currentSeconds` is the signed distance from the active
  audio clock to the current video frame's presentation window: zero inside
  `[timestamp, timestamp + duration)`, negative while audio is behind the frame,
  and positive while audio is ahead. `maxAbsoluteSeconds` retains the largest
  magnitude until reset. Both are `null` outside audio-master playback.
- `audioUnderruns` records lateness only for buffers that retain a schedulable
  remainder. `audioGaps` measures adjacent decoded-buffer timestamps against the
  preceding encoded duration. `droppedAudioBuffers` separately counts fully
  expired buffers and their discarded duration. Each diagnostic reports count,
  total seconds, and maximum seconds.

Snapshots and their nested summaries are frozen. Each snapshot is assembled
synchronously, so it cannot combine fields from different event-loop turns.
Counters are unbounded integers; only raw timing samples consume retained
window storage.

## Required gates

`npm run test:browser -- --project=chromium` is the required functional browser
suite. `npm run test:media-performance -- --project=chromium` is the required
performance suite and currently runs in about 31 seconds on the local shared
Linux runner.

The performance suite blocks on deterministic invariants:

- exact forward and reverse stepping through VFR packet timestamps;
- final-frame catch-up, strictly ordered committed frames, zero stale-overlay
  marker mismatches, video queue depth at most 2, and audio queue depth at most
  16;
- typed `audio_resume_timeout` fallback with a monotonic performance clock;
- exact frame identity through 12 repeated source/seek/resize operations; and
- exactly-once disposal over 10 React mount/unmount cycles.

It also runs one eight-second 30 fps clip at real time, then compares three
no-overlay and three overlay repetitions at 4x in the same browser. Reports
include raw runs plus median and p95 wall time. The shared-runner ceilings are
intentionally conservative: real-time playback must finish in 6–20 seconds.
Every accelerated run must last 1.5–8 seconds. Every no-overlay control must
present at least 100 of 240 frames. Every paired overlay run must also present at
least 100 frames and retain at least 90% of both its paired no-overlay control
and the no-overlay median frame count. Overlay wall-time median may be at most
2.5x the no-overlay median plus 500 ms. The real-time run still requires at
least 120 unique frames. Exact ordering, bounds, final-frame catch-up, and
stale-overlay exclusion remain blocking on every run.

Custom-render stalls of 10, 25, 50, 100, and 250 ms are injected. Long stalls
must produce either a deadline abort or a counted late-frame skip, and the
250 ms run must count a skip while still reaching the final frame.

## Anti-flake policy

- Tests await media events and operation promises; they do not poll playback
  time or sleep for expected completion.
- Functional invariants are blocking on every run. Absolute throughput limits
  are deliberately loose and are evaluated together with same-browser paired
  comparisons.
- Repetitions are fixed at three. Median and p95 are reported; a single fastest
  run is never used as evidence.
- Playwright retains traces and screenshots on failure, and CI uploads the full
  performance report.
- Do not raise a threshold from one noisy failure. Reproduce the regression,
  inspect the attached raw runs and queue/presentation-error counters, and change
  a threshold only with documented evidence from multiple shared-runner
  executions.

Set `MEDIA_REACT_STRESS_CYCLES=100` and select the React stress test for the
opt-in 100-cycle lane. Scheduled CI runs that lane separately from the required
10-cycle pull-request gate.

## Fixtures and compatibility

`npm run fixtures:generate` reproducibly creates the VFR VP9/Opus fixture and
the eight-second 30 fps VP9/Opus WebM stress fixture with the generator versions
recorded in `test/browser/fixtures/manifest.json`. Those versions document the
bytes; the repository does not pin or enforce an installed FFmpeg toolchain.
`npm run fixtures:verify` checks manifested byte lengths and SHA-256 hashes,
runs ffprobe, and fully decodes every audio/video stream while rejecting any
diagnostic stderr. WebM/Opus is decoded with the independently installed system
FFmpeg when present; other containers use the configured FFmpeg so required
codecs remain available. WebM/Opus entries also record codec-delay
normalization, positive terminal packet duration from ffprobe, and zero discard
padding; Mediabunny's encoded-packet view reports a zero terminal duration only
because no following WebM block exists for inference.

The scheduled and manually dispatched compatibility workflow runs functional
media tests in Playwright Chromium and branded Chrome. It uploads each browser's
codec capability reports rather than treating an unsupported optional codec as
a skipped or silently passing case.
