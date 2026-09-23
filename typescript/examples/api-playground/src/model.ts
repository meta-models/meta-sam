/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { SegmentationResult, SegmentationSnapshot } from '@meta-sam/parser';

import type { MediaExample } from './examples';
import type { ReplayScenario } from './scenarios';

export type MediaKind = 'image' | 'video';
export type MediaOrigin = 'example' | 'fixture' | 'upload';
export type TransportMode = 'live' | 'fixture';
export type ThemeMode = 'light' | 'dark' | 'system';
export type InspectorTab = 'objects' | 'records' | 'stream' | 'raw';
export type RunStatus =
  | 'idle'
  | 'ready'
  | 'streaming'
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'refused'
  | 'failed';
export type UploadStatus = 'idle' | 'uploading' | 'ready' | 'failed';
export type RendererStatus = 'initializing' | 'ready' | 'error';

export const MAX_PROMPT_LENGTH = 160;
export const MAX_STREAM_ENTRIES = 5_000;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

export function mediaKindFromFile(file: File): MediaKind | null {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (/\.(png|jpe?g|webp|gif)$/.test(name)) return 'image';
  if (/\.(mp4|m4v|mov|webm)$/.test(name)) return 'video';
  return null;
}

/**
 * The Files API handle for the staged video. It belongs to the media rather
 * than to a run: the same handle serves every run on that media, and only a
 * media change clears it.
 */
export interface MediaUploadState {
  readonly status: UploadStatus;
  readonly fileId: string | null;
  readonly message: string | null;
}

export interface MediaState {
  readonly kind: MediaKind | null;
  readonly origin: MediaOrigin | null;
  readonly id: string | null;
  readonly sourceUrl: string | null;
  readonly sourceName: string | null;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly file: File | null;
  /** Advances whenever the staged media changes; fences upload completions. */
  readonly generation: number;
  readonly upload: MediaUploadState;
}

export interface PromptState {
  readonly text: string;
}

export interface RequestState {
  readonly model: string | null;
}

export interface RunState {
  readonly runId: number;
  readonly status: RunStatus;
  readonly transport: TransportMode;
  readonly message: string | null;
}

export interface RendererState {
  readonly attempt: number;
  readonly status: RendererStatus;
  readonly message: string | null;
  readonly renderedRevision: number | null;
}

export interface SegmentationState {
  readonly snapshot: SegmentationSnapshot | SegmentationResult | null;
  readonly pendingResult: SegmentationResult | null;
}

export type StreamEntryKind = 'delta' | 'refusal' | 'terminal';

export interface StreamEntry {
  readonly sequence: number;
  readonly atMs: number;
  readonly kind: StreamEntryKind;
  readonly text: string;
}

export interface StreamState {
  readonly entries: readonly StreamEntry[];
  readonly droppedEntries: number;
  readonly text: string;
  readonly characters: number;
  readonly firstDeltaMs: number | null;
  readonly endedMs: number | null;
}

export interface ViewState {
  readonly theme: ThemeMode;
  readonly showOverlay: boolean;
  readonly showMasks: boolean;
  readonly showBoxes: boolean;
  readonly showOutlines: boolean;
  readonly hiddenObjectIds: readonly string[];
  readonly inspectorTab: InspectorTab;
}

export interface AppState {
  readonly media: MediaState;
  readonly prompt: PromptState;
  readonly request: RequestState;
  readonly run: RunState;
  readonly renderer: RendererState;
  readonly segmentation: SegmentationState;
  readonly stream: StreamState;
  readonly view: ViewState;
}

export interface InitialSettings {
  readonly example?: MediaExample;
  readonly fixture?: ReplayScenario;
  readonly prompt?: string;
  readonly model?: string;
  readonly showOverlay?: boolean;
  readonly inspectorTab?: InspectorTab;
}

const idleUpload: MediaUploadState = Object.freeze({
  status: 'idle',
  fileId: null,
  message: null,
});

