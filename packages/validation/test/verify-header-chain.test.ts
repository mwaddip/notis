import { describe, it, expect } from 'vitest';
import {
  verifyHeaderChain,
  verifyOrderingBlockPoW,
  blockHash,
  cumulativeWork,
  blockWork,
  level,
} from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, interlinkRoot, updateInterlinks } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Solver — the shape `pow-predicate.test.ts` and `node/test/helpers.ts` use:
// hold no predicate, ask the verifier. Devnet's 3072 target (12 whole bits)
// keeps solves at ~4K hashes.
// ---------------------------------------------------------------------------

const DEVNET_TARGET = 3072;

function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

// ---------------------------------------------------------------------------
// Header and chain helpers
// ---------------------------------------------------------------------------

function makeHeader(overrides: Partial<BlockHeader> & { height: number; prevBlockHash: string }): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: DEVNET_TARGET,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    ...overrides,
  };
}

function mineHeader(overrides: Partial<BlockHeader> & { height: number; prevBlockHash: string }): BlockHeader {
  const h = makeHeader(overrides);
  h.powNonce = solveHeaderPow(h);
  return h;
}

/**
 * Mine a contiguous segment of `count` headers starting at `anchor.height + 1`.
 * Each header's `prevBlockHash` is the `blockHash` of its predecessor (the
 * anchor's `prevBlockHash` for the first). Each header's `interlinkRoot`
 * commits to the interlink vector the anchor's `interlinks` field starts from,
 * walked forward by `updateInterlinks` + `level`.
 */
function mineChain(
  anchor: { prevBlockHash: string; height: number; interlinks: string[] },
  count: number,
): BlockHeader[] {
  const headers: BlockHeader[] = [];
  let prevHash = anchor.prevBlockHash;
  let expectedInterlinks = anchor.interlinks;
  for (let i = 0; i < count; i++) {
    const root = interlinkRoot(expectedInterlinks);
    const h = mineHeader({ height: anchor.height + 1 + i, prevBlockHash: prevHash, interlinkRoot: root });
    const hash = blockHash(h)!;
    const lev = level(h)!;
    expectedInterlinks = updateInterlinks(expectedInterlinks, hash, lev);
    prevHash = hash;
    headers.push(h);
  }
  return headers;
}

const constantTarget = () => DEVNET_TARGET;

// ---------------------------------------------------------------------------
// Tests — VALIDATION_INTERFACE → verifyHeaderChain
// ---------------------------------------------------------------------------

