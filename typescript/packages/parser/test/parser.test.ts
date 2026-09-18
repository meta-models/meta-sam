/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  InvalidSegmentationMaskError,
  ResponsesStreamAbortedError,
  ResponsesStreamConsumedError,
  ResponsesStreamEventError,
  ResponsesStreamFailedError,
  ResponsesStreamLaneError,
  ResponsesStreamRefusalError,
  ResponsesStreamSourceError,
  decodeMaskToRaster,
  formats,
  frameIndexOf,
  parseImageStream,
  parseResponsesStream,
  parseVideoStream,
  recordsOfKind,
  type ImageSegmentationResult,
  type ResponseFormat,
  type ResponseStreamOutcome,
  type ResponsesEvent,
  type SegmentationBoxRecord,
  type SegmentationMaskRecord,
  type SegmentationRecord,
  type SegmentationTextRecord,
  type VideoSegmentationResult,
  type VideoSegmentationSnapshot,
} from '../src/index.js';

type TestEvent = { readonly type: string; readonly [key: string]: unknown };

function withLane(value: TestEvent): ResponsesEvent {
  if (
    value.type === 'response.output_text.delta' ||
    value.type === 'response.output_text.done' ||
    value.type === 'response.refusal.delta' ||
    value.type === 'response.refusal.done'
  ) {
    return {
      item_id: 'message-1',
      output_index: 0,
      content_index: 0,
      ...value,
    } as ResponsesEvent;
  }
  return value as ResponsesEvent;
}

async function* events(...values: TestEvent[]): AsyncGenerator<ResponsesEvent> {
  let text = '';
  let sawDelta = false;
  let sawDone = false;
  for (const value of values) {
    if (value.type === 'response.output_text.delta') {
      sawDelta = true;
      text += String(value.delta ?? '');
    } else if (value.type === 'response.output_text.done') {
      sawDone = true;
    } else if (
      (value.type === 'response.completed' || value.type === 'response.incomplete') &&
      sawDelta &&
      !sawDone
    ) {
      yield withLane({ type: 'response.output_text.done', text });
      sawDone = true;
    }
    yield withLane(value);
  }
}

interface TextResult {
  readonly text: string;
  readonly outcome: ResponseStreamOutcome;
}

const textFormat: ResponseFormat<string, TextResult> = {
  createParser() {
    let text = '';
    return {
      push(chunk) {
        text += chunk;
        return [chunk];
      },
      finish(outcome) {
        return { result: { text, outcome } };
      },
    };
  },
};

function trackedSource(
  values: TestEvent[],
  options: { readonly nextFailure?: unknown; readonly returnFailure?: unknown } = {},
): {
  readonly source: AsyncIterable<ResponsesEvent>;
  readonly counts: { next: number; return: number };
} {
  const counts = { next: 0, return: 0 };
  let index = 0;
  return {
    counts,
    source: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            counts.next += 1;
            if (options.nextFailure !== undefined) throw options.nextFailure;
            const value = values[index++];
            return value === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value: withLane(value) };
          },
          async return() {
            counts.return += 1;
            if (options.returnFailure !== undefined) throw options.returnFailure;
            return { done: true as const, value: undefined };
          },
        };
      },
    },
  };
}

const payload = '!!!!!(QO(0lu8?';

/** One SAM API record: object id, box token, mask token. */
function apiRecord(
  objectId = '0',
  {
    x1 = 0,
    y1 = 0,
    x2 = 4,
    y2 = 4,
    w = 20,
    h = 20,
    size = '5,5',
    data = payload,
  }: Partial<Record<'x1' | 'y1' | 'x2' | 'y2' | 'w' | 'h', number>> & {
    size?: string;
    data?: string;
  } = {},
): string {
  return (
    `${objectId}<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h}|>` +
    `<|mask;x=0;y=0;data=${size},${data}|>`
  );
}

function apiLine(frame: number, ...records: string[]): string {
  return `<${frame}f>${records.join(',')}\n`;
}

