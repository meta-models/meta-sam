/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  EncodedPacketSink,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputAudioTrack,
  type InputTrack,
  type InputVideoTrack,
} from 'mediabunny';
import {
  SegmentationRenderer,
  type VideoFrameFit,
} from '../../packages/graphics/src/index.js';
import type { VideoSegmentationResult } from '../../packages/parser/src/index.js';
import {
  createMediaPlayer,
  type IMediaPlayer,
  type MediaPlayerEventMap,
  type MediaPlayerEventType,
} from '../../packages/video/src/index.js';
import {
  exerciseReactFailurePrecedence,
  exerciseReactHook,
  exerciseReactStrictMode,
  exerciseReactVideo,
  prepareReactAudioExercise,
  waitForReactAudioExercise,
} from './react-harness.js';
import {
  exerciseBlockedAudioResume,
  exercisePlaybackChurn,
  exerciseReactMountStress,
  exerciseVfrStepping,
  prepareMediaPerformanceExercise,
  waitForMediaPerformanceExercise,
} from './performance-harness.js';
import type {
  AudioExerciseReport,
  CompositionExerciseReport,
  CompositionFrameReport,
  CompositionGeometryReport,
  CompositionPixel,
  CompositionSample,
  DecodeStatus,
  FixtureReport,
  PacketReport,
  PlayerExerciseReport,
  TrackReport,
} from './types.js';

const round = (value: number): number => Number.parseFloat(value.toFixed(6));

