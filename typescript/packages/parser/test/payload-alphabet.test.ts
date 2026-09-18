/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  InvalidSegmentationMaskError,
  decodeMaskToRaster,
  parseImageStream,
  type ResponsesEvent,
} from '@meta-sam/parser';
import { encodeSegmentationMask } from '../src/mask-codec.js';

/**
 * The documented base85 digits: printable ASCII from `!` through `{` minus the
 * seven wire delimiters. protocol/sam3.md quotes this string verbatim. `}` and
 * `~` are never digits; `~` is only the lossless marker.
 */
const DOCUMENTED_DIGITS =
  "!#$%&'()*+-./0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{";
const WIRE_DELIMITERS = ['"', '\\', ',', ';', '<', '>', '|'];

function payloadCharacters(): Set<string> {
  const seen = new Set<string>();
  // Enough distinct rasters to exercise the whole alphabet: every 8-bit pattern
  // in a 3-row raster plus a few large runs.
  for (let seed = 0; seed < 4_000; seed += 1) {
    const width = 8 + (seed % 13);
    const height = 3 + (seed % 7);
    const raster = new Uint8Array(width * height);
    let state = (seed * 2654435761) >>> 0 || 1;
    for (let index = 0; index < raster.length; index += 1) {
      // xorshift32
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raster[index] = state & 1;
    }
    for (const character of encodeSegmentationMask(raster, width, height).payload) {
      seen.add(character);
    }
  }
  return seen;
}

describe('mask payload alphabet', () => {
  it('is base85 over printable ASCII `!`..`{` minus the wire delimiters', () => {
    expect(DOCUMENTED_DIGITS).toHaveLength(85);
    const expected = [];
    for (let code = 0x21; code <= 0x7b; code += 1) {
      const character = String.fromCharCode(code);
      if (!WIRE_DELIMITERS.includes(character)) expected.push(character);
    }
    expect(expected.join('')).toBe(DOCUMENTED_DIGITS);
  });

  it('matches the encoder: every digit is emitted, and nothing outside the digits is', () => {
    const seen = payloadCharacters();
    // Every one_bit payload starts with the `!` marker, which is also digit 0.
    expect([...seen].sort().join('')).toBe([...DOCUMENTED_DIGITS].sort().join(''));
    for (const character of [...WIRE_DELIMITERS, '}', '~']) {
      expect(seen.has(character)).toBe(false);
    }
    // The payload really does use the regex- and shell-hostile characters the
    // docs warn about, so `|>` is the only safe terminator.
    for (const hostile of [
      '*',
      '$',
      '(',
      ')',
      '[',
      ']',
      '{',
      '^',
      '?',
      '+',
      '.',
      '`',
    ]) {
      expect(seen.has(hostile)).toBe(true);
    }
  });

  it('rejects a delimiter or non-digit character inside a payload', () => {
    const mask = encodeSegmentationMask(new Uint8Array(25).fill(1), 5, 5);
    for (const bad of [...WIRE_DELIMITERS, '}', '~', ' ', 'é']) {
      const payload = `${mask.payload.slice(0, 6)}${bad}${mask.payload.slice(7)}`;
      expect(() => decodeMaskToRaster({ ...mask, payload })).toThrow(
        InvalidSegmentationMaskError,
      );
    }
  });

  it('reads a lossless payload whose digits include ! without confusion', async () => {
    // From the public docs' example line: `~` marker, then `!!!!M` length
    // prefix, then a body that itself contains `!` as digit zero.
    const payload = "~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(";
    const text = `<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|><|mask;x=0;y=0;data=27,60,${payload}|>\n`;
    async function* events(): AsyncIterable<ResponsesEvent> {
      const lane = { item_id: 'm', output_index: 0, content_index: 0 };
      yield { type: 'response.output_text.delta', ...lane, delta: text };
      yield { type: 'response.output_text.done', ...lane, text };
      yield { type: 'response.completed' };
    }
    const result = await parseImageStream(events()).finalResult;
    expect(result.diagnostics).toEqual([]);
    expect(result.records[1]).toMatchObject({
      kind: 'mask',
      mask: { encoding: 'lossless', payload, width: 60, height: 27 },
    });
  });

  it('is quoted verbatim by the protocol document and named by the READMEs', async () => {
    const root = new URL('../../../../', import.meta.url);
    const protocol = await readFile(new URL('protocol/sam3.md', root), 'utf8');
    expect(protocol).toContain(`\n${DOCUMENTED_DIGITS}\n`);
    for (const relative of [
      'typescript/packages/parser/README.md',
      'typescript/packages/graphics/README.md',
      'python/README.md',
    ]) {
      const readme = await readFile(new URL(relative, root), 'utf8');
      expect(readme, relative).toMatch(/base85/);
    }
  });
});
