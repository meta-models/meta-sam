/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ResponsesStreamError,
  ResponsesStreamLaneError,
  ResponsesStreamSourceError,
  decodeMaskToRaster,
  decodeMaskToRLE,
  decodeMaskToSVGPath,
  formats,
  parseResponsesStream,
  type OutputTextLane,
  type ResponsesEvent,
  type SegmentationDiagnostic,
  type SegmentationRecord,
  type SegmentationResult,
  type SegmentationSnapshot,
} from '../../packages/parser/src/index.js';
import { validateAgainstSchema } from './schema-validator.js';

export type Media = 'image' | 'video';

export interface ConformanceLane {
  readonly item_id: string;
  readonly output_index: number;
  readonly content_index: number;
}

export interface ConformanceSourceLane {
  readonly item_id?: unknown;
  readonly output_index?: unknown;
  readonly content_index?: unknown;
}

export type ConformanceSourceDirective =
  | { readonly operation: 'iterator'; readonly message: string }
  | {
      readonly operation: 'next';
      readonly message: string;
      readonly after_events: number;
    }
  | { readonly operation: 'close'; readonly message: string };

export type ConformanceSourceEvent =
  | {
      readonly type: 'output_text_delta';
      readonly lane: ConformanceSourceLane;
      readonly chunk: number;
    }
  | {
      readonly type: 'output_text_done';
      readonly lane: ConformanceSourceLane;
      readonly text: string;
    }
  | {
      readonly type: 'content_part_done';
      readonly lane: ConformanceSourceLane;
      readonly part_type: 'output_text' | 'refusal' | 'reasoning_text';
      readonly text: string;
    }
  | { readonly type: 'response_completed' }
  | { readonly type: 'response_incomplete'; readonly detail?: string }
  | { readonly type: 'response_failed'; readonly message: string }
  | { readonly type: 'error'; readonly message: string }
  | {
      readonly type: 'refusal_delta' | 'refusal_done';
      readonly lane: ConformanceSourceLane;
      readonly text: string;
    };

export interface ConformanceCase {
  readonly schema_version: 1;
  readonly name: string;
  readonly description: string;
  readonly media: Media;
  readonly chunks: readonly string[];
  readonly events: readonly ConformanceSourceEvent[];
  readonly source?: ConformanceSourceDirective;
  readonly expected: NormalizedExecution;
}

interface NormalizedView {
  readonly media: Media;
  readonly revision: number;
  readonly records: readonly Record<string, unknown>[];
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly raw_output: string;
}

interface NormalizedResult extends NormalizedView {
  readonly outcome: Readonly<Record<string, unknown>>;
}

interface NormalizedTerminalError {
  readonly code: string;
  readonly message: string;
  readonly expected_lane?: ConformanceLane | null;
  readonly received_lane?: ConformanceLane | null;
  readonly source_operation?: string;
}

export type NormalizedExecution =
  | {
      readonly snapshots: readonly NormalizedView[];
      readonly result: NormalizedResult;
    }
  | {
      readonly snapshots: readonly NormalizedView[];
      readonly error: NormalizedTerminalError;
    };

const casesDirectory = new URL('../../../conformance/cases/', import.meta.url);
const schemaUrl = new URL('../../../conformance/case.schema.json', import.meta.url);
export const conformanceCaseSchema: unknown = JSON.parse(
  await readFile(schemaUrl, 'utf8'),
);

function semanticFailure(path: string, message: string): never {
  throw new Error(`Conformance case ${path} is invalid: ${message}`);
}

