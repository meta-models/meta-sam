/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { expect, test } from 'vitest';

import {
  buildObjectPrompt,
  ObjectPromptError,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from '../src/index.js';

const lane = { item_id: 'message-1', output_index: 0, content_index: 0 };

async function* events(text: string): AsyncIterable<ResponsesEvent> {
  yield { type: 'response.output_text.delta', ...lane, delta: text };
  yield { type: 'response.output_text.done', ...lane, text };
  yield { type: 'response.completed' };
}

test('a parsed box record and its object id prompt the same box', async () => {
  const box = '<|box;x1=3;y1=4;x2=7;y2=8;w=20;h=10|>';
  const parsed = parseImageStream(
    events(`<0f>4${box}<|mask;x=0;y=0;data=5,5,!!!!!(QO(0lu8?|>\n`),
  );
  const result = await parsed.finalResult;
  const [record] = recordsOfKind(result.records, 'box');
  expect(record).toBeDefined();
  const text = buildObjectPrompt({
    size: { width: 20, height: 10 },
    objects: [{ id: record!.objectId, prompts: [{ box: record! }] }],
  });
  expect(text).toBe(`<0f>4${box}`);
});

test('the README example builds the documented text', () => {
  const text = buildObjectPrompt({
    size: { width: 640, height: 480 },
    objects: [
      {
        id: 1,
        prompts: [
          { frame: 30, box: { left: 10, top: 20, right: 40, bottom: 60 } },
          {
            frame: 120,
            points: [
              { x: 20, y: 40 },
              { x: 30, y: 50, label: 'negative' },
            ],
          },
        ],
      },
      {
        id: 2,
        prompts: [{ frame: 120, box: { left: 5, top: 5, right: 30, bottom: 30 } }],
      },
    ],
  });
  expect(text).toBe(
    '<30f>1<|box;x1=10;y1=20;x2=39;y2=59;w=640;h=480|><120f>1<|point;x=20;y=40;w=640;h=480|>' +
      '-<|point;x=30;y=50;w=640;h=480|>,2<|box;x1=5;y1=5;x2=29;y2=29;w=640;h=480|>',
  );
});

test('errors carry their code and the class name', () => {
  let thrown: unknown;
  try {
    buildObjectPrompt({ size: { width: 640, height: 480 }, objects: [] });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ObjectPromptError);
  expect(thrown).toMatchObject({ name: 'ObjectPromptError', code: 'no_objects' });
});
