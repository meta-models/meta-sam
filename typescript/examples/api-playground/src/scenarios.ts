/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { ResponsesEvent } from '@meta-sam/parser';

import diagnosticFixture from './fixtures/fragmented-diagnostic.json';
import failureFixture from './fixtures/failure.json';
import incompleteFixture from './fixtures/incomplete.json';
import refusalFixture from './fixtures/refusal.json';
import twoObjectsFixture from './fixtures/two-objects.json';
import videoQuickFixture from './fixtures/video-quick.json';
import videoSustainedFixture from './fixtures/video-sustained.json';
import type { MediaKind } from './model';

export interface ReplayScenario {
  readonly id: string;
  readonly mediaMode: MediaKind;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly media: {
    readonly url: string;
    readonly width: number;
    readonly height: number;
  };
  readonly events: readonly {
    readonly delayMs: number;
    readonly event: ResponsesEvent;
  }[];
}

export const replayScenarios = Object.freeze([
  twoObjectsFixture,
  diagnosticFixture,
  incompleteFixture,
  refusalFixture,
  failureFixture,
  videoSustainedFixture,
  videoQuickFixture,
] as unknown as readonly ReplayScenario[]);

const replayScenarioMap = new Map(
  replayScenarios.map((scenario) => [scenario.id, scenario] as const),
);

export function replayScenariosFor(mode: MediaKind): readonly ReplayScenario[] {
  return replayScenarios.filter((scenario) => scenario.mediaMode === mode);
}

export function getDefaultReplayScenario(mode: MediaKind): ReplayScenario {
  const scenario = replayScenariosFor(mode)[0];
  if (scenario === undefined)
    throw new Error(`No ${mode} replay scenario is available.`);
  return scenario;
}

export function getReplayScenario(
  id: string | null | undefined,
  mode: MediaKind = 'image',
): ReplayScenario {
  const scenario = replayScenarioMap.get(id ?? '');
  return scenario?.mediaMode === mode ? scenario : getDefaultReplayScenario(mode);
}

export function findReplayScenario(
  id: string | null | undefined,
  mode?: MediaKind,
): ReplayScenario | undefined {
  const scenario = replayScenarioMap.get(id ?? '');
  return mode === undefined || scenario?.mediaMode === mode ? scenario : undefined;
}
