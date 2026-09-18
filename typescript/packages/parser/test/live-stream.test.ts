/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ResponsesStreamLaneError,
  ResponsesStreamRefusalError,
  decodeMaskToRaster,
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  type SegmentationRecord,
} from '../src/index.js';

type StreamEvent = { readonly type: string; readonly [key: string]: unknown };

function fixture(name: string): readonly StreamEvent[] {
  const contents = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(contents) as readonly StreamEvent[];
}

async function* replay(events: readonly StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const event of events) yield event;
}

function deltaText(events: readonly StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta as string)
    .join('');
}

interface Lane {
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
}

const lane: Lane = { item_id: 'message-1', output_index: 0, content_index: 0 };

function outputTextDone(text: string): StreamEvent {
  return { type: 'response.output_text.done', ...lane, text };
}

function contentPartDone(
  part: Record<string, unknown>,
  overrides: Partial<Lane> = {},
): StreamEvent {
  return { type: 'response.content_part.done', ...lane, ...overrides, part };
}

function outputTextPartDone(text: string, overrides: Partial<Lane> = {}): StreamEvent {
  return contentPartDone({ type: 'output_text', annotations: [], text }, overrides);
}

function delta(text: string, overrides: Partial<Lane> = {}): StreamEvent {
  return { type: 'response.output_text.delta', ...lane, ...overrides, delta: text };
}

const completed: StreamEvent = { type: 'response.completed' };

describe('captured live SAM Model API streams', () => {
  it('parses a captured image stream finalized only by content_part.done', async () => {
    const events = fixture('image-wheel.events.json');
    expect(events.some((event) => event.type === 'response.output_text.done')).toBe(
      false,
    );

    const result = await parseImageStream(replay(events)).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.diagnostics).toEqual([]);
    expect(result.media).toBe('image');
    expect(result.rawOutput).toBe(deltaText(events));

    const [box, mask] = result.records as readonly [
      SegmentationRecord,
      ...SegmentationRecord[],
    ];
    expect(box).toMatchObject({ kind: 'box', objectId: '0' });
    expect(mask).toMatchObject({ kind: 'mask', objectId: '0' });
    if (mask?.kind !== 'mask') throw new Error('The second record is not a mask.');
    expect(decodeMaskToRaster(mask.mask)).toHaveLength(
      mask.mask.width * mask.mask.height,
    );

    // The capture holds four objects, each as a box record and a mask record.
    expect(result.records.map((record) => record.kind)).toEqual([
      'box',
      'mask',
      'box',
      'mask',
      'box',
      'mask',
      'box',
      'mask',
    ]);
    for (const decoded of recordsOfKind(result.records, 'mask')) {
      expect(decodeMaskToRaster(decoded.mask)).toHaveLength(
        decoded.mask.width * decoded.mask.height,
      );
    }
  });

  it('parses a captured video stream finalized only by content_part.done', async () => {
    const events = fixture('video-pillow.reduced.events.json');
    expect(events.some((event) => event.type === 'response.output_text.done')).toBe(
      false,
    );

    const result = await parseVideoStream(replay(events)).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.diagnostics).toEqual([]);
    expect(result.media).toBe('video');
    expect(result.rawOutput).toBe(deltaText(events));

    const frames = [
      ...new Set(
        result.records.map((record) =>
          record.kind === 'text' ? undefined : record.frame?.frameIndex,
        ),
      ),
    ];
    expect(frames).toEqual([0, 1, 2]);
    expect(recordsOfKind(result.records, 'mask').length).toBeGreaterThan(0);
  });
});

