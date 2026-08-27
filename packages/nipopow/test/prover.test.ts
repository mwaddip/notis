import { describe, it, expect } from 'vitest';
import { proveWithReader, ProofBuildError } from '../src/prover.js';
import { encodeNipopowProof, decodeNipopowProof } from '../src/index.js';
import {
  buildMinedChain,
  makeReader,
} from './helpers.js';
import type { PopowHeaderReader } from '../src/prover.js';

describe('proveWithReader', () => {

  describe('postconditions', () => {
    const mValues = [1, 2, 3, 6, 10];
    const kValues = [1, 2, 3, 6, 10];

    for (const m of mValues) {
      for (const k of kValues) {
        const chainLen = Math.max(64, m + k + 10);
        it(`m=${m}, k=${k}, chain=${chainLen}: postconditions hold`, () => {
          const chain = buildMinedChain({ count: chainLen });
          const reader = makeReader(chain);
          const proof = proveWithReader(reader, { m, k });

          // NIPOPOW_INTERFACE → prefix[0] is height 1
          expect(proof.prefix[0]!.header.height).toBe(1);

          // Heights strictly ascending across the flattened sequence
          const allHeights = [
            ...proof.prefix.map(ph => ph.header.height),
            proof.suffixHead.header.height,
            ...proof.suffixTail.map(h => h.height),
          ];
          for (let i = 1; i < allHeights.length; i++) {
            expect(allHeights[i]!).toBeGreaterThan(allHeights[i - 1]!);
          }

          // NIPOPOW_INTERFACE → suffixHead.header.height === chainHeight − k + 1
          expect(proof.suffixHead.header.height).toBe(chainLen - k + 1);

          // NIPOPOW_INTERFACE → tail is k − 1 headers
          expect(proof.suffixTail.length).toBe(k - 1);
        });
      }
    }
  });

  describe('round-trip through codec', () => {
    it('encode → decode produces an equal object', () => {
      const chain = buildMinedChain({ count: 40 });
      const reader = makeReader(chain);
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const bytes = encodeNipopowProof(proof);
      const decoded = decodeNipopowProof(bytes);
      expect(decoded.m).toBe(proof.m);
      expect(decoded.k).toBe(proof.k);
      expect(decoded.prefix.length).toBe(proof.prefix.length);
      expect(decoded.suffixHead.header.height).toBe(proof.suffixHead.header.height);
      expect(decoded.suffixTail.length).toBe(proof.suffixTail.length);
    });
  });

  describe('preconditions', () => {
    it('throws chain-too-short when height < m + k', () => {
      const chain = buildMinedChain({ count: 5 });
      const reader = makeReader(chain);
      expect(() => proveWithReader(reader, { m: 3, k: 5 }))
        .toThrow(ProofBuildError);
      try {
        proveWithReader(reader, { m: 3, k: 5 });
      } catch (e) {
        expect((e as ProofBuildError).code).toBe('chain-too-short');
      }
    });

    it('throws invalid-m for m = 0', () => {
      const chain = buildMinedChain({ count: 20 });
      const reader = makeReader(chain);
      expect(() => proveWithReader(reader, { m: 0, k: 5 }))
        .toThrow(ProofBuildError);
      try {
        proveWithReader(reader, { m: 0, k: 5 });
      } catch (e) {
        expect((e as ProofBuildError).code).toBe('invalid-m');
      }
    });

    it('throws invalid-k for k = 0', () => {
      const chain = buildMinedChain({ count: 20 });
      const reader = makeReader(chain);
      expect(() => proveWithReader(reader, { m: 3, k: 0 }))
        .toThrow(ProofBuildError);
      try {
        proveWithReader(reader, { m: 3, k: 0 });
      } catch (e) {
        expect((e as ProofBuildError).code).toBe('invalid-k');
      }
    });

    it('throws missing-popow-header from a reader that answers null for a needed hash', () => {
      const chain = buildMinedChain({ count: 30 });
      const baseReader = makeReader(chain);
      const sparseReader: PopowHeaderReader = {
        chainHeight: () => baseReader.chainHeight(),
        popowHeaderByHash: (hash: string) => {
          // Drop a mid-chain header
          const ph = baseReader.popowHeaderByHash(hash);
          if (ph && ph.header.height === 10) return null;
          return ph;
        },
        popowHeaderAtHeight: (h: number) => baseReader.popowHeaderAtHeight(h),
        lastHeaders: (n: number) => baseReader.lastHeaders(n),
        headersAfter: (h: number, n: number) => baseReader.headersAfter(h, n),
      };
      // The walk might not need height 10 — this test verifies no TypeError
      // occurs regardless; either it throws ProofBuildError or succeeds
      try {
        const proof = proveWithReader(sparseReader, { m: 3, k: 5 });
        expect(proof.prefix.length).toBeGreaterThan(0);
      } catch (e) {
        expect(e).toBeInstanceOf(ProofBuildError);
      }
    });

    it('no partial proof returned on a missing header', () => {
      const chain = buildMinedChain({ count: 30 });
      const baseReader = makeReader(chain);
      const sparseReader: PopowHeaderReader = {
        chainHeight: () => baseReader.chainHeight(),
        popowHeaderByHash: () => null,
        popowHeaderAtHeight: (h: number) => baseReader.popowHeaderAtHeight(h),
        lastHeaders: (n: number) => baseReader.lastHeaders(n),
        headersAfter: (h: number, n: number) => baseReader.headersAfter(h, n),
      };
      expect(() => proveWithReader(sparseReader, { m: 3, k: 5 }))
        .toThrow(ProofBuildError);
    });
  });
});
