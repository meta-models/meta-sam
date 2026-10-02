/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';

import {
  boxFromCorners,
  clampPoint,
  describeObjectPrompt,
  initialObjectPrompts,
  MAX_POINTS_PER_FRAME,
  MAX_PROMPT_OBJECTS,
  objectPromptText,
  promptFrames,
  reduceObjectPrompts,
  type ObjectPromptAction,
  type ObjectPromptState,
} from '../src/object-prompts';
import { OBJECT_PROMPT_PATTERN } from '../server/server-core.ts';

function apply(
  actions: readonly ObjectPromptAction[],
  start: ObjectPromptState = { ...initialObjectPrompts, mode: 'objects' },
): ObjectPromptState {
  return actions.reduce(reduceObjectPrompts, start);
}

const box = { x1: 10, y1: 20, x2: 40, y2: 60 };
const later = { x1: 12, y1: 22, x2: 44, y2: 64 };

describe('object prompts', () => {
  it('builds one block per frame in ascending order, objects in list order', () => {
    const state = apply([
      { type: 'placePromptBox', frameIndex: 120, box: later },
      { type: 'placePromptBox', frameIndex: 30, box },
      {
        type: 'placePromptPoint',
        frameIndex: 30,
        point: { x: 25, y: 30, positive: false },
      },
      { type: 'addPromptObject' },
      {
        type: 'placePromptPoint',
        frameIndex: 120,
        point: { x: 5, y: 6, positive: true },
      },
    ]);
    const text = objectPromptText(state, 640, 480);
    expect(text).toBe(
      '<30f>1<|box;x1=10;y1=20;x2=40;y2=60;w=640;h=480|>-<|point;x=25;y=30;w=640;h=480|>' +
        '<120f>1<|box;x1=12;y1=22;x2=44;y2=64;w=640;h=480|>,2<|point;x=5;y=6;w=640;h=480|>',
    );
    expect(OBJECT_PROMPT_PATTERN.test(text!)).toBe(true);
    expect(promptFrames(state)).toEqual([30, 120]);
  });

  it('keeps one entry per object and frame: a box replaces, points add up', () => {
    let state = apply([{ type: 'placePromptBox', frameIndex: 3, box }]);
    state = reduceObjectPrompts(state, {
      type: 'placePromptBox',
      frameIndex: 3,
      box: later,
    });
    state = reduceObjectPrompts(state, {
      type: 'placePromptPoint',
      frameIndex: 3,
      point: { x: 1, y: 1, positive: true },
    });
    expect(state.objects).toEqual([
      {
        id: 1,
        frames: [
          { frameIndex: 3, box: later, points: [{ x: 1, y: 1, positive: true }] },
        ],
      },
    ]);
    state = reduceObjectPrompts(state, { type: 'placePromptBox', frameIndex: 0, box });
    expect(state.objects[0]!.frames.map((entry) => entry.frameIndex)).toEqual([0, 3]);
  });

  it('describes entries per frame for video and without frames for images', () => {
    const state = apply([
      { type: 'placePromptBox', frameIndex: 30, box },
      {
        type: 'placePromptPoint',
        frameIndex: 120,
        point: { x: 1, y: 1, positive: false },
      },
    ]);
    expect(describeObjectPrompt(state.objects[0]!, true)).toBe(
      'frame 30: box; frame 120: 1 negative',
    );
    const image = apply([
      { type: 'placePromptBox', frameIndex: 0, box },
      {
        type: 'placePromptPoint',
        frameIndex: 0,
        point: { x: 1, y: 1, positive: false },
      },
    ]);
    expect(describeObjectPrompt(image.objects[0]!, false)).toBe('box · 1 negative');
  });

  it('leaves out objects that name nothing and needs at least one usable object', () => {
    expect(objectPromptText(initialObjectPrompts, 640, 480)).toBeNull();
    const negativeOnly = apply([
      { type: 'setPromptTool', tool: 'negative' },
      {
        type: 'placePromptPoint',
        frameIndex: 0,
        point: { x: 1, y: 1, positive: false },
      },
    ]);
    expect(objectPromptText(negativeOnly, 640, 480)).toBeNull();
    expect(describeObjectPrompt(negativeOnly.objects[0]!, false)).toBe(
      '1 negative · needs a box or a positive point',
    );
    const withEmpty = apply([
      { type: 'placePromptBox', frameIndex: 0, box },
      { type: 'addPromptObject' },
    ]);
    expect(objectPromptText(withEmpty, 640, 480)).toBe(
      '<0f>1<|box;x1=10;y1=20;x2=40;y2=60;w=640;h=480|>',
    );
    expect(objectPromptText(withEmpty, 0, 480)).toBeNull();
  });

  it('clears one frame, dropping objects left without prompts', () => {
    let state = apply([
      { type: 'placePromptBox', frameIndex: 30, box },
      { type: 'placePromptBox', frameIndex: 120, box: later },
      { type: 'addPromptObject' },
      { type: 'placePromptBox', frameIndex: 120, box },
      { type: 'addPromptObject' },
      { type: 'placePromptBox', frameIndex: 60, box },
      { type: 'selectPromptObject', id: 1 },
    ]);
    state = reduceObjectPrompts(state, { type: 'clearPromptFrame', frameIndex: 120 });
    expect(state.objects.map((object) => object.id)).toEqual([1, 3]);
    expect(state.objects[0]!.frames.map((entry) => entry.frameIndex)).toEqual([30]);
    expect(state.selectedId).toBe(1);
    expect(promptFrames(state)).toEqual([30, 60]);
    expect(
      reduceObjectPrompts(state, { type: 'clearPromptFrame', frameIndex: 120 }),
    ).toBe(state);
    state = reduceObjectPrompts(state, { type: 'clearPromptObjects' });
    expect(state).toMatchObject({ objects: [], selectedId: null });
  });

  it('turns corners in any order into a clamped inclusive pixel box', () => {
    expect(boxFromCorners({ x: 40.4, y: 60.6 }, { x: 9.6, y: 19.5 }, 640, 480)).toEqual(
      {
        x1: 10,
        y1: 20,
        x2: 40,
        y2: 61,
      },
    );
    expect(boxFromCorners({ x: -20, y: -5 }, { x: 900, y: 700 }, 640, 480)).toEqual({
      x1: 0,
      y1: 0,
      x2: 639,
      y2: 479,
    });
    expect(clampPoint(-3, 999, 640, 480)).toEqual({ x: 0, y: 479 });
  });

  it('numbers objects from one, selects the new one, and removes by id', () => {
    let state = apply([
      { type: 'placePromptBox', frameIndex: 0, box },
      { type: 'addPromptObject' },
      { type: 'placePromptBox', frameIndex: 0, box },
      { type: 'addPromptObject' },
    ]);
    expect(state.objects.map((object) => object.id)).toEqual([1, 2, 3]);
    expect(state.selectedId).toBe(3);
    state = reduceObjectPrompts(state, { type: 'selectPromptObject', id: 1 });
    expect(state.selectedId).toBe(1);
    expect(reduceObjectPrompts(state, { type: 'selectPromptObject', id: 9 })).toBe(
      state,
    );
    state = reduceObjectPrompts(state, { type: 'removePromptObject', id: 1 });
    expect(state.objects.map((object) => object.id)).toEqual([2, 3]);
    expect(state.selectedId).toBe(3);
    state = reduceObjectPrompts(state, { type: 'addPromptObject' });
    expect(state.objects.at(-1)!.id).toBe(4);
  });

  it('caps objects and points per frame at the playground limits', () => {
    let state = apply([{ type: 'placePromptBox', frameIndex: 0, box }]);
    for (let index = 0; index < MAX_PROMPT_OBJECTS + 3; index += 1) {
      state = reduceObjectPrompts(state, { type: 'addPromptObject' });
    }
    expect(state.objects).toHaveLength(MAX_PROMPT_OBJECTS);
    let points = apply([]);
    for (let index = 0; index < MAX_POINTS_PER_FRAME + 3; index += 1) {
      points = reduceObjectPrompts(points, {
        type: 'placePromptPoint',
        frameIndex: 0,
        point: { x: index, y: index, positive: true },
      });
    }
    expect(points.objects[0]!.frames[0]!.points).toHaveLength(MAX_POINTS_PER_FRAME);
  });

  it('accepts only the token grammar in the relay pattern', () => {
    for (const text of [
      '<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>',
      '<120f>7<|point;x=1;y=2;w=5;h=6|>-<|point;x=3;y=4;w=5;h=6|>',
      '<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>,2<|point;x=1;y=1;w=5;h=6|>',
      '<30f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|><120f>1<|point;x=1;y=1;w=5;h=6|>,2<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>',
    ]) {
      expect(OBJECT_PROMPT_PATTERN.test(text)).toBe(true);
    }
    for (const text of [
      'wheel <0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>',
      '<0f><|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>',
      '<0f>1<|mask;x=0;y=0;data=1,1,!!!!!|>',
      '<0f>1<|box;x1=1.5;y1=2;x2=3;y2=4;w=5;h=6|>',
      '<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>\n<0f>2<|point;x=1;y=1;w=5;h=6|>',
      '<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|><120f>',
      '<0f>1<|box;x1=1;y1=2;x2=3;y2=4;w=5;h=6|>garbage',
    ]) {
      expect(OBJECT_PROMPT_PATTERN.test(text)).toBe(false);
    }
  });
});
