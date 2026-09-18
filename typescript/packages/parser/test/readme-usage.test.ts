/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  ResponsesStreamAbortedError,
  ResponsesStreamConsumedError,
  decodeMaskToRaster,
  decodeMaskToRLE,
  decodeMaskToSVGPath,
  frameIndexOf,
  parseImageStream,
  parseVideoStream,
  recordsOfKind,
  type ResponsesEvent,
  type VideoSegmentationResult,
  type VideoSegmentationSnapshot,
} from '@meta-sam/parser';

// The README quick-start input: frame 0 of a 320×334 clip, two objects, as the
// SAM API emits it. Keep this identical to the README so the comments there
// stay true.
const outputText =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>' +
  '<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';

async function* responseEvents(
  text = outputText,
  split = text.indexOf(',1<|box'),
): AsyncIterable<ResponsesEvent> {
  yield {
    type: 'response.output_text.delta',
    item_id: 'message-1',
    output_index: 0,
    content_index: 0,
    delta: text.slice(0, split),
  };
  yield {
    type: 'response.output_text.delta',
    item_id: 'message-1',
    output_index: 0,
    content_index: 0,
    delta: text.slice(split),
  };
  yield {
    type: 'response.output_text.done',
    item_id: 'message-1',
    output_index: 0,
    content_index: 0,
    text,
  };
  yield { type: 'response.completed' };
}

async function readmeExampleMatchesReadme(): Promise<void> {
  const readme = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../README.md', import.meta.url), 'utf8'),
  );
  for (const fragment of [
    "'<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +",
    ",1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>' +",
    "data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>",
    'data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>',
  ]) {
    expect(readme).toContain(fragment);
  }
}

describe('README usage', () => {
  it('uses the same SAM API output text as the README', async () => {
    await readmeExampleMatchesReadme();
  });

  it('parses one API frame into two box and two mask records', async () => {
    const parsed = parseVideoStream(responseEvents());

    const snapshots: VideoSegmentationSnapshot[] = [];
    for await (const snapshot of parsed) snapshots.push(snapshot);

    const result: VideoSegmentationResult = await parsed.finalResult;
    // The line is complete only after the second delta, so one snapshot.
    expect(snapshots.map((snapshot) => snapshot.records.length)).toEqual([4]);
    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.diagnostics).toEqual([]);
    expect(result.records.map((record) => record.kind)).toEqual([
      'box',
      'mask',
      'box',
      'mask',
    ]);
    expect(
      result.records.map((record) => (record.kind === 'text' ? null : record.objectId)),
    ).toEqual(['0', '0', '1', '1']);
    expect(result.records.map(frameIndexOf)).toEqual([0, 0, 0, 0]);

    const [firstBox] = recordsOfKind(result.records, 'box');
    // Inclusive wire corners become half-open bounds.
    expect(firstBox).toMatchObject({ left: 211, top: 228, right: 271, bottom: 255 });

    const [maskRecord, secondMask] = recordsOfKind(result.records, 'mask');
    if (maskRecord === undefined || secondMask === undefined) {
      throw new Error('Expected two mask records.');
    }
    expect(maskRecord.identity).toBe('video:0:0');
    expect(maskRecord.mask).toEqual({
      encoding: 'lossless',
      width: 60,
      height: 27,
      payload: "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(",
    });
    expect(maskRecord.bounds).toEqual({ left: 211, top: 228, right: 271, bottom: 255 });

    const raster = decodeMaskToRaster(maskRecord.mask);
    expect(raster.length).toBe(27 * 60);
    expect(raster.every((value) => value === 0 || value === 1)).toBe(true);
    expect(raster.reduce((sum, value) => sum + value, 0)).toBe(1539);
    expect(decodeMaskToRLE(maskRecord.mask).size).toEqual([27, 60]);
    expect(decodeMaskToSVGPath(maskRecord.mask)).toMatch(/^M.*Z$/);

    expect(secondMask.mask).toMatchObject({
      encoding: 'lossless',
      width: 48,
      height: 27,
    });
    expect(decodeMaskToRaster(secondMask.mask).length).toBe(27 * 48);
  });

  it('accepts the same line as a single image at frame zero', async () => {
    const result = await parseImageStream(responseEvents()).finalResult;
    expect(result.diagnostics).toEqual([]);
    expect(result.records).toHaveLength(4);
    expect(result.records.every((record) => frameIndexOf(record) === undefined)).toBe(
      true,
    );
  });

  it('reads sparse frame indexes from the wire instead of counting lines', async () => {
    const text = outputText + outputText.replace('<0f>', '<2f>');
    const result = await parseVideoStream(responseEvents(text, text.indexOf('<2f>')))
      .finalResult;
    expect(result.diagnostics).toEqual([]);
    expect([...new Set(result.records.map(frameIndexOf))]).toEqual([0, 2]);
  });

  it('treats an empty lane as a completed response with no records', async () => {
    const result = await parseImageStream(responseEvents('', 0)).finalResult;
    expect(result.outcome).toEqual({ status: 'completed' });
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('supports final-only consumption and rejects a later iterator', async () => {
    const parsed = parseVideoStream(responseEvents());

    await expect(parsed.finalResult).resolves.toMatchObject({
      outcome: { status: 'completed' },
      records: [{ kind: 'box' }, { kind: 'mask' }, { kind: 'box' }, { kind: 'mask' }],
    });
    expect(() => parsed[Symbol.asyncIterator]()).toThrow(ResponsesStreamConsumedError);
  });

  it('rejects the final result when snapshot iteration stops early', async () => {
    const parsed = parseVideoStream(responseEvents());

    for await (const _snapshot of parsed) break;

    await expect(parsed.finalResult).rejects.toBeInstanceOf(
      ResponsesStreamAbortedError,
    );
  });
});