const emptyMedia: MediaState = Object.freeze({
  kind: null,
  origin: null,
  id: null,
  sourceUrl: null,
  sourceName: null,
  sourceWidth: 0,
  sourceHeight: 0,
  file: null,
  generation: 0,
  upload: idleUpload,
});

const emptyStream: StreamState = Object.freeze({
  entries: Object.freeze([]),
  droppedEntries: 0,
  text: '',
  characters: 0,
  firstDeltaMs: null,
  endedMs: null,
});

function readyStatus(media: MediaState, prompt: PromptState): RunStatus {
  return media.sourceUrl !== null && prompt.text.trim().length > 0 ? 'ready' : 'idle';
}

function initializingRenderer(renderer: RendererState): RendererState {
  return {
    ...renderer,
    status: 'initializing',
    message: null,
    renderedRevision: null,
  };
}

function resultRunState(state: AppState, result: SegmentationResult): RunState {
  return {
    ...state.run,
    status: result.outcome.status === 'completed' ? 'completed' : 'incomplete',
    message:
      result.outcome.status === 'incomplete'
        ? (result.outcome.detail ?? result.outcome.reason)
        : null,
  };
}

function exampleMedia(example: MediaExample, generation: number): MediaState {
  return {
    kind: example.kind,
    origin: 'example',
    id: example.id,
    sourceUrl: example.url,
    sourceName: example.title,
    sourceWidth: example.width,
    sourceHeight: example.height,
    file: null,
    generation,
    upload: idleUpload,
  };
}

function fixtureMedia(fixture: ReplayScenario, generation: number): MediaState {
  return {
    kind: fixture.mediaMode,
    origin: 'fixture',
    id: fixture.id,
    sourceUrl: fixture.media.url,
    sourceName: fixture.title,
    sourceWidth: fixture.media.width,
    sourceHeight: fixture.media.height,
    file: null,
    generation,
    upload: idleUpload,
  };
}

export function createInitialState(settings: InitialSettings = {}): AppState {
  const media =
    settings.fixture !== undefined
      ? fixtureMedia(settings.fixture, 0)
      : settings.example !== undefined
        ? exampleMedia(settings.example, 0)
        : emptyMedia;
  const prompt: PromptState = {
    text: settings.prompt ?? settings.fixture?.prompt ?? settings.example?.prompt ?? '',
  };
  return {
    media,
    prompt,
    request: {
      model:
        settings.model !== undefined && MODEL_ID_PATTERN.test(settings.model)
          ? settings.model
          : null,
    },
    run: {
      runId: 0,
      status: readyStatus(media, prompt),
      transport: settings.fixture !== undefined ? 'fixture' : 'live',
      message: null,
    },
    renderer: {
      attempt: 0,
      status: 'initializing',
      message: null,
      renderedRevision: null,
    },
    segmentation: { snapshot: null, pendingResult: null },
    stream: emptyStream,
    view: {
      theme: 'system',
      showOverlay: settings.showOverlay ?? true,
      showMasks: true,
      showBoxes: true,
      showOutlines: true,
      hiddenObjectIds: [],
      inspectorTab: settings.inspectorTab ?? 'objects',
    },
  };
}

