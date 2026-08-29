import { describe, it, expect } from 'vitest';
import {
  verifyHeaderChain,
  asertTargetBits,
  verifyOrderingBlockPoW,
  blockHash,
  cumulativeWork,
  blockWork,
  powHit,
  levelOfHit,
  orderingPowTarget,
} from '../src/index.js';
import type { RetargetParams } from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, MAX_FUTURE_DRIFT_MS, interlinkRoot, updateInterlinks } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Devnet schedule parameters and helpers
// ---------------------------------------------------------------------------

const P_dev: RetargetParams = {
  anchorBits: 3072,
  idealMs: 60_000,
  halflifeMs: 17_280_000,
  floorBits: 2304,
  ceilingBits: 4096,
};

const t_a = 1_700_000_000_000;

function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

function makeHeader(overrides: Partial<BlockHeader> & { height: number; prevBlockHash: string }): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: P_dev.anchorBits,
    createdAt: t_a,
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
 * Mine a contiguous segment with the ASERT schedule. Each header's
 * `powTargetBits` follows the schedule, `createdAt` strictly increases,
 * and the interlink vector walks with the yardstick level.
 */
function mineChain(
  anchor: { prevBlockHash: string; height: number; interlinks: string[]; createdAt: number | null },
  count: number,
  params: RetargetParams = P_dev,
  anchorCreatedAt: number = t_a,
): BlockHeader[] {
  const headers: BlockHeader[] = [];
  let prevHash = anchor.prevBlockHash;
  let expectedInterlinks = anchor.interlinks;
  const yardstick = orderingPowTarget(params.anchorBits)!;

  for (let i = 0; i < count; i++) {
    const height = anchor.height + 1 + i;
    const createdAt = anchorCreatedAt + params.idealMs * (height - 1);

    let bits: number;
    if (height === 1) {
      bits = params.anchorBits;
    } else {
      let previous: { height: number; createdAt: number };
      if (i === 0 && anchor.createdAt !== null && anchor.createdAt !== undefined) {
        previous = { height: anchor.height, createdAt: anchor.createdAt };
      } else {
        previous = headers[i - 1]!;
      }
      bits = asertTargetBits(params, anchorCreatedAt, previous);
    }

    const root = interlinkRoot(expectedInterlinks);
    const h = mineHeader({
      height,
      prevBlockHash: prevHash,
      interlinkRoot: root,
      powTargetBits: bits,
      createdAt,
    });
    const hash = blockHash(h)!;
    const hit = powHit(h)!;
    const lev = h.height === 1 ? Infinity : levelOfHit(hit, yardstick);
    expectedInterlinks = updateInterlinks(expectedInterlinks, hash, lev);
    prevHash = hash;
    headers.push(h);
  }
  return headers;
}

const FAR_FUTURE = t_a + 1_000_000_000_000;

// ---------------------------------------------------------------------------
// Tests — VALIDATION_INTERFACE → verifyHeaderChain
// ---------------------------------------------------------------------------