function assertSemanticContract(fixture: ConformanceCase, path: string): void {
  const referencedChunks = fixture.events
    .filter(
      (
        event,
      ): event is Extract<ConformanceSourceEvent, { type: 'output_text_delta' }> =>
        event.type === 'output_text_delta',
    )
    .map((event) => event.chunk);
  const expectedChunks = fixture.chunks.map((_, index) => index);
  if (JSON.stringify(referencedChunks) !== JSON.stringify(expectedChunks)) {
    semanticFailure(
      path,
      `delta events must reference every chunk exactly once in order; received [${referencedChunks.join(', ')}]`,
    );
  }

  const terminalTypes = new Set<ConformanceSourceEvent['type']>([
    'response_completed',
    'response_incomplete',
    'response_failed',
    'error',
    'refusal_delta',
    'refusal_done',
  ]);
  const terminalIndex = fixture.events.findIndex((event) =>
    terminalTypes.has(event.type),
  );
  if (terminalIndex >= 0 && terminalIndex !== fixture.events.length - 1) {
    semanticFailure(path, 'a terminal source event must be the final event');
  }

  if (fixture.source !== undefined) {
    const expectedOperation =
      fixture.source.operation === 'close' ? 'return' : fixture.source.operation;
    const expectedError =
      'error' in fixture.expected ? fixture.expected.error : undefined;
    if (
      expectedError?.code !== 'source_error' ||
      expectedError.source_operation !== expectedOperation
    ) {
      semanticFailure(
        path,
        `source ${fixture.source.operation} failure must expect source operation ${expectedOperation}`,
      );
    }
    if (
      fixture.source.operation === 'next' &&
      fixture.source.after_events > fixture.events.length
    ) {
      semanticFailure(path, 'source next failure cannot follow unavailable events');
    }
  }

  const views = [
    ...fixture.expected.snapshots,
    ...('result' in fixture.expected ? [fixture.expected.result] : []),
  ];
  let priorRevision = -1;
  for (const [viewIndex, view] of views.entries()) {
    if (view.media !== fixture.media) {
      semanticFailure(path, `expected view ${viewIndex} uses media ${view.media}`);
    }
    if (viewIndex < fixture.expected.snapshots.length) {
      if (view.revision <= priorRevision) {
        semanticFailure(path, 'snapshot revisions must be strictly increasing');
      }
      priorRevision = view.revision;
    }
    for (const [recordIndex, record] of view.records.entries()) {
      if (record.order !== recordIndex) {
        semanticFailure(path, `view ${viewIndex} record orders must be contiguous`);
      }
      if (record.kind !== 'mask') continue;
      const mask = record.mask as {
        readonly width: number;
        readonly height: number;
        readonly decoded: {
          readonly length: number;
          readonly runs: readonly { readonly value: number; readonly length: number }[];
        };
        readonly raster: readonly number[];
        readonly coco_rle: {
          readonly size: readonly number[];
          readonly counts: string;
        };
        readonly svg_path: string;
      };
      const decodedLength = mask.decoded.runs.reduce(
        (total, run) => total + run.length,
        0,
      );
      if (
        mask.decoded.length !== mask.width * mask.height ||
        decodedLength !== mask.decoded.length
      ) {
        semanticFailure(
          path,
          `view ${viewIndex} mask ${recordIndex} has inconsistent decoded length`,
        );
      }
      for (let index = 1; index < mask.decoded.runs.length; index += 1) {
        if (mask.decoded.runs[index - 1]!.value === mask.decoded.runs[index]!.value) {
          semanticFailure(
            path,
            `view ${viewIndex} mask ${recordIndex} has adjacent equal runs`,
          );
        }
      }
      const expanded = mask.decoded.runs.flatMap((run) =>
        Array<number>(run.length).fill(run.value),
      );
      if (
        mask.raster.length !== mask.width * mask.height ||
        JSON.stringify(mask.raster) !== JSON.stringify(expanded)
      ) {
        semanticFailure(
          path,
          `view ${viewIndex} mask ${recordIndex} has inconsistent raster`,
        );
      }
      if (
        mask.coco_rle.size.length !== 2 ||
        mask.coco_rle.size[0] !== mask.height ||
        mask.coco_rle.size[1] !== mask.width
      ) {
        semanticFailure(
          path,
          `view ${viewIndex} mask ${recordIndex} has inconsistent COCO size`,
        );
      }
      const identity = record.identity as {
        readonly media: Media;
        readonly frame_index: number | null;
        readonly object_id: string;
      };
      if (
        identity.media !== view.media ||
        identity.frame_index !== record.frame_index ||
        identity.object_id !== record.object_id
      ) {
        semanticFailure(
          path,
          `view ${viewIndex} mask ${recordIndex} has inconsistent identity`,
        );
      }
    }
  }
}

