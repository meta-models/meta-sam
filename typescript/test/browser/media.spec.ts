/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioExerciseReport, FixtureReport, TrackReport } from './types.js';

const browserRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(browserRoot, 'fixtures');

type ExpectedTrack = {
  readonly codec: string;
  readonly codecParameterPrefix: string;
  readonly internalCodecId: string;
  readonly packetCount: number;
  readonly timestamps: readonly number[];
  readonly durations: readonly number[];
  readonly trackDurationSeconds?: number;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
};

type Fixture = {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly container: string;
  readonly generation: {
    readonly durationSeconds: number;
  };
  readonly expected: {
    readonly video: ExpectedTrack;
    readonly audio: ExpectedTrack;
  };
};

const manifest = JSON.parse(
  await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'),
) as { readonly fixtures: readonly Fixture[] };

function expectStrictlyIncreasing(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index], `value at index ${index}`).toBeGreaterThan(
      values[index - 1]!,
    );
  }
}

function expectNondecreasing(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index], `value at index ${index}`).toBeGreaterThanOrEqual(
      values[index - 1]!,
    );
  }
}

function expectTrack(report: TrackReport, expected: ExpectedTrack): void {
  expect(report.codec).toBe(expected.codec);
  expect(report.codecParameterString).toEqual(
    expect.stringMatching(
      new RegExp(`^${expected.codecParameterPrefix.replaceAll('.', '\\.')}`),
    ),
  );
  expect(report.internalCodecId).toBe(expected.internalCodecId);
  expect(report.packets.count).toBe(expected.packetCount);
  expect(report.packets.timestamps).toEqual(expected.timestamps);
  expect(report.packets.durations).toEqual(expected.durations);
  expect(report.packets.sequenceNumbers).toHaveLength(expected.packetCount);
  expect(report.packets.byteLengths).toHaveLength(expected.packetCount);
  expect(report.packets.types).toHaveLength(expected.packetCount);
  expect(report.packets.byteLengths.every((byteLength) => byteLength > 0)).toBe(true);
  expect(report.packets.durations.every((duration) => duration >= 0)).toBe(true);
  expect(report.packets.durations.some((duration) => duration > 0)).toBe(true);
  expectStrictlyIncreasing(report.packets.sequenceNumbers);
  expectNondecreasing(report.packets.timestamps);
  expect(report.firstTimestamp).toBe(Math.min(...expected.timestamps));
  expect(report.duration).toBeCloseTo(
    expected.trackDurationSeconds ??
      Math.max(
        ...expected.timestamps.map(
          (timestamp, index) => timestamp + expected.durations[index]!,
        ),
      ),
    5,
  );

  expect(report.canDecode).toBe(report.nativeCanDecode);
  if (report.canDecode) {
    expect(report.decoded.status).toBe('decoded');
    expect(report.decoded.sampleCount).toBeGreaterThan(0);
    expect(report.sampleTimestamps).toHaveLength(report.decoded.sampleCount);
    expect(report.sampleDurations).toHaveLength(report.decoded.sampleCount);
    expectNondecreasing(report.sampleTimestamps);
    expect(report.sampleDurations.every((duration) => duration > 0)).toBe(true);
  } else {
    expect(report.decoded).toEqual({ status: 'unsupported', sampleCount: 0 });
    expect(report.sampleTimestamps).toEqual([]);
    expect(report.sampleDurations).toEqual([]);
  }
}

// Mirrors the renderer's mask fill alpha; interior samples sit clear of the
// contour stroke, so only the fill contributes.
const MASK_FILL_ALPHA = 0.35;

function expectMaskBlend(
  sample: { readonly baseline: readonly number[]; readonly overlay: readonly number[] },
  color: readonly [number, number, number],
): void {
  expect(sample.baseline[3]).toBe(255);
  expect(sample.overlay[3]).toBe(255);
  for (let channel = 0; channel < 3; channel += 1) {
    expect(
      Math.abs(
        sample.overlay[channel]! -
          (color[channel]! * MASK_FILL_ALPHA +
            sample.baseline[channel]! * (1 - MASK_FILL_ALPHA)),
      ),
    ).toBeLessThanOrEqual(2);
  }
}

