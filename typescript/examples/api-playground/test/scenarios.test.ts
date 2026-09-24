/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import {
  findReplayScenario,
  getDefaultReplayScenario,
  getReplayScenario,
  replayScenariosFor,
} from '../src/scenarios';

describe('replay scenarios', () => {
  it('keeps deterministic defaults and declared ordering per media mode', () => {
    expect(replayScenariosFor('image').map((scenario) => scenario.id)).toEqual([
      'two-objects',
      'confidence',
      'fragmented-diagnostic',
      'incomplete',
      'refusal',
      'failure',
    ]);
    expect(replayScenariosFor('video').map((scenario) => scenario.id)).toEqual([
      'video-sustained',
      'video-quick',
    ]);
    expect(getDefaultReplayScenario('image').id).toBe('two-objects');
    expect(getDefaultReplayScenario('video').id).toBe('video-sustained');
  });

  it('never resolves a scenario across media modes', () => {
    expect(findReplayScenario('video-quick', 'image')).toBeUndefined();
    expect(findReplayScenario('two-objects', 'video')).toBeUndefined();
    expect(getReplayScenario('two-objects', 'video').id).toBe('video-sustained');
    expect(getReplayScenario('video-quick', 'image').id).toBe('two-objects');
  });
});