export function parseConformanceCase(
  source: string,
  path: string,
  schema: unknown = conformanceCaseSchema,
): ConformanceCase {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Conformance case ${path} is not valid JSON.`, { cause: error });
  }
  const issues = validateAgainstSchema(
    value,
    schema as boolean | { readonly [key: string]: unknown },
  );
  if (issues.length > 0) {
    const detail = issues
      .slice(0, 8)
      .map(
        (issue) =>
          `${issue.instancePath || '/'} ${issue.message} (${issue.schemaPath})`,
      )
      .join('; ');
    throw new Error(`Conformance case ${path} failed schema validation: ${detail}`);
  }
  const fixture = value as ConformanceCase;
  assertSemanticContract(fixture, path);
  return fixture;
}

export async function discoverConformanceCases(
  directory: URL = casesDirectory,
): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const unsupported = entries.filter(
    (entry) => !entry.isFile() || !entry.name.endsWith('.json'),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Conformance cases directory contains unsupported entries: ${unsupported
        .map((entry) => entry.name)
        .sort()
        .join(', ')}`,
    );
  }
  return entries
    .map((entry) => new URL(entry.name, directory))
    .sort((left, right) => left.pathname.localeCompare(right.pathname));
}

export async function loadConformanceCases(
  directory: URL = casesDirectory,
): Promise<ConformanceCase[]> {
  const urls = await discoverConformanceCases(directory);
  if (urls.length === 0) throw new Error('No shared conformance cases were found.');
  const fixtures = await Promise.all(
    urls.map(async (url) => {
      const fixture = parseConformanceCase(await readFile(url, 'utf8'), url.pathname);
      const expectedFilename = `${fixture.name}.json`;
      if (basename(fileURLToPath(url)) !== expectedFilename) {
        throw new Error(
          `Conformance case ${url.pathname} must be named ${expectedFilename}.`,
        );
      }
      return fixture;
    }),
  );
  const names = new Set<string>();
  for (const fixture of fixtures) {
    if (names.has(fixture.name)) {
      throw new Error(`Duplicate conformance case name: ${fixture.name}`);
    }
    names.add(fixture.name);
  }
  return fixtures;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported conformance source event: ${JSON.stringify(value)}`);
}

function toResponsesEvent(
  event: ConformanceSourceEvent,
  chunks: readonly string[],
): ResponsesEvent {
  switch (event.type) {
    case 'output_text_delta':
      return {
        type: 'response.output_text.delta',
        ...event.lane,
        delta: chunks[event.chunk]!,
      } as unknown as ResponsesEvent;
    case 'output_text_done':
      return {
        type: 'response.output_text.done',
        ...event.lane,
        text: event.text,
      } as unknown as ResponsesEvent;
    case 'content_part_done':
      return {
        type: 'response.content_part.done',
        ...event.lane,
        part:
          event.part_type === 'refusal'
            ? { type: 'refusal', refusal: event.text }
            : { type: event.part_type, text: event.text },
      } as unknown as ResponsesEvent;
    case 'response_completed':
      return { type: 'response.completed' };
    case 'response_incomplete':
      return {
        type: 'response.incomplete',
        response: {
          ...(event.detail === undefined
            ? {}
            : { incomplete_details: { reason: event.detail } }),
        },
      };
    case 'response_failed':
      return {
        type: 'response.failed',
        response: { error: { message: event.message } },
      };
    case 'error':
      return { type: 'error', message: event.message };
    case 'refusal_delta':
      return {
        type: 'response.refusal.delta',
        ...event.lane,
        delta: event.text,
      } as unknown as ResponsesEvent;
    case 'refusal_done':
      return {
        type: 'response.refusal.done',
        ...event.lane,
        refusal: event.text,
      } as unknown as ResponsesEvent;
    default:
      return assertNever(event);
  }
}

function sourceEvents(fixture: ConformanceCase): AsyncIterable<ResponsesEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<ResponsesEvent> {
      const directive = fixture.source;
      if (directive?.operation === 'iterator') {
        throw new Error(directive.message);
      }
      let index = 0;
      return {
        async next(): Promise<IteratorResult<ResponsesEvent>> {
          if (directive?.operation === 'next' && index === directive.after_events) {
            throw new Error(directive.message);
          }
          const event = fixture.events[index];
          if (event === undefined) {
            return { done: true, value: undefined };
          }
          index += 1;
          return { done: false, value: toResponsesEvent(event, fixture.chunks) };
        },
        async return(): Promise<IteratorResult<ResponsesEvent>> {
          if (directive?.operation === 'close') {
            throw new Error(directive.message);
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function normalizeLane(lane: OutputTextLane | undefined): ConformanceLane | null {
  return lane === undefined
    ? null
    : {
        item_id: lane.item_id,
        output_index: lane.output_index,
        content_index: lane.content_index,
      };
}

function normalizeDecodedMask(bytes: Uint8Array): Record<string, unknown> {
  const runs: Array<{ value: number; length: number }> = [];
  for (const value of bytes) {
    const prior = runs.at(-1);
    if (prior?.value === value) prior.length += 1;
    else runs.push({ value, length: 1 });
  }
  return { length: bytes.length, runs };
}

function normalizeRecord(
  record: SegmentationRecord,
  media: Media,
): Record<string, unknown> {
  switch (record.kind) {
    case 'text':
      return { kind: record.kind, order: record.order, text: record.text };
    case 'box':
      return {
        kind: record.kind,
        order: record.order,
        object_id: record.objectId,
        frame_index: record.frame?.frameIndex ?? null,
        left: record.left,
        top: record.top,
        right: record.right,
        bottom: record.bottom,
        ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
      };
    case 'mask':
      return {
        kind: record.kind,
        order: record.order,
        object_id: record.objectId,
        frame_index: record.frame?.frameIndex ?? null,
        identity: {
          media,
          frame_index: record.frame?.frameIndex ?? null,
          object_id: record.objectId,
        },
        revision: record.revision,
        mask: {
          encoding: record.mask.encoding,
          payload: record.mask.payload,
          width: record.mask.width,
          height: record.mask.height,
          decoded: normalizeDecodedMask(decodeMaskToRaster(record.mask)),
          raster: [...decodeMaskToRaster(record.mask)],
          coco_rle: decodeMaskToRLE(record.mask),
          svg_path: decodeMaskToSVGPath(record.mask),
        },
        bounds: {
          left: record.bounds.left,
          top: record.bounds.top,
          right: record.bounds.right,
          bottom: record.bounds.bottom,
        },
        ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
      };
    default:
      return assertNever(record);
  }
}

function normalizeDiagnostic(
  diagnostic: SegmentationDiagnostic,
): Record<string, unknown> {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
    raw: diagnostic.raw,
  };
}

function normalizeView(view: SegmentationSnapshot): NormalizedView {
  return {
    media: view.media,
    revision: view.revision,
    records: view.records.map((record) => normalizeRecord(record, view.media)),
    diagnostics: view.diagnostics.map(normalizeDiagnostic),
    raw_output: view.rawOutput,
  };
}

function normalizeResult(result: SegmentationResult): NormalizedResult {
  return {
    ...normalizeView(result),
    outcome: { ...result.outcome },
  };
}

function normalizeError(error: unknown): NormalizedTerminalError {
  if (!(error instanceof ResponsesStreamError)) throw error;
  const normalized: {
    code: string;
    message: string;
    expected_lane?: ConformanceLane | null;
    received_lane?: ConformanceLane | null;
    source_operation?: string;
  } = { code: error.code, message: error.message };
  if (error instanceof ResponsesStreamLaneError) {
    normalized.expected_lane = normalizeLane(error.expected);
    normalized.received_lane = normalizeLane(error.received);
  }
  if (error instanceof ResponsesStreamSourceError) {
    normalized.source_operation = error.operation;
  }
  return normalized;
}

export async function runConformanceCase(
  fixture: ConformanceCase,
): Promise<NormalizedExecution> {
  const stream =
    fixture.media === 'image'
      ? parseResponsesStream(sourceEvents(fixture), formats.segmentation.image())
      : parseResponsesStream(sourceEvents(fixture), formats.segmentation.video());
  const snapshots: NormalizedView[] = [];
  let iterationError: unknown;
  try {
    for await (const snapshot of stream) snapshots.push(normalizeView(snapshot));
  } catch (error) {
    iterationError = error;
  }

  if (iterationError !== undefined) {
    const finalError = await stream.finalResult.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (finalError !== iterationError) {
      throw new Error(
        'Iteration and finalResult did not report the same terminal error.',
      );
    }
    return { snapshots, error: normalizeError(iterationError) };
  }

  return { snapshots, result: normalizeResult(await stream.finalResult) };
}