async function attachCapabilityReport(
  testInfo: TestInfo,
  fixture: Fixture,
  report: FixtureReport,
): Promise<void> {
  const reportPath = testInfo.outputPath('capability-report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: testInfo.project.name,
        fixture: {
          file: fixture.file,
          sha256: fixture.sha256,
        },
        report,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach('capability-report', {
    path: reportPath,
    contentType: 'application/json',
  });
}

async function attachAudioExerciseReport(
  testInfo: TestInfo,
  file: string,
  report: AudioExerciseReport,
): Promise<void> {
  const reportPath = testInfo.outputPath('audio-playback-report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: testInfo.project.name,
        fixture: file,
        report,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach('audio-playback-report', {
    path: reportPath,
    contentType: 'application/json',
  });
}

async function exerciseAudio(page: Page, file: string) {
  const selector = await page.evaluate(
    (fixture) => window.mediaHarness.prepareAudioExercise(fixture),
    file,
  );
  await page.locator(selector).click();
  return await page.evaluate(() => window.mediaHarness.waitForAudioExercise());
}

test.describe.configure({ mode: 'serial' });

test('serves deterministic byte ranges', async ({ request }) => {
  const fixture = manifest.fixtures[0]!;
  const response = await request.get(`/fixtures/${fixture.file}`, {
    headers: { range: 'bytes=0-31' },
  });
  expect(response.status()).toBe(206);
  expect(response.headers()['accept-ranges']).toBe('bytes');
  expect(response.headers()['content-range']).toBe(`bytes 0-31/${fixture.bytes}`);
  expect(response.headers()['content-length']).toBe('32');
  const expected = (await readFile(path.join(fixtureRoot, fixture.file))).subarray(
    0,
    32,
  );
  expect(await response.body()).toEqual(expected);
});

test('plays VP9 through the Canvas-only media player', async ({ page }) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exercisePlayer('webm-vp9-opus.webm'),
  );
  expect(report.status).toBe('played');
  if (report.status !== 'played') return;
  expect(report.packetTimestamps).toEqual([
    0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875,
  ]);
  expect(report.events).toEqual(
    expect.arrayContaining(['loadedmetadata', 'frame', 'play', 'ended']),
  );
  expect(report.frameIndexes[0]).toBe(0);
  expect(report.finalFrameIndex).toBe(7);
  expect(report.customRenderCount).toBeGreaterThan(4);
});