function normalizeInternalCodecId(
  value: string | number | Uint8Array<ArrayBufferLike> | null,
): string | number | null {
  if (!(value instanceof Uint8Array)) return value;
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function nativeCanDecode(track: InputTrack): Promise<boolean> {
  try {
    if (track.isVideoTrack()) {
      const config = await track.getDecoderConfig();
      if (config === null || typeof VideoDecoder === 'undefined') return false;
      return (await VideoDecoder.isConfigSupported(config)).supported === true;
    }
    if (track.isAudioTrack()) {
      const config = await track.getDecoderConfig();
      if (config === null || typeof AudioDecoder === 'undefined') return false;
      return (await AudioDecoder.isConfigSupported(config)).supported === true;
    }
    return false;
  } catch {
    return false;
  }
}

async function inspectPackets(track: InputTrack): Promise<PacketReport> {
  const timestamps: number[] = [];
  const durations: number[] = [];
  const sequenceNumbers: number[] = [];
  const byteLengths: number[] = [];
  const types: string[] = [];
  const sink = new EncodedPacketSink(track);

  for await (const packet of sink.packets(undefined, undefined, {
    metadataOnly: true,
  })) {
    timestamps.push(round(packet.timestamp));
    durations.push(round(packet.duration));
    sequenceNumbers.push(packet.sequenceNumber);
    byteLengths.push(packet.byteLength);
    types.push(packet.type);
  }

  return {
    count: timestamps.length,
    timestamps,
    durations,
    sequenceNumbers,
    byteLengths,
    types,
  };
}

async function decodeVideo(
  track: InputVideoTrack,
  supported: boolean,
): Promise<{
  decoded: DecodeStatus;
  sampleTimestamps: number[];
  sampleDurations: number[];
}> {
  if (!supported) {
    return {
      decoded: { status: 'unsupported', sampleCount: 0 },
      sampleTimestamps: [],
      sampleDurations: [],
    };
  }

  const sampleTimestamps: number[] = [];
  const sampleDurations: number[] = [];
  for await (const sample of new VideoSampleSink(track).samples()) {
    sampleTimestamps.push(round(sample.timestamp));
    sampleDurations.push(round(sample.duration));
    sample.close();
  }
  return {
    decoded: { status: 'decoded', sampleCount: sampleTimestamps.length },
    sampleTimestamps,
    sampleDurations,
  };
}

async function decodeAudio(
  track: InputAudioTrack,
  supported: boolean,
): Promise<{
  decoded: DecodeStatus;
  sampleTimestamps: number[];
  sampleDurations: number[];
}> {
  if (!supported) {
    return {
      decoded: { status: 'unsupported', sampleCount: 0 },
      sampleTimestamps: [],
      sampleDurations: [],
    };
  }

  const sampleTimestamps: number[] = [];
  const sampleDurations: number[] = [];
  for await (const sample of new AudioSampleSink(track).samples()) {
    sampleTimestamps.push(round(sample.timestamp));
    sampleDurations.push(round(sample.duration));
    sample.close();
  }
  return {
    decoded: { status: 'decoded', sampleCount: sampleTimestamps.length },
    sampleTimestamps,
    sampleDurations,
  };
}

async function inspectTrack(track: InputTrack): Promise<TrackReport> {
  const [codec, codecParameterString, internalCodecId, firstTimestamp, duration] =
    await Promise.all([
      track.getCodec(),
      track.getCodecParameterString(),
      track.getInternalCodecId(),
      track.getFirstTimestamp(),
      track.computeDuration(),
    ]);
  const [canDecode, nativeSupport, packets] = await Promise.all([
    track.canDecode(),
    nativeCanDecode(track),
    inspectPackets(track),
  ]);

  if (track.isVideoTrack()) {
    const [codedWidth, codedHeight, decoded] = await Promise.all([
      track.getCodedWidth(),
      track.getCodedHeight(),
      decodeVideo(track, canDecode),
    ]);
    return {
      id: track.id,
      type: 'video',
      codec,
      codecParameterString,
      internalCodecId: normalizeInternalCodecId(internalCodecId),
      firstTimestamp: round(firstTimestamp),
      duration: round(duration),
      canDecode,
      nativeCanDecode: nativeSupport,
      packets,
      ...decoded,
      codedWidth,
      codedHeight,
    };
  }

  if (track.isAudioTrack()) {
    const [sampleRate, numberOfChannels, decoded] = await Promise.all([
      track.getSampleRate(),
      track.getNumberOfChannels(),
      decodeAudio(track, canDecode),
    ]);
    return {
      id: track.id,
      type: 'audio',
      codec,
      codecParameterString,
      internalCodecId: normalizeInternalCodecId(internalCodecId),
      firstTimestamp: round(firstTimestamp),
      duration: round(duration),
      canDecode,
      nativeCanDecode: nativeSupport,
      packets,
      ...decoded,
      sampleRate,
      numberOfChannels,
    };
  }

  throw new Error(`Unsupported track type: ${track.type}`);
}

async function analyzeFixture(file: string): Promise<FixtureReport> {
  if (!/^[a-z0-9.-]+$/.test(file)) throw new Error(`Invalid fixture name: ${file}`);
  const input = new Input({
    source: new UrlSource(`/fixtures/${file}`, {
      maxCacheSize: 4 * 1024,
      parallelism: 1,
    }),
    formats: ALL_FORMATS,
  });

  try {
    const canRead = await input.canRead();
    if (!canRead) throw new Error(`Mediabunny cannot read ${file}.`);
    const [format, mimeType, firstTimestamp, duration, tracks] = await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getFirstTimestamp(),
      input.computeDuration(),
      input.getTracks(),
    ]);
    const trackReports: TrackReport[] = [];
    for (const track of tracks) trackReports.push(await inspectTrack(track));

    return {
      file,
      userAgent: navigator.userAgent,
      webCodecs: {
        videoDecoder: typeof VideoDecoder !== 'undefined',
        audioDecoder: typeof AudioDecoder !== 'undefined',
      },
      canRead,
      container: format.name,
      mimeType,
      firstTimestamp: round(firstTimestamp),
      duration: round(duration),
      tracks: trackReports,
    };
  } finally {
    input.dispose();
  }
}

async function once<T extends MediaPlayerEventType>(
  player: IMediaPlayer,
  event: T,
): Promise<MediaPlayerEventMap[T]> {
  return await new Promise((resolve) => {
    const remove = player.on(event, (payload) => {
      remove();
      resolve(payload);
    });
  });
}

