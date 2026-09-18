/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { MediaPerformanceReport, PerformancePlaybackRun } from './types.js';

const requiredComparisonRepetitions = 3;
const requiredReactMountCycles = 10;
const optInReactMountCycles = 100;
const reactMountCycles =
  process.env.MEDIA_REACT_STRESS_CYCLES === String(optInReactMountCycles)
    ? optInReactMountCycles
    : requiredReactMountCycles;

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)]!;
}

function summarize(values: readonly number[]) {
  return {
    repetitions: values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function expectNondecreasing(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index], `value at index ${index}`).toBeGreaterThanOrEqual(
      values[index - 1]!,
    );
  }
}

function expectStrictlyIncreasing(values: readonly number[]): void {
  for (let index = 1; index < values.length; index += 1) {
    expect(values[index], `value at index ${index}`).toBeGreaterThan(
      values[index - 1]!,
    );
  }
}

function expectBoundedRun(run: PerformancePlaybackRun): void {
  expect(run.finalFrameIndex).toBeGreaterThanOrEqual(0);
  expect(run.stats.videoQueueDepth.max).toBeLessThanOrEqual(2);
  expect(run.stats.audioQueueDepth.max).toBeLessThanOrEqual(16);
  expect(run.stats.decodeTime.sampleCount).toBeGreaterThan(0);
  expect(run.overlayMismatches).toBe(0);
  expectNondecreasing(run.clockSamples);
  expectStrictlyIncreasing(run.frameIndexes);
  expectStrictlyIncreasing(run.overlayFrameIndexes);
}

async function exercisePerformance(page: Page): Promise<MediaPerformanceReport> {
  const selector = await page.evaluate(() =>
    window.mediaHarness.prepareMediaPerformanceExercise(),
  );
  await page.locator(selector).click();
  return await page.evaluate(() =>
    window.mediaHarness.waitForMediaPerformanceExercise(),
  );
}