describe('parseResponsesStream lifecycle', () => {
  it('supports iteration-first completion and stable final promise identity', async () => {
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'a' },
        { type: 'response.output_text.delta', delta: 'b' },
        { type: 'response.completed' },
      ),
      textFormat,
    );
    const iterator = parsed[Symbol.asyncIterator]();
    const final = parsed.finalResult;
    expect(parsed.finalResult).toBe(final);
    const chunks: string[] = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      chunks.push(item.value);
    }
    await expect(final).resolves.toEqual({
      text: 'ab',
      outcome: { status: 'completed' },
    });
    expect(chunks).toEqual(['a', 'b']);
    expect(() => parsed[Symbol.asyncIterator]()).toThrow(ResponsesStreamConsumedError);
  });

  it('drains internally when finalResult is requested first', async () => {
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'complete' },
        { type: 'response.completed' },
      ),
      textFormat,
    );
    await expect(parsed.finalResult).resolves.toMatchObject({ text: 'complete' });
    expect(() => parsed[Symbol.asyncIterator]()).toThrow(ResponsesStreamConsumedError);
  });

  it('closes an unstarted source owner once without creating its iterator', async () => {
    let iterators = 0;
    let closes = 0;
    const source: AsyncIterable<ResponsesEvent> & { close(): void } = {
      [Symbol.asyncIterator]() {
        iterators += 1;
        return events()[Symbol.asyncIterator]();
      },
      close() {
        closes += 1;
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    await iterator.return?.();
    await iterator.return?.();
    expect(iterators).toBe(0);
    expect(closes).toBe(1);
    await expect(parsed.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamAbortedError,
    );
  });

  it('closes once at EOF and surfaces an EOF close failure', async () => {
    const clean = trackedSource([{ type: 'response.output_text.delta', delta: 'x' }]);
    const parsed = parseResponsesStream(clean.source, textFormat);
    await expect(parsed.finalResult).resolves.toEqual({
      text: 'x',
      outcome: { status: 'incomplete', reason: 'eof' },
    });
    expect(clean.counts.return).toBe(1);

    const cause = new Error('EOF close failed');
    const failing = trackedSource([], { returnFailure: cause });
    const failed = parseResponsesStream(failing.source, textFormat);
    await expect(failed.finalResult).rejects.toMatchObject({
      code: 'source_error',
      operation: 'return',
      cause,
    });
    expect(failing.counts.return).toBe(1);
  });

  it('delegates close to a distinct source owner without double-closing', async () => {
    const counts = { owner: 0, iterator: 0 };
    const values = [
      withLane({ type: 'response.output_text.done', text: 'done' }),
      withLane({ type: 'response.completed' }),
    ];
    let index = 0;
    const iterator: AsyncIterator<ResponsesEvent> = {
      async next() {
        const value = values[index++];
        return value === undefined
          ? { done: true, value: undefined }
          : { done: false, value };
      },
      async return() {
        counts.iterator += 1;
        return { done: true, value: undefined };
      },
    };
    const source: AsyncIterable<ResponsesEvent> & { close(): Promise<void> } = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      async close() {
        counts.owner += 1;
        await iterator.return?.();
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    await expect(parsed.finalResult).resolves.toMatchObject({ text: 'done' });
    expect(counts).toEqual({ owner: 1, iterator: 1 });
  });

  it('pulls on demand and final-only consumption suppresses intermediate events', async () => {
    let reads = 0;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        const values = [
          withLane({ type: 'response.output_text.delta', delta: 'first' }),
          withLane({ type: 'response.output_text.delta', delta: 'second' }),
          withLane({ type: 'response.completed' }),
        ];
        return {
          next: async () => {
            const value = values[reads++];
            return value === undefined
              ? { done: true as const, value: undefined }
              : { done: false as const, value };
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    expect(reads).toBe(0);
    const iterator = parsed[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    expect(reads).toBe(1);
    await iterator.return?.();

    const pushes: boolean[] = [];
    const finalOnly = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'a' },
        { type: 'response.output_text.delta', delta: 'b' },
        { type: 'response.completed' },
      ),
      {
        createParser() {
          let text = '';
          return {
            push(chunk, options) {
              text += chunk;
              pushes.push(options?.emit !== false);
              return options?.emit === false ? [] : [chunk];
            },
            finish(outcome) {
              return { result: { text, outcome } };
            },
          };
        },
      },
    );
    await expect(finalOnly.finalResult).resolves.toMatchObject({ text: 'ab' });
    expect(pushes).toEqual([false, false]);
  });

  it('rejects finalResult when iteration stops early and closes the source', async () => {
    let returned = false;
    let reads = 0;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({
                done: false as const,
                value: withLane({
                  type: 'response.output_text.delta',
                  delta: 'first',
                }),
              });
            }
            return new Promise<IteratorResult<ResponsesEvent>>(() => undefined);
          },
          return() {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    for await (const _chunk of parsed) break;
    await expect(parsed.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamAbortedError,
    );
    expect(returned).toBe(true);
  });

  it.each([
    [
      { type: 'response.failed', response: { error: { message: 'failed' } } },
      ResponsesStreamFailedError,
      'failed',
    ],
    [
      { type: 'response.failed', response: { error: { message: '' } } },
      ResponsesStreamFailedError,
      '',
    ],
    [{ type: 'error', message: 'errored' }, ResponsesStreamEventError, 'errored'],
    [
      { type: 'error', error: { message: '' }, message: 'direct' },
      ResponsesStreamEventError,
      '',
    ],
    [{ type: 'error', message: '' }, ResponsesStreamEventError, ''],
  ] as const)(
    'classifies terminal error event %o',
    async (event, ErrorClass, expectedMessage) => {
      const parsed = parseResponsesStream(events(event), textFormat);
      const iterator = parsed[Symbol.asyncIterator]();
      const iterationError = await iterator.next().catch((error: unknown) => error);
      expect(iterationError).toBeInstanceOf(ErrorClass);
      expect((iterationError as Error).message).toBe(expectedMessage);
      await expect(parsed.finalResult).rejects.toBe(iterationError);
    },
  );

  it('normalizes signed-zero lane indexes', async () => {
    const parsed = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        item_id: 'message',
        output_index: -0,
        content_index: -0,
      }),
      textFormat,
    );
    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamLaneError);
    const lane = (error as ResponsesStreamLaneError).expected;
    expect(lane).toEqual({ item_id: 'message', output_index: 0, content_index: 0 });
    expect(Object.is(lane?.output_index, -0)).toBe(false);
    expect(Object.is(lane?.content_index, -0)).toBe(false);
  });

  it('locks one official output text lane and rejects interleaving', async () => {
    const parsed = parseResponsesStream(
      events(
        {
          type: 'response.output_text.delta',
          delta: 'first',
          item_id: 'message-1',
          output_index: 0,
          content_index: 0,
        },
        {
          type: 'response.output_text.delta',
          delta: 'second',
          item_id: 'message-2',
          output_index: 1,
          content_index: 0,
        },
      ),
      textFormat,
    );
    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamLaneError);
    expect((error as ResponsesStreamLaneError).expected).toEqual({
      item_id: 'message-1',
      output_index: 0,
      content_index: 0,
    });
    expect((error as ResponsesStreamLaneError).received).toEqual({
      item_id: 'message-2',
      output_index: 1,
      content_index: 0,
    });
  });

  it('enforces exactly one finalized output text lane', async () => {
    const missing = parseResponsesStream(
      trackedSource([{ type: 'response.completed' }]).source,
      textFormat,
    );
    await expect(missing.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);

    const repeated = parseResponsesStream(
      events(
        { type: 'response.output_text.done', text: 'done' },
        { type: 'response.output_text.done', text: 'done' },
      ),
      textFormat,
    );
    await expect(repeated.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);

    const conflicting = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'delta' },
        { type: 'response.output_text.done', text: 'different' },
      ),
      textFormat,
    );
    await expect(conflicting.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamLaneError,
    );

    const afterDone = parseResponsesStream(
      events(
        { type: 'response.output_text.done', text: 'done' },
        { type: 'response.output_text.delta', delta: 'late' },
      ),
      textFormat,
    );
    await expect(afterDone.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamLaneError,
    );
  });

  it('does not emit an in-flight next result after return completes', async () => {
    let resolveNext!: (value: IteratorResult<ResponsesEvent>) => void;
    let returned = 0;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<ResponsesEvent>>((resolve) => {
              resolveNext = resolve;
            }),
          return: async () => {
            returned += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    await iterator.return?.();
    resolveNext({
      done: false,
      value: withLane({ type: 'response.output_text.delta', delta: 'late' }),
    });
    await expect(pending).rejects.toBeInstanceOf(ResponsesStreamAbortedError);
    expect(returned).toBe(1);
  });

  it('settles a never-resolving consumer pull after return', async () => {
    let returned = 0;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<ResponsesEvent>>(() => undefined),
          return: async () => {
            returned += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(pending).rejects.toBeInstanceOf(ResponsesStreamAbortedError);
    expect(returned).toBe(1);
  });

  it('surfaces a direct return cleanup failure', async () => {
    const cause = new Error('close failed');
    const tracked = trackedSource(
      [{ type: 'response.output_text.delta', delta: 'first' }],
      { returnFailure: cause },
    );
    const parsed = parseResponsesStream(tracked.source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    await iterator.next();
    const error = await iterator.return?.().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('return');
    expect((error as Error).cause).toBe(cause);
    expect(tracked.counts.return).toBe(1);
  });

  it('classifies malformed successful iterator results as source failures', async () => {
    let returned = 0;
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => undefined,
          return: async () => {
            returned += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    } as unknown as AsyncIterable<ResponsesEvent>;
    const parsed = parseResponsesStream(source, textFormat);
    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('next');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(returned).toBe(1);
  });

  it('reports a clean terminal close failure without a fabricated prior error', async () => {
    const cause = new Error('close failed');
    const tracked = trackedSource(
      [
        { type: 'response.output_text.delta', delta: 'done' },
        { type: 'response.output_text.done', text: 'done' },
        { type: 'response.completed' },
      ],
      { returnFailure: cause },
    );
    const parsed = parseResponsesStream(tracked.source, textFormat);
    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('return');
    expect((error as Error).cause).toBe(cause);
    expect((error as ResponsesStreamSourceError).priorError).toBeUndefined();
    expect(tracked.counts.return).toBe(1);
  });

  it('classifies a refusal on another content lane as refusal', async () => {
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.refusal.done',
          refusal: 'cannot comply',
          item_id: 'message-1',
          output_index: 0,
          content_index: 1,
        },
      ),
      textFormat,
    );
    await expect(parsed.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamRefusalError,
    );
  });

  it.each(['response.refusal.delta', 'response.refusal.done'] as const)(
    'treats %s as a typed terminal failure',
    async (type) => {
      const event =
        type === 'response.refusal.delta'
          ? { type, delta: 'cannot comply' }
          : { type, refusal: 'cannot comply' };
      const parsed = parseResponsesStream(events(event), textFormat);
      await expect(parsed.finalResult).rejects.toBeInstanceOf(
        ResponsesStreamRefusalError,
      );
    },
  );

  it('closes the source exactly once for event and parser failures', async () => {
    const cases: Array<{
      readonly source: ReturnType<typeof trackedSource>;
      readonly run: () => Promise<unknown>;
    }> = [];

    const eventSource = trackedSource([{ type: 'error', message: 'bad event' }]);
    const eventParsed = parseResponsesStream(eventSource.source, textFormat);
    cases.push({ source: eventSource, run: () => eventParsed.finalResult });

    const parserSource = trackedSource([
      { type: 'response.output_text.delta', delta: 'text' },
    ]);
    const parserParsed = parseResponsesStream(parserSource.source, {
      createParser() {
        return {
          push(): readonly string[] {
            throw new Error('parser failed');
          },
          finish(outcome: ResponseStreamOutcome) {
            return { result: { text: '', outcome } };
          },
        };
      },
    });
    cases.push({ source: parserSource, run: () => parserParsed.finalResult });

    for (const testCase of cases) {
      await expect(testCase.run()).rejects.toBeDefined();
      expect(testCase.source.counts.return).toBe(1);
      await expect(testCase.run()).rejects.toBeDefined();
      expect(testCase.source.counts.return).toBe(1);
    }
  });

  it('wraps next and return failures with operation and cause', async () => {
    const nextCause = new Error('next failed');
    const nextTracked = trackedSource([], { nextFailure: nextCause });
    const nextParsed = parseResponsesStream(nextTracked.source, textFormat);
    const nextError = await nextParsed.finalResult.catch((reason: unknown) => reason);
    expect(nextError).toBeInstanceOf(ResponsesStreamSourceError);
    expect((nextError as ResponsesStreamSourceError).operation).toBe('next');
    expect((nextError as Error).cause).toBe(nextCause);
    expect(nextTracked.counts.return).toBe(1);

    const returnCause = new Error('return failed');
    const returnTracked = trackedSource([{ type: 'error', message: 'event failed' }], {
      returnFailure: returnCause,
    });
    const returnParsed = parseResponsesStream(returnTracked.source, textFormat);
    const returnError = await returnParsed.finalResult.catch(
      (reason: unknown) => reason,
    );
    expect(returnError).toBeInstanceOf(ResponsesStreamSourceError);
    expect((returnError as ResponsesStreamSourceError).operation).toBe('return');
    expect((returnError as Error).cause).toBe(returnCause);
    expect((returnError as ResponsesStreamSourceError).priorError).toBeInstanceOf(
      ResponsesStreamEventError,
    );
    expect(returnTracked.counts.return).toBe(1);
  });

  it('requires explicit incompletion to follow one finalized lane', async () => {
    const missing = parseResponsesStream(
      trackedSource([
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'limit' } },
        },
      ]).source,
      textFormat,
    );
    await expect(missing.finalResult).rejects.toBeInstanceOf(ResponsesStreamLaneError);
  });

  it('rejects a source that does not confirm closure', async () => {
    let returned = 0;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          async next() {
            if (!emitted) {
              emitted = true;
              return {
                done: false as const,
                value: withLane({
                  type: 'response.output_text.delta',
                  delta: 'first',
                }),
              };
            }
            return new Promise<IteratorResult<ResponsesEvent>>(() => undefined);
          },
          async return() {
            returned += 1;
            return {
              done: false as const,
              value: withLane({
                type: 'response.output_text.delta',
                delta: 'still open',
              }),
            };
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    await iterator.next();
    const error = await iterator.return?.().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('return');
    expect((error as Error).cause).toBeInstanceOf(TypeError);
    expect(returned).toBe(1);
  });

  it('wraps a throwing return accessor without fabricating its cause', async () => {
    const cause = new Error('return accessor failed');
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        const iterator = {
          next: async () => ({
            done: false as const,
            value: withLane({
              type: 'response.output_text.delta',
              delta: 'first',
            }),
          }),
        } as AsyncIterator<ResponsesEvent>;
        Object.defineProperty(iterator, 'return', {
          get() {
            throw cause;
          },
        });
        return iterator;
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const iterator = parsed[Symbol.asyncIterator]();
    await iterator.next();
    const error = await iterator.return?.().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('return');
    expect((error as Error).cause).toBe(cause);
    expect((error as ResponsesStreamSourceError).priorError).toBeInstanceOf(
      ResponsesStreamAbortedError,
    );
  });

  it('guards close before a synchronously reentrant return', async () => {
    let returned = 0;
    let iterator!: AsyncIterator<string>;
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return {
              done: false as const,
              value: withLane({ type: 'response.output_text.delta', delta: 'x' }),
            };
          },
          async return() {
            returned += 1;
            await iterator.return?.();
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    iterator = parsed[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(returned).toBe(1);
  });

  it('represents explicit incompletion and EOF truncation', async () => {
    const incomplete = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output' } },
        },
      ),
      textFormat,
    );
    await expect(incomplete.finalResult).resolves.toEqual({
      text: 'partial',
      outcome: { status: 'incomplete', reason: 'response', detail: 'max_output' },
    });

    const eof = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: 'truncated' }),
      textFormat,
    );
    await expect(eof.finalResult).resolves.toEqual({
      text: 'truncated',
      outcome: { status: 'incomplete', reason: 'eof' },
    });
  });

  it('propagates source errors by identity', async () => {
    const failure = new Error('source failed');
    const source: AsyncIterable<ResponsesEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(failure),
        };
      },
    };
    const parsed = parseResponsesStream(source, textFormat);
    const error = await parsed.finalResult.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ResponsesStreamSourceError);
    expect((error as ResponsesStreamSourceError).operation).toBe('next');
    expect((error as Error).cause).toBe(failure);
  });

  it('uses output_text.done when no deltas were emitted', async () => {
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.done', text: 'fallback' },
        { type: 'response.completed' },
      ),
      textFormat,
    );
    await expect(parsed.finalResult).resolves.toMatchObject({ text: 'fallback' });
  });
});