async function exercisePlayer(file: string): Promise<PlayerExerciseReport> {
  if (!/^[a-z0-9.-]+$/.test(file)) throw new Error(`Invalid fixture name: ${file}`);
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  document.body.append(canvas);
  const player = createMediaPlayer(canvas);
  const events: string[] = [];
  const frameIndexes: number[] = [];
  let customRenderCount = 0;
  for (const event of [
    'loadedmetadata',
    'frame',
    'timeupdate',
    'play',
    'pause',
    'ended',
  ] as const) {
    player.on(event, (payload) => {
      events.push(event);
      if (event === 'frame') {
        frameIndexes.push((payload as MediaPlayerEventMap['frame']).frameIndex);
      }
    });
  }
  player.setCustomRender(({ ctx, frame }) => {
    customRenderCount += 1;
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  });

  try {
    const loaded = once(player, 'loadedmetadata');
    const firstFrame = once(player, 'frame');
    try {
      await Promise.all([player.open(`/fixtures/${file}`), loaded, firstFrame]);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'media_source_error' &&
        error.message.includes('cannot decode')
      ) {
        return { status: 'unsupported', errorCode: error.code };
      }
      throw error;
    }

    const middleFrame = Math.floor(player.getVideoPackets().length / 2);
    await player.seekToFrame(middleFrame);
    await player.nextFrame();
    await player.previousFrame();
    await player.forceRender();
    await player.seekToFrame(0);

    player.playbackRate = 4;
    const ended = once(player, 'ended');
    await player.play();
    await ended;

    const pixels = canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data;
    if (
      player.getCurrentFrame() === null ||
      pixels === undefined ||
      pixels.length !== 4 ||
      pixels[3] === 0
    ) {
      throw new Error('The player did not commit a visible decoded frame.');
    }

    return {
      status: 'played',
      events,
      frameIndexes,
      packetTimestamps: player
        .getVideoPackets()
        .map(({ timestamp }) => round(timestamp)),
      customRenderCount,
      finalFrameIndex: player.currentFrameIndex,
    };
  } finally {
    player.dispose();
    canvas.remove();
  }
}

type DeferredSignal = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

function deferredSignal(): DeferredSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const compositionResult: VideoSegmentationResult = {
  media: 'video',
  revision: 1,
  records: [
    {
      kind: 'mask',
      order: 0,
      objectId: 'global',
      identity: 'video:*:global',
      revision: 1,
      mask: {
        encoding: 'one_bit',
        width: 96,
        height: 64,
        payload: '!!!!!/?`VKTkT:6?4$sZ[',
      },
      // Full-frame raster: the mask covers the whole 96×64 source.
      bounds: { left: 0, top: 0, right: 96, bottom: 64 },
    },
    {
      kind: 'box',
      order: 1,
      objectId: 'global',
      left: 3,
      top: 3,
      right: 13,
      bottom: 13,
    },
    {
      kind: 'mask',
      order: 2,
      objectId: 'frame-one',
      identity: 'video:1:frame-one',
      revision: 1,
      frame: { frameIndex: 1 },
      mask: {
        encoding: 'one_bit',
        width: 96,
        height: 64,
        payload: '!!!!!046ryYMMl__pCDu@!!',
      },
      // Full-frame raster: the mask covers the whole 96×64 source.
      bounds: { left: 0, top: 0, right: 96, bottom: 64 },
    },
    {
      kind: 'box',
      order: 3,
      objectId: 'frame-one',
      frame: { frameIndex: 1 },
      left: 20,
      top: 12,
      right: 76,
      bottom: 52,
    },
  ],
  diagnostics: [],
  rawOutput: '',
  outcome: { status: 'completed' },
};

const compositionLogicalWidth = 101;
const compositionLogicalHeight = 75;
const compositionSourceWidth = 96;
const compositionSourceHeight = 64;

function compositionTarget(
  fit: VideoFrameFit,
  width = compositionLogicalWidth,
  height = compositionLogicalHeight,
) {
  if (fit === 'fill') return { x: 0, y: 0, width, height };
  const scale =
    fit === 'contain'
      ? Math.min(width / compositionSourceWidth, height / compositionSourceHeight)
      : Math.max(width / compositionSourceWidth, height / compositionSourceHeight);
  const targetWidth = compositionSourceWidth * scale;
  const targetHeight = compositionSourceHeight * scale;
  return {
    x: (width - targetWidth) / 2,
    y: (height - targetHeight) / 2,
    width: targetWidth,
    height: targetHeight,
  };
}

