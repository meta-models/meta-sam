/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { AppState, InspectorTab } from './model';
import { MAX_PROMPT_LENGTH, MODEL_ID_PATTERN } from './model';

export interface SafeUrlSettings {
  readonly exampleId: string | null;
  readonly fixtureId: string | null;
  readonly prompt: string | null;
  readonly model: string | null;
  readonly showOverlay: boolean;
  readonly inspectorTab: InspectorTab | null;
}

const inspectorTabs: ReadonlySet<string> = new Set([
  'objects',
  'records',
  'stream',
  'raw',
]);

function enabled(value: string | null, fallback: boolean): boolean {
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

export function readSafeUrlState(url: URL): SafeUrlSettings {
  const params = url.searchParams;
  const promptValue = params.get('prompt');
  const modelValue = params.get('model');
  const tab = params.get('panel');
  return {
    exampleId: params.get('example'),
    fixtureId: params.get('fixture'),
    prompt:
      promptValue !== null && promptValue.length <= MAX_PROMPT_LENGTH
        ? promptValue
        : null,
    model: modelValue !== null && MODEL_ID_PATTERN.test(modelValue) ? modelValue : null,
    showOverlay: enabled(params.get('overlay'), true),
    inspectorTab: tab !== null && inspectorTabs.has(tab) ? (tab as InspectorTab) : null,
  };
}

export function createSafeUrl(state: AppState, current: URL): URL {
  const next = new URL(current.pathname, current.origin);
  next.hash = current.hash;
  if (state.media.origin === 'example' && state.media.id !== null) {
    next.searchParams.set('example', state.media.id);
  } else if (state.media.origin === 'fixture' && state.media.id !== null) {
    next.searchParams.set('fixture', state.media.id);
  }
  const prompt = state.prompt.text.trim();
  if (prompt.length > 0) {
    next.searchParams.set('prompt', prompt.slice(0, MAX_PROMPT_LENGTH));
  }
  if (state.request.model !== null && MODEL_ID_PATTERN.test(state.request.model)) {
    next.searchParams.set('model', state.request.model);
  }
  if (!state.view.showOverlay) next.searchParams.set('overlay', '0');
  if (state.view.inspectorTab !== 'objects') {
    next.searchParams.set('panel', state.view.inspectorTab);
  }
  return next;
}