test('composes packet-exact SAM overlays with real Canvas and Path2D', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() => window.mediaHarness.exerciseComposition());

  expect(report.frames.map(({ frameIndex }) => frameIndex)).toEqual([0, 1, 2]);
  for (const frame of report.frames) {
    expect(frame.renderFrameIndex).toBe(frame.frameIndex);
    expect(frame.global.baseline[3]).toBe(255);
    expect(frame.specificInterior.baseline[3]).toBe(255);
    expect(frame.specificBox.baseline[3]).toBe(255);
    expect(frame.exterior.baseline[3]).toBe(255);
    expectMaskBlend(frame.global, [207, 19, 34]);
    expect(frame.exterior.overlay).toEqual(frame.exterior.baseline);
    if (frame.frameIndex === 1) {
      expectMaskBlend(frame.specificInterior, [196, 29, 127]);
      expect(frame.specificBox.overlay).not.toEqual(frame.specificBox.baseline);
    } else {
      expect(frame.specificInterior.overlay).toEqual(frame.specificInterior.baseline);
      expect(frame.specificBox.overlay).toEqual(frame.specificBox.baseline);
    }
  }

  expect(report.geometry).toHaveLength(expectedGeometryPixels.length);
  for (const [index, geometry] of report.geometry.entries()) {
    const expectedPixels = expectedGeometryPixels[index]!;
    expect(geometry.frameIndex).toBe(1);
    expect(geometry.renderFrameIndex).toBe(1);
    expect(geometry.fit).toBe(expectedPixels.fit);
    expect(geometry.devicePixelRatio).toBe(expectedPixels.devicePixelRatio);
    expect(geometry.backingWidth).toBe(
      compositionLogicalWidth * geometry.devicePixelRatio,
    );
    expect(geometry.backingHeight).toBe(
      compositionLogicalHeight * geometry.devicePixelRatio,
    );
    expect(geometry.specificInterior.baseline).toEqual(expectedPixels.baseline);
    expect(geometry.specificInterior.overlay).toEqual(expectedPixels.overlay);
    expect(geometry.exterior.baseline).toEqual(expectedPixels.exterior);
    expect(geometry.exterior.overlay).toEqual(expectedPixels.exterior);
    expect(geometry.clipped).toEqual(expectedPixels.clipped);
    expectMaskBlend(geometry.specificInterior, [196, 29, 127]);

    if (geometry.fit === 'contain') {
      expect(geometry.target.x).toBeCloseTo(0);
      expect(geometry.target.y).toBeCloseTo(23 / 6);
      expect(geometry.target.width).toBeCloseTo(101);
      expect(geometry.target.height).toBeCloseTo(202 / 3);
      expect(geometry.clipped[3]).toBe(0);
    } else if (geometry.fit === 'cover') {
      expect(geometry.target.x).toBeCloseTo(-23 / 4);
      expect(geometry.target.y).toBeCloseTo(0);
      expect(geometry.target.width).toBeCloseTo(225 / 2);
      expect(geometry.target.height).toBeCloseTo(75);
      expect(geometry.clipped[3]).toBe(255);
    } else {
      expect(geometry.target).toEqual({ x: 0, y: 0, width: 101, height: 75 });
      expect(geometry.clipped[3]).toBe(255);
    }
  }

  expect(report.staleSeek).toMatchObject({
    cancelledCode: 'operation_cancelled',
    aborted: true,
    finalFrameIndex: 2,
  });
  expect(report.staleSeek.staleSpecificPixel.overlay).toEqual(
    report.staleSeek.staleSpecificPixel.baseline,
  );
  expect(report.staleSource).toMatchObject({
    cancelledCode: 'operation_cancelled',
    aborted: true,
    finalFrameIndex: 0,
  });
  expect(report.staleSource.staleSpecificPixel.overlay).toEqual(
    report.staleSource.staleSpecificPixel.baseline,
  );
  expect(report.playbackSupersession.aborted).toBe(true);
  expect(report.playbackSupersession.attemptedFrameIndexes).toContain(1);
  expect(report.playbackSupersession.committedFrameIndexes).not.toContain(1);
  expect(
    report.playbackSupersession.committedFrameIndexes.some(
      (frameIndex) => frameIndex >= 2,
    ),
  ).toBe(true);
  expect(report.playbackSupersession.finalFrameIndex).toBeGreaterThanOrEqual(2);
  expect(report.playbackSupersession.staleSpecificPixel.overlay).toEqual(
    report.playbackSupersession.staleSpecificPixel.baseline,
  );

  expect(report.finalDeadline).toMatchObject({
    aborted: true,
    finalFrameIndex: 7,
    bareGlobalPixel: {
      baseline: [87, 5, 0, 255],
      overlay: [87, 5, 0, 255],
    },
    clipped: [0, 0, 0, 0],
  });
  expect(report.offscreen).toEqual({
    frameIndex: 1,
    interior: {
      baseline: [7, 48, 62, 255],
      overlay: [72, 41, 84, 255],
    },
    finalFrameIndex: 7,
    finalAborted: true,
    finalBareGlobal: {
      baseline: [95, 6, 0, 255],
      overlay: [95, 6, 0, 255],
    },
    clipped: [0, 0, 0, 0],
  });
});

