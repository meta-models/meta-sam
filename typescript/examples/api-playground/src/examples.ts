/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { MediaKind } from './model';

export interface MediaExample {
  readonly id: string;
  readonly kind: MediaKind;
  readonly title: string;
  readonly prompt: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Source duration in seconds; absent for stills. */
  readonly durationSeconds?: number;
}

/**
 * Real media checked into `public/media`, copied from the public
 * `facebookresearch/sam3` repository's `assets/` directory and distributed under
 * the same SAM License. Every example runs against the live API; there is no
 * canned output, so a configured key is required to segment.
 */
export const mediaExamples: readonly MediaExample[] = Object.freeze([
  {
    id: 'bedroom',
    kind: 'video',
    title: 'Bedroom',
    prompt: 'pillow',
    url: '/media/bedroom.mp4',
    width: 960,
    height: 540,
    durationSeconds: 6.7,
  },
  {
    id: 'truck',
    kind: 'image',
    title: 'Truck',
    prompt: 'wheel',
    url: '/media/truck.jpg',
    width: 1800,
    height: 1200,
  },
  {
    id: 'groceries',
    kind: 'image',
    title: 'Groceries',
    prompt: 'paper bag',
    url: '/media/groceries.jpg',
    width: 800,
    height: 534,
  },
]);

const exampleMap = new Map(mediaExamples.map((example) => [example.id, example]));

export function findMediaExample(
  id: string | null | undefined,
): MediaExample | undefined {
  return exampleMap.get(id ?? '');
}
