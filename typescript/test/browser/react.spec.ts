/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test, type Page } from '@playwright/test';

async function exerciseReactAudio(page: Page, file: string) {
  const selector = await page.evaluate(
    (fixture) => window.mediaHarness.prepareReactAudioExercise(fixture),
    file,
  );
  await page.locator(selector).click();
  return await page.evaluate(() => window.mediaHarness.waitForReactAudioExercise());
}

test.describe.configure({ mode: 'serial' });

test('runs VP9 through the React Canvas component with exact seeks and overlays', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exerciseReactVideo('webm-vp9-opus.webm', 'webm-vp8-opus.webm'),
  );
  expect(report.status).toBe('played');
  if (report.status !== 'played') return;

  expect(report.canvasCount).toBe(1);
  expect(report.videoCount).toBe(0);
  expect(report.readyCount).toBe(1);
  expect(report.packetTimestamps).toEqual([
    0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875,
  ]);
  expect(report.exactPacketFrameIndex).toBe(4);
  expect(report.exactSeekFrameIndex).toBe(4);
  expect(report.replacementFrameIndex).toBe(0);
  expect(report.staleTimeCallsAfterUpdate).toBe(0);
  expect(report.freshTimeCalls).toBeGreaterThan(0);
  expect(report.staleLoadedCallsAfterUpdate).toBe(0);
  expect(report.freshLoadedCalls).toBe(1);
  expect(report.compositedPixel[3]).toBe(255);
  expect(report.rawPixel[3]).toBe(255);
  expect(report.hiddenPixel[3]).toBe(255);
  expect(report.compositedPixel).not.toEqual(report.rawPixel);
  expect(report.hiddenPixel).toEqual(report.rawPixel);
  expect(report.stats.uniqueVideoFramesRendered).toBeGreaterThan(0);
  expect(report.stats.duplicateRedraws).toBeGreaterThan(0);
  expect(report.stats.videoQueueDepth.max).toBeLessThanOrEqual(2);
  expect(report.stats.decodeTime.sampleCount).toBeGreaterThan(0);
});

test('runs useMediaPlayer on a caller-owned Canvas with current callbacks and source replacement', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exerciseReactHook('webm-vp9-opus.webm', 'webm-vp8-opus.webm'),
  );
  expect(report.status).toBe('played');
  if (report.status !== 'played') return;

  expect(report.canvasCount).toBe(1);
  expect(report.videoCount).toBe(0);
  expect(report.readyCount).toBe(1);
  expect(report.renderCount).toBeGreaterThan(1);
  expect(report.staleTimeCallsAfterUpdate).toBe(0);
  expect(report.freshTimeCalls).toBeGreaterThan(0);
  expect(report.frameIndex).toBe(1);
  expect(report.replacementFrameIndex).toBe(0);
  expect(report.pixel[3]).toBe(255);
});

test('keeps a fatal React harness failure authoritative over later unsupported capability', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exerciseReactFailurePrecedence(),
  );
  expect(report).toEqual({
    fatalMessage: 'fatal-before-unsupported',
    unsupportedCode: 'media_source_error',
    selectedMessage: 'fatal-before-unsupported',
  });
});

test('runs H.264 through React when the browser reports decoder support', async ({
  page,
}) => {
  await page.goto('/');
  const [capability, report] = await Promise.all([
    page.evaluate(() => window.mediaHarness.analyzeFixture('mp4-h264-aac.mp4')),
    page.evaluate(() => window.mediaHarness.exerciseReactVideo('mp4-h264-aac.mp4')),
  ]);
  const video = capability.tracks.find((track) => track.type === 'video');
  expect(video).toBeDefined();
  expect(report.status).toBe(video!.nativeCanDecode ? 'played' : 'unsupported');
  if (report.status !== 'played') return;

  expect(report.canvasCount).toBe(1);
  expect(report.videoCount).toBe(0);
  expect(report.readyCount).toBe(1);
  expect(report.exactPacketFrameIndex).toBe(4);
  expect(report.exactSeekFrameIndex).toBe(4);
  expect(report.compositedPixel[3]).toBe(255);
  expect(report.rawPixel[3]).toBe(255);
  expect(report.hiddenPixel[3]).toBe(255);
  expect(report.compositedPixel).not.toEqual(report.rawPixel);
  expect(report.hiddenPixel).toEqual(report.rawPixel);
  expect(report.staleTimeCallsAfterUpdate).toBe(0);
  expect(report.freshTimeCalls).toBeGreaterThan(0);
});

test('disposes every StrictMode React player exactly once without leaking DOM media', async ({
  page,
}) => {
  await page.goto('/');
  const report = await page.evaluate(() =>
    window.mediaHarness.exerciseReactStrictMode(),
  );
  expect(report.readyCount).toBeGreaterThanOrEqual(2);
  expect(report.disposeCounts).toHaveLength(report.readyCount);
  expect(report.disposeCounts.every((count) => count === 1)).toBe(true);
  expect(report.canvasCount).toBe(1);
  expect(report.videoCount).toBe(0);
});

test('drives React Opus audio controls from a trusted click', async ({ page }) => {
  await page.goto('/');
  const report = await exerciseReactAudio(page, 'webm-vp9-opus.webm');
  expect(report.status).toBe('played');
  if (report.status !== 'played') return;

  expect(report.audioMetadata).toMatchObject({
    capability: 'supported',
    codec: 'opus',
    sampleRate: 48_000,
    numberOfChannels: 1,
  });
  expect(report.peakScheduledBufferCount).toBeGreaterThan(0);
  expect(report.peakScheduledBufferCount).toBeLessThanOrEqual(16);
  expect(report.audioStatus).toMatchObject({
    capability: 'supported',
    clockSource: 'audio-context',
    contextState: 'running',
  });
  expect(report.stats.audioQueueDepth.max).toBeGreaterThan(0);
  expect(report.stats.audioQueueDepth.max).toBeLessThanOrEqual(16);
});

test('drives React AAC controls when H.264 is supported', async ({ page }) => {
  await page.goto('/');
  const capability = await page.evaluate(() =>
    window.mediaHarness.analyzeFixture('mp4-h264-aac.mp4'),
  );
  const video = capability.tracks.find((track) => track.type === 'video');
  const audio = capability.tracks.find((track) => track.type === 'audio');
  expect(video).toBeDefined();
  expect(audio).toBeDefined();

  const report = await exerciseReactAudio(page, 'mp4-h264-aac.mp4');
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
  expect(report.stats.uniqueVideoFramesRendered).toBeGreaterThan(0);
  if (audio!.nativeCanDecode) {
    expect(report.peakScheduledBufferCount).toBeGreaterThan(0);
    expect(report.audioStatus.clockSource).toBe('audio-context');
  } else {
    expect(report.peakScheduledBufferCount).toBe(0);
    expect(report.audioStatus.capability).toBe('unsupported');
  }
});
