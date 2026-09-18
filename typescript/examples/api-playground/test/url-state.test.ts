/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import { findMediaExample } from '../src/examples';
import { appReducer, createInitialState } from '../src/model';
import { getReplayScenario } from '../src/scenarios';
import { createSafeUrl, readSafeUrlState } from '../src/url-state';

const fixture = getReplayScenario('two-objects');
const bedroom = findMediaExample('bedroom')!;

describe('safe URL state', () => {
  it('round-trips a fixture selection, prompt, and no foreign params', () => {
    const state = createInitialState({ fixture, prompt: 'untrusted override' });
    const current = new URL(
      'https://playground.test/?apiKey=secret&file=blob%3Aunsafe&results=private#evidence',
    );
    const next = createSafeUrl(state, current);
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
    const next = createSafeUrl(state, new URL('https://playground.test/'));
    expect(next.searchParams.get('example')).toBe('bedroom');
    expect(next.searchParams.get('prompt')).toBe('paddle');
    expect(next.searchParams.get('model')).toBe('example-video-model');
    expect(next.searchParams.get('overlay')).toBe('0');
    expect(next.searchParams.get('panel')).toBe('stream');

    const defaults = createSafeUrl(
      createInitialState({ example: bedroom }),
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
      state,
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
});
