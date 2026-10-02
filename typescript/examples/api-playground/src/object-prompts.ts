/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { buildObjectPrompt } from '@meta-sam/parser';

/**
 * Object prompts name the objects to segment with boxes and points instead of
 * a noun phrase. This module holds the playground's editing state: each object
 * keeps at most one entry per source frame, with an inclusive pixel box and
 * clicks. `objectPromptText` turns that state into the request's `input_text`
 * with `buildObjectPrompt` from `@meta-sam/parser`.
 */

export type PromptMode = 'text' | 'objects';
/**
 * What a plain click adds. A drag always draws a box, and an Option-click or a
 * right-click always adds a negative point, whichever tool is chosen.
 */
export type PromptTool = 'positive' | 'negative';

/** An inclusive pixel box in source-frame coordinates. */
export interface PixelBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface PromptPoint {
  readonly x: number;
  readonly y: number;
  /** `true` adds the region under the click; `false` removes it. */
  readonly positive: boolean;
}

/** One object's prompts on one source frame. */
export interface FramePrompt {
  readonly frameIndex: number;
  readonly box: PixelBox | null;
  readonly points: readonly PromptPoint[];
}

export interface ObjectPrompt {
  readonly id: number;
  /** At most one entry per frame, sorted by frame. */
  readonly frames: readonly FramePrompt[];
}

export interface ObjectPromptState {
  readonly mode: PromptMode;
  readonly tool: PromptTool;
  readonly objects: readonly ObjectPrompt[];
  readonly selectedId: number | null;
}

/** The playground prompts at most 16 objects per request, with up to 16 points per frame. */
export const MAX_PROMPT_OBJECTS = 16;
export const MAX_POINTS_PER_FRAME = 16;
/** A drag shorter than this, in screen pixels, is a click rather than a box. */
export const MIN_BOX_DRAG_PX = 4;

export const initialObjectPrompts: ObjectPromptState = Object.freeze({
  mode: 'text',
  tool: 'positive',
  objects: Object.freeze([]),
  selectedId: null,
});

/** Clears the prompts but keeps the chosen mode and tool. */
export function clearedObjectPrompts(state: ObjectPromptState): ObjectPromptState {
  return { ...state, objects: [], selectedId: null };
}

function hasPositive(entry: FramePrompt): boolean {
  return entry.box !== null || entry.points.some((point) => point.positive);
}

/**
 * An object the API can track needs a box or a positive point on at least one
 * frame; an object with only negative points names nothing.
 */
export function isUsableObject(object: ObjectPrompt): boolean {
  return object.frames.some(hasPositive);
}

/** The frames that carry at least one prompt, ascending. */
export function promptFrames(state: ObjectPromptState): readonly number[] {
  const frames = new Set<number>();
  for (const object of state.objects) {
    for (const entry of object.frames) frames.add(entry.frameIndex);
  }
  return [...frames].sort((a, b) => a - b);
}

function clampPixel(value: number, size: number): number {
  return Math.min(size - 1, Math.max(0, Math.round(value)));
}

/** Rounds and clamps a source-space position onto the frame's pixel grid. */
export function clampPoint(
  x: number,
  y: number,
  width: number,
  height: number,
): { readonly x: number; readonly y: number } {
  return { x: clampPixel(x, width), y: clampPixel(y, height) };
}

/**
 * Turns two opposite corners, in source-space coordinates, into an inclusive
 * pixel box on the frame. The corners may come in any order.
 */
export function boxFromCorners(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  width: number,
  height: number,
): PixelBox {
  const x1 = clampPixel(Math.min(a.x, b.x), width);
  const y1 = clampPixel(Math.min(a.y, b.y), height);
  const x2 = clampPixel(Math.max(a.x, b.x), width);
  const y2 = clampPixel(Math.max(a.y, b.y), height);
  return { x1, y1, x2, y2 };
}

/**
 * The `input_text` for the current prompts, or `null` when no object can be
 * tracked yet. Objects without a box or a positive point on any frame are left
 * out; `buildObjectPrompt` orders frames ascending and keeps the list order of
 * objects within a frame.
 */
export function objectPromptText(
  state: ObjectPromptState,
  width: number,
  height: number,
): string | null {
  const objects = state.objects.filter(isUsableObject);
  if (width <= 0 || height <= 0 || objects.length === 0) return null;
  return buildObjectPrompt({
    size: { width, height },
    objects: objects.map((object) => ({
      id: object.id,
      prompts: object.frames.map((entry) => ({
        frame: entry.frameIndex,
        // The builder takes half-open boxes; the playground keeps inclusive pixels.
        ...(entry.box === null
          ? {}
          : {
              box: {
                left: entry.box.x1,
                top: entry.box.y1,
                right: entry.box.x2 + 1,
                bottom: entry.box.y2 + 1,
              },
            }),
        points: entry.points.map((point) => ({
          x: point.x,
          y: point.y,
          label: point.positive ? ('positive' as const) : ('negative' as const),
        })),
      })),
    })),
  });
}

function describeEntry(entry: FramePrompt): string {
  const positive = entry.points.filter((point) => point.positive).length;
  const negative = entry.points.length - positive;
  return [
    ...(entry.box === null ? [] : ['box']),
    ...(positive === 0 ? [] : [`${positive} positive`]),
    ...(negative === 0 ? [] : [`${negative} negative`]),
  ].join(' · ');
}

/**
 * A short description of one object's prompts, for lists. Video entries name
 * their frame; an image has only frame 0, so its entry needs no frame.
 */