describe('verifyHeaderChain', () => {
  const anchor = { prevBlockHash: 'aa'.repeat(32), height: 10, interlinks: ['bb'.repeat(32)] };
  const genesisAnchor = { prevBlockHash: '00'.repeat(32), height: 0, interlinks: [] as string[] };

  // ---- Happy path ----

  it('accepts a contiguous mined segment with correct work and hashes', () => {
    const headers = mineChain(anchor, 3);
    const result = verifyHeaderChain(headers, anchor, constantTarget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.work).toBe(cumulativeWork(headers));
    expect(result.hashes.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(result.hashes[i]).toBe(blockHash(headers[i]!));
    }
  });

  // ---- Empty segment ----

  it('returns ok with zero work for an empty segment', () => {
    const result = verifyHeaderChain([], anchor, constantTarget);
    expect(result).toEqual({ ok: true, work: 0n, hashes: [] });
  });

  // ---- Genesis anchor ----

  it('accepts a height-1 header against the genesis anchor', () => {
    const headers = mineChain(genesisAnchor, 1);
    expect(headers[0]!.height).toBe(1);
    expect(headers[0]!.prevBlockHash).toBe('00'.repeat(32));
    const result = verifyHeaderChain(headers, genesisAnchor, constantTarget);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.work).toBe(blockWork(DEVNET_TARGET));
    expect(result.hashes[0]).toBe(blockHash(headers[0]!));
  });

  // ---- reason: domain ----

  describe('reason: domain', () => {
    it('at first position — non-object header', () => {
      const headers = mineChain(anchor, 3);
      (headers as unknown[])[0] = null;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('at middle position — header with invalid prevBlockHash type', () => {
      const headers = mineChain(anchor, 3);
      (headers[1] as unknown as Record<string, unknown>).prevBlockHash = 12345;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'domain' });
    });

    it('at last position — header with wrong-width validatorId', () => {
      const headers = mineChain(anchor, 3);
      (headers[2] as unknown as Record<string, unknown>).validatorId = new Uint8Array(16);
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'domain' });
    });
  });

  // ---- reason: version ----

  describe('reason: version', () => {
    it('at first position', () => {
      const headers = mineChain(anchor, 3);
      headers[0] = mineHeader({ height: anchor.height + 1, prevBlockHash: anchor.prevBlockHash, protocolVersion: 99 });
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'version' });
    });

    it('at middle position', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[1]!, protocolVersion: 0 };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'version' });
    });

    it('at last position', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[2]!, protocolVersion: 2 };
      h.powNonce = solveHeaderPow(h);
      headers[2] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'version' });
    });
  });

  // ---- reason: height ----

  describe('reason: height', () => {
    it('gap — height skips from anchor', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({ height: anchor.height + 3, prevBlockHash: anchor.prevBlockHash });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'height' });
    });

    it('duplicate — same height twice in the middle', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[1]!, height: headers[0]!.height };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'height' });
    });

    it('wrong start — height does not continue from anchor', () => {
      const wrongAnchor = { prevBlockHash: 'aa'.repeat(32), height: 5, interlinks: ['bb'.repeat(32)] };
      const headers = mineChain(anchor, 3);
      const result = verifyHeaderChain(headers, wrongAnchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'height' });
    });

    it('at last position — height repeats', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[2]!, height: headers[1]!.height };
      h.powNonce = solveHeaderPow(h);
      headers[2] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'height' });
    });
  });

  // ---- reason: link ----

  describe('reason: link', () => {
    it('against the anchor at i=0', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({ height: anchor.height + 1, prevBlockHash: 'bb'.repeat(32) });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'link' });
    });

    it('against hashes[i-1] at middle position', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: 'cc'.repeat(32),
      });
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'link' });
    });

    it('against hashes[i-1] at last position', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 3,
        prevBlockHash: 'dd'.repeat(32),
      });
      headers[2] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'link' });
    });
  });

  // ---- reason: target ----

  describe('reason: target', () => {
    const OTHER_TARGET = 3328;

    it('at first position — wrong target', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        powTargetBits: OTHER_TARGET,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'target' });
    });

    it('at middle position', () => {
      const headers = mineChain(anchor, 3);
      const h = {
        ...headers[1]!,
        powTargetBits: OTHER_TARGET,
      };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'target' });
    });

    it('at last position', () => {
      const headers = mineChain(anchor, 3);
      const h = {
        ...headers[2]!,
        powTargetBits: OTHER_TARGET,
      };
      h.powNonce = solveHeaderPow(h);
      headers[2] = h;
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'target' });
    });
  });

  // ---- reason: pow ----

  describe('reason: pow', () => {
    it('at first position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[0] = { ...headers[0]!, powNonce: headers[0]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'pow' });
    });

    it('at middle position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[1] = { ...headers[1]!, powNonce: headers[1]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'pow' });
    });

    it('at last position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[2] = { ...headers[2]!, powNonce: headers[2]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 2, reason: 'pow' });
    });
  });

  // ---- Retarget seam — non-constant scheduledTarget ----

  describe('retarget seam', () => {
    it('a non-constant schedule is consulted per height; mismatch at one height fails with target', () => {
      const TARGET_A = 3072;
      const TARGET_B = 3328;
      const retargetHeight = anchor.height + 2;
      const schedule = (h: number) => (h >= retargetHeight ? TARGET_B : TARGET_A);

      let vec = anchor.interlinks;
      const h0 = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        powTargetBits: TARGET_A,
        interlinkRoot: interlinkRoot(vec),
      });
      const h0Hash = blockHash(h0)!;
      vec = updateInterlinks(vec, h0Hash, level(h0)!);
      const h1 = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: h0Hash,
        powTargetBits: TARGET_B,
        interlinkRoot: interlinkRoot(vec),
      });
      const h1Hash = blockHash(h1)!;
      vec = updateInterlinks(vec, h1Hash, level(h1)!);
      const h2 = mineHeader({
        height: anchor.height + 3,
        prevBlockHash: h1Hash,
        powTargetBits: TARGET_B,
        interlinkRoot: interlinkRoot(vec),
      });

      const headers = [h0, h1, h2];
      const ok = verifyHeaderChain(headers, anchor, schedule);
      expect(ok.ok).toBe(true);

      // Now mine h1 with TARGET_A instead of TARGET_B — mismatch at index 1
      const h1Wrong = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: h0Hash,
        powTargetBits: TARGET_A,
        interlinkRoot: interlinkRoot(updateInterlinks(anchor.interlinks, h0Hash, level(h0)!)),
      });
      const headersMismatch = [h0, h1Wrong, h2];
      const fail = verifyHeaderChain(headersMismatch, anchor, schedule);
      expect(fail).toEqual({ ok: false, index: 1, reason: 'target' });
    });
  });

  // ---- M-5: no-throw on malformed input ----

  describe('M-5: no-throw on malformed input', () => {
    it('non-object header answers domain', () => {
      const headers = [42 as unknown as BlockHeader];
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('string header answers domain', () => {
      const headers = ['not a header' as unknown as BlockHeader];
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('header with NaN height answers domain (blockHash refuses it)', () => {
      const h = makeHeader({ height: NaN as unknown as number, prevBlockHash: anchor.prevBlockHash });
      const result = verifyHeaderChain([h], anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('header with NaN powTargetBits answers domain (blockHash refuses it)', () => {
      const h = makeHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        powTargetBits: NaN as unknown as number,
      });
      const result = verifyHeaderChain([h], anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('null header answers domain', () => {
      const result = verifyHeaderChain([null as unknown as BlockHeader], anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('non-array headers treated as empty segment', () => {
      const result = verifyHeaderChain(null as unknown as BlockHeader[], anchor, constantTarget);
      expect(result).toEqual({ ok: true, work: 0n, hashes: [] });
    });
  });

  // ---- Cross-check: pow step IS verifyOrderingBlockPoW ----

  it('a header passing everything but with a tampered nonce fails as pow at its index', () => {
    const headers = mineChain(anchor, 2);
    const original = headers[1]!;
    expect(verifyOrderingBlockPoW(original)).toBe(true);
    const tampered = { ...original, powNonce: original.powNonce + 1 };
    expect(verifyOrderingBlockPoW(tampered)).toBe(false);
    headers[1] = tampered;
    const result = verifyHeaderChain(headers, anchor, constantTarget);
    expect(result).toEqual({ ok: false, index: 1, reason: 'pow' });
  });

  // ---- Nothing partial is exposed on failure ----

  it('failure exposes no hashes or work', () => {
    const headers = mineChain(anchor, 3);
    headers[1] = { ...headers[1]!, powNonce: headers[1]!.powNonce + 1 };
    const result = verifyHeaderChain(headers, anchor, constantTarget);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result).toEqual({ ok: false, index: 1, reason: 'pow' });
    expect('work' in result).toBe(false);
    expect('hashes' in result).toBe(false);
  });

  // ---- reason: interlinks (step 7) ----

  describe('reason: interlinks', () => {
    it('the honest chain passes step 7 — mineChain maintains the vector', () => {
      const headers = mineChain(genesisAnchor, 5);
      const result = verifyHeaderChain(headers, genesisAnchor, constantTarget);
      expect(result.ok).toBe(true);
    });

    it('a header mined with a wrong interlinkRoot → { index: i, reason: interlinks }', () => {
      // Mine the first header honestly, then mine header[1] with a wrong root
      // baked in (so PoW passes over the wrong root).
      const headers = mineChain(anchor, 1);
      const h0hash = blockHash(headers[0]!)!;
      const wrongRoot = 'ff'.repeat(32);
      const h1 = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: h0hash,
        interlinkRoot: wrongRoot,
      });
      const result = verifyHeaderChain([headers[0]!, h1], anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'interlinks' });
    });

    it('a root from a different vector → refused', () => {
      const headers = mineChain(anchor, 1);
      const h0hash = blockHash(headers[0]!)!;
      const wrongRoot = interlinkRoot(['cc'.repeat(32), 'dd'.repeat(32)]);
      const h1 = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: h0hash,
        interlinkRoot: wrongRoot,
      });
      const result = verifyHeaderChain([headers[0]!, h1], anchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 1, reason: 'interlinks' });
    });

    it('an anchor vector that is not the chain\'s → refused at index 0', () => {
      const headers = mineChain(anchor, 2);
      const wrongAnchor = { ...anchor, interlinks: ['cc'.repeat(32), 'dd'.repeat(32)] };
      const result = verifyHeaderChain(headers, wrongAnchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('genesis anchor [] accepted for a height-1 header committing to interlinkRoot([])', () => {
      const headers = mineChain(genesisAnchor, 1);
      expect(headers[0]!.interlinkRoot).toBe(interlinkRoot([]));
      const result = verifyHeaderChain(headers, genesisAnchor, constantTarget);
      expect(result.ok).toBe(true);
    });

    it('a non-genesis anchor with a non-empty vector threads through', () => {
      const headers = mineChain(anchor, 3);
      const result = verifyHeaderChain(headers, anchor, constantTarget);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hashes).toHaveLength(3);
    });

    it('malformed anchor vector — not an array → interlinks at index 0', () => {
      const badAnchor = { ...anchor, interlinks: 'not-an-array' as unknown as string[] };
      const headers = mineChain(anchor, 1);
      const result = verifyHeaderChain(headers, badAnchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('malformed anchor vector — entry not hex(32) → interlinks at index 0', () => {
      const badAnchor = { ...anchor, interlinks: ['not-hex'] };
      const headers = mineChain(anchor, 1);
      const result = verifyHeaderChain(headers, badAnchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('malformed anchor vector — too many entries → interlinks at index 0', () => {
      const tooMany = Array.from({ length: 258 }, () => 'aa'.repeat(32));
      const badAnchor = { ...anchor, interlinks: tooMany };
      const headers = mineChain(anchor, 1);
      const result = verifyHeaderChain(headers, badAnchor, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('empty vector above genesis → interlinks at index 0, never throws', () => {
      // An empty vector is valid only at genesis (height 0). Above it,
      // updateInterlinks would throw on a finite level with prev.length === 0.
      // The anchor shape check refuses it as a verdict, not a throw.
      const emptyAboveGenesis = {
        prevBlockHash: 'aa'.repeat(32),
        height: 5,
        interlinks: [] as string[],
      };
      // Mine a header that commits to interlinkRoot([]) — the root the
      // empty vector produces — so step 7 would pass if the shape check
      // did not fire first.
      const h = mineHeader({
        height: 6,
        prevBlockHash: emptyAboveGenesis.prevBlockHash,
        interlinkRoot: interlinkRoot([]),
      });
      expect(() => verifyHeaderChain([h], emptyAboveGenesis, constantTarget)).not.toThrow();
      const result = verifyHeaderChain([h], emptyAboveGenesis, constantTarget);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('malformed anchor never throws', () => {
      for (const bad of [null, undefined, 42, 'str', [42], [null]]) {
        const badAnchor = { ...anchor, interlinks: bad as unknown as string[] };
        expect(() => verifyHeaderChain([], badAnchor, constantTarget)).not.toThrow();
      }
    });
  });
});