describe('verifyHeaderChain', () => {
  const anchor = {
    prevBlockHash: 'aa'.repeat(32),
    height: 10,
    interlinks: ['bb'.repeat(32)],
    createdAt: t_a + P_dev.idealMs * 9,
  };
  const genesisAnchor = {
    prevBlockHash: '00'.repeat(32),
    height: 0,
    interlinks: [] as string[],
    createdAt: null as number | null,
  };

  // ---- Happy path ----

  it('accepts a contiguous mined segment with correct work and hashes', () => {
    const headers = mineChain(anchor, 3);
    const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
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
    const result = verifyHeaderChain([], anchor, P_dev, t_a, FAR_FUTURE);
    expect(result).toEqual({ ok: true, work: 0n, hashes: [] });
  });

  // ---- Genesis anchor ----

  it('accepts a height-1 header against the genesis anchor', () => {
    const headers = mineChain(genesisAnchor, 1, P_dev, t_a);
    expect(headers[0]!.height).toBe(1);
    expect(headers[0]!.prevBlockHash).toBe('00'.repeat(32));
    const result = verifyHeaderChain(headers, genesisAnchor, P_dev, null, FAR_FUTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.work).toBe(blockWork(P_dev.anchorBits));
    expect(result.hashes[0]).toBe(blockHash(headers[0]!));
  });

  // ---- reason: domain ----

  describe('reason: domain', () => {
    it('at first position — non-object header', () => {
      const headers = mineChain(anchor, 3);
      (headers as unknown[])[0] = null;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('at middle position — header with invalid prevBlockHash type', () => {
      const headers = mineChain(anchor, 3);
      (headers[1] as unknown as Record<string, unknown>).prevBlockHash = 12345;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'domain' });
    });

    it('at last position — header with wrong-width validatorId', () => {
      const headers = mineChain(anchor, 3);
      (headers[2] as unknown as Record<string, unknown>).validatorId = new Uint8Array(16);
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 2, reason: 'domain' });
    });
  });

  // ---- reason: version ----

  describe('reason: version', () => {
    it('at first position', () => {
      const headers = mineChain(anchor, 3);
      headers[0] = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        protocolVersion: 99,
        createdAt: headers[0]!.createdAt,
        powTargetBits: headers[0]!.powTargetBits,
      });
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'version' });
    });

    it('at middle position', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[1]!, protocolVersion: 0 };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'version' });
    });
  });

  // ---- reason: height ----

  describe('reason: height', () => {
    it('gap — height skips from anchor', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 3,
        prevBlockHash: anchor.prevBlockHash,
        createdAt: headers[0]!.createdAt,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'height' });
    });
  });

  // ---- reason: link ----

  describe('reason: link', () => {
    it('against the anchor at i=0', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: 'bb'.repeat(32),
        createdAt: headers[0]!.createdAt,
        powTargetBits: headers[0]!.powTargetBits,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'link' });
    });
  });

  // ---- reason: time ----

  describe('reason: time', () => {
    it('at index 0 against anchor.createdAt', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        createdAt: anchor.createdAt!,
        powTargetBits: headers[0]!.powTargetBits,
        interlinkRoot: headers[0]!.interlinkRoot,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'time' });
    });

    it('at a middle index against the previous header', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[1]!, createdAt: headers[0]!.createdAt };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'time' });
    });

    it('equal stamps are rejected (strict >)', () => {
      const headers = mineChain(anchor, 3);
      const h = { ...headers[1]!, createdAt: headers[0]!.createdAt };
      h.powNonce = solveHeaderPow(h);
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('time');
    });

    it('the malformed null/non-null mix → time at index 0', () => {
      const headers = mineChain(anchor, 1);
      const mixedAnchor = { ...anchor, createdAt: null as number | null };
      const result = verifyHeaderChain(headers, mixedAnchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'time' });
    });

    it('the reverse null/non-null mix → time at index 0', () => {
      const headers = mineChain(anchor, 1);
      const result = verifyHeaderChain(headers, anchor, P_dev, null, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'time' });
    });
  });

  // ---- reason: clock ----

  describe('reason: clock', () => {
    it('a header stamped nowMs + MAX_FUTURE_DRIFT_MS + 1 → clock', () => {
      const headers = mineChain(anchor, 3);
      const nowMs = headers[1]!.createdAt - MAX_FUTURE_DRIFT_MS - 1;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, nowMs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('clock');
    });

    it('nowMs + MAX_FUTURE_DRIFT_MS exactly → passes', () => {
      const headers = mineChain(anchor, 3);
      const maxCa = Math.max(...headers.map(h => h.createdAt));
      const nowMs = maxCa - MAX_FUTURE_DRIFT_MS;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, nowMs);
      expect(result.ok).toBe(true);
    });

    it('the same segment with nowMs advanced past it → verifies', () => {
      const headers = mineChain(anchor, 3);
      const maxCa = Math.max(...headers.map(h => h.createdAt));
      const tooEarly = maxCa - MAX_FUTURE_DRIFT_MS - 1;
      const early = verifyHeaderChain(headers, anchor, P_dev, t_a, tooEarly);
      expect(early.ok).toBe(false);
      if (!early.ok) expect(early.reason).toBe('clock');
      const ok = verifyHeaderChain(headers, anchor, P_dev, t_a, maxCa);
      expect(ok.ok).toBe(true);
    });
  });

  // ---- reason: target ----

  describe('reason: target', () => {
    it('at index 0 — declaring a wrong target', () => {
      const headers = mineChain(anchor, 3);
      const wrongBits = headers[0]!.powTargetBits + 256;
      const h = mineHeader({
        height: anchor.height + 1,
        prevBlockHash: anchor.prevBlockHash,
        powTargetBits: wrongBits,
        createdAt: headers[0]!.createdAt,
        interlinkRoot: headers[0]!.interlinkRoot,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'target' });
    });

    it('at a middle position', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: headers[1]!.height,
        prevBlockHash: headers[1]!.prevBlockHash,
        powTargetBits: P_dev.anchorBits + 256,
        createdAt: headers[1]!.createdAt,
        interlinkRoot: headers[1]!.interlinkRoot,
      });
      headers[1] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'target' });
    });

    it('at last position', () => {
      const headers = mineChain(anchor, 3);
      const h = mineHeader({
        height: headers[2]!.height,
        prevBlockHash: headers[2]!.prevBlockHash,
        powTargetBits: P_dev.anchorBits + 256,
        createdAt: headers[2]!.createdAt,
        interlinkRoot: headers[2]!.interlinkRoot,
      });
      headers[2] = h;
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 2, reason: 'target' });
    });

    it('a height-1 header with bits ≠ anchorBits → target', () => {
      const headers = mineChain(genesisAnchor, 1, P_dev, t_a);
      const h = mineHeader({
        height: 1,
        prevBlockHash: '00'.repeat(32),
        powTargetBits: P_dev.anchorBits + 1,
        createdAt: t_a,
        interlinkRoot: headers[0]!.interlinkRoot,
      });
      headers[0] = h;
      const result = verifyHeaderChain(headers, genesisAnchor, P_dev, null, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'target' });
    });
  });

  // ---- order: a header failing both time and target answers time ----

  it('a header failing both time and target answers time — the earlier step wins', () => {
    const headers = mineChain(anchor, 3);
    const h = { ...headers[1]!, createdAt: headers[0]!.createdAt, powTargetBits: P_dev.anchorBits + 256 };
    h.powNonce = solveHeaderPow(h);
    headers[1] = h;
    const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('time');
  });

  // ---- reason: pow ----

  describe('reason: pow', () => {
    it('at first position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[0] = { ...headers[0]!, powNonce: headers[0]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'pow' });
    });

    it('at middle position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[1] = { ...headers[1]!, powNonce: headers[1]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'pow' });
    });

    it('at last position — tampered nonce', () => {
      const headers = mineChain(anchor, 3);
      headers[2] = { ...headers[2]!, powNonce: headers[2]!.powNonce + 1 };
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 2, reason: 'pow' });
    });
  });

  // ---- Genesis anchor: both nulls, headers[0] is height 1 ----

  describe('genesis anchor', () => {
    it('headers[1] target computed from headers[0] stamp', () => {
      const headers = mineChain(genesisAnchor, 3, P_dev, t_a);
      const result = verifyHeaderChain(headers, genesisAnchor, P_dev, null, FAR_FUTURE);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.work).toBe(cumulativeWork(headers));
    });
  });

  // ---- No-level header leaves interlinks unchanged ----

  it('a no-level header (yardstick harder than own target) verifies', () => {
    const headers = mineChain(anchor, 5);
    const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
    expect(result.ok).toBe(true);
  });

  // ---- M-5: no-throw on malformed input ----

  describe('M-5: no-throw on malformed input', () => {
    it('non-object header answers domain', () => {
      const headers = [42 as unknown as BlockHeader];
      const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('null header answers domain', () => {
      const result = verifyHeaderChain([null as unknown as BlockHeader], anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'domain' });
    });

    it('non-array headers treated as empty segment', () => {
      const result = verifyHeaderChain(null as unknown as BlockHeader[], anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: true, work: 0n, hashes: [] });
    });
  });

  // ---- Nothing partial is exposed on failure ----

  it('failure exposes no hashes or work', () => {
    const headers = mineChain(anchor, 3);
    headers[1] = { ...headers[1]!, powNonce: headers[1]!.powNonce + 1 };
    const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect('work' in result).toBe(false);
    expect('hashes' in result).toBe(false);
  });

  // ---- reason: interlinks ----

  describe('reason: interlinks', () => {
    it('the honest chain passes step 9 — mineChain maintains the vector', () => {
      const headers = mineChain(genesisAnchor, 5, P_dev, t_a);
      const result = verifyHeaderChain(headers, genesisAnchor, P_dev, null, FAR_FUTURE);
      expect(result.ok).toBe(true);
    });

    it('a header mined with a wrong interlinkRoot → { index: i, reason: interlinks }', () => {
      const headers = mineChain(anchor, 1);
      const h0hash = blockHash(headers[0]!)!;
      const wrongRoot = 'ff'.repeat(32);
      const bits1 = asertTargetBits(P_dev, t_a, headers[0]!);
      const h1 = mineHeader({
        height: anchor.height + 2,
        prevBlockHash: h0hash,
        interlinkRoot: wrongRoot,
        powTargetBits: bits1,
        createdAt: headers[0]!.createdAt + P_dev.idealMs,
      });
      const result = verifyHeaderChain([headers[0]!, h1], anchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 1, reason: 'interlinks' });
    });

    it('malformed anchor vector → interlinks at index 0', () => {
      const badAnchor = { ...anchor, interlinks: 'not-an-array' as unknown as string[] };
      const headers = mineChain(anchor, 1);
      const result = verifyHeaderChain(headers, badAnchor, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('empty vector above genesis → interlinks at index 0', () => {
      const emptyAboveGenesis = {
        prevBlockHash: 'aa'.repeat(32),
        height: 5,
        interlinks: [] as string[],
        createdAt: t_a + 4 * P_dev.idealMs,
      };
      const h = mineHeader({
        height: 6,
        prevBlockHash: emptyAboveGenesis.prevBlockHash,
        interlinkRoot: interlinkRoot([]),
        createdAt: t_a + 5 * P_dev.idealMs,
      });
      expect(() => verifyHeaderChain([h], emptyAboveGenesis, P_dev, t_a, FAR_FUTURE)).not.toThrow();
      const result = verifyHeaderChain([h], emptyAboveGenesis, P_dev, t_a, FAR_FUTURE);
      expect(result).toEqual({ ok: false, index: 0, reason: 'interlinks' });
    });

    it('genesis anchor [] accepted for a height-1 header', () => {
      const headers = mineChain(genesisAnchor, 1, P_dev, t_a);
      expect(headers[0]!.interlinkRoot).toBe(interlinkRoot([]));
      const result = verifyHeaderChain(headers, genesisAnchor, P_dev, null, FAR_FUTURE);
      expect(result.ok).toBe(true);
    });
  });

  // ---- The segment whose targets follow the schedule verifies ----

  it('a segment whose declared targets follow the schedule over its own stamps verifies', () => {
    const headers = mineChain(anchor, 5);
    const result = verifyHeaderChain(headers, anchor, P_dev, t_a, FAR_FUTURE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.work).toBe(cumulativeWork(headers));
  });
});
