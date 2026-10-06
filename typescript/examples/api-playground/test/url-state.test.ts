/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import { findMediaExample } from '../src/examples';
import { appReducer, createInitialState } from '../src/model';
import { getReplayScenario } from '../src/scenarios';
import {
  createSafeUrl,
  readSafeUrlState,
  safeUrlSettingsFromState,
} from '../src/url-state';

const fixture = getReplayScenario('two-objects');
const bedroom = findMediaExample('bedroom')!;
const groceries = findMediaExample('groceries')!;

describe('safe URL state', () => {
  it('round-trips a fixture selection, prompt, and no foreign params', () => {
    const state = createInitialState({ fixture, prompt: 'untrusted override' });
    const current = new URL(
      'https://playground.test/?apiKey=secret&file=blob%3Aunsafe&results=private#evidence',
    );
    const next = createSafeUrl(safeUrlSettingsFromState(state), current);
    expect([...next.searchParams.keys()].sort()).toEqual(['fixture', 'prompt']);
    expect(next.searchParams.get('fixture')).toBe('two-objects');
    expect(next.searchParams.get('prompt')).toBe('untrusted override');
    expect(state.prompt.text).toBe('untrusted override');
    expect(next.href).not.toContain('secret');
    expect(next.href).not.toContain('blob%3Aunsafe');
    expect(next.hash).toBe('#evidence');
  });

  it('round-trips an example with its live prompt and non-default view state', () => {
    let state = createInitialState({ example: bedroom });
    state = appReducer(state, { type: 'setPrompt', text: 'paddle' });
    state = appReducer(state, {
      type: 'setModel',
      runId: 1,
      model: 'example-video-model',
    });
    state = appReducer(state, { type: 'setView', key: 'showOverlay', value: false });
    state = appReducer(state, { type: 'setInspectorTab', tab: 'stream' });
    const next = createSafeUrl(
      safeUrlSettingsFromState(state),
      new URL('https://playground.test/'),
    );
    expect(next.searchParams.get('example')).toBe('bedroom');
    expect(next.searchParams.get('prompt')).toBe('paddle');
    expect(next.searchParams.get('model')).toBe('example-video-model');
    expect(next.searchParams.get('overlay')).toBe('0');
    expect(next.searchParams.get('panel')).toBe('stream');

    const defaults = createSafeUrl(
      safeUrlSettingsFromState(createInitialState({ example: bedroom })),
      new URL('https://playground.test/'),
    );
    expect([...defaults.searchParams.keys()].sort()).toEqual(['example', 'prompt']);
  });

  it('never serializes uploaded media', () => {
    let state = createInitialState();
    state = appReducer(state, {
      type: 'uploadMedia',
      runId: 1,
      kind: 'video',
      file: new File(['x'], 'private.mp4', { type: 'video/mp4' }),
      url: 'blob:private',
      width: 0,
      height: 0,
    });
    const next = createSafeUrl(
      safeUrlSettingsFromState(state),
      new URL('https://playground.test/?file=blob%3Aprivate'),
    );
    expect(next.searchParams.has('example')).toBe(false);
    expect(next.searchParams.has('fixture')).toBe(false);
    expect(next.href).not.toContain('private');
  });

  it('bounds prompt input and ignores unknown settings', () => {
    const url = new URL(
      `https://playground.test/?example=groceries&prompt=${'x'.repeat(161)}&key=secret&overlay=0&panel=bogus`,
    );
    expect(readSafeUrlState(url)).toEqual({
      exampleId: 'groceries',
      fixtureId: null,
      prompt: null,
      model: null,
      scoreThreshold: null,
      includeConfidence: true,
      showOverlay: false,
      inspectorTab: null,
    });
    expect(
      readSafeUrlState(
        new URL(
          'https://playground.test/?fixture=video-quick&panel=raw&model=beta-model',
        ),
      ),
    ).toMatchObject({
      fixtureId: 'video-quick',
      model: 'beta-model',
      inspectorTab: 'raw',
      showOverlay: true,
    });
    expect(
      readSafeUrlState(new URL('https://playground.test/?model=invalid%20model')).model,
    ).toBeNull();
  });

  it('records a live opt-out of confidence and ignores it for replays', () => {
    for (const example of [groceries, bedroom]) {
      let state = createInitialState({ example });
      const on = createSafeUrl(
        safeUrlSettingsFromState(state),
        new URL('https://playground.test/'),
      );
      expect(on.searchParams.has('confidence')).toBe(false);
      state = appReducer(state, { type: 'setIncludeConfidence', value: false });
      const off = createSafeUrl(
        safeUrlSettingsFromState(state),
        new URL('https://playground.test/'),
      );
      expect(off.searchParams.get('confidence')).toBe('0');
      expect(readSafeUrlState(off).includeConfidence).toBe(false);
    }
    const replay = createInitialState({ fixture, includeConfidence: false });
    expect(
      createSafeUrl(
        safeUrlSettingsFromState(replay),
        new URL('https://playground.test/'),
      ).searchParams.has('confidence'),
    ).toBe(false);
    const read = (value: string) =>
      readSafeUrlState(new URL(`https://playground.test/?confidence=${value}`))
        .includeConfidence;
    expect(read('0')).toBe(false);
    expect(read('1')).toBe(true);
    expect(read('no')).toBe(true);
  });

  it('round-trips a live image score threshold and omits it for video and replays', () => {
    let image = createInitialState({ example: groceries });
    image = appReducer(image, { type: 'setScoreThreshold', value: 0.35 });
    const next = createSafeUrl(
      safeUrlSettingsFromState(image),
      new URL('https://playground.test/'),
    );
    expect(next.searchParams.get('threshold')).toBe('0.35');
    expect(readSafeUrlState(next).scoreThreshold).toBe(0.35);

    const video = createInitialState({ example: bedroom, scoreThreshold: 0.35 });
    const replay = createInitialState({ fixture, scoreThreshold: 0.35 });
    for (const state of [video, replay]) {
      const url = createSafeUrl(
        safeUrlSettingsFromState(state),
        new URL('https://playground.test/'),
      );
      expect(url.searchParams.has('threshold')).toBe(false);
    }

    const read = (value: string) =>
      readSafeUrlState(
        new URL(`https://playground.test/?threshold=${encodeURIComponent(value)}`),
      ).scoreThreshold;
    expect(read('0')).toBe(0);
    expect(read('1')).toBe(1);
    expect(read('.5')).toBe(0.5);
    for (const invalid of ['1.5', '-0.1', 'abc', '', '1e-1', 'NaN', '0x1']) {
      expect(read(invalid)).toBeNull();
    }
  });
});
