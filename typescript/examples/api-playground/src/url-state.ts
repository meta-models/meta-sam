/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { AppState, InspectorTab } from './model';
import { isScoreThreshold, MAX_PROMPT_LENGTH, MODEL_ID_PATTERN } from './model';

export interface SafeUrlSettings {
  readonly exampleId: string | null;
  readonly fixtureId: string | null;
  readonly prompt: string | null;
  readonly model: string | null;
  readonly scoreThreshold: number | null;
  readonly showOverlay: boolean;
  readonly inspectorTab: InspectorTab | null;
}

const inspectorTabs: ReadonlySet<string> = new Set([
  'objects',
  'records',
  'stream',
  'raw',
]);

function scoreThreshold(value: string | null): number | null {
  if (value === null || !/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(value)) return null;
  const threshold = Number(value);
  return isScoreThreshold(threshold) ? threshold : null;
}

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
    scoreThreshold: scoreThreshold(params.get('threshold')),
    showOverlay: enabled(params.get('overlay'), true),
    inspectorTab: tab !== null && inspectorTabs.has(tab) ? (tab as InspectorTab) : null,
  };
}

export function safeUrlSettingsFromState(state: AppState): SafeUrlSettings {
  return {
    exampleId:
      state.media.origin === 'example' && state.media.id !== null
        ? state.media.id
        : null,
    fixtureId:
      state.media.origin === 'fixture' && state.media.id !== null
        ? state.media.id
        : null,
    prompt: state.prompt.text,
    model: state.request.model,
    // Only live image runs send a threshold, so only they carry it in the URL.
    scoreThreshold:
      state.media.kind === 'image' && state.run.transport === 'live'
        ? state.request.scoreThreshold
        : null,
    showOverlay: state.view.showOverlay,
    inspectorTab: state.view.inspectorTab,
  };
}

export function createSafeUrl(settings: SafeUrlSettings, current: URL): URL {
  const next = new URL(current.pathname, current.origin);
  next.hash = current.hash;
  if (settings.exampleId !== null) {
    next.searchParams.set('example', settings.exampleId);
  } else if (settings.fixtureId !== null) {
    next.searchParams.set('fixture', settings.fixtureId);
  }
  const prompt = settings.prompt?.trim() ?? '';
  if (prompt.length > 0) {
    next.searchParams.set('prompt', prompt.slice(0, MAX_PROMPT_LENGTH));
  }
  if (settings.model !== null && MODEL_ID_PATTERN.test(settings.model)) {
    next.searchParams.set('model', settings.model);
  }
  if (isScoreThreshold(settings.scoreThreshold)) {
    next.searchParams.set('threshold', String(settings.scoreThreshold));
  }
  if (!settings.showOverlay) next.searchParams.set('overlay', '0');
  if (settings.inspectorTab !== null && settings.inspectorTab !== 'objects') {
    next.searchParams.set('panel', settings.inspectorTab);
  }
  return next;
}