export type AppAction =
  | {
      readonly type: 'stageExample';
      readonly runId: number;
      readonly example: MediaExample;
    }
  | {
      readonly type: 'stageFixture';
      readonly runId: number;
      readonly fixture: ReplayScenario;
    }
  | { readonly type: 'clearMedia'; readonly runId: number }
  | { readonly type: 'setPrompt'; readonly text: string }
  | { readonly type: 'initializeModel'; readonly model: string }
  | { readonly type: 'setModel'; readonly runId: number; readonly model: string }
  | { readonly type: 'setTheme'; readonly theme: ThemeMode }
  | { readonly type: 'mediaUploadStart'; readonly generation: number }
  | {
      readonly type: 'mediaUploadReady';
      readonly generation: number;
      readonly fileId: string;
    }
  | {
      readonly type: 'mediaUploadFailed';
      readonly generation: number;
      readonly message: string;
    }
  | { readonly type: 'uploadSelectionStart'; readonly runId: number }
  | {
      readonly type: 'uploadMedia';
      readonly runId: number;
      readonly kind: MediaKind;
      readonly file: File;
      readonly url: string;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: 'mediaMetadata';
      readonly runId: number;
      readonly width: number;
      readonly height: number;
    }
  | { readonly type: 'uploadError'; readonly runId: number; readonly message: string }
  | { readonly type: 'runStart'; readonly runId: number }
  | {
      readonly type: 'streamEntry';
      readonly runId: number;
      readonly entry: Omit<StreamEntry, 'sequence'>;
    }
  | { readonly type: 'streamEnd'; readonly runId: number; readonly atMs: number }
  | {
      readonly type: 'snapshot';
      readonly runId: number;
      readonly snapshot: SegmentationSnapshot;
    }
  | {
      readonly type: 'runResult';
      readonly runId: number;
      readonly result: SegmentationResult;
    }
  | {
      readonly type: 'runTerminal';
      readonly runId: number;
      readonly status: 'cancelled' | 'refused' | 'failed';
      readonly message: string;
    }
  | {
      readonly type: 'rendererInitializing';
      readonly runId: number;
      readonly attempt: number;
    }
  | {
      readonly type: 'rendererReady';
      readonly runId: number;
      readonly attempt: number;
      readonly renderedRevision: number | null;
    }
  | {
      readonly type: 'rendererFailed';
      readonly runId: number;
      readonly attempt: number;
      readonly message: string;
    }
  | { readonly type: 'retryRenderer' }
  | { readonly type: 'toggleObject'; readonly objectId: string }
  | { readonly type: 'showAllObjects' }
  | { readonly type: 'setInspectorTab'; readonly tab: InspectorTab }
  | {
      readonly type: 'setView';
      readonly key: 'showOverlay' | 'showMasks' | 'showBoxes' | 'showOutlines';
      readonly value: boolean;
    };

function acceptsNewGeneration(state: AppState, runId: number): boolean {
  return Number.isSafeInteger(runId) && runId > state.run.runId;
}

function clearDerivedState(
  state: AppState,
  runId: number,
  media: MediaState,
  prompt: PromptState,
  transport: TransportMode,
): AppState {
  return {
    ...state,
    media,
    prompt,
    run: {
      runId,
      status: readyStatus(media, prompt),
      transport,
      message: null,
    },
    renderer: initializingRenderer(state.renderer),
    segmentation: { snapshot: null, pendingResult: null },
    stream: emptyStream,
    view: { ...state.view, hiddenObjectIds: [] },
  };
}