describe('content_part.done output text finalization', () => {
  it('finalizes the output text lane without any output_text.done event', async () => {
    const result = await parseImageStream(
      replay([delta('one line'), outputTextPartDone('one line'), completed]),
    ).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.rawOutput).toBe('one line');
  });

  it('supplies the whole parser input when no deltas were seen', async () => {
    const result = await parseImageStream(
      replay([outputTextPartDone('whole text'), completed]),
    ).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.rawOutput).toBe('whole text');
    expect(result.records).toEqual([{ kind: 'text', order: 0, text: 'whole text' }]);
  });

  it('accepts output_text.done then content_part.done with identical text', async () => {
    const result = await parseImageStream(
      replay([
        delta('shared'),
        outputTextDone('shared'),
        outputTextPartDone('shared'),
        completed,
      ]),
    ).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.rawOutput).toBe('shared');
    expect(result.records).toEqual([{ kind: 'text', order: 0, text: 'shared' }]);
  });

  it('accepts content_part.done then output_text.done with identical text', async () => {
    const result = await parseImageStream(
      replay([outputTextPartDone('shared'), outputTextDone('shared'), completed]),
    ).finalResult;

    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.rawOutput).toBe('shared');
    expect(result.records).toEqual([{ kind: 'text', order: 0, text: 'shared' }]);
  });

  it('rejects content_part.done text that conflicts with accumulated deltas', async () => {
    const parsed = parseImageStream(
      replay([delta('deltas'), outputTextPartDone('different'), completed]),
    );

    await expect(parsed.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);
  });

  it('rejects a second finalization whose text differs from the first', async () => {
    const parsed = parseImageStream(
      replay([outputTextDone('first'), outputTextPartDone('second'), completed]),
    );

    await expect(parsed.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);
  });

  it('rejects a repeated content_part.done finalization', async () => {
    const parsed = parseImageStream(
      replay([outputTextPartDone('shared'), outputTextPartDone('shared'), completed]),
    );

    await expect(parsed.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);
  });

  it.each([
    [
      'output_text.done then repeated content_part.done',
      outputTextDone,
      outputTextPartDone,
      outputTextPartDone,
    ],
    [
      'content_part.done then repeated output_text.done',
      outputTextPartDone,
      outputTextDone,
      outputTextDone,
    ],
    [
      'alternating finalizers repeat output_text.done',
      outputTextDone,
      outputTextPartDone,
      outputTextDone,
    ],
  ] as const)('rejects %s', async (_name, first, second, repeated) => {
    for (const prefix of [[], [delta('shared')]]) {
      for (const repeatedText of ['shared', 'conflicting']) {
        const parsed = parseImageStream(
          replay([
            ...prefix,
            first('shared'),
            second('shared'),
            repeated(repeatedText),
            completed,
          ]),
        );

        const error = await parsed.finalResult.catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(ResponsesStreamLaneError);
        expect(error).toMatchObject({
          code: 'response_lane',
          message: 'The response finalized its output text lane more than once.',
          expected: lane,
          received: lane,
        });
      }
    }
  });

  it('rejects content_part.done on a different lane than the deltas', async () => {
    const parsed = parseImageStream(
      replay([
        delta('deltas'),
        outputTextPartDone('deltas', { item_id: 'message-2', output_index: 1 }),
        completed,
      ]),
    );

    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamLaneError);
    expect((error as ResponsesStreamLaneError).expected).toEqual(lane);
    expect((error as ResponsesStreamLaneError).received).toEqual({
      item_id: 'message-2',
      output_index: 1,
      content_index: 0,
    });
  });

  it('rejects output text deltas after content_part.done finalizes the lane', async () => {
    const parsed = parseImageStream(
      replay([delta('deltas'), outputTextPartDone('deltas'), delta('late'), completed]),
    );

    await expect(parsed.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);
  });

  it('throws a refusal error for a content_part.done refusal part', async () => {
    const parsed = parseImageStream(
      replay([
        delta('deltas'),
        contentPartDone({ type: 'refusal', refusal: 'The request was refused.' }),
        completed,
      ]),
    );

    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamRefusalError);
    expect((error as ResponsesStreamRefusalError).message).toBe(
      'The request was refused.',
    );
  });

  it('ignores a reasoning_text content part and still requires a finalized lane', async () => {
    const parsed = parseImageStream(
      replay([
        delta('deltas'),
        contentPartDone({ type: 'reasoning_text', text: 'thinking out loud' }),
        completed,
      ]),
    );

    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamLaneError);
    expect((error as ResponsesStreamLaneError).message).toBe(
      'The response completed before finalizing one output text lane.',
    );
  });
});