describe('segmentation format', () => {
  it('exposes zero-argument factories at type and runtime', () => {
    expectTypeOf(formats.segmentation.image).parameters.toEqualTypeOf<[]>();
    expectTypeOf(formats.segmentation.video).parameters.toEqualTypeOf<[]>();

    const image = formats.segmentation.image as unknown as (
      ...args: unknown[]
    ) => unknown;
    const video = formats.segmentation.video as unknown as (
      ...args: unknown[]
    ) => unknown;
    expect(() => image({})).toThrow(TypeError);
    expect(() => video({ options: true })).toThrow(TypeError);
  });

  it('parses image records across every character boundary', async () => {
    const text =
      'Synthetic scene.\n' +
      apiLine(0, apiRecord('0'), apiRecord('1', { x1: 5, x2: 9 }));
    const streamEvents: TestEvent[] = [...text].map((delta) => ({
      type: 'response.output_text.delta',
      delta,
    }));
    streamEvents.push({ type: 'response.completed' });
    const parsed = parseResponsesStream(
      events(...streamEvents),
      formats.segmentation.image(),
    );
    const snapshots = [];
    for await (const snapshot of parsed) snapshots.push(snapshot);
    const result = await parsed.finalResult;
    const exactImageResult: ImageSegmentationResult = result;
    expect(exactImageResult.media).toBe('image');

    expect(result.media).toBe('image');
    expect(result.records.map((record) => record.kind)).toEqual([
      'text',
      'box',
      'mask',
      'box',
      'mask',
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.outcome).toEqual({ status: 'completed' });
    // One snapshot per completed line: the prose, then the record line.
    expect(snapshots).toHaveLength(2);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[4])).toBe(true);
  });

  it('parses SAM API image records with box-local masks', async () => {
    const text = `<0f>7<|box;x1=10;y1=20;x2=14;y2=24;w=100;h=80|><|mask;x=0;y=0;data=5,5,${payload}|>\n`;
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed' },
      ),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      kind: 'box',
      objectId: '7',
      left: 10,
      top: 20,
      right: 15,
      bottom: 25,
    });
    expect(result.records[1]).toMatchObject({
      kind: 'mask',
      objectId: '7',
      identity: 'image:*:7',
      bounds: { left: 10, top: 20, right: 15, bottom: 25 },
      mask: { encoding: 'one_bit', width: 5, height: 5, payload },
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('normalizes signed-zero API coordinates', async () => {
    const text = `<0f>0<|box;x1=-0;y1=-0;x2=4;y2=4;w=5;h=5|><|mask;x=0;y=0;data=5,5,${payload}|>\n`;
    const result = await parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: text }),
      formats.segmentation.image(),
    ).finalResult;
    const box = result.records[0];
    const mask = result.records[1];
    expect(box).toMatchObject({ kind: 'box', left: 0, top: 0 });
    expect(mask).toMatchObject({ kind: 'mask', bounds: { left: 0, top: 0 } });
    if (box?.kind !== 'box' || mask?.kind !== 'mask') {
      throw new Error('Expected box and mask records.');
    }
    expect(Object.is(box.left, -0)).toBe(false);
    expect(Object.is(box.top, -0)).toBe(false);
    expect(Object.is(mask.bounds.left, -0)).toBe(false);
    expect(Object.is(mask.bounds.top, -0)).toBe(false);
  });

  it('accepts optional commas, multi-digit IDs, and non-contiguous IDs in API records', async () => {
    const segment = (id: string) =>
      `${id}<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|>` +
      `<|mask;x=0;y=0;data=5,5,${payload}|>`;
    const parsed = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        delta: `<0f>,${segment('0')}${segment('2')},${segment('10')}\n`,
      }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records.map((record) => record.kind)).toEqual([
      'box',
      'mask',
      'box',
      'mask',
      'box',
      'mask',
    ]);
    expect(
      result.records
        .filter((record): record is SegmentationBoxRecord => record.kind === 'box')
        .map((record) => record.objectId),
    ).toEqual(['0', '2', '10']);
    expect(result.diagnostics).toEqual([]);
  });

  it('diagnoses non-numeric API object IDs', async () => {
    const text =
      `<0f>car<|box;x1=0;y1=0;x2=4;y2=4;w=5;h=5|>` +
      `<|mask;x=0;y=0;data=5,5,${payload}|>\n`;
    const result = await parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: text }),
      formats.segmentation.image(),
    ).finalResult;

    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'malformed_record',
        message: 'Malformed SAM API object record.',
        raw: text.trimEnd(),
      }),
    ]);
  });

  it('diagnoses an empty API frame record', async () => {
    const parsed = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: '<0f>\n' }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'malformed_record',
        raw: '<0f>',
      }),
    ]);
  });

  it('retains SAM API frame indices for video records', async () => {
    const text = `<7f>0<|box;x1=1;y1=2;x2=5;y2=6;w=20;h=10|><|mask;x=0;y=0;data=5,5,${payload}|>\n`;
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed' },
      ),
      formats.segmentation.video(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every(
        (record) => record.kind === 'text' || record.frame?.frameIndex === 7,
      ),
    ).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('tracks video frame references and stable mask revisions', async () => {
    const text = apiLine(7, apiRecord('3')) + apiLine(7, apiRecord('3'));
    const parsed = parseResponsesStream(
      events(
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed' },
      ),
      formats.segmentation.video(),
    );
    const result = await parsed.finalResult;
    const exactVideoResult: VideoSegmentationResult = result;
    expect(exactVideoResult.media).toBe('video');
    const masks = result.records.filter((record) => record.kind === 'mask');
    expect(masks.map((mask) => [mask.identity, mask.revision])).toEqual([
      ['video:7:3', 1],
      ['video:7:3', 2],
    ]);
    expect(masks[0]?.frame).toEqual({ frameIndex: 7 });
  });

  it('retains prose and diagnoses malformed API lines', async () => {
    const parsed = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        delta:
          'Useful prose\n' +
          '<0f>\n' +
          apiLine(0, apiRecord('0', { x1: 3, y1: 4, x2: 1, y2: 2 })) +
          apiLine(0, `0<|box;x1=0;y1=0;x2=4|><|mask;x=0;y=0;data=5,5,${payload}|>`) +
          apiLine(0, apiRecord('0', { data: payload.slice(0, -1) })) +
          apiLine(2, apiRecord('0')),
      }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    // The box of a record whose mask fails to decode is still an accepted record.
    expect(result.records.map((record) => record.kind)).toEqual(['text', 'box']);
    expect(result.records[0]).toMatchObject({ kind: 'text', text: 'Useful prose' });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'malformed_record',
      'invalid_box',
      'malformed_record',
      'invalid_mask_payload',
      'unexpected_frame',
    ]);
    expect(result.outcome).toEqual({ status: 'incomplete', reason: 'eof' });
  });

  it('isolates parser state for repeated use of one frozen format', async () => {
    const format = formats.segmentation.video();
    expect(Object.isFrozen(formats)).toBe(true);
    expect(Object.isFrozen(formats.segmentation)).toBe(true);
    const line = apiLine(0, apiRecord());
    const first = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: line }),
      format,
    );
    const second = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: line }),
      format,
    );
    const [a, b] = await Promise.all([first.finalResult, second.finalResult]);
    expect(a.records[1]).toMatchObject({ kind: 'mask', revision: 1 });
    expect(b.records[1]).toMatchObject({ kind: 'mask', revision: 1 });
  });

  it('decodes the canonical lossless single-plane conformance vector', () => {
    const decoded = decodeMaskToRaster({
      encoding: 'lossless',
      payload: '~!!!!5!!SS2!]]5!!!!!!!!!!!!!!',
      width: 128,
      height: 128,
    });
    expect(decoded).toHaveLength(128 * 128);
    expect(decoded.every((value) => value === 0)).toBe(true);
  });

  it('applies structural validation beyond the former decoder ceilings', async () => {
    const formerlyOversizedArea = {
      encoding: 'one_bit',
      payload: '!',
      width: 16_777_217,
      height: 1,
    } as const;
    expect(() => decodeMaskToRaster(formerlyOversizedArea)).toThrow(
      /missing its length prefix/,
    );

    const formerlyOversizedPayload = {
      encoding: 'one_bit',
      payload: '!'.repeat(2_000_001),
      width: 1,
      height: 1,
    } as const;
    expect(() => decodeMaskToRaster(formerlyOversizedPayload)).toThrow(
      /length does not match its prefix/,
    );

    const parsed = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        delta: apiLine(
          0,
          apiRecord('0', {
            x2: 16_777_216,
            w: 16_777_217,
            size: '1,16777217',
            data: '!!',
          }),
        ),
      }),
      formats.segmentation.image(),
    );
    await expect(parsed.finalResult).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'invalid_mask_payload' })],
    });
  });

  it('wraps allocation RangeErrors as invalid-mask errors with their cause', () => {
    let caught: unknown;
    try {
      decodeMaskToRaster({
        encoding: 'one_bit',
        payload,
        width: Number.MAX_SAFE_INTEGER,
        height: 1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidSegmentationMaskError);
    expect((caught as Error).cause).toBeInstanceOf(RangeError);
  });

  it('accepts non-unique lossless trailing and finalization variants', () => {
    const canonical = {
      encoding: 'lossless',
      payload: '~!!!!.!0^zlTde]:)]`W',
      width: 3,
      height: 2,
    } as const;
    const expected = decodeMaskToRaster(canonical);
    for (const alternatePayload of ['~!!!!/!0^zlTde]:)]`W[', '~!!!!.!0^zlTde[y)]`W']) {
      expect(alternatePayload).not.toBe(canonical.payload);
      expect(decodeMaskToRaster({ ...canonical, payload: alternatePayload })).toEqual(
        expected,
      );
    }
  });

  it('strictly rejects truncated, trailing, invalid, and noncanonical one_bit payloads', () => {
    const valid = {
      encoding: 'one_bit',
      payload,
      width: 5,
      height: 5,
    } as const;
    expect([...decodeMaskToRaster(valid)].join('')).toBe('1001000110000001011110001');
    for (const invalidPayload of [
      payload.slice(0, -1),
      `${payload}!`,
      `${payload.slice(0, -1)}|`,
      '!~~~~~',
    ]) {
      expect(() => decodeMaskToRaster({ ...valid, payload: invalidPayload })).toThrow(
        InvalidSegmentationMaskError,
      );
    }
    expect(() =>
      decodeMaskToRaster({
        ...valid,
        width: Number.MAX_SAFE_INTEGER,
        height: 2,
      }),
    ).toThrow(/unsafe decoded area/);
  });

  it('rejects an unknown mask encoding marker as a malformed record', async () => {
    const parsed = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        delta: apiLine(0, apiRecord('0', { data: '#opaque' })),
      }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'malformed_record' }),
    ]);
    expect(() =>
      decodeMaskToRaster({
        encoding: 'unknown' as unknown as 'one_bit',
        payload: '#opaque',
        width: 5,
        height: 5,
      }),
    ).toThrow(/Unsupported complete mask encoding/);
  });

  it('keeps multi-megabyte unterminated input approximately linear', () => {
    const chunk = 'x'.repeat(64);
    const count = 62_501;
    const parser = formats.segmentation.image().createParser();
    for (let index = 0; index < count; index += 1) {
      if (parser.push(chunk, { emit: false }).length !== 0) {
        throw new Error('An unterminated chunk unexpectedly emitted a snapshot.');
      }
    }
    const result = parser.finish({ status: 'completed' }).result;
    expect(result.rawOutput.length).toBe(chunk.length * count);
    expect(result.records).toEqual([
      expect.objectContaining({ kind: 'text', text: chunk.repeat(count) }),
    ]);
  }, 10_000);

  it('retains records beyond the former parser threshold', () => {
    const line = `${'x'.repeat(200)}\n`;
    const count = 20_001;
    const parser = formats.segmentation.image().createParser();
    let latest: ReturnType<typeof parser.push>[number] | undefined;
    for (let index = 0; index < count; index += 1) {
      [latest] = parser.push(line);
    }
    expect(latest).toMatchObject({
      revision: count,
      rawOutput: line.repeat(count),
    });
    expect(latest?.records).toHaveLength(count);
  }, 10_000);

  it('validates structurally invalid frame references', async () => {
    const invalidFrame = parseResponsesStream(
      events({
        type: 'response.output_text.delta',
        delta: `<999999999999999999999f>${apiRecord()}\n`,
      }),
      formats.segmentation.video(),
    );
    await expect(invalidFrame.finalResult).resolves.toMatchObject({
      diagnostics: [expect.objectContaining({ code: 'invalid_frame' })],
    });
  });

  it('retains diagnostics beyond the former parser threshold', async () => {
    const delta = '<0f>\n'.repeat(1_001);
    const parsed = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toHaveLength(1_001);
  });

  it('retains masks beyond the former parser threshold', async () => {
    const line = apiLine(0, apiRecord());
    const parsed = parseResponsesStream(
      events({ type: 'response.output_text.delta', delta: line.repeat(4_097) }),
      formats.segmentation.image(),
    );
    const result = await parsed.finalResult;
    expect(result.records).toHaveLength(2 * 4_097);
    expect(result.records.at(-1)).toMatchObject({ kind: 'mask', revision: 4_097 });
    expect(result.diagnostics).toEqual([]);
  }, 10_000);
});

