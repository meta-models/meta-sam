/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { SegmentationMask } from './segmentation.js';
import { DataArray, encode, type RLEObject } from './coco-rle.js';
import { decodeMaskToRaster } from './mask-codec.js';
import { decodeToSVGPath } from './svg-path.js';

export function decodeMaskToRLE(mask: SegmentationMask): RLEObject {
  const raster = decodeMaskToRaster(mask);
  const { height, width } = mask;
  const coco = new Uint8Array(raster.length);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      coco[col * height + row] = raster[row * width + col]!;
    }
  }
  const encoded = encode(new DataArray(coco, [height, width]));
  if (Array.isArray(encoded)) {
    throw new Error('COCO encoding returned multiple masks for one raster.');
  }
  return encoded;
}

export function decodeMaskToSVGPath(mask: SegmentationMask): string {
  const paths = decodeToSVGPath(decodeMaskToRLE(mask));
  if (paths.length !== 1) {
    throw new Error('SVG conversion returned multiple paths for one mask.');
  }
  return paths[0]!;
}