function appendStreamEntry(
  stream: StreamState,
  entry: Omit<StreamEntry, 'sequence'>,
): StreamState {
  const sequence = stream.entries.length + stream.droppedEntries;
  const full = stream.entries.length >= MAX_STREAM_ENTRIES;
  const entries = full
    ? [...stream.entries.slice(1), { ...entry, sequence }]
    : [...stream.entries, { ...entry, sequence }];
  const isText = entry.kind !== 'terminal';
  return {
    entries,
    droppedEntries: full ? stream.droppedEntries + 1 : stream.droppedEntries,
    text: isText ? stream.text + entry.text : stream.text,
    characters: isText ? stream.characters + entry.text.length : stream.characters,
    firstDeltaMs: stream.firstDeltaMs ?? (entry.kind === 'delta' ? entry.atMs : null),
    endedMs: stream.endedMs,
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'stageExample':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return clearDerivedState(
        state,
        action.runId,
        exampleMedia(action.example, action.runId),
        { text: action.example.prompt },
        'live',
      );
    case 'stageFixture':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return clearDerivedState(
        state,
        action.runId,
        fixtureMedia(action.fixture, action.runId),
        { text: action.fixture.prompt },
        'fixture',
      );
    case 'clearMedia':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return clearDerivedState(
        state,
        action.runId,
        { ...emptyMedia, generation: action.runId },
        state.prompt,
        'live',
      );
    case 'setPrompt': {
      if (state.run.status === 'streaming') return state;
      const text = action.text.slice(0, MAX_PROMPT_LENGTH);
      return text === state.prompt.text ? state : { ...state, prompt: { text } };
    }
    case 'initializeModel':
      return state.request.model === null && MODEL_ID_PATTERN.test(action.model)
        ? { ...state, request: { model: action.model } }
        : state;
    case 'setModel': {
      if (
        !acceptsNewGeneration(state, action.runId) ||
        !MODEL_ID_PATTERN.test(action.model)
      ) {
        return state;
      }
      const next = clearDerivedState(
        state,
        action.runId,
        state.media,
        state.prompt,
        state.run.transport,
      );
      return { ...next, request: { model: action.model } };
    }
    case 'setTheme':
      return { ...state, view: { ...state.view, theme: action.theme } };
    case 'mediaUploadStart':
      return action.generation === state.media.generation &&
        state.media.kind === 'video'
        ? {
            ...state,
            media: {
              ...state.media,
              upload: { status: 'uploading', fileId: null, message: null },
            },
          }
        : state;
    case 'mediaUploadReady':
      return action.generation === state.media.generation &&
        state.media.upload.status === 'uploading'
        ? {
            ...state,
            media: {
              ...state.media,
              upload: { status: 'ready', fileId: action.fileId, message: null },
            },
          }
        : state;
    case 'mediaUploadFailed':
      return action.generation === state.media.generation &&
        state.media.upload.status === 'uploading'
        ? {
            ...state,
            media: {
              ...state.media,
              upload: { status: 'failed', fileId: null, message: action.message },
            },
          }
        : state;
    case 'uploadSelectionStart':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return clearDerivedState(
        state,
        action.runId,
        state.media,
        state.prompt,
        state.run.transport,
      );
    case 'uploadMedia': {
      if (!acceptsNewGeneration(state, action.runId)) return state;
      const media: MediaState = {
        kind: action.kind,
        origin: 'upload',
        id: null,
        sourceUrl: action.url,
        sourceName: action.file.name,
        sourceWidth: action.width,
        sourceHeight: action.height,
        file: action.file,
        generation: action.runId,
        upload: idleUpload,
      };
      return clearDerivedState(state, action.runId, media, state.prompt, 'live');
    }
    case 'mediaMetadata':
      return action.runId === state.run.runId && action.width > 0 && action.height > 0
        ? {
            ...state,
            media: {
              ...state.media,
              sourceWidth: action.width,
              sourceHeight: action.height,
            },
          }
        : state;
    case 'uploadError':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return {
        ...state,
        run: {
          ...state.run,
          runId: action.runId,
          status: 'failed',
          message: action.message,
        },
        renderer: initializingRenderer(state.renderer),
        segmentation: { snapshot: null, pendingResult: null },
        stream: emptyStream,
        view: { ...state.view, hiddenObjectIds: [] },
      };
    case 'runStart':
      if (!acceptsNewGeneration(state, action.runId)) return state;
      return {
        ...state,
        run: {
          ...state.run,
          runId: action.runId,
          status: 'streaming',
          message: null,
        },
        renderer: initializingRenderer(state.renderer),
        segmentation: { snapshot: null, pendingResult: null },
        stream: emptyStream,
        view: { ...state.view, hiddenObjectIds: [] },
      };
    case 'streamEntry':
      return action.runId === state.run.runId && state.run.status === 'streaming'
        ? {
            ...state,
            stream: appendStreamEntry(state.stream, action.entry),
          }
        : state;
    case 'streamEnd':
      return action.runId === state.run.runId && state.stream.endedMs === null
        ? { ...state, stream: { ...state.stream, endedMs: action.atMs } }
        : state;
    case 'snapshot':
      return action.runId === state.run.runId &&
        state.run.status === 'streaming' &&
        action.snapshot.media === state.media.kind
        ? {
            ...state,
            renderer: initializingRenderer(state.renderer),
            segmentation: { snapshot: action.snapshot, pendingResult: null },
          }
        : state;
    case 'runResult': {
      if (
        action.runId !== state.run.runId ||
        state.run.status !== 'streaming' ||
        action.result.media !== state.media.kind
      ) {
        return state;
      }
      if (
        state.renderer.status === 'ready' &&
        state.renderer.renderedRevision === action.result.revision
      ) {
        return {
          ...state,
          run: resultRunState(state, action.result),
          segmentation: { snapshot: action.result, pendingResult: null },
        };
      }
      return {
        ...state,
        renderer: initializingRenderer(state.renderer),
        segmentation: { snapshot: action.result, pendingResult: action.result },
      };
    }
    case 'runTerminal':
      return action.runId === state.run.runId && state.run.status === 'streaming'
        ? {
            ...state,
            run: { ...state.run, status: action.status, message: action.message },
            segmentation: { ...state.segmentation, pendingResult: null },
          }
        : state;
    case 'rendererInitializing':
      if (
        action.runId !== state.run.runId ||
        action.attempt !== state.renderer.attempt ||
        state.renderer.status === 'error'
      ) {
        return state;
      }
      return { ...state, renderer: initializingRenderer(state.renderer) };
    case 'rendererReady': {
      if (
        action.runId !== state.run.runId ||
        action.attempt !== state.renderer.attempt ||
        state.renderer.status === 'error'
      ) {
        return state;
      }
      const renderer: RendererState = {
        ...state.renderer,
        status: 'ready',
        message: null,
        renderedRevision: action.renderedRevision,
      };
      const pendingResult = state.segmentation.pendingResult;
      if (
        state.run.status === 'streaming' &&
        pendingResult !== null &&
        pendingResult.revision === action.renderedRevision
      ) {
        return {
          ...state,
          run: resultRunState(state, pendingResult),
          renderer,
          segmentation: { snapshot: pendingResult, pendingResult: null },
        };
      }
      return { ...state, renderer };
    }
    case 'rendererFailed':
      if (
        action.runId !== state.run.runId ||
        action.attempt !== state.renderer.attempt
      ) {
        return state;
      }
      return {
        ...state,
        run: { ...state.run, status: 'failed', message: action.message },
        renderer: {
          ...state.renderer,
          status: 'error',
          message: action.message,
          renderedRevision: null,
        },
        segmentation: { snapshot: null, pendingResult: null },
        view: { ...state.view, hiddenObjectIds: [] },
      };
    case 'retryRenderer':
      if (state.renderer.status !== 'error') return state;
      return {
        ...state,
        run: {
          ...state.run,
          status: readyStatus(state.media, state.prompt),
          message: null,
        },
        renderer: {
          attempt: state.renderer.attempt + 1,
          status: 'initializing',
          message: null,
          renderedRevision: null,
        },
        segmentation: { snapshot: null, pendingResult: null },
        view: { ...state.view, hiddenObjectIds: [] },
      };
    case 'toggleObject': {
      const hidden = new Set(state.view.hiddenObjectIds);
      if (hidden.has(action.objectId)) hidden.delete(action.objectId);
      else hidden.add(action.objectId);
      return {
        ...state,
        renderer:
          state.segmentation.snapshot === null
            ? state.renderer
            : initializingRenderer(state.renderer),
        view: { ...state.view, hiddenObjectIds: [...hidden] },
      };
    }
    case 'showAllObjects':
      if (state.view.hiddenObjectIds.length === 0) return state;
      return {
        ...state,
        renderer:
          state.segmentation.snapshot === null
            ? state.renderer
            : initializingRenderer(state.renderer),
        view: { ...state.view, hiddenObjectIds: [] },
      };
    case 'setInspectorTab':
      return { ...state, view: { ...state.view, inspectorTab: action.tab } };
    case 'setView':
      return {
        ...state,
        renderer:
          action.value !== state.view[action.key] &&
          state.segmentation.snapshot !== null
            ? initializingRenderer(state.renderer)
            : state.renderer,
        view: { ...state.view, [action.key]: action.value },
      };
  }
}
