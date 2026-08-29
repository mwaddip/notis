import { describe, it, expect } from 'vitest';
import { BOX_VALUE_BOUND, PROTOCOL_VERSION, writeVlqU64OrThrow, ByteWriter } from '@dagsocial/types';

import { jsonToTx } from '../../src/routes/json-to-tx.js';

/**
 * `jsonToTx` is the JSON edge, and a client-supplied box `value` copied through
 * it verbatim is a forgery lever. `value` is a bigint at runtime
 * (TYPES_INTERFACE → Value denomination), so this edge coerces a decimal string
 * or a safe-integer number to bigint and enforces
 * `0 <= value < BOX_VALUE_BOUND` — the accepted domain, which is narrower than
 * the encodable one (TYPES_INTERFACE → Box value domain).
 */
describe('jsonToTx box value validation (audit L-11, Spec B P0)', () => {
  const ownerHex = 'ab'.repeat(32);

  function rawTx(value: unknown): Record<string, unknown> {
    return {
      inputs: ['cd'.repeat(32)],
      outputs: [
        {
          boxType: 'karma',
          value,
          owner: ownerHex,
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  it('coerces a non-negative integer number to bigint', () => {
    const tx = jsonToTx(rawTx(42));
    const out = tx.outputs[0]!;
    expect(out.value).toBe(42n);
    // Hex fields are still decoded to raw bytes. Narrow on the discriminant
    // rather than asserting `owner` onto the union — three candidate members
    // (invite, bond, vouch) genuinely have no `owner`.
    if (out.boxType !== 'karma') throw new Error(`expected a karma candidate, got ${out.boxType}`);
    expect(Buffer.from(out.owner).toString('hex')).toBe(ownerHex);
  });

  it('coerces a decimal string to bigint (canonical wire form)', () => {
    expect(jsonToTx(rawTx('10')).outputs[0]!.value).toBe(10n);
  });

  it('coerces a decimal string above 2^53 without precision loss', () => {
    const big = (1n << 60n).toString();
    expect(jsonToTx(rawTx(big)).outputs[0]!.value).toBe(1n << 60n);
  });

  it('accepts a zero value (fully-spent change box)', () => {
    expect(jsonToTx(rawTx(0)).outputs[0]!.value).toBe(0n);
  });

  it('accepts a value just below BOX_VALUE_BOUND', () => {
    const max = (BOX_VALUE_BOUND - 1n).toString();
    expect(jsonToTx(rawTx(max)).outputs[0]!.value).toBe(BOX_VALUE_BOUND - 1n);
  });

  it('the stranded values ENCODE — this edge is narrower than the writer, deliberately', () => {
    // ⛔ **The rejections below say nothing about the encoder, and must not be
    // read as if they did** (TYPES_INTERFACE → Box value domain). `vlqU64` keeps
    // `[0, 2^64)`; only what consensus ACCEPTS narrowed. Without this, a suite
    // green after someone narrowed the writer instead would look identical —
    // and narrowing the writer moves every box id.
    for (const value of [BOX_VALUE_BOUND, (1n << 64n) - 1n]) {
      const w = new ByteWriter();
      expect(() => writeVlqU64OrThrow(w, value), String(value)).not.toThrow();
      expect(w.toBytes().length, String(value)).toBeGreaterThan(0);
    }
  });

  for (const [label, badValue] of [
    ['negative', -1],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    // Unsafe numbers have already lost precision — only strings carry >2^53.
    ['beyond MAX_SAFE_INTEGER as a number', Number.MAX_SAFE_INTEGER + 2],
    ['a negative string', '-5'],
    ['a fractional string', '1.5'],
    ['a non-decimal string', '0x10'],
    // The stranded band: accepted under the old bound, refused under this one.
    // `2^64` alone could not tell the two apart — it was refused either way.
    ['at BOX_VALUE_BOUND', BOX_VALUE_BOUND.toString()],
    ['inside the stranded band', ((1n << 64n) - 1n).toString()],
    ['at 2^64', (1n << 64n).toString()],
    ['null', null],
    ['missing', undefined],
  ] as const) {
    it(`rejects a ${label} value`, () => {
      expect(() => jsonToTx(rawTx(badValue))).toThrow(
        /box value must be a non-negative/,
      );
    });
  }

  it('rejects when any one output in a multi-output tx is invalid', () => {
    const raw = rawTx(100);
    (raw.outputs as Record<string, unknown>[]).push({
      boxType: 'karma',
      value: -2n,
      owner: ownerHex,
    });

    expect(() => jsonToTx(raw)).toThrow(/box value must be a non-negative/);
  });

  it('a JSON body carrying postWithdraw survives jsonToTx with the payload intact', () => {
    const postId = 'ff'.repeat(32);
    const raw = {
      ...rawTx(100),
      postWithdraw: { postId },
    };
    const tx = jsonToTx(raw);
    expect(tx.postWithdraw).toBeDefined();
    expect(tx.postWithdraw!.postId).toBe(postId);
  });
});