export function describeObjectPrompt(
  object: ObjectPrompt,
  withFrames: boolean,
): string {
  if (object.frames.length === 0) return 'Draw a box or add a point';
  const parts = object.frames.map((entry) =>
    withFrames
      ? `frame ${entry.frameIndex}: ${describeEntry(entry)}`
      : describeEntry(entry),
  );
  const text = parts.join('; ');
  return isUsableObject(object) ? text : `${text} · needs a box or a positive point`;
}

function nextObjectId(objects: readonly ObjectPrompt[]): number {
  return objects.reduce((highest, object) => Math.max(highest, object.id), 0) + 1;
}

export type ObjectPromptAction =
  | { readonly type: 'setPromptMode'; readonly mode: PromptMode }
  | { readonly type: 'setPromptTool'; readonly tool: PromptTool }
  | { readonly type: 'addPromptObject' }
  | { readonly type: 'selectPromptObject'; readonly id: number }
  | { readonly type: 'removePromptObject'; readonly id: number }
  | { readonly type: 'clearPromptObjects' }
  | { readonly type: 'clearPromptFrame'; readonly frameIndex: number }
  | {
      readonly type: 'placePromptBox';
      readonly frameIndex: number;
      readonly box: PixelBox;
    }
  | {
      readonly type: 'placePromptPoint';
      readonly frameIndex: number;
      readonly point: PromptPoint;
    };

/**
 * Ensures an object is selected to receive the next prompt, creating the next
 * object when none is selected. Returns `null` when no object can be added.
 */
function selectedTarget(
  state: ObjectPromptState,
): { readonly state: ObjectPromptState; readonly id: number } | null {
  const selected = state.objects.find((object) => object.id === state.selectedId);
  if (selected !== undefined) return { state, id: selected.id };
  if (state.objects.length >= MAX_PROMPT_OBJECTS) return null;
  const id = nextObjectId(state.objects);
  return {
    state: {
      ...state,
      objects: [...state.objects, { id, frames: [] }],
      selectedId: id,
    },
    id,
  };
}

function updateEntry(
  state: ObjectPromptState,
  id: number,
  frameIndex: number,
  update: (entry: FramePrompt) => FramePrompt | null,
): ObjectPromptState {
  return {
    ...state,
    objects: state.objects.map((object) => {
      if (object.id !== id) return object;
      const existing = object.frames.find(
        (entry) => entry.frameIndex === frameIndex,
      ) ?? {
        frameIndex,
        box: null,
        points: [],
      };
      const next = update(existing);
      if (next === null) return object;
      const frames = [
        ...object.frames.filter((entry) => entry.frameIndex !== frameIndex),
        next,
      ].sort((a, b) => a.frameIndex - b.frameIndex);
      return { ...object, frames };
    }),
  };
}

function isFrameIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function reduceObjectPrompts(
  state: ObjectPromptState,
  action: ObjectPromptAction,
): ObjectPromptState {
  switch (action.type) {
    case 'setPromptMode':
      return action.mode === state.mode ? state : { ...state, mode: action.mode };
    case 'setPromptTool':
      return action.tool === state.tool ? state : { ...state, tool: action.tool };
    case 'addPromptObject': {
      if (state.objects.length >= MAX_PROMPT_OBJECTS) return state;
      const id = nextObjectId(state.objects);
      return {
        ...state,
        objects: [...state.objects, { id, frames: [] }],
        selectedId: id,
        // A new object starts from something it includes.
        tool: 'positive',
      };
    }
    case 'selectPromptObject':
      return state.objects.some((object) => object.id === action.id)
        ? { ...state, selectedId: action.id }
        : state;
    case 'removePromptObject': {
      const objects = state.objects.filter((object) => object.id !== action.id);
      if (objects.length === state.objects.length) return state;
      return {
        ...state,
        objects,
        selectedId:
          state.selectedId === action.id
            ? (objects.at(-1)?.id ?? null)
            : state.selectedId,
      };
    }
    case 'clearPromptObjects':
      return state.objects.length === 0 ? state : clearedObjectPrompts(state);
    case 'clearPromptFrame': {
      if (
        !state.objects.some((object) =>
          object.frames.some((e) => e.frameIndex === action.frameIndex),
        )
      ) {
        return state;
      }
      // Objects left without prompts on any frame are removed with the frame.
      const objects = state.objects
        .map((object) => ({
          ...object,
          frames: object.frames.filter(
            (entry) => entry.frameIndex !== action.frameIndex,
          ),
        }))
        .filter((object) => object.frames.length > 0 || object.id === state.selectedId);
      return {
        ...state,
        objects,
        selectedId: objects.some((object) => object.id === state.selectedId)
          ? state.selectedId
          : (objects.at(-1)?.id ?? null),
      };
    }
    case 'placePromptBox': {
      if (!isFrameIndex(action.frameIndex)) return state;
      const target = selectedTarget(state);
      if (target === null) return state;
      return updateEntry(target.state, target.id, action.frameIndex, (entry) => ({
        ...entry,
        box: action.box,
      }));
    }
    case 'placePromptPoint': {
      if (!isFrameIndex(action.frameIndex)) return state;
      const target = selectedTarget(state);
      if (target === null) return state;
      return updateEntry(target.state, target.id, action.frameIndex, (entry) =>
        entry.points.length >= MAX_POINTS_PER_FRAME
          ? null
          : { ...entry, points: [...entry.points, action.point] },
      );
    }
  }
}
