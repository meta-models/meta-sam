/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'media-fixtures-'));
const defaultVideoSource = 'testsrc2=size=96x64:rate=8:duration=1';
const defaultAudioSource = 'sine=frequency=880:sample_rate=48000:duration=1';
const round = (value) => Number.parseFloat(Number.parseFloat(value).toFixed(6));

const fixtures = [
  {
    file: 'mp4-h264-aac.mp4',
    description: 'MP4 with H.264 constrained baseline video and AAC-LC audio',
    container: 'MP4',
    video: {
      codec: 'avc',
      codecParameterPrefix: 'avc1.',
      internalCodecId: 'avc1',
      ffmpeg: [
        '-c:v',
        'libx264',
        '-preset',
        'veryslow',
        '-crf',
        '28',
        '-profile:v',
        'baseline',
        '-level:v',
        '3.0',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '8',
        '-keyint_min',
        '8',
        '-sc_threshold',
        '0',
        '-bf',
        '0',
        '-threads:v',
        '1',
        '-x264-params',
        'force-cfr=1:nal-hrd=none',
      ],
    },
    audio: {
      codec: 'aac',
      codecParameterPrefix: 'mp4a.40.',
      internalCodecId: 'mp4a',
      ffmpeg: [
        '-c:a',
        'aac',
        '-profile:a',
        'aac_low',
        '-b:a',
        '48k',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-movflags', '+faststart', '-video_track_timescale', '8000'],
  },
  {
    file: 'mp4-h265-aac.mp4',
    description: 'MP4 with H.265 main-profile video and AAC-LC audio',
    container: 'MP4',
    video: {
      codec: 'hevc',
      codecParameterPrefix: 'hev1.',
      internalCodecId: 'hvc1',
      ffmpeg: [
        '-c:v',
        'libx265',
        '-preset',
        'veryslow',
        '-crf',
        '32',
        '-tag:v',
        'hvc1',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '8',
        '-keyint_min',
        '8',
        '-sc_threshold',
        '0',
        '-bf',
        '0',
        '-threads:v',
        '1',
        '-x265-params',
        'pools=none:frame-threads=1:wpp=0:log-level=error:no-info=1:repeat-headers=1:keyint=8:min-keyint=8:scenecut=0:bframes=0',
      ],
    },
    audio: {
      codec: 'aac',
      codecParameterPrefix: 'mp4a.40.',
      internalCodecId: 'mp4a',
      ffmpeg: [
        '-c:a',
        'aac',
        '-profile:a',
        'aac_low',
        '-b:a',
        '48k',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-movflags', '+faststart', '-video_track_timescale', '8000'],
  },
  {
    file: 'webm-vp9-opus.webm',
    description: 'WebM with VP9 profile 0 video and Opus audio',
    container: 'WebM',
    audioSource: 'sine=frequency=880:sample_rate=48000:duration=0.9935',
    video: {
      codec: 'vp9',
      codecParameterPrefix: 'vp09.',
      internalCodecId: 'V_VP9',
      ffmpeg: [
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-crf',
        '35',
        '-b:v',
        '0',
        '-g',
        '8',
        '-threads:v',
        '1',
        '-row-mt',
        '0',
        '-tile-columns',
        '0',
        '-frame-parallel',
        '0',
        '-auto-alt-ref',
        '0',
      ],
    },
    audio: {
      codec: 'opus',
      codecParameterPrefix: 'opus',
      internalCodecId: 'A_OPUS',
      ffmpeg: [
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'off',
        '-compression_level',
        '10',
        '-frame_duration',
        '20',
        '-application',
        'audio',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-cluster_time_limit', '5000'],
  },
  {
    file: 'webm-vp8-opus.webm',
    description: 'WebM with VP8 video and Opus audio',
    container: 'WebM',
    audioSource: 'sine=frequency=880:sample_rate=48000:duration=0.9935',
    video: {
      codec: 'vp8',
      codecParameterPrefix: 'vp8',
      internalCodecId: 'V_VP8',
      ffmpeg: [
        '-c:v',
        'libvpx',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-crf',
        '15',
        '-b:v',
        '100k',
        '-g',
        '8',
        '-threads:v',
        '1',
        '-auto-alt-ref',
        '0',
      ],
    },
    audio: {
      codec: 'opus',
      codecParameterPrefix: 'opus',
      internalCodecId: 'A_OPUS',
      ffmpeg: [
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'off',
        '-compression_level',
        '10',
        '-frame_duration',
        '20',
        '-application',
        'audio',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-cluster_time_limit', '5000'],
  },
  {
    file: 'webm-vp9-opus-vfr.webm',
    description: 'WebM with deterministic variable-frame-rate VP9 video and Opus audio',
    container: 'WebM',
    duration: 1,
    videoSource: 'testsrc2=size=96x64:rate=1000:duration=1',
    audioSource: 'sine=frequency=660:sample_rate=48000:duration=0.9935',
    videoFilter:
      "select='eq(n,0)+eq(n,40)+eq(n,190)+eq(n,520)+eq(n,999)',setpts=PTS-STARTPTS",
    videoOutput: ['-fps_mode:v', 'vfr'],
    inferVideoDurations: true,
    video: {
      codec: 'vp9',
      codecParameterPrefix: 'vp09.',
      internalCodecId: 'V_VP9',
      ffmpeg: [
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-crf',
        '35',
        '-b:v',
        '0',
        '-g',
        '5',
        '-threads:v',
        '1',
        '-row-mt',
        '0',
        '-tile-columns',
        '0',
        '-frame-parallel',
        '0',
        '-auto-alt-ref',
        '0',
      ],
    },
    audio: {
      codec: 'opus',
      codecParameterPrefix: 'opus',
      internalCodecId: 'A_OPUS',
      ffmpeg: [
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'off',
        '-compression_level',
        '10',
        '-frame_duration',
        '20',
        '-application',
        'audio',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-cluster_time_limit', '5000'],
  },
  {
    file: 'webm-vp9-opus-cfr30-8s.webm',
    description: 'Eight-second 30 fps WebM with VP9 video and Opus audio',
    container: 'WebM',
    duration: 8,
    videoSource: 'testsrc2=size=320x180:rate=30:duration=8',
    audioSource: 'sine=frequency=440:sample_rate=48000:duration=7.9935',
    videoOutput: ['-fps_mode:v', 'vfr'],
    inferVideoDurations: true,
    terminalVideoDurationSeconds: 1 / 30,
    video: {
      codec: 'vp9',
      codecParameterPrefix: 'vp09.',
      internalCodecId: 'V_VP9',
      ffmpeg: [
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'good',
        '-cpu-used',
        '4',
        '-crf',
        '38',
        '-b:v',
        '0',
        '-g',
        '240',
        '-threads:v',
        '1',
        '-row-mt',
        '0',
        '-tile-columns',
        '0',
        '-frame-parallel',
        '0',
        '-auto-alt-ref',
        '0',
      ],
    },
    audio: {
      codec: 'opus',
      codecParameterPrefix: 'opus',
      internalCodecId: 'A_OPUS',
      ffmpeg: [
        '-c:a',
        'libopus',
        '-b:a',
        '32k',
        '-vbr',
        'off',
        '-compression_level',
        '10',
        '-frame_duration',
        '20',
        '-application',
        'audio',
        '-threads:a',
        '1',
      ],
    },
    muxer: ['-cluster_time_limit', '10000'],
  },
];

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function packetTimeline(probe, streamIndex, normalizeWebmOpus = false) {
  const packets = probe.packets.filter((packet) => packet.stream_index === streamIndex);
  const rawTimestamps = packets.map((packet) => round(packet.pts_time));
  const rawDurations = packets.map((packet) => round(packet.duration_time));
  if (!normalizeWebmOpus) {
    return {
      packetCount: packets.length,
      timestamps: rawTimestamps,
      durations: rawDurations,
    };
  }

  // Normalize the encoded Opus pre-skip so the Mediabunny timeline starts at
  // zero. Mediabunny has no following WebM block from which to infer the final
  // duration, so its packet API reports zero; timingSemantics separately records
  // ffprobe's positive terminal packet duration and discard-padding evidence.
  const offset = -(rawTimestamps[0] ?? 0);
  const timestamps = rawTimestamps.map((timestamp) => round(timestamp + offset));
  return {
    packetCount: packets.length,
    timestamps,
    durations: timestamps.map((timestamp, index) =>
      index + 1 === timestamps.length ? 0 : round(timestamps[index + 1] - timestamp),
    ),
  };
}

function videoPacketTimeline(
  probe,
  streamIndex,
  inferDurations,
  terminalDurationSeconds,
) {
  const timeline = packetTimeline(probe, streamIndex);
  if (!inferDurations) return timeline;
  return {
    ...timeline,
    durations: timeline.timestamps.map((timestamp, index) =>
      index + 1 === timeline.timestamps.length
        ? round(terminalDurationSeconds ?? timeline.durations[index])
        : round(timeline.timestamps[index + 1] - timestamp),
    ),
  };
}

function opusTimingSemantics(probe, streamIndex) {
  const packets = probe.packets.filter((packet) => packet.stream_index === streamIndex);
  const first = packets[0];
  const last = packets.at(-1);
  const skipSamples = last?.side_data_list?.find(
    ({ side_data_type: type }) => type === 'Skip Samples',
  );
  return {
    timestampNormalization: 'codec-delay-to-zero',
    rawFirstTimestampSeconds: round(first?.pts_time ?? 0),
    terminalPacketDurationSource: 'ffprobe-packet-duration',
    terminalPacketDurationSeconds: round(last?.duration_time ?? 0),
    discardPaddingSamples: Number(skipSamples?.discard_padding ?? 0),
  };
}

function stream(probe, type) {
  const value = probe.streams.find((candidate) => candidate.codec_type === type);
  if (value === undefined) throw new Error(`Generated fixture has no ${type} stream.`);
  return value;
}

try {
  const ffmpegVersion = run('ffmpeg', ['-version']).split('\n')[0];
  const ffprobeVersion = run('ffprobe', ['-version']).split('\n')[0];
  const manifestFixtures = [];

  for (const fixture of fixtures) {
    const temporaryPath = path.join(temporaryDirectory, fixture.file);
    run('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      fixture.videoSource ?? defaultVideoSource,
      '-f',
      'lavfi',
      '-i',
      fixture.audioSource ?? defaultAudioSource,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-t',
      String(fixture.duration ?? 1),
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      ...(fixture.videoFilter === undefined ? [] : ['-vf', fixture.videoFilter]),
      ...fixture.video.ffmpeg,
      ...fixture.audio.ffmpeg,
      ...(fixture.videoOutput ?? []),
      ...(fixture.container === 'MP4' && fixture.video.codec === 'vp9'
        ? ['-movflags', '+faststart', '-video_track_timescale', '30000']
        : fixture.muxer),
      temporaryPath,
    ]);

    const probe = JSON.parse(
      run('ffprobe', [
        '-v',
        'error',
        '-show_streams',
        '-show_packets',
        '-show_entries',
        'stream=index,codec_name,codec_type,width,height,sample_rate,channels:packet=stream_index,pts_time,duration_time,side_data_list',
        '-of',
        'json',
        temporaryPath,
      ]),
    );
    const videoStream = stream(probe, 'video');
    const audioStream = stream(probe, 'audio');
    const bytes = await readFile(temporaryPath);
    const hash = createHash('sha256').update(bytes).digest('hex');

    manifestFixtures.push({
      file: fixture.file,
      description: fixture.description,
      bytes: bytes.length,
      sha256: hash,
      container: fixture.container,
      generation: {
        videoSource: fixture.videoSource ?? defaultVideoSource,
        audioSource: fixture.audioSource ?? defaultAudioSource,
        durationSeconds: fixture.duration ?? 1,
        ...(fixture.videoFilter === undefined
          ? {}
          : { videoFilter: fixture.videoFilter }),
        ...(fixture.inferVideoDurations === true
          ? { videoDurationInference: 'next-packet' }
          : {}),
        ...(fixture.terminalVideoDurationSeconds === undefined
          ? {}
          : {
              terminalVideoDurationSeconds: round(fixture.terminalVideoDurationSeconds),
            }),
      },
      expected: {
        video: {
          codec: fixture.video.codec,
          codecParameterPrefix: fixture.video.codecParameterPrefix,
          internalCodecId: fixture.video.internalCodecId,
          codedWidth: videoStream.width,
          codedHeight: videoStream.height,
          ...(fixture.terminalVideoDurationSeconds === undefined
            ? {}
            : { trackDurationSeconds: fixture.duration }),
          ...videoPacketTimeline(
            probe,
            videoStream.index,
            fixture.inferVideoDurations === true,
            fixture.terminalVideoDurationSeconds,
          ),
        },
        audio: {
          codec: fixture.audio.codec,
          codecParameterPrefix: fixture.audio.codecParameterPrefix,
          internalCodecId:
            fixture.container === 'MP4' && fixture.audio.codec === 'opus'
              ? 'Opus'
              : fixture.audio.internalCodecId,
          sampleRate: Number.parseInt(audioStream.sample_rate, 10),
          numberOfChannels: audioStream.channels,
          ...(fixture.container === 'WebM' && fixture.audio.codec === 'opus'
            ? { timingSemantics: opusTimingSemantics(probe, audioStream.index) }
            : {}),
          ...packetTimeline(probe, audioStream.index, fixture.container === 'WebM'),
        },
      },
    });
    await rename(temporaryPath, path.join(fixtureDirectory, fixture.file));
  }

  const manifest = {
    schemaVersion: 3,
    generation: {
      toolchainPolicy: 'recorded-not-enforced',
      ffmpeg: ffmpegVersion,
      ffprobe: ffprobeVersion,
    },
    fixtures: manifestFixtures,
  };
  const manifestJson = await format(JSON.stringify(manifest), {
    parser: 'json',
    printWidth: 88,
  });
  await writeFile(path.join(fixtureDirectory, 'manifest.json'), manifestJson);
  await writeFile(
    path.join(fixtureDirectory, 'SHA256SUMS'),
    `${manifestFixtures.map(({ file, sha256 }) => `${sha256}  ${file}`).join('\n')}\n`,
  );
  console.log(`Generated ${manifestFixtures.length} deterministic browser fixtures.`);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
