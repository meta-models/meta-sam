/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Divider } from '@astryxdesign/core/Divider';
import { FileInput } from '@astryxdesign/core/FileInput';
import { Heading } from '@astryxdesign/core/Heading';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Item } from '@astryxdesign/core/Item';
import {
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
} from '@astryxdesign/core/Layout';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';
import { Selector } from '@astryxdesign/core/Selector';
import { Slider } from '@astryxdesign/core/Slider';
import { StackItem } from '@astryxdesign/core/Stack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Switch } from '@astryxdesign/core/Switch';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import {
  createStaticSource,
  Typeahead,
  type SearchableItem,
} from '@astryxdesign/core/Typeahead';
import { Theme } from '@astryxdesign/core/theme';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { VStack } from '@astryxdesign/core/VStack';
import { butterTheme } from '@astryxdesign/theme-butter/built';
import { gothicTheme } from '@astryxdesign/theme-gothic/built';
import { matchaTheme } from '@astryxdesign/theme-matcha/built';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { stoneTheme } from '@astryxdesign/theme-stone/built';
import { y2kTheme } from '@astryxdesign/theme-y2k/built';
import {
  formats,
  frameIndexOf,
  parseResponsesStream,
  ResponsesStreamFailedError,
  ResponsesStreamRefusalError,
  type ImageSegmentationResult,
  type ResponsesEvent,
  type VideoSegmentationResult,
} from '@meta-sam/parser';
import { Code2, Film, Image as ImageIcon, Moon, Sun, SunMoon, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react';

import { createCodeExamples, inferMediaMimeType } from './code-examples';
import { ExampleList } from './ExampleList';
import { Inspector } from './Inspector';
import { Stage } from './Stage';
import { findMediaExample, mediaExamples, type MediaExample } from './examples';
import {
  appReducer,
  createInitialState,
  MAX_PROMPT_LENGTH,
  mediaKindFromFile,
  MODEL_ID_PATTERN,
  type AppAction,
  type AppState,
  type MediaKind,
  type MediaState,
  type RunStatus,
  type StreamEntryKind,
  type ThemeMode,
} from './model';
import { findReplayScenario, replayScenarios, type ReplayScenario } from './scenarios';
import { countRender } from './render-counts';
import {
  LiveTransport,
  RelayRequestError,
  ReplayTransport,
  STALE_FILE_HANDLE,
  uploadMediaFile,
  type ResponsesTransport,
  type StreamRequest,
} from './transports';
import { createSafeUrl, readSafeUrlState, safeUrlSettingsFromState } from './url-state';

const replayTransport = new ReplayTransport(replayScenarios);
const liveTransport = new LiveTransport();
const StableTypeahead = memo(Typeahead);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const ACCEPTED_FILES =
  'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.gif,.mp4,.m4v,.mov,.webm';
const THEME_STORAGE_KEY = 'sam-playground-visual-theme';
const visualThemes = {
  neutral: { label: 'Neutral', theme: neutralTheme },
  stone: { label: 'Stone', theme: stoneTheme },
  gothic: { label: 'Gothic', theme: gothicTheme },
  matcha: { label: 'Matcha', theme: matchaTheme },
  y2k: { label: 'Y2K', theme: y2kTheme },
  butter: { label: 'Butter', theme: butterTheme },
} as const;
const visualThemeOptions = Object.entries(visualThemes).map(([value, option]) => ({
  value,
  label: option.label,
}));
type VisualTheme = keyof typeof visualThemes;

function initialVisualTheme(): VisualTheme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored !== null && stored in visualThemes) return stored as VisualTheme;
  } catch {}
  return 'neutral';
}

const statusDot: Record<
  RunStatus,
  'neutral' | 'accent' | 'success' | 'warning' | 'error'
> = {
  idle: 'neutral',
  ready: 'neutral',
  streaming: 'accent',
  completed: 'success',
  incomplete: 'warning',
  cancelled: 'neutral',
  refused: 'warning',
  failed: 'error',
};

interface LiveConfig {
  readonly checked: boolean;
  readonly configured: boolean;
  readonly endpointOrigin: string | null;
  readonly model: string | null;
}

interface ModelCatalog {
  readonly loading: boolean;
  readonly models: readonly string[];
}

type CodeTab = 'curl' | 'typescript';

const DEFAULT_SCORE_THRESHOLD = 0.5;

function initialState() {
  const settings = readSafeUrlState(new URL(window.location.href));
  const fixture = findReplayScenario(settings.fixtureId);
  const example =
    fixture === undefined ? findMediaExample(settings.exampleId) : undefined;
  return createInitialState({
    ...(fixture === undefined ? {} : { fixture }),
    ...(example === undefined ? {} : { example }),
    ...(settings.prompt === null ? {} : { prompt: settings.prompt }),
    ...(settings.model === null ? {} : { model: settings.model }),
    ...(settings.scoreThreshold === null
      ? {}
      : { scoreThreshold: settings.scoreThreshold }),
    showOverlay: settings.showOverlay,
    ...(settings.inspectorTab === null ? {} : { inspectorTab: settings.inspectorTab }),
  });
}

function imageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('The selected image could not be decoded.'));
    image.src = url;
  });
}

async function fetchExampleBlob(
  url: string,
  controller?: AbortController,
): Promise<Blob> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...(controller === undefined ? {} : { signal: controller.signal }),
  });
  if (!response.ok) throw new Error('The example media could not be loaded.');
  return await response.blob();
}

function themeIcon(theme: ThemeMode) {
  return theme === 'light' ? (
    <Sun size={16} />
  ) : theme === 'dark' ? (
    <Moon size={16} />
  ) : (
    <SunMoon size={16} />
  );
}

function stagedFilename(media: MediaState): string {
  if (media.file !== null) return media.file.name;
  const path = media.sourceUrl?.split(/[?#]/, 1)[0];
  const leaf = path?.split('/').filter(Boolean).at(-1);
  return leaf === undefined
    ? (media.sourceName ?? (media.kind === 'video' ? 'video.mp4' : 'image.jpg'))
    : decodeURIComponent(leaf);
}

/**
 * The parser wraps a source failure in its own error, so the relay's contract
 * is reached through the cause chain rather than the thrown error itself.
 */
function relayCause(error: unknown): RelayRequestError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof RelayRequestError) return current;
    if (typeof current !== 'object' || current === null) return null;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

// Keep unsupported async control flow outside component scope so the compiler can
// optimize App's render path instead of bailing out on the whole component.
async function bootstrapLiveConfig(
  signal: AbortSignal,
  onConfig: (config: Omit<LiveConfig, 'checked'>) => void,
  onCatalog: (catalog: ModelCatalog, defaultModel?: string) => void,
): Promise<void> {
  const value = await fetch('/api/config', {
    signal,
    credentials: 'same-origin',
  })
    .then(async (response) => {
      if (!response.ok) throw new Error('unconfigured');
      const payload = (await response.json()) as {
        configured?: unknown;
        endpointOrigin?: unknown;
        model?: unknown;
      };
      return {
        configured: payload.configured === true,
        endpointOrigin:
          typeof payload.endpointOrigin === 'string' ? payload.endpointOrigin : null,
        model:
          typeof payload.model === 'string' && MODEL_ID_PATTERN.test(payload.model)
            ? payload.model
            : null,
      };
    })
    .catch(() => ({ configured: false, endpointOrigin: null, model: null }));
  if (signal.aborted) return;
  onConfig(value);
  if (!value.configured || value.model === null) return;
  onCatalog({ loading: true, models: [] }, value.model);
  try {
    const response = await fetch('/api/models', {
      signal,
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('models unavailable');
    const payload = (await response.json()) as {
      models?: unknown;
      default?: unknown;
    };
    if (!Array.isArray(payload.models) || payload.models.length > 500) {
      throw new Error('invalid models');
    }
    const models = payload.models
      .map((entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { id?: unknown }).id === 'string'
          ? (entry as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null && MODEL_ID_PATTERN.test(id));
    if (models.length !== payload.models.length) throw new Error('invalid models');
    const defaultModel =
      typeof payload.default === 'string' && MODEL_ID_PATTERN.test(payload.default)
        ? payload.default
        : value.model;
    onCatalog({ loading: false, models }, defaultModel);
  } catch {
    if (!signal.aborted) onCatalog({ loading: false, models: [value.model] });
  }
}

async function prepareMediaSelection(file: File): Promise<{
  kind: MediaKind;
  url: string;
  width: number;
  height: number;
}> {
  const url = URL.createObjectURL(file);
  try {
    const kind = mediaKindFromFile(file);
    if (kind === null) {
      throw new Error('Choose a PNG, JPEG, WebP, GIF, MP4, MOV, or WebM file.');
    }
    if (file.size === 0 || file.size > MAX_MEDIA_BYTES) {
      throw new Error('Media must be between 1 byte and 20 MB.');
    }
    const dimensions =
      kind === 'image' ? await imageDimensions(url) : { width: 0, height: 0 };
    return { kind, url, ...dimensions };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

interface ExecuteRunOptions {
  readonly state: AppState;
  readonly fixture: ReplayScenario | undefined;
  readonly currentModel: string | null;
  readonly controller: AbortController;
  readonly runId: number;
  readonly dispatch: Dispatch<AppAction>;
  readonly uploadForMedia: (media: MediaState, force?: boolean) => Promise<string>;
}

async function executeRun({
  state,
  fixture,
  currentModel,
  controller,
  runId,
  dispatch,
  uploadForMedia,
}: ExecuteRunOptions): Promise<void> {
  const kind = state.media.kind;
  if (kind === null || state.media.sourceUrl === null) return;
  const startedAt = performance.now();
  const tap = async function* (
    source: AsyncIterable<ResponsesEvent>,
  ): AsyncIterable<ResponsesEvent> {
    for await (const event of source) {
      const entryKind: StreamEntryKind | null =
        event.type === 'response.output_text.delta'
          ? 'delta'
          : event.type === 'response.refusal.delta'
            ? 'refusal'
            : event.type === 'response.completed' ||
                event.type === 'response.incomplete' ||
                event.type === 'response.failed' ||
                event.type === 'error'
              ? 'terminal'
              : null;
      if (entryKind !== null) {
        const text =
          entryKind === 'terminal'
            ? event.type
            : typeof (event as { delta?: unknown }).delta === 'string'
              ? (event as { delta: string }).delta
              : '';
        dispatch({
          type: 'streamEntry',
          runId,
          entry: { atMs: performance.now() - startedAt, kind: entryKind, text },
        });
      }
      yield event;
    }
    dispatch({ type: 'streamEnd', runId, atMs: performance.now() - startedAt });
  };

  try {
    const transport: ResponsesTransport =
      state.run.transport === 'fixture' ? replayTransport : liveTransport;
    const bytes =
      state.run.transport === 'fixture' || kind === 'video'
        ? undefined
        : (state.media.file ?? (await fetchExampleBlob(state.media.sourceUrl)));
    if (controller.signal.aborted) throw controller.signal.reason;

    const streamOnce = async (fileId: string | null) => {
      const request: StreamRequest = {
        fixtureId: state.media.origin === 'fixture' ? state.media.id : null,
        kind,
        prompt:
          state.run.transport === 'fixture'
            ? (fixture?.prompt ?? state.prompt.text.trim())
            : state.prompt.text.trim(),
        model: currentModel ?? '<model-id>',
        ...(bytes === undefined
          ? {}
          : { media: bytes, filename: state.media.sourceName ?? undefined }),
        ...(fileId === null ? {} : { fileId }),
        ...(kind === 'image' &&
        state.run.transport === 'live' &&
        state.request.scoreThreshold !== null
          ? { scoreThreshold: state.request.scoreThreshold }
          : {}),
      };
      const events = tap(transport.stream(request, controller.signal));
      if (kind === 'image') {
        const parsed = parseResponsesStream(events, formats.segmentation.image());
        for await (const next of parsed)
          dispatch({ type: 'snapshot', runId, snapshot: next });
        const result: ImageSegmentationResult = await parsed.finalResult;
        dispatch({ type: 'runResult', runId, result });
      } else {
        const parsed = parseResponsesStream(events, formats.segmentation.video());
        for await (const next of parsed)
          dispatch({ type: 'snapshot', runId, snapshot: next });
        const result: VideoSegmentationResult = await parsed.finalResult;
        dispatch({ type: 'runResult', runId, result });
      }
    };

    const handle = state.run.transport === 'fixture' ? null : state.media.upload.fileId;
    try {
      await streamOnce(handle);
    } catch (error) {
      const staleHandle =
        handle !== null && relayCause(error)?.code === STALE_FILE_HANDLE;
      if (!staleHandle || controller.signal.aborted) throw error;
      const refreshed = await uploadForMedia(state.media, true);
      if (controller.signal.aborted) throw controller.signal.reason;
      await streamOnce(refreshed);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      dispatch({
        type: 'runTerminal',
        runId,
        status: 'cancelled',
        message: 'The run was stopped before a terminal response.',
      });
    } else if (error instanceof ResponsesStreamRefusalError) {
      dispatch({
        type: 'runTerminal',
        runId,
        status: 'refused',
        message: error.message,
      });
    } else if (error instanceof ResponsesStreamFailedError) {
      dispatch({
        type: 'runTerminal',
        runId,
        status: 'failed',
        message: error.message,
      });
    } else {
      dispatch({
        type: 'runTerminal',
        runId,
        status: 'failed',
        message:
          relayCause(error)?.message ??
          (error instanceof Error ? error.message : 'The stream failed.'),
      });
    }
  }
}

export function App(): React.JSX.Element {
  countRender('App');
  const [state, dispatch] = useReducer(appReducer, undefined, initialState);
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(initialVisualTheme);
  const [live, setLive] = useState<LiveConfig>({
    checked: false,
    configured: false,
    endpointOrigin: null,
    model: null,
  });
  const [catalog, setCatalog] = useState<ModelCatalog>({
    loading: false,
    models: [],
  });
  const [isCodeOpen, setIsCodeOpen] = useState(false);
  const [codeTab, setCodeTab] = useState<CodeTab>('curl');
  const [currentFrame, setCurrentFrame] = useState<number | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const isNarrow = useMediaQuery('(max-width: 1100px)');
  const isMobile = useMediaQuery('(max-width: 760px)');
  const activeRun = useRef<{ controller: AbortController; runId: number } | null>(null);
  const activeUpload = useRef<{
    generation: number;
    controller: AbortController;
    promise: Promise<string>;
  } | null>(null);
  const uploadedUrl = useRef<string | null>(null);
  const runGeneration = useRef(state.run.runId);
  // Where the slider starts when score filtering is switched on: the last value
  // used in this session, else the midpoint of the range.
  const lastScoreThreshold = useRef(
    state.request.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
  );
  const selectionGeneration = useRef(0);

  const isRunning = state.run.status === 'streaming';
  const snapshot = state.segmentation.snapshot;
  const followFrame = useMemo(() => {
    if (!isRunning || snapshot === null || snapshot.media !== 'video') return null;
    let latest: number | null = null;
    for (const record of snapshot.records) {
      const frameIndex = frameIndexOf(record);
      if (frameIndex !== undefined) {
        latest = latest === null ? frameIndex : Math.max(latest, frameIndex);
      }
    }
    return latest;
  }, [isRunning, snapshot]);
  const fixture =
    state.media.origin === 'fixture' ? findReplayScenario(state.media.id) : undefined;
  const currentModel = state.request.model ?? live.model;
  const modelItems = useMemo(() => {
    const ids = new Set(catalog.models);
    if (currentModel !== null) ids.add(currentModel);
    return [...ids].sort().map((id) => ({ id, label: id }) satisfies SearchableItem);
  }, [catalog.models, currentModel]);
  const modelSource = useMemo(() => createStaticSource([...modelItems]), [modelItems]);
  const selectedModel =
    currentModel === null
      ? null
      : (modelItems.find((item) => item.id === currentModel) ?? {
          id: currentModel,
          label: currentModel,
        });

  const advanceRunId = useCallback(() => {
    runGeneration.current += 1;
    return runGeneration.current;
  }, []);

  const abortActiveRun = useCallback((reason = 'The request inputs changed.') => {
    activeRun.current?.controller.abort(new Error(reason));
  }, []);

  const abortActiveUpload = useCallback((reason = 'The staged media changed.') => {
    activeUpload.current?.controller.abort(new Error(reason));
    activeUpload.current = null;
  }, []);

  /**
   * Uploads the staged video once and hands every later run the same handle.
   * Calls for a generation already in flight join it, so a re-render never
   * starts a second upload; `force` is the one-shot recovery after the upstream
   * rejects a handle it previously issued.
   */
  const uploadForMedia = useCallback(
    (media: MediaState, force = false): Promise<string> => {
      const generation = media.generation;
      const existing = activeUpload.current;
      if (!force && existing !== null && existing.generation === generation) {
        return existing.promise;
      }
      existing?.controller.abort(new Error('A newer upload started.'));
      const controller = new AbortController();
      const promise = (async () => {
        dispatch({ type: 'mediaUploadStart', generation });
        const blob =
          media.file ?? (await fetchExampleBlob(media.sourceUrl ?? '', controller));
        const uploaded = await uploadMediaFile(
          blob,
          media.sourceName ?? 'video.mp4',
          controller.signal,
        );
        dispatch({ type: 'mediaUploadReady', generation, fileId: uploaded.fileId });
        return uploaded.fileId;
      })();
      promise.catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: 'mediaUploadFailed',
          generation,
          message:
            error instanceof Error ? error.message : 'The video could not be uploaded.',
        });
      });
      activeUpload.current = { generation, controller, promise };
      return promise;
    },
    [],
  );

  const releaseUpload = useCallback(() => {
    if (uploadedUrl.current === null) return;
    URL.revokeObjectURL(uploadedUrl.current);
    uploadedUrl.current = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void bootstrapLiveConfig(
      controller.signal,
      (config) => setLive({ checked: true, ...config }),
      (nextCatalog, defaultModel) => {
        if (defaultModel !== undefined) {
          dispatch({ type: 'initializeModel', model: defaultModel });
        }
        setCatalog(nextCatalog);
      },
    );
    return () => controller.abort();
  }, []);

  const safeUrl = createSafeUrl(
    safeUrlSettingsFromState(state),
    new URL(window.location.href),
  );
  const safeLocation = `${safeUrl.pathname}${safeUrl.search}${safeUrl.hash}`;

  useEffect(() => {
    window.history.replaceState(null, '', safeLocation);
  }, [safeLocation]);

  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, visualTheme);
    } catch {}
  }, [visualTheme]);

  useEffect(
    () => () => {
      activeRun.current?.controller.abort();
      activeUpload.current?.controller.abort();
      if (uploadedUrl.current !== null) URL.revokeObjectURL(uploadedUrl.current);
    },
    [],
  );

  const media = state.media;
  const isLiveVideo =
    state.run.transport === 'live' &&
    media.kind === 'video' &&
    media.sourceUrl !== null;
  // The score threshold is an image-only request option; replays never send one.
  const isLiveImage =
    state.run.transport === 'live' &&
    media.kind === 'image' &&
    media.sourceUrl !== null;

  useEffect(() => {
    if (!live.configured || !isLiveVideo) return;
    void uploadForMedia(media).catch(() => undefined);
  }, [isLiveVideo, live.configured, media, uploadForMedia]);

  const stageExample = (example: MediaExample) => {
    selectionGeneration.current += 1;
    setIsSelecting(false);
    abortActiveRun();
    abortActiveUpload();
    releaseUpload();
    setCurrentFrame(null);
    dispatch({ type: 'stageExample', runId: advanceRunId(), example });
  };

  const clearMedia = () => {
    selectionGeneration.current += 1;
    setIsSelecting(false);
    abortActiveRun();
    abortActiveUpload();
    releaseUpload();
    setCurrentFrame(null);
    dispatch({ type: 'clearMedia', runId: advanceRunId() });
  };

  const setPrompt = (text: string) => {
    dispatch({ type: 'setPrompt', text });
  };

  const setModel = useCallback(
    (model: string) => {
      if (model === state.request.model || !MODEL_ID_PATTERN.test(model)) return;
      abortActiveRun();
      dispatch({ type: 'setModel', runId: advanceRunId(), model });
    },
    [abortActiveRun, advanceRunId, state.request.model],
  );

  const handleModelChange = useCallback(
    (item: SearchableItem | null) => {
      if (item !== null) setModel(item.id);
    },
    [setModel],
  );

  const selectFile = async (selection: File | File[] | null) => {
    const file = selection instanceof File ? selection : null;
    if (file === null) return;
    const selectionId = ++selectionGeneration.current;
    setIsSelecting(true);
    abortActiveRun();
    abortActiveUpload();
    dispatch({ type: 'uploadSelectionStart', runId: advanceRunId() });
    try {
      const { kind, url, width, height } = await prepareMediaSelection(file);
      if (selectionGeneration.current !== selectionId) {
        URL.revokeObjectURL(url);
        return;
      }
      setIsSelecting(false);
      releaseUpload();
      uploadedUrl.current = url;
      setCurrentFrame(null);
      dispatch({
        type: 'uploadMedia',
        runId: advanceRunId(),
        kind,
        file,
        url,
        width,
        height,
      });
    } catch (error) {
      if (selectionGeneration.current !== selectionId) return;
      setIsSelecting(false);
      dispatch({
        type: 'uploadError',
        runId: advanceRunId(),
        message:
          error instanceof Error
            ? error.message
            : 'The selected file could not be used.',
      });
    }
  };

  const handleRendererInitializing = useCallback((runId: number, attempt: number) => {
    dispatch({ type: 'rendererInitializing', runId, attempt });
  }, []);
  const handleRendererReady = useCallback(
    (runId: number, attempt: number, renderedRevision: number | null) => {
      dispatch({ type: 'rendererReady', runId, attempt, renderedRevision });
    },
    [],
  );
  const handleRendererError = useCallback(
    (runId: number, attempt: number, message: string) => {
      if (state.run.runId !== runId || state.renderer.attempt !== attempt) return;
      if (activeRun.current?.runId === runId) {
        activeRun.current.controller.abort(new Error(message));
      }
      dispatch({ type: 'rendererFailed', runId, attempt, message });
    },
    [state.renderer.attempt, state.run.runId],
  );
  const handleMediaMetadata = useCallback(
    (runId: number, width: number, height: number) => {
      dispatch({ type: 'mediaMetadata', runId, width, height });
    },
    [],
  );

  const uploadStatus = state.media.upload.status;
  const canRun =
    !isRunning &&
    !isSelecting &&
    state.media.kind !== null &&
    state.media.sourceUrl !== null &&
    state.prompt.text.trim().length > 0 &&
    state.renderer.status === 'ready' &&
    (state.run.transport === 'fixture'
      ? fixture !== undefined
      : live.configured &&
        currentModel !== null &&
        (!isLiveVideo || uploadStatus === 'ready'));
  const canShowCode =
    state.media.kind !== null &&
    state.media.sourceUrl !== null &&
    state.prompt.text.trim().length > 0;
  const codeExamples = useMemo(() => {
    if (!isCodeOpen || state.media.kind === null) return null;
    const filename = stagedFilename(state.media);
    return createCodeExamples({
      endpointOrigin: live.endpointOrigin,
      model: currentModel ?? '<model-id>',
      prompt: state.prompt.text,
      mediaKind: state.media.kind,
      filename,
      mimeType:
        state.media.file?.type || inferMediaMimeType(filename, state.media.kind),
      fileId: state.media.upload.fileId,
      scoreThreshold: isLiveImage ? state.request.scoreThreshold : null,
    });
  }, [
    currentModel,
    isCodeOpen,
    isLiveImage,
    live.endpointOrigin,
    state.media,
    state.prompt.text,
    state.request.scoreThreshold,
  ]);

  const run = () => {
    if (!canRun || state.media.kind === null || state.media.sourceUrl === null) return;
    activeRun.current?.controller.abort(new Error('A newer run started.'));
    const runId = advanceRunId();
    const controller = new AbortController();
    activeRun.current = { controller, runId };
    dispatch({ type: 'runStart', runId });
    void executeRun({
      state,
      fixture,
      currentModel,
      controller,
      runId,
      dispatch,
      uploadForMedia,
    }).then(() => {
      if (activeRun.current?.controller === controller) activeRun.current = null;
    });
  };

  const stop = () => activeRun.current?.controller.abort();

  const runLabel = isRunning
    ? state.run.transport === 'fixture'
      ? 'Replaying…'
      : 'Segmenting…'
    : state.run.transport === 'fixture'
      ? 'Run replay'
      : 'Segment';

  const uploadLabel =
    uploadStatus === 'uploading'
      ? 'uploading video'
      : uploadStatus === 'ready'
        ? 'video ready'
        : 'video upload failed';

  const uploadHint =
    !isLiveVideo || !live.configured || uploadStatus === 'idle' ? null : (
      <VStack gap={1} data-testid="upload-status">
        <HStack gap={2} align="center">
          <StatusDot
            variant={
              uploadStatus === 'ready'
                ? 'success'
                : uploadStatus === 'failed'
                  ? 'error'
                  : 'accent'
            }
            label={uploadLabel}
          />
          <Text type="supporting" color="secondary">
            {uploadLabel}
          </Text>
        </HStack>
        {state.media.upload.message !== null ? (
          <Text type="supporting" color="secondary" maxLines={3}>
            {state.media.upload.message}
          </Text>
        ) : null}
      </VStack>
    );

  const statusMessage =
    state.run.message ??
    (state.run.status === 'completed'
      ? `${snapshot?.records.length ?? 0} records · revision ${snapshot?.revision ?? 0}`
      : null);

  const liveHint = !live.checked ? null : live.configured ? (
    <Text type="supporting" color="secondary" display="block">
      {live.model} via {live.endpointOrigin?.replace(/^https?:\/\//, '')}. The key stays
      server-side.
    </Text>
  ) : (
    <Banner
      status="warning"
      title="Live API not configured"
      description="Set SAM_API_KEY and SAM_MODEL in typescript/examples/api-playground/.env.local and restart. Media still plays locally."
    />
  );

  const requestRail = (
    <VStack gap={5}>
      <VStack as="section" gap={3}>
        <StableTypeahead
          label="Model"
          description="Choose any model returned by the Model API."
          searchSource={modelSource}
          value={selectedModel}
          onChange={handleModelChange}
          placeholder="Search models"
          hasEntriesOnFocus
          hasClear={false}
          minQueryLength={0}
          debounceMs={0}
          maxMenuItems={500}
          width="100%"
          isDisabled={isRunning || !live.configured || catalog.loading}
          disabledMessage={
            isRunning
              ? 'The model cannot change while a run is streaming.'
              : !live.configured
                ? 'Live API not configured.'
                : catalog.loading
                  ? 'Loading models.'
                  : undefined
          }
          data-testid="model-typeahead"
        />
      </VStack>

      <VStack as="section" gap={3}>
        <HStack justify="between" align="center">
          <Text type="body" weight="semibold" as="h2">
            Media
          </Text>
          {state.media.sourceUrl !== null ? (
            <Tooltip content="Clear media">
              <IconButton
                label="Clear media"
                variant="ghost"
                size="sm"
                icon={<X size={16} />}
                isDisabled={isRunning}
                onClick={clearMedia}
              />
            </Tooltip>
          ) : null}
        </HStack>
        <FileInput
          label="Choose image or video"
          isLabelHidden
          value={null}
          accept={ACCEPTED_FILES}
          isDisabled={isRunning}
          onChange={(value) => void selectFile(value)}
        />
        {state.media.sourceUrl !== null ? (
          <Card className="rail__current" padding={0}>
            <Item
              density="compact"
              startContent={
                state.media.kind === 'video' ? (
                  <Film size={16} />
                ) : (
                  <ImageIcon size={16} />
                )
              }
              label={
                <Text type="body" maxLines={1}>
                  {state.media.sourceName}
                </Text>
              }
              endContent={
                state.media.sourceWidth > 0 ? (
                  <Text type="supporting" color="secondary" hasTabularNumbers>
                    {state.media.sourceWidth}×{state.media.sourceHeight}
                  </Text>
                ) : undefined
              }
            />
          </Card>
        ) : null}
        <ExampleList
          examples={mediaExamples}
          selectedId={state.media.origin === 'example' ? state.media.id : null}
          isDisabled={isRunning}
          onSelect={stageExample}
        />
      </VStack>

      <VStack as="section" gap={3}>
        <TextInput
          label="Noun phrase"
          description="Name what to segment, e.g. “red circle”."
          value={state.prompt.text}
          isDisabled={isRunning}
          onChange={(value) => setPrompt(value.slice(0, MAX_PROMPT_LENGTH))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canRun) void run();
          }}
        />
        {isLiveImage ? (
          <VStack gap={2} data-testid="score-threshold">
            <Switch
              label="Filter by score"
              description="Off sends no threshold."
              size="sm"
              value={state.request.scoreThreshold !== null}
              isDisabled={isRunning || !live.configured}
              onChange={(checked) =>
                dispatch({
                  type: 'setScoreThreshold',
                  value: checked ? lastScoreThreshold.current : null,
                })
              }
            />
            {state.request.scoreThreshold !== null ? (
              <Slider
                label="Score threshold"
                description="Keep objects that score at least this value."
                min={0}
                max={1}
                step={0.01}
                value={state.request.scoreThreshold}
                valueDisplay="text"
                formatValue={(value) => value.toFixed(2)}
                width="100%"
                isDisabled={isRunning || !live.configured}
                disabledMessage={
                  isRunning
                    ? 'The threshold cannot change while a run is streaming.'
                    : !live.configured
                      ? 'Live API not configured.'
                      : undefined
                }
                onChange={(value: number) => {
                  lastScoreThreshold.current = value;
                  dispatch({ type: 'setScoreThreshold', value });
                }}
              />
            ) : null}
          </VStack>
        ) : null}
        <HStack gap={2}>
          <StackItem size="fill">
            <Button
              label={runLabel}
              variant="primary"
              size="sm"
              width="100%"
              isDisabled={!canRun}
              onClick={() => void run()}
            >
              <Text type="body" color="inherit">
                {runLabel}
              </Text>
            </Button>
          </StackItem>
          <Button
            label="Stop"
            variant="secondary"
            size="sm"
            isDisabled={!isRunning}
            onClick={stop}
          >
            <Text type="body" color="inherit">
              Stop
            </Text>
          </Button>
          <Button
            label="Code"
            variant="secondary"
            size="sm"
            icon={<Code2 size={16} />}
            isDisabled={!canShowCode}
            onClick={() => setIsCodeOpen(true)}
          >
            <Text type="body" color="inherit">
              Code
            </Text>
          </Button>
        </HStack>
        {liveHint}
        {uploadHint}
        {state.run.status !== 'idle' && state.run.status !== 'ready' ? (
          <HStack gap={2} align="center" data-testid="run-status" role="status">
            <StatusDot
              variant={statusDot[state.run.status]}
              label={state.run.status}
              isPulsing={state.run.status === 'streaming'}
            />
            <Text type="supporting" color="secondary">
              {state.run.status}
              {statusMessage === null ? '' : ` · ${statusMessage}`}
            </Text>
          </HStack>
        ) : null}
        {state.renderer.status === 'error' ? (
          <Button
            label="Retry renderer"
            variant="secondary"
            size="sm"
            onClick={() => {
              abortActiveRun();
              dispatch({ type: 'retryRenderer' });
            }}
          />
        ) : null}
      </VStack>
    </VStack>
  );

  const stageContent = (
    <Stage
      media={state.media}
      snapshot={snapshot}
      hiddenObjectIds={state.view.hiddenObjectIds}
      boxLabel={state.run.prompt}
      showOverlay={state.view.showOverlay}
      showMasks={state.view.showMasks}
      showBoxes={state.view.showBoxes}
      showOutlines={state.view.showOutlines}
      status={state.run.status}
      runId={state.run.runId}
      rendererAttempt={state.renderer.attempt}
      onMediaMetadata={handleMediaMetadata}
      onRendererInitializing={handleRendererInitializing}
      onRendererReady={handleRendererReady}
      onRendererError={handleRendererError}
      onFrameChange={setCurrentFrame}
      followFrame={followFrame}
    />
  );

  const inspectorContent = (
    <Inspector
      tab={state.view.inspectorTab}
      onTabChange={(tab) => dispatch({ type: 'setInspectorTab', tab })}
      mediaKind={state.media.kind}
      status={state.run.status}
      snapshot={snapshot}
      stream={state.stream}
      hiddenObjectIds={state.view.hiddenObjectIds}
      showOverlay={state.view.showOverlay}
      showMasks={state.view.showMasks}
      showBoxes={state.view.showBoxes}
      showOutlines={state.view.showOutlines}
      currentFrame={currentFrame}
      onToggleObject={(objectId) => dispatch({ type: 'toggleObject', objectId })}
      onShowAllObjects={() => dispatch({ type: 'showAllObjects' })}
      onSetView={(key, value) => dispatch({ type: 'setView', key, value })}
    />
  );

  const workspace = isNarrow ? (
    <LayoutContent padding={0} isScrollable={false}>
      <VStack className="workspace--narrow">
        <VStack as="aside" className="rail" gap={5} padding={4} aria-label="Request">
          {requestRail}
        </VStack>
        <Divider />
        <VStack
          as="main"
          className="stage"
          padding={4}
          minHeight="40vh"
          aria-label="Stage"
        >
          {stageContent}
        </VStack>
        <Divider />
        <VStack
          as="aside"
          className="panel"
          minHeight={isMobile ? undefined : '40vh'}
          aria-label="Inspector"
        >
          {inspectorContent}
        </VStack>
      </VStack>
    </LayoutContent>
  ) : (
    <Layout
      height="fill"
      start={
        <LayoutPanel
          className="rail"
          width={300}
          padding={4}
          hasDivider
          role="complementary"
          label="Request"
        >
          {requestRail}
        </LayoutPanel>
      }
      content={
        <LayoutContent className="stage" padding={4} role="main" label="Stage">
          {stageContent}
        </LayoutContent>
      }
      end={
        <LayoutPanel
          className="panel"
          width={440}
          padding={0}
          hasDivider
          role="complementary"
          label="Inspector"
        >
          {inspectorContent}
        </LayoutPanel>
      }
    />
  );

  return (
    <Theme theme={visualThemes[visualTheme].theme} mode={state.view.theme}>
      <Layout
        className="app"
        height={isMobile ? 'auto' : 'fill'}
        header={
          <LayoutHeader className="app__header" hasDivider padding={3} role="banner">
            <HStack justify="between" align="center" gap={3} wrap="wrap">
              <HStack className="app__brand" align="center" gap={3}>
                <Heading level={1}>SAM 3 Playground</Heading>
                {live.checked ? (
                  <Badge
                    label={currentModel ?? 'offline'}
                    variant={live.configured ? 'success' : 'neutral'}
                  />
                ) : null}
              </HStack>
              <HStack
                align="center"
                justify={isMobile ? 'between' : 'start'}
                gap={2}
                width={isMobile ? '100%' : undefined}
              >
                <Selector
                  label="Visual theme"
                  isLabelHidden
                  size="sm"
                  width={132}
                  value={visualTheme}
                  options={visualThemeOptions}
                  onChange={(value) => {
                    if (value in visualThemes) setVisualTheme(value as VisualTheme);
                  }}
                  data-testid="visual-theme-selector"
                />
                <SegmentedControl
                  label="Color mode"
                  size="sm"
                  value={state.view.theme}
                  onChange={(value) =>
                    dispatch({ type: 'setTheme', theme: value as ThemeMode })
                  }
                >
                  {(['light', 'dark', 'system'] as const).map((theme) => (
                    <SegmentedControlItem
                      key={theme}
                      value={theme}
                      label={theme}
                      isLabelHidden
                      icon={themeIcon(theme)}
                    />
                  ))}
                </SegmentedControl>
              </HStack>
            </HStack>
          </LayoutHeader>
        }
        content={workspace}
      />

      <Dialog
        isOpen={isCodeOpen}
        onOpenChange={setIsCodeOpen}
        purpose="info"
        width="min(960px, calc(100vw - 32px))"
        maxHeight="88dvh"
      >
        <Layout
          height="fill"
          header={
            <DialogHeader
              title="Request code"
              subtitle="Uses the staged media, noun phrase, and selected model."
              hasDivider
              onOpenChange={setIsCodeOpen}
            />
          }
          content={
            <LayoutContent padding={3}>
              <VStack gap={3}>
                <TabList
                  aria-label="Code language"
                  role="tablist"
                  value={codeTab}
                  onChange={(value) => setCodeTab(value as CodeTab)}
                  hasDivider
                >
                  <Tab value="curl" label="curl" panelId="code-panel-curl" />
                  <Tab
                    value="typescript"
                    label="TypeScript"
                    panelId="code-panel-typescript"
                  />
                </TabList>
                <div
                  id={`code-panel-${codeTab}`}
                  role="tabpanel"
                  aria-label={`${codeTab === 'curl' ? 'curl' : 'TypeScript'} example`}
                >
                  <CodeBlock
                    code={
                      codeTab === 'curl'
                        ? (codeExamples?.curl ?? '')
                        : (codeExamples?.typescript ?? '')
                    }
                    language={codeTab === 'curl' ? 'bash' : 'typescript'}
                    title={codeTab === 'curl' ? 'curl' : 'TypeScript'}
                    hasCopyButton
                    isWrapped={false}
                    maxHeight="60dvh"
                    width="100%"
                    data-testid="code-example"
                  />
                </div>
              </VStack>
            </LayoutContent>
          }
        />
      </Dialog>
    </Theme>
  );
}
