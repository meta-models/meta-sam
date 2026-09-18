/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export class SegmentationGraphicsError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnsupportedMaskEncodingError extends SegmentationGraphicsError {
  public constructor(public readonly encoding: string) {
    super(`Unsupported complete mask encoding: ${encoding}.`, 'unsupported_encoding');
  }
}

export class InvalidMaskPayloadError extends SegmentationGraphicsError {
  public constructor(message: string) {
    super(message, 'invalid_mask_payload');
  }
}

export class SegmentationResourceLimitError extends SegmentationGraphicsError {
  public constructor(public readonly limit: string) {
    super(`Segmentation rendering exceeded the ${limit} limit.`, 'resource_limit');
  }
}

export class InvalidRenderOptionsError extends SegmentationGraphicsError {
  public constructor(message: string) {
    super(message, 'invalid_render_options');
  }
}

export class RendererDisposedError extends SegmentationGraphicsError {
  public constructor() {
    super('The segmentation renderer has been disposed.', 'renderer_disposed');
  }
}

export class Path2DUnavailableError extends SegmentationGraphicsError {
  public constructor() {
    super('Path2D is unavailable in this environment.', 'path2d_unavailable');
  }
}
