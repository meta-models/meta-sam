/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { expect, test } from 'vitest';

type Assert<T extends true> = T;
type Compatibility = Assert<
  ResponseStreamEvent extends { readonly type: string } ? true : false
>;

test('OpenAI response stream events expose a string discriminator', () => {
  const compatibility: Compatibility = true;
  expect(compatibility).toBe(true);
});
