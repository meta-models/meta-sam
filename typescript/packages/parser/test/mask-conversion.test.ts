/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, test } from 'vitest';

import * as parser from '../src/index.js';
import { decode } from '../src/coco-rle.js';
import { encodeSegmentationMask } from '../src/mask-codec.js';
import {
  InvalidSegmentationMaskError,
  decodeMaskToRaster,
  decodeMaskToRLE,
  decodeMaskToSVGPath,
  type RLEObject,
  type SegmentationMask,
} from '../src/index.js';

interface ShapeGolden {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly raster: readonly number[];
  readonly rle: RLEObject;
  readonly svg: string;
}

const shapes: readonly ShapeGolden[] = [
  {
    name: 'empty',
    width: 4,
    height: 4,
    raster: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    rle: { size: [4, 4], counts: '`0' },
    svg: '',
  },
  {
    name: 'single pixel',
    width: 2,
    height: 2,
    raster: [1, 0, 0, 0],
    rle: { size: [2, 2], counts: '013' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L0 0.5Z',
  },
  {
    name: 'filled',
    width: 2,
    height: 2,
    raster: [1, 1, 1, 1],
    rle: { size: [2, 2], counts: '04' },
    svg: 'M-0.5 0L0 -0.5L1 -0.5L1.5 0L1.5 1L1 1.5L0 1.5L-0.5 1Z',
  },
  {
    name: 'full column',
    width: 2,
    height: 4,
    raster: [1, 0, 1, 0, 1, 0, 1, 0],
    rle: { size: [4, 2], counts: '044' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L0.5 1L0.5 2L0.5 3L0 3.5L-0.5 3L-0.5 2L-0.5 1Z',
  },
  {
    name: 'disconnected',
    width: 1,
    height: 6,
    raster: [1, 1, 0, 0, 1, 1],
    rle: { size: [6, 1], counts: '0220' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L0.5 1L0 1.5L-0.5 1ZM-0.5 4L0 3.5L0.5 4L0.5 5L0 5.5L-0.5 5Z',
  },
  {
    name: 'L',
    width: 3,
    height: 3,
    raster: [1, 0, 0, 1, 0, 0, 1, 1, 1],
    rle: { size: [3, 3], counts: '032N00' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L0.5 1L1 1.5L2 1.5L2.5 2L2 2.5L1 2.5L0 2.5L-0.5 2L-0.5 1Z',
  },
  {
    name: 'diagonal',
    width: 3,
    height: 3,
    raster: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    rle: { size: [3, 3], counts: '013000' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L1 0.5L1.5 1L2 1.5L2.5 2L2 2.5L1.5 2L1 1.5L0.5 1L0 0.5Z',
  },
  {
    name: 'checkerboard',
    width: 2,
    height: 2,
    raster: [1, 0, 0, 1],
    rle: { size: [2, 2], counts: '0120' },
    svg: 'M-0.5 0L0 -0.5L0.5 0L1 0.5L1.5 1L1 1.5L0.5 1L0 0.5Z',
  },
];

function maskFromRaster(golden: ShapeGolden): SegmentationMask {
  return encodeSegmentationMask(
    Uint8Array.from(golden.raster),
    golden.width,
    golden.height,
  );
}

describe('mask conversion APIs', () => {
  test.each(shapes)('$name has exact raster, COCO RLE, and SVG output', (golden) => {
    const mask = maskFromRaster(golden);
    expect([...decodeMaskToRaster(mask)]).toEqual(golden.raster);
    expect(decodeMaskToRLE(mask)).toEqual(golden.rle);
    expect(decodeMaskToSVGPath(mask)).toBe(golden.svg);
  });

  test('transposes an asymmetric row-major 6x3 raster before COCO encoding', () => {
    const raster = [0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1];
    const mask = encodeSegmentationMask(Uint8Array.from(raster), 3, 6);
    const rle = decodeMaskToRLE(mask);
    expect(rle).toEqual({ size: [6, 3], counts: '543OON' });

    const columnMajor = decode(rle).data;
    const roundTrip = new Uint8Array(raster.length);
    for (let row = 0; row < mask.height; row += 1) {
      for (let col = 0; col < mask.width; col += 1) {
        roundTrip[row * mask.width + col] = columnMajor[col * mask.height + row]!;
      }
    }
    expect([...roundTrip]).toEqual(raster);
  });

  test('one_bit and lossless encodings of one raster convert identically', () => {
    const raster = Uint8Array.from([0, 0, 1, 1, 0, 1]);
    const oneBit = encodeSegmentationMask(raster, 3, 2);
    const lossless: SegmentationMask = {
      encoding: 'lossless',
      payload: '~!!!!.!0^zlTde]:)]`W',
      width: 3,
      height: 2,
    };
    expect(decodeMaskToRaster(oneBit)).toEqual(decodeMaskToRaster(lossless));
    expect(decodeMaskToRLE(oneBit)).toEqual(decodeMaskToRLE(lossless));
    expect(decodeMaskToSVGPath(oneBit)).toBe(decodeMaskToSVGPath(lossless));
  });

  test('all conversions reject a malformed SAM mask consistently', () => {
    const malformed: SegmentationMask = {
      encoding: 'one_bit',
      payload: '!',
      width: 1,
      height: 1,
    };
    const messages = [decodeMaskToRaster, decodeMaskToRLE, decodeMaskToSVGPath].map(
      (convert) => {
        try {
          convert(malformed);
          throw new Error('Expected conversion to fail.');
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidSegmentationMaskError);
          return (error as Error).message;
        }
      },
    );
    expect(new Set(messages)).toEqual(
      new Set(['Mask payload is missing its length prefix.']),
    );
  });

  test('exports conversion APIs and their type from the package root only', () => {
    const rle: RLEObject = { size: [1, 1], counts: '1' };
    expect(rle.size).toEqual([1, 1]);
    expect(parser).toMatchObject({
      decodeMaskToRaster,
      decodeMaskToRLE,
      decodeMaskToSVGPath,
    });
    expect(parser).not.toHaveProperty(['decode', 'Segmentation', 'Mask'].join(''));
  });
});