const compositionLogicalWidth = 101;
const compositionLogicalHeight = 75;
const expectedGeometryPixels = [
  {
    fit: 'contain',
    devicePixelRatio: 1,
    baseline: [5, 52, 56, 255],
    overlay: [71, 43, 80, 255],
    exterior: [0, 230, 255, 255],
    clipped: [0, 0, 0, 0],
  },
  {
    fit: 'cover',
    devicePixelRatio: 1,
    baseline: [6, 51, 57, 255],
    overlay: [71, 43, 81, 255],
    exterior: [0, 230, 255, 255],
    clipped: [127, 127, 127, 255],
  },
  {
    fit: 'fill',
    devicePixelRatio: 1,
    baseline: [6, 52, 56, 255],
    overlay: [71, 43, 80, 255],
    exterior: [0, 230, 255, 255],
    clipped: [143, 141, 111, 255],
  },
  {
    fit: 'contain',
    devicePixelRatio: 2,
    baseline: [7, 48, 62, 255],
    overlay: [72, 41, 84, 255],
    exterior: [0, 230, 255, 255],
    clipped: [0, 0, 0, 0],
  },
  {
    fit: 'cover',
    devicePixelRatio: 2,
    baseline: [7, 48, 62, 255],
    overlay: [72, 41, 84, 255],
    exterior: [0, 230, 255, 255],
    clipped: [191, 183, 64, 255],
  },
  {
    fit: 'fill',
    devicePixelRatio: 2,
    baseline: [7, 48, 62, 255],
    overlay: [72, 41, 84, 255],
    exterior: [0, 230, 255, 255],
    clipped: [191, 183, 64, 255],
  },
] as const;

test('plays H.264 when the browser reports decoder support', async ({ page }) => {
  await page.goto('/');
  const [capability, report] = await Promise.all([
    page.evaluate(() => window.mediaHarness.analyzeFixture('mp4-h264-aac.mp4')),
    page.evaluate(() => window.mediaHarness.exercisePlayer('mp4-h264-aac.mp4')),
  ]);
  const video = capability.tracks.find((track) => track.type === 'video');
  expect(video).toBeDefined();
  expect(report.status).toBe(video!.nativeCanDecode ? 'played' : 'unsupported');
  if (report.status === 'played') {
    expect(report.packetTimestamps).toEqual([
      0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875,
    ]);
    expect(report.events).toContain('ended');
    expect(report.finalFrameIndex).toBe(7);
  }
});

test('schedules Opus through real Web Audio with bounded A/V skew', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const report = await exerciseAudio(page, 'webm-vp9-opus.webm');
  await attachAudioExerciseReport(testInfo, 'webm-vp9-opus.webm', report);
  expect(report.status).toBe('played');
  if (report.status !== 'played') return;

  expect(report.audioMetadata).toMatchObject({
    capability: 'supported',
    codec: 'opus',
    sampleRate: 48_000,
    numberOfChannels: 1,
  });
  expect(report.finalAudioStatus).toMatchObject({
    capability: 'supported',
    clockSource: 'audio-context',
    contextState: 'running',
    scheduledBufferCount: 0,
  });
  expect(report.peakScheduledBufferCount).toBeGreaterThan(0);
  expect(report.peakScheduledBufferCount).toBeLessThanOrEqual(16);
  expect(
    report.audioStatusEvents.some(
      ({ scheduledBufferCount }) => scheduledBufferCount > 0,
    ),
  ).toBe(true);
  expect(report.frameSkewSeconds.length).toBeGreaterThan(0);
  expect(Math.min(...report.frameSkewSeconds)).toBeGreaterThanOrEqual(-0.05);
  expect(Math.max(...report.frameSkewSeconds)).toBeLessThanOrEqual(0.25);
  expect(report.endedTime).toBeCloseTo(1, 2);
});