describe('segmentation media entry points', () => {
  const imageText = apiLine(0, apiRecord('0'));
  const videoText = apiLine(
    7,
    apiRecord('0', { x1: 10, y1: 20, x2: 14, y2: 24, w: 200, h: 100 }),
  );

  function streamEvents(text: string): TestEvent[] {
    return [
      { type: 'response.output_text.delta', delta: text },
      { type: 'response.completed' },
    ];
  }

  it('parses image streams exactly like the explicit image format', async () => {
    const wrapped = parseImageStream(events(...streamEvents(imageText)));
    const explicit = parseResponsesStream(
      events(...streamEvents(imageText)),
      formats.segmentation.image(),
    );

    const result: ImageSegmentationResult = await wrapped.finalResult;
    expect(result.media).toBe('image');
    expect(result).toEqual(await explicit.finalResult);
  });

  it('parses video streams exactly like the explicit video format', async () => {
    const wrapped = parseVideoStream(events(...streamEvents(videoText)));
    const explicit = parseResponsesStream(
      events(...streamEvents(videoText)),
      formats.segmentation.video(),
    );

    const result: VideoSegmentationResult = await wrapped.finalResult;
    expect(result.media).toBe('video');
    expect(result.records).toEqual([
      expect.objectContaining({
        kind: 'box',
        objectId: '0',
        frame: { frameIndex: 7 },
      }),
      expect.objectContaining({ kind: 'mask', frame: { frameIndex: 7 } }),
    ]);
    expect(result).toEqual(await explicit.finalResult);
  });

  it('emits cumulative snapshots and honors one consumer', async () => {
    const parsed = parseVideoStream(events(...streamEvents(videoText)));

    const snapshots: VideoSegmentationSnapshot[] = [];
    for await (const snapshot of parsed) snapshots.push(snapshot);

    expect(snapshots.map((snapshot) => snapshot.records.length)).toEqual([2]);
    await expect(parsed.finalResult).resolves.toMatchObject({ media: 'video' });
    expect(() => parsed[Symbol.asyncIterator]()).toThrow(ResponsesStreamConsumedError);
  });

  it('applies the media rules of the format it selects', async () => {
    const image = parseImageStream(events(...streamEvents(videoText)));
    await expect(image.finalResult).resolves.toMatchObject({
      records: [],
      diagnostics: [expect.objectContaining({ code: 'unexpected_frame' })],
    });

    const video = parseVideoStream(events(...streamEvents(videoText)));
    await expect(video.finalResult).resolves.toMatchObject({ diagnostics: [] });
  });
});

