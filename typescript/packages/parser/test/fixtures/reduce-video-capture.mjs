#!/usr/bin/env node
/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

/**
 * Reduces a captured SAM Model API video stream to a committable fixture.
 *
 * The capture emits one `response.output_text.delta` per frame, so a 200-frame
 * video is 868 KB of events. This keeps the first `--frames` deltas (3 by
 * default) plus every surrounding non-delta event, renumbers `sequence_number`,
 * and rewrites the texts that must equal the concatenation of the deltas:
 * `response.content_part.done.part.text`,
 * `response.output_item.done.item.content[*].text`, and
 * `response.completed.response.output[*].content[*].text`.
 *
 * Usage:
 *   node reduce-video-capture.mjs <capture.json> <output.json> [--frames=3]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const DELTA = 'response.output_text.delta';

function parseArguments(argv) {
  const positional = [];
  let frames = 3;
  for (const argument of argv) {
    const match = /^--frames=(\d+)$/.exec(argument);
    if (match !== null) {
      frames = Number(match[1]);
      continue;
    }
    positional.push(argument);
  }
  if (positional.length !== 2 || !Number.isSafeInteger(frames) || frames <= 0) {
    throw new Error(
      'Usage: node reduce-video-capture.mjs <capture.json> <output.json> [--frames=N]',
    );
  }
  return { source: positional[0], target: positional[1], frames };
}

function setContentText(content, text) {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part !== null && typeof part === 'object' && part.type === 'output_text') {
      part.text = text;
    }
  }
}

const { source, target, frames } = parseArguments(process.argv.slice(2));
const captured = JSON.parse(readFileSync(source, 'utf8'));

let kept = 0;
const reduced = [];
for (const event of captured) {
  if (event.type !== DELTA) {
    reduced.push(event);
    continue;
  }
  if (kept < frames) {
    reduced.push(event);
    kept += 1;
  }
}
if (kept < frames) {
  throw new Error(`The capture holds ${kept} text deltas; ${frames} were requested.`);
}

const text = reduced
  .filter((event) => event.type === DELTA)
  .map((event) => event.delta)
  .join('');

for (const [index, event] of reduced.entries()) {
  event.sequence_number = index;
  if (event.type === 'response.content_part.done') {
    event.part.text = text;
  } else if (event.type === 'response.output_item.done') {
    setContentText(event.item.content, text);
  } else if (event.type === 'response.completed') {
    for (const item of event.response.output ?? []) setContentText(item.content, text);
  }
}

writeFileSync(target, `${JSON.stringify(reduced, null, 2)}\n`);
process.stdout.write(
  `Wrote ${reduced.length} events (${kept} deltas, ${text.length} text characters) to ${target}\n`,
);