test('schedules AAC through real Web Audio when Chromium supports its video', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const capability = await page.evaluate(() =>
    window.mediaHarness.analyzeFixture('mp4-h264-aac.mp4'),
  );
  const video = capability.tracks.find((track) => track.type === 'video');
  const audio = capability.tracks.find((track) => track.type === 'audio');
  expect(video).toBeDefined();
  expect(audio).toBeDefined();

  const report = await exerciseAudio(page, 'mp4-h264-aac.mp4');
  await attachAudioExerciseReport(testInfo, 'mp4-h264-aac.mp4', report);
  if (!video!.nativeCanDecode) {
    expect(report).toEqual({
      status: 'unsupported-video',
      errorCode: 'media_source_error',
    });
    return;
  }

  expect(report.status).toBe('played');
  if (report.status !== 'played') return;
  expect(report.audioMetadata).toMatchObject({
    capability: audio!.nativeCanDecode ? 'supported' : 'unsupported',
    codec: 'aac',
    sampleRate: 48_000,
    numberOfChannels: 1,
  });
  expect(report.finalAudioStatus.clockSource).toBe('audio-context');
  if (audio!.nativeCanDecode) {
    expect(report.peakScheduledBufferCount).toBeGreaterThan(0);
    expect(
      report.audioStatusEvents.some(
        ({ scheduledBufferCount }) => scheduledBufferCount > 0,
      ),
    ).toBe(true);
  } else {
    expect(report.peakScheduledBufferCount).toBe(0);
    expect(report.finalAudioStatus.capability).toBe('unsupported');
  }
  expect(report.frameSkewSeconds.length).toBeGreaterThan(0);
  expect(Math.min(...report.frameSkewSeconds)).toBeGreaterThanOrEqual(-0.05);
  expect(Math.max(...report.frameSkewSeconds)).toBeLessThanOrEqual(0.25);
  expect(report.endedTime).toBeCloseTo(1, 2);
});

for (const fixture of manifest.fixtures) {
  test(`demuxes and decodes ${fixture.file}`, async ({ page }, testInfo) => {
    await page.goto('/');
    const report = await page.evaluate(
      (file) => window.mediaHarness.analyzeFixture(file),
      fixture.file,
    );
    await attachCapabilityReport(testInfo, fixture, report);

    expect(report.canRead).toBe(true);
    expect(report.container).toBe(fixture.container);
    expect(report.mimeType).toContain(
      fixture.container === 'MP4' ? 'video/mp4' : 'video/webm',
    );
    expect(report.duration).toBeGreaterThan(fixture.generation.durationSeconds - 0.1);
    expect(report.duration).toBeLessThan(fixture.generation.durationSeconds + 0.2);
    expect(report.tracks).toHaveLength(2);

    const video = report.tracks.find((track) => track.type === 'video');
    const audio = report.tracks.find((track) => track.type === 'audio');
    expect(video, 'video track').toBeDefined();
    expect(audio, 'audio track').toBeDefined();
    expectTrack(video!, fixture.expected.video);
    expectTrack(audio!, fixture.expected.audio);
    expect(video!.codedWidth).toBe(fixture.expected.video.codedWidth);
    expect(video!.codedHeight).toBe(fixture.expected.video.codedHeight);
    expect(audio!.sampleRate).toBe(fixture.expected.audio.sampleRate);
    expect(audio!.numberOfChannels).toBe(fixture.expected.audio.numberOfChannels);

    if (testInfo.project.name === 'chromium' && fixture.file === 'webm-vp9-opus.webm') {
      expect(video!.decoded.status, 'Chromium must decode VP9').toBe('decoded');
      expect(audio!.decoded.status, 'Chromium must decode Opus').toBe('decoded');
    }
    if (testInfo.project.name === 'chrome' && fixture.file === 'mp4-h264-aac.mp4') {
      expect(video!.decoded.status, 'branded Chrome must decode H.264').toBe('decoded');
      expect(audio!.decoded.status, 'branded Chrome must decode AAC').toBe('decoded');
    }
    if (fixture.file === 'mp4-h265-aac.mp4') {
      expect(video!.decoded.status).toBe(video!.canDecode ? 'decoded' : 'unsupported');
      expect(audio!.decoded.status).toBe(audio!.canDecode ? 'decoded' : 'unsupported');
    }
  });
}
