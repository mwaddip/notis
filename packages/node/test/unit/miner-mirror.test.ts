/**
 * `scripts/miner.mjs` answers PoW with its own copy of the admission rule, and
 * this test is what holds that copy to `@dagsocial/validation`'s.
 *
 * The script is standalone by decision (MINING_INTERFACE → Miner Script): it
 * imports `node:crypto` and nothing else, so the machine that mines is not
 * required to build the workspace. Agreement is therefore enforced by extracting
 * both declarations by name, not by an import — VALIDATION_INTERFACE →
 * orderingPowTarget → Mirrors, "`scripts/miner.mjs` mirrors this function".
 *
 * The script expands a header target, so the half it mirrors is
 * `orderingPowTarget` — 1/256-bit units over `[0, 65536]`.
 *
 * The property that makes it worth having is that a *missing* declaration fails.
 * A comment asserting the copy is byte-identical would be a duplication claim
 * checked by nothing; the extraction is checked every run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  orderingPowTarget as realOrderingPowTarget,
  meetsPowTarget as realMeetsPowTarget,
} from '@dagsocial/validation';
import { extractDeclaration } from './extract-declaration.js';

const MINER = fileURLToPath(new URL('../../scripts/miner.mjs', import.meta.url));

interface MinerPredicate {
  orderingPowTarget: (scaledBits: number) => Uint8Array | null;
  meetsPowTarget: (hash: Uint8Array, target: Uint8Array) => boolean;
}

function loadMinerPredicate(): MinerPredicate {
  const src = readFileSync(MINER, 'utf8');
  const body = [
    // The factors and the scale are what the expansion reads, so they are part
    // of the declaration this mirror extracts — VALIDATION_INTERFACE →
    // orderingPowTarget → What is not consensus: they are an implementation
    // choice, and agreement is what makes the two copies one rule.
    extractDeclaration(src, 'const ORDERING_TARGET_FACTORS = ', 'miner.mjs'),
    extractDeclaration(src, 'const ORDERING_TARGET_PRECISION = ', 'miner.mjs'),
    extractDeclaration(src, 'function orderingPowTarget(', 'miner.mjs'),
    extractDeclaration(src, 'function meetsPowTarget(', 'miner.mjs'),
    'return { orderingPowTarget, meetsPowTarget };',
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
    // The script solves in one place, `throttledSolvePoW`, over one copy of each
    // half. A second declaration is a second walk this mirror does not extract,
    // so the count is what keeps the pin exhaustive.
    const src = readFileSync(MINER, 'utf8');
    expect(src.split('function orderingPowTarget(').length - 1).toBe(1);
    expect(src.split('function meetsPowTarget(').length - 1).toBe(1);
    expect(src.split('const ORDERING_TARGET_FACTORS = ').length - 1).toBe(1);
    expect(src.split('const ORDERING_TARGET_PRECISION = ').length - 1).toBe(1);
  });

  it('carries no second expansion beside the one this mirror pins', () => {
    // The count above pins how many times the extracted declaration appears; it
    // cannot see a *differently named* expansion sitting next to it. `powTarget`
    // is a live validation export (the whole-bit expansion), and nothing but its
    // absence says the script is not calling it somewhere this mirror does not
    // extract.
    const src = readFileSync(MINER, 'utf8');
    expect(src.includes('function powTarget(')).toBe(false);
  });

  it('produces byte-identical targets across the whole domain', () => {
    // All 65537 admitted inputs, not a sample: the fractional path is 256 base
    // values and a shift (VALIDATION_INTERFACE → orderingPowTarget), so a
    // divergence in one factor shows on inputs a whole-bit sweep never visits.
    for (let bits = 0; bits <= 65536; bits++) {
      const mine = miner.orderingPowTarget(bits);
      const real = realOrderingPowTarget(bits);
      expect(mine === null).toBe(real === null);
      if (real !== null) expect(Array.from(mine!)).toEqual(Array.from(real));
    }
  });

  it('refuses the same off-domain targets validation refuses', () => {
    // A solver reads `powTargetBits` off a mining template, so the off-domain
    // answer is reachable here in a way it is not inside the verifier. `257` is
    // the old ceiling and is now an ordinary difficulty, so the boundary case is
    // `65537` — VALIDATION_INTERFACE → orderingPowTarget clause 1.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 60, 65537]) {
      expect(miner.orderingPowTarget(bad)).toBeNull();
      expect(realOrderingPowTarget(bad)).toBeNull();
    }
    expect(miner.orderingPowTarget(257)).not.toBeNull();
  });

  it('answers identically on random digests across every target', () => {
    const rand = lcg(0x5eed);
    for (let n = 0; n <= 256; n++) {
      // Whole bits plus the fraction one step above each, so `meetsPowTarget`
      // is exercised against targets the byte-fill shape cannot produce.
      for (const bits of n === 256 ? [65536] : [256 * n, 256 * n + 1]) {
        const target = realOrderingPowTarget(bits)!;
        for (let trial = 0; trial < 4; trial++) {
          const d = digest(rand);
          expect(miner.meetsPowTarget(d, target)).toBe(realMeetsPowTarget(d, target));
        }
      }
    }
  });

  it('answers identically at the boundary — a digest with exactly n leading zeros', () => {
    const rand = lcg(0xd1ff);
    for (let n = 0; n <= 256; n++) {
      const d = digest(rand);
      for (let i = 0; i < n; i++) d[i >> 3] = d[i >> 3]! & ~(1 << (7 - (i % 8)));
      if (n < 256) d[n >> 3] = d[n >> 3]! | (1 << (7 - (n % 8)));

      const at = realOrderingPowTarget(256 * n)!;
      expect(miner.meetsPowTarget(d, at)).toBe(realMeetsPowTarget(d, at));
      expect(miner.meetsPowTarget(d, at)).toBe(true);

      if (n < 256) {
        const tighter = realOrderingPowTarget(256 * (n + 1))!;
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
