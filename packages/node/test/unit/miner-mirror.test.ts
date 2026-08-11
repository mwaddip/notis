/**
 * `scripts/miner.mjs` answers PoW with its own copy of the admission rule, and
 * this test is what holds that copy to `@dagsocial/validation`'s.
 *
 * The script is standalone by decision (MINING_INTERFACE → Miner Script): it
 * imports `node:crypto` and nothing else, so the machine that mines is not
 * required to build the workspace. Agreement is therefore enforced by extracting
 * both declarations by name, not by an import — VALIDATION_INTERFACE → powTarget /
 * meetsPowTarget, "two consumers cannot import this package and mirror it instead".
 *
 * The property that makes it worth having is that a *missing* declaration fails.
 * The script previously carried the comment "byte-identical to block-creator.ts
 * solvePoW()" — a duplication claim checked by nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  powTarget as realPowTarget,
  meetsPowTarget as realMeetsPowTarget,
} from '@dagsocial/validation';
import { extractDeclaration } from './extract-declaration.js';

const MINER = fileURLToPath(new URL('../../scripts/miner.mjs', import.meta.url));

interface MinerPredicate {
  powTarget: (targetBits: number) => Uint8Array | null;
  meetsPowTarget: (hash: Uint8Array, target: Uint8Array) => boolean;
}

function loadMinerPredicate(): MinerPredicate {
  const src = readFileSync(MINER, 'utf8');
  const body = [
    extractDeclaration(src, 'function powTarget(', 'miner.mjs'),
    extractDeclaration(src, 'function meetsPowTarget(', 'miner.mjs'),
    'return { powTarget, meetsPowTarget };',
  ].join('\n\n');
  return new Function(body)() as MinerPredicate;
}

/** Deterministic LCG so a failure reproduces exactly. Not cryptographic. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  };
}

function digest(rand: () => number): Uint8Array {
  const d = new Uint8Array(32);
  for (let i = 0; i < 32; i++) d[i] = rand();
  return d;
}

describe('miner.mjs PoW predicate ↔ @dagsocial/validation', () => {
  const miner = loadMinerPredicate();

  it('declares each half exactly once', () => {
    // The defect this unit removes was TWO copies of the walk in this one file —
    // `solvePoW` and `throttledSolvePoW` each carried their own.
    const src = readFileSync(MINER, 'utf8');
    expect(src.split('function powTarget(').length - 1).toBe(1);
    expect(src.split('function meetsPowTarget(').length - 1).toBe(1);
  });

  it('produces byte-identical targets across the whole domain', () => {
    for (let bits = 0; bits <= 256; bits++) {
      const mine = miner.powTarget(bits);
      const real = realPowTarget(bits);
      expect(mine === null).toBe(real === null);
      if (real !== null) expect(Array.from(mine!)).toEqual(Array.from(real));
    }
  });

  it('refuses the same off-domain targets validation refuses', () => {
    // A solver reads `targetBits` off a mining template, so the off-domain answer
    // is reachable here in a way it is not inside the verifier.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 60, 257]) {
      expect(miner.powTarget(bad)).toBeNull();
      expect(realPowTarget(bad)).toBeNull();
    }
  });

  it('answers identically on random digests across every target', () => {
    const rand = lcg(0x5eed);
    for (let bits = 0; bits <= 256; bits++) {
      const target = realPowTarget(bits)!;
      for (let trial = 0; trial < 4; trial++) {
        const d = digest(rand);
        expect(miner.meetsPowTarget(d, target)).toBe(realMeetsPowTarget(d, target));
      }
    }
  });

  it('answers identically at the boundary — a digest with exactly n leading zeros', () => {
    const rand = lcg(0xd1ff);
    for (let n = 0; n <= 256; n++) {
      const d = digest(rand);
      for (let i = 0; i < n; i++) d[i >> 3] = d[i >> 3]! & ~(1 << (7 - (i % 8)));
      if (n < 256) d[n >> 3] = d[n >> 3]! | (1 << (7 - (n % 8)));

      const at = realPowTarget(n)!;
      expect(miner.meetsPowTarget(d, at)).toBe(realMeetsPowTarget(d, at));
      expect(miner.meetsPowTarget(d, at)).toBe(true);

      if (n < 256) {
        const tighter = realPowTarget(n + 1)!;
        expect(miner.meetsPowTarget(d, tighter)).toBe(realMeetsPowTarget(d, tighter));
        expect(miner.meetsPowTarget(d, tighter)).toBe(false);
      }
    }
  });

  it('the script still imports nothing but node:crypto', () => {
    // The mirror exists BECAUSE the script is standalone. If it ever gains a
    // workspace import the mirror is redundant, and if it gains any other
    // dependency the "no build step to mine" decision has quietly lapsed.
    const src = readFileSync(MINER, 'utf8');
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)]
      .map((m) => m[1]!);
    expect(imports).toEqual(['crypto']);
  });
});
