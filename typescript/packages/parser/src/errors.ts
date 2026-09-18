/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { OutputTextLane } from './types.js';

export interface ResponsesEventReference {
  readonly type: string;
}

export class ResponsesStreamError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ResponsesStreamConsumedError extends ResponsesStreamError {
  public constructor() {
    super('A parsed response stream can be iterated only once.', 'stream_consumed');
  }
}

export class ResponsesStreamAbortedError extends ResponsesStreamError {
  public constructor() {
    super(
      'The parsed response stream was abandoned before completion.',
      'stream_aborted',
    );
  }
}

export class ResponsesStreamFailedError extends ResponsesStreamError {
  public constructor(
    message: string,
    public readonly event: ResponsesEventReference,
  ) {
    super(message, 'response_failed');
  }
}

export class ResponsesStreamEventError extends ResponsesStreamError {
  public constructor(
    message: string,
    public readonly event: ResponsesEventReference,
  ) {
    super(message, 'response_error');
  }
}

export class ResponsesStreamLaneError extends ResponsesStreamError {
  public constructor(
    message: string,
    public readonly expected: OutputTextLane | undefined,
    public readonly received: OutputTextLane | undefined,
  ) {
    super(message, 'response_lane');
  }
}

export class ResponsesStreamRefusalError extends ResponsesStreamError {
  public constructor(
    message: string,
    public readonly event: ResponsesEventReference,
  ) {
    super(message, 'response_refusal');
  }
}

export class ResponsesStreamParserError extends ResponsesStreamError {
  public constructor(cause: unknown) {
    super('The response format parser failed.', 'parser_error', { cause });
  }
}

export class ResponsesStreamSourceError extends ResponsesStreamError {
  public constructor(
    public readonly operation: 'iterator' | 'next' | 'return',
    cause: unknown,
    public readonly priorError?: unknown,
  ) {
    super(`The Responses event source failed during ${operation}.`, 'source_error', {
      cause,
    });
  }
}

export class InvalidSegmentationMaskError extends ResponsesStreamError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'invalid_mask_payload', options);
  }
}
