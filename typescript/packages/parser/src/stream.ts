/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import {
  ResponsesStreamAbortedError,
  ResponsesStreamConsumedError,
  ResponsesStreamError,
  ResponsesStreamEventError,
  ResponsesStreamFailedError,
  ResponsesStreamLaneError,
  ResponsesStreamParserError,
  ResponsesStreamRefusalError,
  ResponsesStreamSourceError,
} from './errors.js';
import type {
  OutputTextLane,
  ParsedResponsesStream,
  ResponseFormat,
  ResponseFormatParser,
  ResponseStreamOutcome,
} from './types.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function nestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === 'object' && nested !== null
    ? (nested as Record<string, unknown>)
    : undefined;
}

function nestedString(value: unknown, ...path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

type Consumption = 'idle' | 'iteration' | 'final';
type SourceEvent = { readonly type: string };
/** The event types that finalize the output text lane. */
type OutputTextFinalizer = 'response.output_text.done' | 'response.content_part.done';

class ParsedResponsesStreamImpl<Event, Result>
  implements ParsedResponsesStream<Event, Result>, AsyncIterator<Event>
{
  readonly #source: AsyncIterable<SourceEvent>;
  readonly #format: ResponseFormat<Event, Result>;
  readonly #result = deferred<Result>();
  readonly #readInterruption = deferred<unknown>();
  readonly #pending: Event[] = [];
  #parser: ResponseFormatParser<Event, Result> | undefined;
  #sourceIterator: AsyncIterator<SourceEvent> | undefined;
  #consumption: Consumption = 'idle';
  #pull: Promise<IteratorResult<Event>> = Promise.resolve({
    done: true,
    value: undefined,
  });
  #drain: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #failurePromise: Promise<void> | undefined;
  #readInterrupted = false;
  #terminal = false;
  #consumerDone = false;
  #resultValue: Result | undefined;
  #hasResult = false;
  #error: unknown;
  #lane: OutputTextLane | undefined;
  #laneDone = false;
  readonly #laneFinalizers = new Set<OutputTextFinalizer>();
  #text = '';
  #sawDelta = false;

  public constructor(
    source: AsyncIterable<SourceEvent>,
    format: ResponseFormat<Event, Result>,
  ) {
    this.#source = source;
    this.#format = format;
    // Once consumption starts, the stream owns background teardown. An ignored final
    // result must never surface as a process-level unhandled rejection.
    void this.#result.promise.catch(() => undefined);
  }

  public get finalResult(): Promise<Result> {
    if (this.#consumption === 'idle') {
      this.#consumption = 'final';
      this.#drain = this.#drainFinal();
      void this.#drain.catch(() => undefined);
    }
    return this.#result.promise;
  }

  public [Symbol.asyncIterator](): AsyncIterator<Event> {
    if (this.#consumption !== 'idle') throw new ResponsesStreamConsumedError();
    this.#consumption = 'iteration';
    return this;
  }

  public next(): Promise<IteratorResult<Event>> {
    if (this.#consumption !== 'iteration') {
      return Promise.reject(new ResponsesStreamConsumedError());
    }
    const next = this.#pull.then(() => this.#nextOne());
    this.#pull = next.catch(() => ({ done: true, value: undefined }));
    return next;
  }

  public async return(): Promise<IteratorResult<Event>> {
    if (this.#failurePromise !== undefined && this.#closePromise !== undefined) {
      return { done: true, value: undefined };
    }
    if (!this.#consumerDone) {
      await this.#failAndClose(new ResponsesStreamAbortedError());
      this.#consumerDone = true;
      if (
        this.#error instanceof ResponsesStreamSourceError &&
        this.#error.operation === 'return'
      ) {
        throw this.#error;
      }
    }
    return { done: true, value: undefined };
  }

  async #nextOne(): Promise<IteratorResult<Event>> {
    if (this.#pending.length > 0) {
      return { done: false, value: this.#pending.shift()! };
    }
    if (this.#error !== undefined) throw this.#error;
    if (this.#terminal) return this.#completeIteration();

    try {
      this.#ensureSourceIterator();
      this.#ensureParser();
      for (;;) {
        const item = await this.#readSource();
        if (this.#terminal) {
          if (this.#error !== undefined) throw this.#error;
          return this.#completeIteration();
        }
        if (item.done) {
          this.#finish({ status: 'incomplete', reason: 'eof' }, true);
          await this.#closeSource();
          return this.#pending.length > 0
            ? { done: false, value: this.#pending.shift()! }
            : this.#completeIteration();
        }
        const outcome = this.#accept(item.value, true);
        if (outcome !== undefined) {
          this.#finish(outcome, true);
          await this.#closeSource();
          return this.#pending.length > 0
            ? { done: false, value: this.#pending.shift()! }
            : this.#completeIteration();
        }
        if (this.#pending.length > 0) {
          return { done: false, value: this.#pending.shift()! };
        }
      }
    } catch (error) {
      await this.#failAndClose(error);
      throw this.#error;
    }
  }

  async #drainFinal(): Promise<void> {
    try {
      this.#ensureSourceIterator();
      this.#ensureParser();
      for (;;) {
        const item = await this.#readSource();
        if (item.done) {
          this.#finish({ status: 'incomplete', reason: 'eof' }, false);
          await this.#closeSource();
          this.#resolveResult();
          return;
        }
        const outcome = this.#accept(item.value, false);
        if (outcome !== undefined) {
          this.#finish(outcome, false);
          await this.#closeSource();
          this.#resolveResult();
          return;
        }
      }
    } catch (error) {
      await this.#failAndClose(error);
    }
  }

  #accept(event: SourceEvent, emit: boolean): ResponseStreamOutcome | undefined {
    switch (event.type) {
      case 'response.output_text.delta': {
        const fields = event as Record<string, unknown>;
        const lane = this.#acceptLane(fields);
        if (this.#laneDone) {
          throw new ResponsesStreamLaneError(
            'The response emitted output text after finalizing its lane.',
            this.#lane,
            lane,
          );
        }
        if (typeof fields.delta !== 'string') {
          throw new ResponsesStreamLaneError(
            'The output text delta is missing its text.',
            this.#lane,
            lane,
          );
        }
        this.#sawDelta = true;
        this.#text += fields.delta;
        this.#enqueue(this.#pushParser(fields.delta, emit), emit);
        return undefined;
      }
      case 'response.output_text.done': {
        const fields = event as Record<string, unknown>;
        this.#finalizeOutputText(
          fields,
          fields.text,
          'response.output_text.done',
          emit,
        );
        return undefined;
      }
      case 'response.content_part.done': {
        const fields = event as Record<string, unknown>;
        const part = nestedRecord(fields, 'part');
        if (part === undefined) return undefined;
        if (part.type === 'refusal') {
          const message =
            typeof part.refusal === 'string'
              ? part.refusal
              : 'The response was refused.';
          throw new ResponsesStreamRefusalError(message, event);
        }
        // Parts of any other type, `reasoning_text` among them, carry no output
        // text and never finalize the output text lane.
        if (part.type !== 'output_text') return undefined;
        this.#finalizeOutputText(fields, part.text, 'response.content_part.done', emit);
        return undefined;
      }
      case 'response.refusal.delta':
      case 'response.refusal.done': {
        const fields = event as Record<string, unknown>;
        const message =
          (typeof fields.refusal === 'string' ? fields.refusal : undefined) ??
          (typeof fields.delta === 'string' ? fields.delta : undefined) ??
          'The response was refused.';
        throw new ResponsesStreamRefusalError(message, event);
      }
      case 'response.completed':
        if (this.#lane === undefined || !this.#laneDone) {
          throw new ResponsesStreamLaneError(
            'The response completed before finalizing one output text lane.',
            this.#lane,
            undefined,
          );
        }
        return { status: 'completed' };
      case 'response.incomplete': {
        if (this.#lane === undefined || !this.#laneDone) {
          throw new ResponsesStreamLaneError(
            'The response became incomplete before finalizing one output text lane.',
            this.#lane,
            undefined,
          );
        }
        const detail = nestedString(event, 'response', 'incomplete_details', 'reason');
        return detail === undefined
          ? { status: 'incomplete', reason: 'response' }
          : { status: 'incomplete', reason: 'response', detail };
      }
      case 'response.failed': {
        const message =
          nestedString(event, 'response', 'error', 'message') ?? 'The response failed.';
        throw new ResponsesStreamFailedError(message, event);
      }
      case 'error': {
        const error = nestedRecord(event, 'error');
        const message =
          (typeof error?.message === 'string' ? error.message : undefined) ??
          nestedString(event, 'message') ??
          'The Responses stream reported an error.';
        throw new ResponsesStreamEventError(message, event);
      }
      default:
        return undefined;
    }
  }

  /**
   * Finalizes the output text lane from the event that completes it.
   *
   * Two event types finalize the lane: `response.output_text.done`, whose own
   * `text` field carries the completed text, and `response.content_part.done`
   * for an `output_text` part, whose `part.text` carries it. The OpenAI
   * Responses API emits both for one lane; the live SAM Model API
   * (`api.meta.ai`) emits only `response.content_part.done`. Either one
   * validates the lane identity, rejects text that conflicts with the
   * accumulated deltas, and — when no delta was seen — supplies the whole
   * parser input itself.
   *
   * Finalizing twice is accepted as a no-op when the second event is of the
   * other type and carries identical text, which is exactly the pair the
   * OpenAI spec emits. A repeat of the same event type is still
   * `ResponsesStreamLaneError`, as is any second finalization whose text
   * differs from the text already accepted for the lane.
   */
  #finalizeOutputText(
    fields: Record<string, unknown>,
    text: unknown,
    finalizer: OutputTextFinalizer,
    emit: boolean,
  ): void {
    const lane = this.#acceptLane(fields);
    if (this.#laneDone && this.#laneFinalizers.has(finalizer)) {
      throw new ResponsesStreamLaneError(
        'The response finalized its output text lane more than once.',
        this.#lane,
        lane,
      );
    }
    if (typeof text !== 'string') {
      throw new ResponsesStreamLaneError(
        'The completed output text is missing its text.',
        this.#lane,
        lane,
      );
    }
    if (this.#laneDone) {
      if (text !== this.#text) {
        throw new ResponsesStreamLaneError(
          'The response finalized its output text lane twice with conflicting text.',
          this.#lane,
          lane,
        );
      }
      this.#laneFinalizers.add(finalizer);
      return;
    }
    if (this.#sawDelta && text !== this.#text) {
      throw new ResponsesStreamLaneError(
        'The finalized output text conflicts with its accumulated deltas.',
        this.#lane,
        lane,
      );
    }
    if (!this.#sawDelta) {
      this.#text = text;
      this.#enqueue(this.#pushParser(text, emit), emit);
    }
    this.#laneDone = true;
    this.#laneFinalizers.add(finalizer);
  }

  #acceptLane(fields: Record<string, unknown>): OutputTextLane {
    const itemId = fields.item_id;
    const outputIndex = fields.output_index;
    const contentIndex = fields.content_index;
    const lane =
      typeof itemId === 'string' &&
      itemId.length > 0 &&
      Number.isSafeInteger(outputIndex) &&
      (outputIndex as number) >= 0 &&
      Number.isSafeInteger(contentIndex) &&
      (contentIndex as number) >= 0
        ? Object.freeze({
            item_id: itemId,
            output_index: (outputIndex as number) === 0 ? 0 : (outputIndex as number),
            content_index:
              (contentIndex as number) === 0 ? 0 : (contentIndex as number),
          })
        : undefined;
    if (lane === undefined) {
      throw new ResponsesStreamLaneError(
        'The output text event has an invalid lane identity.',
        this.#lane,
        undefined,
      );
    }
    if (this.#lane === undefined) {
      this.#lane = lane;
      return lane;
    }
    if (
      this.#lane.item_id !== lane.item_id ||
      this.#lane.output_index !== lane.output_index ||
      this.#lane.content_index !== lane.content_index
    ) {
      throw new ResponsesStreamLaneError(
        'The response interleaved multiple output text lanes.',
        this.#lane,
        lane,
      );
    }
    return lane;
  }

  #finish(outcome: ResponseStreamOutcome, emit: boolean): void {
    if (this.#terminal) return;
    let finished: ReturnType<ResponseFormatParser<Event, Result>['finish']>;
    try {
      finished = this.#ensureParser().finish(Object.freeze(outcome));
    } catch (error) {
      throw this.#asParserError(error);
    }
    this.#enqueue(finished.events ?? [], emit);
    this.#resultValue = finished.result;
    this.#hasResult = true;
    this.#terminal = true;
  }

  #pushParser(chunk: string, emit: boolean): readonly Event[] {
    try {
      return this.#ensureParser().push(chunk, { emit });
    } catch (error) {
      throw this.#asParserError(error);
    }
  }

  #ensureParser(): ResponseFormatParser<Event, Result> {
    if (this.#parser !== undefined) return this.#parser;
    try {
      this.#parser = this.#format.createParser();
      return this.#parser;
    } catch (error) {
      throw this.#asParserError(error);
    }
  }

  #asParserError(error: unknown): ResponsesStreamError {
    return error instanceof ResponsesStreamError
      ? error
      : new ResponsesStreamParserError(error);
  }

  #enqueue(events: readonly Event[], emit: boolean): void {
    if (!emit || events.length === 0) return;
    this.#pending.push(...events);
  }

  #completeIteration(): IteratorResult<Event> {
    if (this.#error !== undefined) throw this.#error;
    this.#consumerDone = true;
    this.#resolveResult();
    return { done: true, value: undefined };
  }

  #resolveResult(): void {
    if (this.#hasResult && this.#error === undefined) {
      this.#result.resolve(this.#resultValue as Result);
    }
  }

  async #failAndClose(error: unknown): Promise<void> {
    if (this.#failurePromise !== undefined) return this.#failurePromise;
    const failed = deferred<void>();
    this.#failurePromise = failed.promise;
    void (async () => {
      try {
        let failure =
          error instanceof ResponsesStreamError
            ? error
            : new ResponsesStreamParserError(error);
        this.#interruptReads(failure);
        if (
          failure instanceof ResponsesStreamSourceError &&
          failure.operation === 'return' &&
          this.#closePromise !== undefined
        ) {
          this.#fail(failure);
          failed.resolve();
          return;
        }
        try {
          await this.#closeSource();
        } catch (closeError) {
          failure =
            closeError instanceof ResponsesStreamSourceError
              ? new ResponsesStreamSourceError('return', closeError.cause, failure)
              : new ResponsesStreamSourceError('return', closeError, failure);
        }
        this.#fail(failure);
        failed.resolve();
      } catch (unexpected) {
        this.#fail(unexpected);
        failed.resolve();
      }
    })();
    return this.#failurePromise;
  }

  #interruptReads(error: unknown): void {
    if (this.#readInterrupted) return;
    this.#readInterrupted = true;
    this.#readInterruption.resolve(error);
  }

  #fail(error: unknown): void {
    if (this.#error !== undefined) return;
    this.#error = error;
    this.#terminal = true;
    this.#pending.length = 0;
    this.#result.reject(error);
  }

  #ensureSourceIterator(): AsyncIterator<SourceEvent> {
    if (this.#sourceIterator !== undefined) return this.#sourceIterator;
    try {
      this.#sourceIterator = this.#source[Symbol.asyncIterator]();
      return this.#sourceIterator;
    } catch (error) {
      throw new ResponsesStreamSourceError('iterator', error);
    }
  }

  async #readSource(): Promise<IteratorResult<SourceEvent>> {
    const reading = (async (): Promise<IteratorResult<SourceEvent>> => {
      try {
        const item = await this.#ensureSourceIterator().next();
        if (
          typeof item !== 'object' ||
          item === null ||
          typeof item.done !== 'boolean' ||
          (!item.done &&
            (typeof item.value !== 'object' ||
              item.value === null ||
              typeof item.value.type !== 'string'))
        ) {
          throw new TypeError('The event source returned an invalid iterator result.');
        }
        return item;
      } catch (error) {
        throw error instanceof ResponsesStreamSourceError
          ? error
          : new ResponsesStreamSourceError('next', error);
      }
    })();
    // The source may ignore return() and leave next() pending forever. The parsed
    // stream still owns its consumer-facing pull, so race it against internal
    // termination and observe the losing source promise to prevent a late rejection.
    void reading.catch(() => undefined);
    const outcome = await Promise.race([
      reading.then((item) => ({ kind: 'item' as const, item })),
      this.#readInterruption.promise.then((error) => ({
        kind: 'interrupted' as const,
        error,
      })),
    ]);
    if (outcome.kind === 'interrupted') throw outcome.error;
    return outcome.item;
  }

  #closeSource(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closed = deferred<void>();
    this.#closePromise = closed.promise;
    void (async () => {
      try {
        const iterator = this.#sourceIterator;
        let target: object = this.#source;
        let close: (() => unknown) | undefined;
        let requireIteratorResult = false;
        try {
          const owner = target as {
            readonly aclose?: () => unknown;
            readonly close?: () => unknown;
          };
          close = owner.aclose ?? owner.close;
          if (close === undefined && iterator !== undefined) {
            target = iterator;
            close = iterator.return;
            requireIteratorResult = close !== undefined;
          }
        } catch (error) {
          throw new ResponsesStreamSourceError('return', error);
        }
        if (close === undefined) {
          closed.resolve();
          return;
        }
        let result: unknown;
        try {
          result = await close.call(target);
        } catch (error) {
          throw new ResponsesStreamSourceError('return', error);
        }
        if (
          requireIteratorResult &&
          (typeof result !== 'object' ||
            result === null ||
            (result as { readonly done?: unknown }).done !== true)
        ) {
          throw new ResponsesStreamSourceError(
            'return',
            new TypeError('The event source did not confirm that it closed.'),
          );
        }
        closed.resolve();
      } catch (error) {
        closed.reject(error);
      }
    })();
    return this.#closePromise;
  }
}

export function parseResponsesStream<
  SourceEventType extends { readonly type: string },
  Event,
  Result,
>(
  source: AsyncIterable<SourceEventType>,
  format: ResponseFormat<Event, Result>,
): ParsedResponsesStream<Event, Result> {
  return new ParsedResponsesStreamImpl(source, format);
}