function compositionPoint(
  target: ReturnType<typeof compositionTarget>,
  sourceX: number,
  sourceY: number,
): readonly [number, number] {
  return [
    target.x + (sourceX / compositionSourceWidth) * target.width,
    target.y + (sourceY / compositionSourceHeight) * target.height,
  ];
}

function readCompositionPixel(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  point: readonly [number, number],
  devicePixelRatio: number,
): CompositionPixel {
  const data = context.getImageData(
    Math.max(0, Math.floor(point[0] * devicePixelRatio)),
    Math.max(0, Math.floor(point[1] * devicePixelRatio)),
    1,
    1,
  ).data;
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

function operationErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown';
}

async function exerciseComposition(): Promise<CompositionExerciseReport> {
  const canvas = document.createElement('canvas');
  canvas.width = compositionLogicalWidth;
  canvas.height = compositionLogicalHeight;
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas 2D is unavailable.');

  const renderer = new SegmentationRenderer();
  await renderer.update(compositionResult);
  const player = createMediaPlayer(canvas, {
    createAudioContext: () => {
      throw new Error('Use the deterministic performance clock in this exercise.');
    },
  });
  const hiddenIds = new Set<string>();
  let fit: VideoFrameFit = 'contain';
  let devicePixelRatio = 1;
  const attemptedFrameIndexes: number[] = [];
  let delayed:
    | {
        readonly frameIndex: number;
        readonly started: DeferredSignal;
        readonly aborted: DeferredSignal;
      }
    | undefined;

  player.setCustomRender(async (renderContext) => {
    attemptedFrameIndexes.push(renderContext.frameIndex);
    renderer.renderVideoFrame(renderContext, {
      fit,
      devicePixelRatio,
      hiddenIds,
    });
    const active = delayed;
    if (active === undefined || active.frameIndex !== renderContext.frameIndex) return;
    delayed = undefined;
    active.started.resolve();
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        active.aborted.resolve();
        resolve();
      };
      if (renderContext.signal.aborted) onAbort();
      else renderContext.signal.addEventListener('abort', onAbort, { once: true });
    });
  });

  const configureCanvas = (ratio: number): void => {
    devicePixelRatio = ratio;
    canvas.width = compositionLogicalWidth * ratio;
    canvas.height = compositionLogicalHeight * ratio;
  };
  const sample = (
    sourceX: number,
    sourceY: number,
    target = compositionTarget(fit),
  ): CompositionPixel =>
    readCompositionPixel(
      context,
      compositionPoint(target, sourceX, sourceY),
      devicePixelRatio,
    );
  const capture = (): {
    readonly global: CompositionPixel;
    readonly specificInterior: CompositionPixel;
    readonly specificBox: CompositionPixel;
    readonly exterior: CompositionPixel;
  } => ({
    global: sample(8, 8),
    specificInterior: sample(48, 32),
    specificBox: sample(48, 12),
    exterior: sample(88, 58),
  });
  const paired = (
    baseline: ReturnType<typeof capture>,
    overlay: ReturnType<typeof capture>,
  ): Pick<
    CompositionFrameReport,
    'global' | 'specificInterior' | 'specificBox' | 'exterior'
  > => ({
    global: { baseline: baseline.global, overlay: overlay.global },
    specificInterior: {
      baseline: baseline.specificInterior,
      overlay: overlay.specificInterior,
    },
    specificBox: { baseline: baseline.specificBox, overlay: overlay.specificBox },
    exterior: { baseline: baseline.exterior, overlay: overlay.exterior },
  });
  const captureFrame = async (frameIndex: number): Promise<CompositionFrameReport> => {
    configureCanvas(1);
    fit = 'contain';
    hiddenIds.clear();
    hiddenIds.add('global');
    hiddenIds.add('frame-one');
    await player.seekToFrame(frameIndex);
    const baseline = capture();
    hiddenIds.clear();
    await player.forceRender();
    const overlay = capture();
    return {
      frameIndex: player.currentFrameIndex,
      renderFrameIndex: attemptedFrameIndexes.at(-1)!,
      ...paired(baseline, overlay),
    };
  };
  const staleSample = async (): Promise<CompositionSample> => {
    const overlay = sample(48, 32);
    hiddenIds.add('frame-one');
    await player.forceRender();
    const baseline = sample(48, 32);
    hiddenIds.delete('frame-one');
    await player.forceRender();
    return { baseline, overlay };
  };
  const beginDelay = (frameIndex: number) => {
    const control = {
      frameIndex,
      started: deferredSignal(),
      aborted: deferredSignal(),
    };
    delayed = control;
    return control;
  };

  try {
    await player.open('/fixtures/webm-vp9-opus.webm');
    const frames: CompositionFrameReport[] = [];
    for (const frameIndex of [0, 1, 2]) {
      frames.push(await captureFrame(frameIndex));
    }

    const geometry: CompositionGeometryReport[] = [];
    for (const ratio of [1, 2]) {
      for (const nextFit of ['contain', 'cover', 'fill'] as const) {
        configureCanvas(ratio);
        fit = nextFit;
        hiddenIds.clear();
        hiddenIds.add('global');
        hiddenIds.add('frame-one');
        await player.seekToFrame(1);
        const baseline = capture();
        hiddenIds.clear();
        await player.forceRender();
        const overlay = capture();
        const target = compositionTarget(fit);
        geometry.push({
          fit,
          devicePixelRatio,
          backingWidth: canvas.width,
          backingHeight: canvas.height,
          frameIndex: player.currentFrameIndex,
          renderFrameIndex: attemptedFrameIndexes.at(-1)!,
          target,
          specificInterior: {
            baseline: baseline.specificInterior,
            overlay: overlay.specificInterior,
          },
          exterior: { baseline: baseline.exterior, overlay: overlay.exterior },
          clipped: readCompositionPixel(context, [50, 1], devicePixelRatio),
        });
      }
    }

    configureCanvas(1);
    fit = 'contain';
    hiddenIds.clear();
    await player.seekToFrame(0);
    let control = beginDelay(1);
    const staleSeekPromise = player
      .seekToFrame(1)
      .then(() => 'resolved', operationErrorCode);
    await control.started.promise;
    await Promise.all([player.seekToFrame(2), control.aborted.promise]);
    const staleSeek = {
      cancelledCode: await staleSeekPromise,
      aborted: true,
      finalFrameIndex: player.currentFrameIndex,
      staleSpecificPixel: await staleSample(),
    };

    await player.seekToFrame(0);
    control = beginDelay(1);
    const staleSourcePromise = player
      .seekToFrame(1)
      .then(() => 'resolved', operationErrorCode);
    await control.started.promise;
    await Promise.all([
      player.open('/fixtures/webm-vp8-opus.webm'),
      control.aborted.promise,
    ]);
    const staleSource = {
      cancelledCode: await staleSourcePromise,
      aborted: true,
      finalFrameIndex: player.currentFrameIndex,
      staleSpecificPixel: await staleSample(),
    };

    await player.open('/fixtures/webm-vp9-opus.webm');
    await player.seekToFrame(0);
    attemptedFrameIndexes.length = 0;
    const committedFrameIndexes: number[] = [];
    const removeFrameListener = player.on('frame', ({ frameIndex }) => {
      committedFrameIndexes.push(frameIndex);
    });
    control = beginDelay(1);
    const advanced = onceWhere(player, 'frame', ({ frameIndex }) => frameIndex >= 2);
    player.playbackRate = 4;
    await player.play();
    await control.started.promise;
    await Promise.all([control.aborted.promise, advanced]);
    player.pause();
    removeFrameListener();
    const playbackSupersession = {
      attemptedFrameIndexes: [...attemptedFrameIndexes],
      committedFrameIndexes,
      aborted: true,
      finalFrameIndex: player.currentFrameIndex,
      staleSpecificPixel: await staleSample(),
    };

    hiddenIds.clear();
    hiddenIds.add('global');
    hiddenIds.add('frame-one');
    await player.seekToFrame(7);
    const bareFinalGlobal = sample(8, 8);
    await player.seekToFrame(0);
    hiddenIds.clear();
    control = beginDelay(7);
    const ended = once(player, 'ended');
    player.playbackRate = 4;
    await player.play();
    await control.started.promise;
    await Promise.all([control.aborted.promise, ended]);
    const finalDeadline = {
      aborted: true,
      finalFrameIndex: player.currentFrameIndex,
      bareGlobalPixel: {
        baseline: bareFinalGlobal,
        overlay: sample(8, 8),
      },
      clipped: readCompositionPixel(context, [50, 1], devicePixelRatio),
    };

    const offscreenCanvas = new OffscreenCanvas(202, 150);
    const offscreenContext = offscreenCanvas.getContext('2d');
    if (offscreenContext === null) {
      throw new Error('Offscreen Canvas 2D is unavailable.');
    }
    const offscreenPlayer = createMediaPlayer(offscreenCanvas, {
      createAudioContext: () => {
        throw new Error('Use the deterministic performance clock in this exercise.');
      },
    });
    const offscreenHiddenIds = new Set<string>();
    const offscreenStarted = deferredSignal();
    let offscreenFinalSignal: AbortSignal | undefined;
    let stallOffscreenFinal = false;
    offscreenPlayer.setCustomRender((renderContext) => {
      renderer.renderVideoFrame(renderContext, {
        fit: 'contain',
        devicePixelRatio: 2,
        hiddenIds: offscreenHiddenIds,
      });
      if (!stallOffscreenFinal || renderContext.frameIndex !== 7) return;
      offscreenFinalSignal = renderContext.signal;
      offscreenStarted.resolve();
      return new Promise<void>(() => undefined);
    });
    try {
      await offscreenPlayer.open('/fixtures/webm-vp9-opus.webm');
      offscreenHiddenIds.add('global');
      offscreenHiddenIds.add('frame-one');
      await offscreenPlayer.seekToFrame(1);
      const baselineInterior = readCompositionPixel(
        offscreenContext,
        [101 / 2, 75 / 2],
        2,
      );
      offscreenHiddenIds.clear();
      await offscreenPlayer.forceRender();
      const overlayInterior = readCompositionPixel(
        offscreenContext,
        [101 / 2, 75 / 2],
        2,
      );

      offscreenHiddenIds.add('global');
      offscreenHiddenIds.add('frame-one');
      await offscreenPlayer.seekToFrame(7);
      const bareFinalGlobal = readCompositionPixel(
        offscreenContext,
        compositionPoint(compositionTarget('contain'), 8, 8),
        2,
      );
      await offscreenPlayer.seekToFrame(0);
      offscreenHiddenIds.clear();
      stallOffscreenFinal = true;
      const offscreenEnded = once(offscreenPlayer, 'ended');
      offscreenPlayer.playbackRate = 4;
      await offscreenPlayer.play();
      await offscreenStarted.promise;
      await offscreenEnded;

      const offscreen = {
        frameIndex: 1,
        interior: { baseline: baselineInterior, overlay: overlayInterior },
        finalFrameIndex: offscreenPlayer.currentFrameIndex,
        finalAborted: offscreenFinalSignal?.aborted === true,
        finalBareGlobal: {
          baseline: bareFinalGlobal,
          overlay: readCompositionPixel(
            offscreenContext,
            compositionPoint(compositionTarget('contain'), 8, 8),
            2,
          ),
        },
        clipped: readCompositionPixel(offscreenContext, [50, 1], 2),
      };

      return {
        frames,
        geometry,
        staleSeek,
        staleSource,
        playbackSupersession,
        finalDeadline,
        offscreen,
      };
    } finally {
      offscreenPlayer.dispose();
    }
  } finally {
    player.dispose();
    renderer.dispose();
    canvas.remove();
  }
}

