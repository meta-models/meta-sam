/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

export {
  InvalidMaskPayloadError,
  InvalidRenderOptionsError,
  Path2DUnavailableError,
  RendererDisposedError,
  SegmentationGraphicsError,
  SegmentationResourceLimitError,
  UnsupportedMaskEncodingError,
} from './errors.js';
export { SegmentationRenderer, objectColor } from './renderer.js';
export type {
  ImageRenderOptions,
  MaskOutlineOptions,
  Rectangle,
  SegmentationCanvasContext,
  SegmentationRendererOptions,
  SegmentationRenderOptions,
  SegmentationUpdateOptions,
  VideoFrameCompositionContext,
  VideoFrameCompositionOptions,
  VideoFrameFit,
  VideoRenderOptions,
} from './renderer.js';
