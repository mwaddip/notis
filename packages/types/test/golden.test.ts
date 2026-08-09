/**
 * The golden-vector suite — the corpus in `test/golden/*.json`, run.
 *
 * Every vector is asserted in both directions and every decode goes through
 * `decodeStruct`, so the four-part boundary check (spec §2.1) covers even a
 * one-byte fixture. See `test/golden/README.md` for the file format.
 */

import { describe, expect, it } from 'vitest';
import { ReaderError } from '@dagsocial/wire';
import { CodecError, decodeStruct, encodeStruct } from '../src/codec.js';
import {
  type GoldenVector,
  type RejectVector,
  asStruct,
  assertBytes,
  describeCodec,
  hex,
  loadRejects,
  loadVectors,
  resolveCodec,
} from './golden/harness.js';
import './golden/probe.js'; // registers the `probe` struct codec

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

const FILES = ['primitives.json', 'probe.json'] as const;

function runVectors(file: string, vectors: GoldenVector[]): void {
  describe(file, () => {
    it('is non-empty and has unique names', () => {
      expect(vectors.length).toBeGreaterThan(0);
      expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    });

    for (const v of vectors) {
      const codec = resolveCodec(v.codec);
      const struct = asStruct(describeCodec(v.codec), codec);
      const expected = hex(v.bytes);
      const value = v.raw === true ? v.value : codec.parse(v.value);

      it(`${v.name} — encodes to ${v.bytes.length / 2} byte(s)`, () => {
        assertBytes(encodeStruct(struct, value), expected, `golden "${v.name}"`);
      });

      if (v.decode === false) {
        // Sentinel vectors: the bytes are what a malformed value encodes to,
        // and they must NOT decode back into anything. That one-wayness is
        // what keeps a malformed value from round-tripping as if it were fine.
        it(`${v.name} — the sentinel does not decode back`, () => {
          expect(() => decodeStruct(struct, expected)).toThrow(ReaderError);
        });
        continue;
      }

      it(`${v.name} — decodes back to the same value`, () => {
        expect(decodeStruct(struct, expected)).toEqual(value);
      });
    }
  });
}

for (const file of FILES) {
  runVectors(file, loadVectors(file));
}

// ---------------------------------------------------------------------------
// Rejections — the corpus's other half
// ---------------------------------------------------------------------------

function runRejects(file: string, rejects: RejectVector[]): void {
  describe(`${file} — rejections`, () => {
    it('is non-empty and has unique names', () => {
      expect(rejects.length).toBeGreaterThan(0);
      expect(new Set(rejects.map((r) => r.name)).size).toBe(rejects.length);
    });

    for (const r of rejects) {
      const struct = asStruct(describeCodec(r.codec), resolveCodec(r.codec));
      const label = r.failure ? `failure=${r.failure}` : `code=${r.code}`;

      it(`${r.name} — rejected (${label})`, () => {
        let thrown: unknown;
        try {
          decodeStruct(struct, hex(r.bytes));
        } catch (err) {
          thrown = err;
        }

        expect(thrown, `expected "${r.name}" to be rejected, but it decoded`).toBeInstanceOf(
          ReaderError,
        );

        if (r.failure !== undefined) {
          expect(thrown).toBeInstanceOf(CodecError);
          expect((thrown as CodecError).failure).toBe(r.failure);
        } else {
          // Wire's own rejection — and specifically NOT a boundary-check one,
          // or the vector is testing something other than what it claims.
          expect(thrown).not.toBeInstanceOf(CodecError);
          expect((thrown as ReaderError).code).toBe(r.code);
        }
      });
    }
  });
}

runRejects('reject.json', loadRejects('reject.json'));
runRejects('probe.json', loadRejects('probe.json'));