describe('segmentation record helpers', () => {
  const text =
    'Synthetic scene.\n' +
    apiLine(7, apiRecord('0', { x1: 10, y1: 20, x2: 14, y2: 24, w: 200, h: 100 })) +
    apiLine(9, apiRecord('0', { x1: 11, y1: 20, x2: 15, y2: 24, w: 200, h: 100 }));

  async function videoRecords(): Promise<readonly SegmentationRecord[]> {
    const parsed = parseVideoStream(
      events(
        { type: 'response.output_text.delta', delta: text },
        { type: 'response.completed' },
      ),
    );
    return (await parsed.finalResult).records;
  }

  it('reads a frame index from every record kind', async () => {
    const records = await videoRecords();
    expect(records.map(frameIndexOf)).toEqual([undefined, 7, 7, 9, 9]);
  });

  it('reports no frame index for image records', async () => {
    const parsed = parseImageStream(
      events(
        { type: 'response.output_text.delta', delta: apiLine(0, apiRecord()) },
        { type: 'response.completed' },
      ),
    );
    const result = await parsed.finalResult;
    expect(result.records.map(frameIndexOf)).toEqual([undefined, undefined]);
  });

  it('narrows records to one kind and freezes the result', async () => {
    const records = await videoRecords();

    const masks: readonly SegmentationMaskRecord[] = recordsOfKind(records, 'mask');
    expect(masks).toHaveLength(2);
    expect(masks[0]?.identity).toBe('video:7:0');
    expect(masks[1]?.identity).toBe('video:9:0');
    expect(decodeMaskToRaster(masks[0]!.mask)).toHaveLength(25);
    expect(Object.isFrozen(masks)).toBe(true);

    const boxes: readonly SegmentationBoxRecord[] = recordsOfKind(records, 'box');
    expect(boxes.map((box) => box.left)).toEqual([10, 11]);

    const texts: readonly SegmentationTextRecord[] = recordsOfKind(records, 'text');
    expect(texts.map((entry) => entry.text)).toEqual(['Synthetic scene.']);
  });

  it('returns an empty list when no record matches', async () => {
    const parsed = parseImageStream(
      events(
        { type: 'response.output_text.delta', delta: 'Synthetic scene.\n' },
        { type: 'response.completed' },
      ),
    );
    const result = await parsed.finalResult;
    expect(recordsOfKind(result.records, 'mask')).toEqual([]);
  });
});