async function attachPerformanceReport(
  testInfo: TestInfo,
  report: MediaPerformanceReport,
): Promise<void> {
  const noOverlayWall = summarize(
    report.noOverlay.map(({ wallMilliseconds }) => wallMilliseconds),
  );
  const overlayWall = summarize(
    report.overlay.map(({ wallMilliseconds }) => wallMilliseconds),
  );
  const overlayP95 = summarize(
    report.overlay.map(({ stats }) => stats.overlayRenderTime.p95Milliseconds),
  );
  const noOverlayUniqueFrames = summarize(
    report.noOverlay.map(({ stats }) => stats.uniqueVideoFramesRendered),
  );
  const overlayUniqueFrames = summarize(
    report.overlay.map(({ stats }) => stats.uniqueVideoFramesRendered),
  );
  const reportPath = testInfo.outputPath('media-performance-report.json');
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        project: testInfo.project.name,
        fixture: report.fixture,
        declaredRepetitions: report.repetitions,
        summaries: {
          noOverlayWall,
          overlayWall,
          overlayP95,
          noOverlayUniqueFrames,
          overlayUniqueFrames,
        },
        report,
      },
      null,
      2,
    )}\n`,
  );
  await testInfo.attach('media-performance-report', {
    path: reportPath,
    contentType: 'application/json',
  });
}

test.describe.configure({ mode: 'serial' });

test('@performance steps every deterministic VFR packet exactly', async ({ page }) => {
  await page.goto('/');
  const report = await page.evaluate(() => window.mediaHarness.exerciseVfrStepping());
  expect(report.timestamps).toEqual([0, 0.04, 0.19, 0.52, 0.999]);
  expect(report.durations).toEqual([0.04, 0.15, 0.33, 0.479, 0.001]);
  expect(report.forwardFrameIndexes).toEqual([0, 1, 2, 3, 4]);
  expect(report.reverseFrameIndexes).toEqual([4, 3, 2, 1, 0]);
});

test('@performance sustains real-time playback and measures overlay/stall behavior', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await page.goto('/');
  const report = await exercisePerformance(page);
  await attachPerformanceReport(testInfo, report);

  expect(report.fixture).toBe('webm-vp9-opus-cfr30-8s.webm');
  expect(report.repetitions).toBe(requiredComparisonRepetitions);
  expect(report.noOverlay).toHaveLength(requiredComparisonRepetitions);
  expect(report.overlay).toHaveLength(requiredComparisonRepetitions);

  expectBoundedRun(report.realTime);
  expect(report.realTime.audioClockSource).toBe('audio-context');
  expect(report.realTime.wallMilliseconds).toBeGreaterThanOrEqual(6_000);
  expect(report.realTime.wallMilliseconds).toBeLessThan(20_000);
  expect(report.realTime.finalFrameIndex).toBe(239);
  expect(report.realTime.stats.uniqueVideoFramesRendered).toBeGreaterThanOrEqual(120);
  expect(report.realTime.stats.renderLoopTicks).toBeGreaterThanOrEqual(120);
  expect(report.realTime.stats.avPresentationError.maxAbsoluteSeconds).not.toBeNull();
  expect(
    report.realTime.stats.avPresentationError.maxAbsoluteSeconds!,
  ).toBeLessThanOrEqual(0.25);

  const noOverlayUniqueFrames = summarize(
    report.noOverlay.map(({ stats }) => stats.uniqueVideoFramesRendered),
  );
  for (const run of report.noOverlay) {
    expectBoundedRun(run);
    expect(run.finalFrameIndex).toBe(239);
    expect(run.wallMilliseconds).toBeGreaterThanOrEqual(1_500);
    expect(run.wallMilliseconds).toBeLessThan(8_000);
    expect(run.stats.uniqueVideoFramesRendered).toBeGreaterThanOrEqual(100);
    expect(run.stats.overlayRenderTime.sampleCount).toBe(0);
  }
  for (const [index, run] of report.overlay.entries()) {
    expectBoundedRun(run);
    expect(run.finalFrameIndex).toBe(239);
    expect(run.wallMilliseconds).toBeGreaterThanOrEqual(1_500);
    expect(run.wallMilliseconds).toBeLessThan(8_000);
    const pairedControlFrames =
      report.noOverlay[index]?.stats.uniqueVideoFramesRendered;
    expect(pairedControlFrames).toBeDefined();
    const relativeFrameFloor = Math.ceil(
      Math.max(pairedControlFrames!, noOverlayUniqueFrames.median) * 0.9,
    );
    expect(run.stats.uniqueVideoFramesRendered).toBeGreaterThanOrEqual(100);
    expect(run.stats.uniqueVideoFramesRendered).toBeGreaterThanOrEqual(
      relativeFrameFloor,
    );
    expect(run.stats.overlayRenderTime.sampleCount).toBeGreaterThan(0);
    expect(run.overlayFrameIndexes.length).toBeGreaterThan(0);
  }

  const noOverlay = summarize(
    report.noOverlay.map(({ wallMilliseconds }) => wallMilliseconds),
  );
  const overlay = summarize(
    report.overlay.map(({ wallMilliseconds }) => wallMilliseconds),
  );
  expect(noOverlay.repetitions).toBe(requiredComparisonRepetitions);
  expect(overlay.repetitions).toBe(requiredComparisonRepetitions);
  expect(noOverlay.p95).toBeLessThan(8_000);
  expect(overlay.p95).toBeLessThan(8_000);
  expect(overlay.median).toBeLessThanOrEqual(noOverlay.median * 2.5 + 500);

  expect(report.stalls.map(({ stallMilliseconds }) => stallMilliseconds)).toEqual([
    10, 25, 50, 100, 250,
  ]);
  for (const run of report.stalls) {
    expectBoundedRun(run);
    expect(run.finalFrameIndex).toBe(4);
    expect(run.wallMilliseconds).toBeLessThan(5_000);
  }
  const disruptiveStalls = report.stalls.filter(({ stallMilliseconds }) =>
    [100, 250].includes(stallMilliseconds),
  );
  expect(
    disruptiveStalls.every(
      ({ stats, abortedFrameIndexes }) =>
        stats.lateFramesSkipped > 0 || abortedFrameIndexes.length > 0,
    ),
  ).toBe(true);
  expect(report.stalls.at(-1)!.stats.lateFramesSkipped).toBeGreaterThan(0);
});

test('@performance keeps repeated source, seek, and resize operations exact', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exercisePlaybackChurn(12),
  );
  expect(report.iterations).toBe(12);
  expect(report.committedFrameIndexes).toEqual(report.expectedFrameIndexes);
  expect(report.widths).toEqual([
    96, 104, 112, 120, 96, 104, 112, 120, 96, 104, 112, 120,
  ]);
  expect(report.stats.videoQueueDepth.max).toBeLessThanOrEqual(2);
  expect(report.stats.overlayRenderTime.sampleCount).toBeGreaterThan(0);
});

test('@performance fails open when AudioContext resume remains blocked', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exerciseBlockedAudioResume(),
  );
  expect(report).toMatchObject({
    warningCode: 'audio_resume_timeout',
    warningName: 'MediaPlayerAudioResumeTimeoutError',
    timeoutMilliseconds: 25,
  });
  expect(report.clockSamples.length).toBeGreaterThan(0);
  expectNondecreasing(report.clockSamples);
  expect(report.stats.avPresentationError).toEqual({
    currentSeconds: null,
    maxAbsoluteSeconds: null,
  });
  expect(report.stats.audioQueueDepth.max).toBe(0);
  expect(report.stats.uniqueVideoFramesRendered).toBeGreaterThan(0);
});

test(`@performance disposes React media players across ${reactMountCycles} mount cycles`, async ({
  page,
}) => {
  test.setTimeout(reactMountCycles === optInReactMountCycles ? 120_000 : 30_000);
  await page.goto('/');
  const report = await page.evaluate(
    (cycles) => window.mediaHarness.exerciseReactMountStress(cycles),
    reactMountCycles,
  );
  expect(report.cycles).toBe(reactMountCycles);
  expect(report.readyCount).toBe(reactMountCycles);
  expect(report.disposeCounts).toHaveLength(reactMountCycles);
  expect(report.disposeCounts.every((count) => count === 1)).toBe(true);
  expect(report.remainingCanvasCount).toBe(0);
  expect(report.remainingVideoCount).toBe(0);
});
