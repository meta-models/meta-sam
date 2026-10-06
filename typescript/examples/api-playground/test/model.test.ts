/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type {
  ImageSegmentationResult,
  ImageSegmentationSnapshot,
  VideoSegmentationResult,
  VideoSegmentationSnapshot,
} from '@meta-sam/parser';
import { describe, expect, it } from 'vitest';

import { findMediaExample } from '../src/examples';
import {
  appReducer,
  createInitialState,
  MAX_STREAM_ENTRIES,
  type RunStatus,
} from '../src/model';
import { getReplayScenario } from '../src/scenarios';

const fixture = getReplayScenario('two-objects');
const videoFixture = getReplayScenario('video-quick', 'video');
const bedroom = findMediaExample('bedroom')!;
const truck = findMediaExample('truck')!;
const snapshot: ImageSegmentationSnapshot = {
  media: 'image',
  revision: 1,
  records: [],
  diagnostics: [],
  rawOutput: '',
};
const result: ImageSegmentationResult = {
  ...snapshot,
  outcome: { status: 'completed' },
};
const videoSnapshot: VideoSegmentationSnapshot = {
  media: 'video',
  revision: 1,
  records: [],
  diagnostics: [],
  rawOutput: '',
};
const videoResult: VideoSegmentationResult = {
  ...videoSnapshot,
  outcome: { status: 'completed' },
};

function start(runId = 1) {
  return appReducer(createInitialState({ example: truck }), {
    type: 'runStart',
    runId,
  });
}