let pendingAudioExercise: Promise<AudioExerciseReport> | undefined;

async function onceWhere<T extends MediaPlayerEventType>(
  player: IMediaPlayer,
  event: T,
  predicate: (payload: MediaPlayerEventMap[T]) => boolean,
): Promise<MediaPlayerEventMap[T]> {
  return await new Promise((resolve) => {
    const remove = player.on(event, (payload) => {
      if (!predicate(payload)) return;
      remove();
      resolve(payload);
    });
  });
}

async function prepareAudioExercise(file: string): Promise<string> {
  if (!/^[a-z0-9.-]+$/.test(file)) throw new Error(`Invalid fixture name: ${file}`);
  if (pendingAudioExercise !== undefined) {
    throw new Error('An audio exercise is already pending.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  document.body.append(canvas);
  const player = createMediaPlayer(canvas);
  player.volume = 0;
  const audioStatusEvents: MediaPlayerEventMap['audiostatuschange'][] = [];
  const frameSkewSeconds: number[] = [];
  player.on('audiostatuschange', (status) => {
    audioStatusEvents.push({ ...status });
  });
  player.on('frame', ({ time }) => {
    if (!player.paused) frameSkewSeconds.push(round(player.currentTime - time));
  });

  let unsupportedVideo: AudioExerciseReport | undefined;
  try {
    await player.open(`/fixtures/${file}`);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'media_source_error' &&
      error.message.includes('cannot decode')
    ) {
      unsupportedVideo = { status: 'unsupported-video', errorCode: error.code };
    } else {
      player.dispose();
      canvas.remove();
      throw error;
    }
  }

  const button = document.createElement('button');
  button.id = 'audio-exercise-start';
  button.type = 'button';
  button.textContent = `Play ${file}`;
  document.body.append(button);

  pendingAudioExercise = new Promise<AudioExerciseReport>((resolve, reject) => {
    button.addEventListener(
      'click',
      () => {
        button.remove();
        if (unsupportedVideo !== undefined) {
          player.dispose();
          canvas.remove();
          resolve(unsupportedVideo);
          return;
        }

        const ended = once(player, 'ended');
        const scheduled =
          player.audioMetadata.capability === 'supported'
            ? onceWhere(
                player,
                'audiostatuschange',
                ({ scheduledBufferCount }) => scheduledBufferCount > 0,
              )
            : Promise.resolve(undefined);
        // Calling play synchronously in this trusted click handler keeps resume()
        // inside the browser's user-activation boundary.
        const playing = player.play();
        void (async () => {
          try {
            await playing;
            await scheduled;
            const endedEvent = await ended;
            const finalAudioStatus = player.audioStatus;
            resolve({
              status: 'played',
              audioMetadata: player.audioMetadata,
              finalAudioStatus,
              audioStatusEvents,
              peakScheduledBufferCount: Math.max(
                0,
                ...audioStatusEvents.map(
                  ({ scheduledBufferCount }) => scheduledBufferCount,
                ),
              ),
              frameSkewSeconds,
              endedTime: round(endedEvent.time),
            });
          } catch (error) {
            reject(error);
          } finally {
            player.dispose();
            canvas.remove();
          }
        })();
      },
      { once: true },
    );
  });
  return `#${button.id}`;
}

async function waitForAudioExercise(): Promise<AudioExerciseReport> {
  const pending = pendingAudioExercise;
  if (pending === undefined) throw new Error('No audio exercise is pending.');
  try {
    return await pending;
  } finally {
    pendingAudioExercise = undefined;
  }
}

window.mediaHarness = {
  analyzeFixture,
  exercisePlayer,
  exerciseComposition,
  prepareAudioExercise,
  waitForAudioExercise,
  exerciseReactVideo,
  exerciseReactHook,
  exerciseReactFailurePrecedence,
  exerciseReactStrictMode,
  prepareReactAudioExercise,
  waitForReactAudioExercise,
  exerciseVfrStepping,
  prepareMediaPerformanceExercise,
  waitForMediaPerformanceExercise,
  exercisePlaybackChurn,
  exerciseBlockedAudioResume,
  exerciseReactMountStress,
};
