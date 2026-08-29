import { describe, it, expect } from 'vitest';
import {
  powHit,
  levelOfHit,
  level,
  verifyOrderingBlockPoW,
  meetsPowTarget,
  orderingPowTarget,
} from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';
import { PROTOCOL_VERSION, LEVEL_CAP } from '@dagsocial/types';

const DEVNET_TARGET = 3072;

function makeHeader(over: Partial<BlockHeader> & { height: number; prevBlockHash: string }): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: DEVNET_TARGET,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    ...over,
  };
}

function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

function mineHeader(over: Partial<BlockHeader> & { height: number; prevBlockHash: string }): BlockHeader {
  const h = makeHeader(over);
  h.powNonce = solveHeaderPow(h);
  return h;
}

// ---------------------------------------------------------------------------
// powHit — VALIDATION_INTERFACE → powHit
// ---------------------------------------------------------------------------

describe('powHit', () => {
  it('equals the bytes verifyOrderingBlockPoW judges', () => {
    const h = mineHeader({ height: 5, prevBlockHash: 'aa'.repeat(32) });
    const hit = powHit(h);
    expect(hit).not.toBeNull();
    const target = orderingPowTarget(h.powTargetBits)!;
    expect(meetsPowTarget(hit!, target)).toBe(true);
    expect(verifyOrderingBlockPoW(h)).toBe(true);
  });

  it('a header verifyOrderingBlockPoW rejects has a hit above the target', () => {
    const h = mineHeader({ height: 5, prevBlockHash: 'aa'.repeat(32) });
    const tampered = { ...h, powNonce: h.powNonce + 1 };
    expect(verifyOrderingBlockPoW(tampered)).toBe(false);
    const hit = powHit(tampered);
    if (hit !== null) {
      const target = orderingPowTarget(tampered.powTargetBits)!;
      expect(meetsPowTarget(hit, target)).toBe(false);
    }
  });

  it('returns null on domain failures', () => {
    expect(powHit(makeHeader({ height: 1, prevBlockHash: 'aa'.repeat(32), powNonce: NaN }))).toBeNull();
    expect(powHit(makeHeader({ height: 1, prevBlockHash: 'aa'.repeat(32), powNonce: -1 }))).toBeNull();
    expect(powHit(makeHeader({ height: 1, prevBlockHash: 'aa'.repeat(32), powNonce: 1.5 }))).toBeNull();
    expect(powHit(makeHeader({ height: 1, prevBlockHash: 'nope' as any }))).toBeNull();
    expect(powHit(null as any)).toBeNull();
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 42, 'str', {}, [], NaN]) {
      expect(() => powHit(bad as any)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// levelOfHit — VALIDATION_INTERFACE → level
// ---------------------------------------------------------------------------

describe('levelOfHit', () => {
  it('zero hit → LEVEL_CAP', () => {
    const hit = new Uint8Array(32);
    const target = orderingPowTarget(DEVNET_TARGET)!;
    expect(levelOfHit(hit, target)).toBe(LEVEL_CAP);
  });

  it('hit > target → null', () => {
    const target = orderingPowTarget(DEVNET_TARGET)!;
    const hit = new Uint8Array(32).fill(0xff);
    expect(levelOfHit(hit, target)).toBeNull();
  });

  it('hit === target → 0', () => {
    const target = orderingPowTarget(DEVNET_TARGET)!;
    expect(levelOfHit(target, target)).toBe(0);
  });

  it('hit === target >> 3 → 3', () => {
    const target = orderingPowTarget(DEVNET_TARGET)!;
    let t = 0n;
    for (const b of target) t = (t << 8n) | BigInt(b);
    const shifted = t >> 3n;
    const hitBytes = new Uint8Array(32);
    let v = shifted;
    for (let i = 31; i >= 0; i--) {
      hitBytes[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    expect(levelOfHit(hitBytes, target)).toBe(3);
  });

  it('wrong-width operands → null', () => {
    const target = orderingPowTarget(DEVNET_TARGET)!;
    expect(levelOfHit(new Uint8Array(31), target)).toBeNull();
    expect(levelOfHit(new Uint8Array(33), target)).toBeNull();
    expect(levelOfHit(new Uint8Array(32), new Uint8Array(31))).toBeNull();
    expect(levelOfHit(new Uint8Array(32), new Uint8Array(33))).toBeNull();
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 42, 'str']) {
      expect(() => levelOfHit(bad as any, bad as any)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// level — the yardstick (VALIDATION_INTERFACE → level)
// ---------------------------------------------------------------------------

describe('level', () => {
  it('height 1 → Infinity regardless of hit', () => {
    const h = mineHeader({ height: 1, prevBlockHash: '00'.repeat(32) });
    expect(level(h, DEVNET_TARGET)).toBe(Infinity);
  });

  it('asserted by an independent BigInt computation on mined headers', () => {
    const prev = 'aa'.repeat(32);
    for (let i = 0; i < 10; i++) {
      const h = mineHeader({
        height: 2 + i,
        prevBlockHash: prev,
        powNonce: 0,
      });
      const hit = powHit(h)!;
      const yardstick = orderingPowTarget(DEVNET_TARGET)!;
      expect(hit).not.toBeNull();
      expect(yardstick).not.toBeNull();

      let hitBig = 0n;
      for (const b of hit) hitBig = (hitBig << 8n) | BigInt(b);
      let ysBig = 0n;
      for (const b of yardstick) ysBig = (ysBig << 8n) | BigInt(b);

      if (hitBig === 0n) {
        expect(level(h, DEVNET_TARGET)).toBe(LEVEL_CAP);
        continue;
      }
      if (hitBig > ysBig) {
        expect(level(h, DEVNET_TARGET)).toBeNull();
        continue;
      }
      let mu = 0;
      while ((hitBig << BigInt(mu + 1)) <= ysBig) mu++;
      expect(level(h, DEVNET_TARGET)).toBe(mu);
    }
  });

  it('returns null when powHit would return null', () => {
    expect(level(makeHeader({ height: 2, prevBlockHash: 'aa'.repeat(32), powNonce: NaN }), DEVNET_TARGET)).toBeNull();
  });

  it('returns null when anchorBits is outside orderingPowTarget domain', () => {
    expect(level(makeHeader({ height: 2, prevBlockHash: 'aa'.repeat(32) }), 70000)).toBeNull();
  });

  it('never throws', () => {
    for (const bad of [null, undefined, 42, 'str', {}, []]) {
      expect(() => level(bad as any, DEVNET_TARGET)).not.toThrow();
    }
  });

  // ---- Yardstick: a harder yardstick than the header's own target ----

  describe('yardstick harder than header target', () => {
    const HARDER_YARDSTICK = 3328;

    it('a header mined at 3072 against yardstick 3328: hit in (2^243, 2^244] → null', () => {
      const ysTarget = orderingPowTarget(HARDER_YARDSTICK)!;
      let ysBig = 0n;
      for (const b of ysTarget) ysBig = (ysBig << 8n) | BigInt(b);

      let foundNull = false;
      for (let attempt = 0; attempt < 200 && !foundNull; attempt++) {
        const h = mineHeader({ height: 2 + attempt, prevBlockHash: 'aa'.repeat(32) });
        const hit = powHit(h)!;
        let hitBig = 0n;
        for (const b of hit) hitBig = (hitBig << 8n) | BigInt(b);
        if (hitBig > ysBig) {
          expect(level(h, HARDER_YARDSTICK)).toBeNull();
          foundNull = true;
        }
      }
      expect(foundNull).toBe(true);
    });

    it('a header mined at 3072 against yardstick 3328: hit below yardstick → level ≥ 0', () => {
      const ysTarget = orderingPowTarget(HARDER_YARDSTICK)!;
      let ysBig = 0n;
      for (const b of ysTarget) ysBig = (ysBig << 8n) | BigInt(b);

      let foundLevel = false;
      for (let attempt = 0; attempt < 200 && !foundLevel; attempt++) {
        const h = mineHeader({ height: 2 + attempt, prevBlockHash: 'bb'.repeat(32) });
        const hit = powHit(h)!;
        let hitBig = 0n;
        for (const b of hit) hitBig = (hitBig << 8n) | BigInt(b);
        if (hitBig <= ysBig) {
          const lev = level(h, HARDER_YARDSTICK);
          expect(lev).not.toBeNull();
          expect(lev).toBeGreaterThanOrEqual(0);
          foundLevel = true;
        }
      }
      expect(foundLevel).toBe(true);
    });

    it('a header mined at 3328 against yardstick 3072 always → level ≥ 1', () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const h = mineHeader({
          height: 2 + attempt,
          prevBlockHash: 'cc'.repeat(32),
          powTargetBits: HARDER_YARDSTICK,
        });
        const lev = level(h, DEVNET_TARGET);
        expect(lev).not.toBeNull();
        expect(lev).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