describe('app reducer', () => {
  it('starts empty, stages examples live, and keeps fixture prompts editable', () => {
    const empty = createInitialState();
    expect(empty.media).toMatchObject({ kind: null, origin: null, sourceUrl: null });
    expect(empty.run).toMatchObject({ status: 'idle', transport: 'live' });

    const example = createInitialState({ example: bedroom });
    expect(example.media).toMatchObject({
      kind: 'video',
      origin: 'example',
      id: 'bedroom',
      sourceUrl: '/media/bedroom.mp4',
    });
    expect(example.prompt.text).toBe(bedroom.prompt);
    expect(example.run).toMatchObject({ status: 'ready', transport: 'live' });

    const fixtureState = createInitialState({ fixture, prompt: 'fixture override' });
    expect(fixtureState.media).toMatchObject({
      kind: 'image',
      origin: 'fixture',
      id: fixture.id,
    });
    expect(fixtureState.prompt.text).toBe('fixture override');
    expect(fixtureState.run.transport).toBe('fixture');
    expect(
      appReducer(fixtureState, { type: 'setPrompt', text: 'edited' }),
    ).toMatchObject({
      prompt: { text: 'edited' },
      run: fixtureState.run,
    });
  });

  it('initializes, validates, and preserves the selected model', () => {
    let state = createInitialState({ example: truck, model: 'sam-3.1' });
    expect(state.request.model).toBe('sam-3.1');
    expect(createInitialState({ model: 'invalid model' }).request.model).toBeNull();
    expect(
      appReducer(state, { type: 'initializeModel', model: 'configured-model' }),
    ).toBe(state);

    state = appReducer(state, {
      type: 'setModel',
      runId: 1,
      model: 'example-video-model',
    });
    expect(state.request.model).toBe('example-video-model');
    expect(state.run).toMatchObject({ runId: 1, status: 'ready' });
    const staged = appReducer(state, {
      type: 'stageExample',
      runId: 2,
      example: bedroom,
    });
    expect(staged.request.model).toBe('example-video-model');
    expect(
      appReducer(staged, { type: 'setModel', runId: 3, model: 'invalid model' }),
    ).toBe(staged);
  });

  it('models ready, streaming, rendered, and completed states explicitly', () => {
    const ready = createInitialState({ example: truck });
    expect(ready.run).toMatchObject({ runId: 0, status: 'ready' });
    expect(ready.renderer.status).toBe('initializing');

    const streaming = appReducer(ready, { type: 'runStart', runId: 1 });
    expect(streaming.run).toMatchObject({ runId: 1, status: 'streaming' });
    expect(streaming.segmentation.snapshot).toBeNull();

    const withSnapshot = appReducer(streaming, {
      type: 'snapshot',
      runId: 1,
      snapshot,
    });
    expect(withSnapshot.segmentation.snapshot).toBe(snapshot);
    expect(withSnapshot.renderer.status).toBe('initializing');

    const rendered = appReducer(withSnapshot, {
      type: 'rendererReady',
      runId: 1,
      attempt: 0,
      renderedRevision: 1,
    });
    const completed = appReducer(rendered, { type: 'runResult', runId: 1, result });
    expect(completed.run.status).toBe('completed');
    expect(completed.renderer).toMatchObject({ status: 'ready', renderedRevision: 1 });
    expect(completed.segmentation.snapshot).toBe(result);
  });

  it('uploads staged video once and keeps the handle across runs and prompt edits', () => {
    let state = createInitialState({ example: bedroom });
    const generation = state.media.generation;
    expect(state.media.upload).toEqual({
      status: 'idle',
      fileId: null,
      message: null,
    });

    state = appReducer(state, { type: 'mediaUploadStart', generation });
    expect(state.media.upload.status).toBe('uploading');
    state = appReducer(state, {
      type: 'mediaUploadReady',
      generation,
      fileId: 'file-abc',
    });
    expect(state.media.upload).toEqual({
      status: 'ready',
      fileId: 'file-abc',
      message: null,
    });

    const edited = appReducer(state, {
      type: 'setPrompt',
      text: 'blanket',
    });
    expect(edited.media.generation).toBe(generation);
    expect(edited.media.upload.fileId).toBe('file-abc');
    const streaming = appReducer(edited, { type: 'runStart', runId: 1 });
    expect(streaming.run.status).toBe('streaming');
    expect(streaming.media.upload.fileId).toBe('file-abc');
    const rerun = appReducer(streaming, { type: 'runStart', runId: 2 });
    expect(rerun.media.upload.fileId).toBe('file-abc');
  });

  it('keeps a valid score threshold across model changes and locks it while streaming', () => {
    const groceries = findMediaExample('groceries')!;
    expect(
      createInitialState({ example: groceries }).request.scoreThreshold,
    ).toBeNull();
    expect(
      createInitialState({ example: groceries, scoreThreshold: 1.5 }).request
        .scoreThreshold,
    ).toBeNull();
    let state = createInitialState({ example: groceries, scoreThreshold: 0.4 });
    expect(state.request.scoreThreshold).toBe(0.4);
    state = appReducer(state, { type: 'setScoreThreshold', value: 0.9 });
    expect(state.request.scoreThreshold).toBe(0.9);
    for (const invalid of [2, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(appReducer(state, { type: 'setScoreThreshold', value: invalid })).toBe(
        state,
      );
    }
    state = appReducer(state, { type: 'setModel', runId: 1, model: 'alpha-model' });
    expect(state.request).toEqual({
      model: 'alpha-model',
      scoreThreshold: 0.9,
      includeConfidence: true,
    });
    state = appReducer(state, { type: 'runStart', runId: 2 });
    expect(appReducer(state, { type: 'setScoreThreshold', value: 0.2 })).toBe(state);
    state = appReducer(state, {
      type: 'runTerminal',
      runId: 2,
      status: 'cancelled',
      message: 'cancelled',
    });
    state = appReducer(state, { type: 'setScoreThreshold', value: null });
    expect(state.request.scoreThreshold).toBeNull();
  });

  it('asks for confidence by default and locks the choice while streaming', () => {
    expect(createInitialState({ example: bedroom }).request.includeConfidence).toBe(
      true,
    );
    let state = createInitialState({ example: bedroom, includeConfidence: false });
    expect(state.request.includeConfidence).toBe(false);
    state = appReducer(state, { type: 'setIncludeConfidence', value: true });
    expect(state.request.includeConfidence).toBe(true);
    expect(appReducer(state, { type: 'setIncludeConfidence', value: true })).toBe(
      state,
    );
    state = appReducer(state, { type: 'setModel', runId: 1, model: 'alpha-model' });
    expect(state.request.includeConfidence).toBe(true);
    state = appReducer(state, { type: 'runStart', runId: 2 });
    expect(appReducer(state, { type: 'setIncludeConfidence', value: false })).toBe(
      state,
    );
    state = appReducer(state, {
      type: 'runTerminal',
      runId: 2,
      status: 'cancelled',
      message: 'cancelled',
    });
    state = appReducer(state, { type: 'setIncludeConfidence', value: false });
    expect(state.request.includeConfidence).toBe(false);
  });

  it('keeps the noun phrase a run started with for its labels', () => {
    let state = createInitialState({ example: bedroom });
    expect(state.run.prompt).toBeNull();
    state = appReducer(state, { type: 'setPrompt', text: '  blanket  ' });
    state = appReducer(state, { type: 'runStart', runId: 1 });
    expect(state.run.prompt).toBe('blanket');
    // The prompt field is locked while a run streams; edits apply after it ends.
    state = appReducer(state, { type: 'setPrompt', text: 'ignored' });
    expect(state.prompt.text).toBe('  blanket  ');
    state = appReducer(state, {
      type: 'runTerminal',
      runId: 1,
      status: 'cancelled',
      message: 'cancelled',
    });
    state = appReducer(state, { type: 'setPrompt', text: 'pillow' });
    expect(state.run.prompt).toBe('blanket');
    state = appReducer(state, { type: 'runStart', runId: 2 });
    expect(state.run.prompt).toBe('pillow');
  });

  it('clears the upload when the media changes and fences stale completions', () => {
    let state = createInitialState({ example: bedroom });
    state = appReducer(state, { type: 'mediaUploadStart', generation: 0 });
    state = appReducer(state, {
      type: 'mediaUploadReady',
      generation: 0,
      fileId: 'file-abc',
    });

    // Re-selecting a video example is a new media generation and must clear
    // the previous upload like any other media change.
    const staged = appReducer(state, {
      type: 'stageExample',
      runId: 5,
      example: bedroom,
    });
    expect(staged.media.generation).toBe(5);
    expect(staged.media.upload).toEqual({
      status: 'idle',
      fileId: null,
      message: null,
    });
    expect(
      appReducer(staged, {
        type: 'mediaUploadReady',
        generation: 0,
        fileId: 'file-stale',
      }),
    ).toBe(staged);

    const failed = appReducer(
      appReducer(staged, { type: 'mediaUploadStart', generation: 5 }),
      { type: 'mediaUploadFailed', generation: 5, message: 'The upload failed.' },
    );
    expect(failed.media.upload).toEqual({
      status: 'failed',
      fileId: null,
      message: 'The upload failed.',
    });

    const image = appReducer(createInitialState({ example: truck }), {
      type: 'mediaUploadStart',
      generation: 0,
    });
    expect(image.media.upload.status).toBe('idle');
  });

  it('starts every run streaming now that the bytes are uploaded up front', () => {
    const fixtureVideo = createInitialState({ fixture: videoFixture });
    expect(appReducer(fixtureVideo, { type: 'runStart', runId: 1 }).run.status).toBe(
      'streaming',
    );
  });

  it('logs the raw stream in order, bounds it, and records the end', () => {
    let state = start();
    for (let index = 0; index < MAX_STREAM_ENTRIES + 5; index += 1) {
      state = appReducer(state, {
        type: 'streamEntry',
        runId: 1,
        entry: { atMs: index, kind: 'delta', text: 'x' },
      });
    }
    expect(state.stream.entries).toHaveLength(MAX_STREAM_ENTRIES);
    expect(state.stream.droppedEntries).toBe(5);
    expect(state.stream.entries[0]?.sequence).toBe(5);
    expect(state.stream.entries.at(-1)?.sequence).toBe(MAX_STREAM_ENTRIES + 4);
    expect(state.stream.characters).toBe(MAX_STREAM_ENTRIES + 5);
    expect(state.stream.text).toHaveLength(MAX_STREAM_ENTRIES + 5);

    const terminal = appReducer(state, {
      type: 'streamEntry',
      runId: 1,
      entry: { atMs: 9_000, kind: 'terminal', text: 'response.completed' },
    });
    expect(terminal.stream.characters).toBe(state.stream.characters);
    const ended = appReducer(terminal, { type: 'streamEnd', runId: 1, atMs: 9_001 });
    expect(ended.stream.endedMs).toBe(9_001);
    expect(appReducer(ended, { type: 'streamEnd', runId: 1, atMs: 9_500 })).toBe(ended);
    expect(
      appReducer(ended, {
        type: 'streamEntry',
        runId: 0,
        entry: { atMs: 1, kind: 'delta', text: 'stale' },
      }),
    ).toBe(ended);
  });

  it('waits for the matching visualization before completing a run', () => {
    const streaming = start();
    const awaitingRender = appReducer(streaming, {
      type: 'runResult',
      runId: 1,
      result,
    });
    expect(awaitingRender.run.status).toBe('streaming');
    expect(awaitingRender.segmentation.pendingResult).toBe(result);

    const stale = appReducer(awaitingRender, {
      type: 'rendererReady',
      runId: 0,
      attempt: 0,
      renderedRevision: 1,
    });
    expect(stale).toBe(awaitingRender);

    const completed = appReducer(awaitingRender, {
      type: 'rendererReady',
      runId: 1,
      attempt: 0,
      renderedRevision: 1,
    });
    expect(completed.run.status).toBe('completed');
    expect(completed.segmentation.pendingResult).toBeNull();
  });

  it.each(['cancelled', 'refused', 'failed'] as const)(
    'keeps %s as a distinct terminal state',
    (status) => {
      const state = appReducer(start(), {
        type: 'runTerminal',
        runId: 1,
        status,
        message: status,
      });
      expect(state.run).toMatchObject({ runId: 1, status, message: status });
    },
  );

  it('ignores prompt edits while streaming and stale run actions', () => {
    let state = createInitialState({ example: truck });
    state = appReducer(state, { type: 'setPrompt', text: 'first prompt' });
    state = appReducer(state, { type: 'runStart', runId: 1 });
    expect(appReducer(state, { type: 'setPrompt', text: 'second prompt' })).toBe(state);

    expect(appReducer(state, { type: 'snapshot', runId: 0, snapshot })).toBe(state);
    expect(appReducer(state, { type: 'runResult', runId: 0, result })).toBe(state);
    expect(
      appReducer(state, {
        type: 'runTerminal',
        runId: 0,
        status: 'failed',
        message: 'stale',
      }),
    ).toBe(state);
    expect(appReducer(state, { type: 'runStart', runId: 1 })).toBe(state);
  });

  it('keeps completed output visible while the next prompt is edited', () => {
    let state = start();
    state = appReducer(state, { type: 'snapshot', runId: 1, snapshot });
    state = appReducer(state, {
      type: 'streamEntry',
      runId: 1,
      entry: { atMs: 1, kind: 'delta', text: 'a' },
    });
    state = appReducer(state, { type: 'toggleObject', objectId: 'shape' });
    state = appReducer(state, {
      type: 'runTerminal',
      runId: 1,
      status: 'failed',
      message: 'boom',
    });
    const edited = appReducer(state, { type: 'setPrompt', text: 'new' });
    expect(edited.prompt.text).toBe('new');
    expect(edited.segmentation).toBe(state.segmentation);
    expect(edited.stream).toBe(state.stream);
    expect(edited.view).toBe(state.view);
    expect(edited.run).toBe(state.run);
    expect(edited.renderer).toBe(state.renderer);
  });

  it('sequences upload completion by generation and detects the media kind', () => {
    let state = createInitialState({ example: truck });
    state = appReducer(state, { type: 'uploadSelectionStart', runId: 1 });
    expect(state.media.origin).toBe('example');
    const file = new File(['mp4'], 'clip.mp4', { type: 'video/mp4' });
    const uploaded = appReducer(state, {
      type: 'uploadMedia',
      runId: 2,
      kind: 'video',
      file,
      url: 'blob:clip',
      width: 0,
      height: 0,
    });
    expect(uploaded.media).toMatchObject({
      kind: 'video',
      origin: 'upload',
      id: null,
      sourceUrl: 'blob:clip',
      sourceName: 'clip.mp4',
      file,
    });
    expect(uploaded.prompt.text).toBe(truck.prompt);
    expect(uploaded.run).toMatchObject({
      runId: 2,
      status: 'ready',
      transport: 'live',
    });
    const withMetadata = appReducer(uploaded, {
      type: 'mediaMetadata',
      runId: 2,
      width: 1280,
      height: 720,
    });
    expect(withMetadata.media).toMatchObject({ sourceWidth: 1280, sourceHeight: 720 });
    expect(
      appReducer(uploaded, { type: 'mediaMetadata', runId: 1, width: 1, height: 1 }),
    ).toBe(uploaded);

    const stale = appReducer(uploaded, {
      type: 'uploadMedia',
      runId: 2,
      kind: 'image',
      file,
      url: 'blob:stale',
      width: 1,
      height: 1,
    });
    expect(stale).toBe(uploaded);

    const failed = appReducer(uploaded, {
      type: 'uploadError',
      runId: 3,
      message: 'too large',
    });
    expect(failed.run).toMatchObject({
      runId: 3,
      status: 'failed',
      message: 'too large',
    });

    const cleared = appReducer(failed, { type: 'clearMedia', runId: 4 });
    expect(cleared.media.sourceUrl).toBeNull();
    expect(cleared.run.status).toBe('idle');
  });

  it('keeps renderer errors durable until an explicit retry and fences attempts', () => {
    let state = start();
    state = appReducer(state, {
      type: 'rendererFailed',
      runId: 1,
      attempt: 0,
      message: 'canvas lost',
    });
    expect(state.run).toMatchObject({ status: 'failed', message: 'canvas lost' });
    expect(state.renderer).toMatchObject({ status: 'error', attempt: 0 });

    const lateReady = appReducer(state, {
      type: 'rendererReady',
      runId: 1,
      attempt: 0,
      renderedRevision: 1,
    });
    expect(lateReady).toBe(state);
    const lateInit = appReducer(state, {
      type: 'rendererInitializing',
      runId: 1,
      attempt: 0,
    });
    expect(lateInit).toBe(state);

    const retried = appReducer(state, { type: 'retryRenderer' });
    expect(retried.renderer).toMatchObject({ status: 'initializing', attempt: 1 });
    expect(retried.run.status).toBe('ready');
    expect(
      appReducer(retried, {
        type: 'rendererFailed',
        runId: 1,
        attempt: 0,
        message: 'stale attempt',
      }),
    ).toBe(retried);
  });

  it('turns a visualization failure after a result into failure, not completion', () => {
    let state = start();
    state = appReducer(state, { type: 'runResult', runId: 1, result });
    state = appReducer(state, {
      type: 'rendererFailed',
      runId: 1,
      attempt: 0,
      message: 'render failed',
    });
    expect(state.run.status).toBe('failed');
    expect(state.segmentation.pendingResult).toBeNull();
  });

  it('stages video as ready and waits for the matching cumulative render', () => {
    let state = createInitialState({ fixture: videoFixture });
    expect(state.media.kind).toBe('video');
    expect(state.run.status).toBe('ready');
    state = appReducer(state, { type: 'runStart', runId: 1 });
    state = appReducer(state, { type: 'snapshot', runId: 1, snapshot: videoSnapshot });
    state = appReducer(state, { type: 'runResult', runId: 1, result: videoResult });
    expect(state.run.status).toBe('streaming');
    state = appReducer(state, {
      type: 'rendererReady',
      runId: 1,
      attempt: 0,
      renderedRevision: 1,
    });
    expect(state.run.status).toBe('completed');
    expect(state.segmentation.snapshot).toBe(videoResult);
  });

  it('rejects snapshots from a different media kind', () => {
    const state = start();
    expect(
      appReducer(state, { type: 'snapshot', runId: 1, snapshot: videoSnapshot }),
    ).toBe(state);
    expect(
      appReducer(state, { type: 'runResult', runId: 1, result: videoResult }),
    ).toBe(state);
  });

  it('toggles object visibility, restores all, and switches inspector tabs', () => {
    let state = appReducer(start(), { type: 'snapshot', runId: 1, snapshot });
    state = appReducer(state, { type: 'toggleObject', objectId: 'a' });
    state = appReducer(state, { type: 'toggleObject', objectId: 'b' });
    expect(state.view.hiddenObjectIds).toEqual(['a', 'b']);
    expect(state.renderer.status).toBe('initializing');
    state = appReducer(state, { type: 'toggleObject', objectId: 'a' });
    expect(state.view.hiddenObjectIds).toEqual(['b']);
    state = appReducer(state, { type: 'showAllObjects' });
    expect(state.view.hiddenObjectIds).toEqual([]);
    expect(appReducer(state, { type: 'showAllObjects' })).toBe(state);
    state = appReducer(state, { type: 'setInspectorTab', tab: 'stream' });
    expect(state.view.inspectorTab).toBe('stream');
    state = appReducer(state, { type: 'setView', key: 'showBoxes', value: false });
    expect(state.view.showBoxes).toBe(false);
  });

  it('toggles mask outlines on and off without touching other view state', () => {
    const initial = createInitialState({ example: truck });
    expect(initial.view.showOutlines).toBe(true);

    const withSnapshot = appReducer(
      appReducer(initial, { type: 'runStart', runId: 1 }),
      { type: 'snapshot', runId: 1, snapshot },
    );
    const off = appReducer(withSnapshot, {
      type: 'setView',
      key: 'showOutlines',
      value: false,
    });
    expect(off.view.showOutlines).toBe(false);
    expect(off.view.showMasks).toBe(true);
    expect(off.view.showOverlay).toBe(true);
    expect(off.renderer.status).toBe('initializing');
    expect(withSnapshot.view.showOutlines).toBe(true);

    // Setting the same value is a no-op that keeps the renderer as it stands.
    const again = appReducer(off, {
      type: 'setView',
      key: 'showOutlines',
      value: false,
    });
    expect(again.view).toEqual(off.view);
    expect(again.renderer).toBe(off.renderer);

    const on = appReducer(off, { type: 'setView', key: 'showOutlines', value: true });
    expect(on.view.showOutlines).toBe(true);
  });

  it('supports every declared run state', () => {
    const statuses: RunStatus[] = [
      'idle',
      'ready',
      'streaming',
      'completed',
      'incomplete',
      'cancelled',
      'refused',
      'failed',
    ];
    expect(new Set(statuses).size).toBe(statuses.length);
  });
});
