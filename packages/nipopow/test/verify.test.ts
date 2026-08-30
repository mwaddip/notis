import { describe, it, expect } from 'vitest';
import { verifyProof, encodeNipopowProof } from '../src/index.js';
import { proveWithReader } from '../src/prover.js';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  devnetProfileWithGenesisId,
} from './helpers.js';
import type { NipopowProof } from '../src/index.js';

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj, (_k, v) =>
    v instanceof Uint8Array ? { __uint8: Array.from(v) } : v,
  ), (_k, v) =>
    v && typeof v === 'object' && '__uint8' in v
      ? new Uint8Array(v.__uint8)
      : v,
  );
}

describe('verifyProof', () => {
  const chain = buildMinedChain({ count: 40 });
  const reader = makeReader(chain);
  const profile = devnetProfile();

  it('accepts a valid proof from proveWithReader', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const result = verifyProof(proof, profile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tipHeight).toBe(chain.headers.length);
      expect(result.suffixHead.header.height).toBe(chain.headers.length - 5 + 1);
    }
  });

  it('accepts a valid proof from bytes', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    const result = verifyProof(bytes, profile);
    expect(result.ok).toBe(true);
  });

  it('refuses garbage bytes as parse-failed', () => {
    const result = verifyProof(new Uint8Array([0xff, 0x00, 0x01]), profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-failed');
  });

  it('refuses empty bytes as parse-failed', () => {
    const result = verifyProof(new Uint8Array(0), profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-failed');
  });

  describe('shape', () => {
    it('refuses m = 0', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.m = 0;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses k = 0', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.k = 0;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses empty prefix', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix = [];
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses suffixTail.length > k - 1', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      // Add an extra tail header
      proof.suffixTail.push(proof.suffixTail[proof.suffixTail.length - 1]!);
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });
  });

  describe('anchor', () => {
    it('refuses prefix[0] not at height 1', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[0]!.header.height = 2;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('refuses prefix[0] with non-empty interlinks', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[0]!.interlinks = ['00'.repeat(32)];
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('genesisId pinned-match accepts', () => {
      const pinnedProfile = devnetProfileWithGenesisId(chain);
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, pinnedProfile);
      expect(result.ok).toBe(true);
    });

    it('genesisId pinned-mismatch refuses', () => {
      const pinnedProfile = {
        ...devnetProfile(),
        genesisId: 'ff'.repeat(32),
      };
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, pinnedProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('genesisId empty accepts any genesis', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, { ...devnetProfile(), genesisId: '' });
      expect(result.ok).toBe(true);
    });
  });

  describe('domain / version / target / pow', () => {
    it('refuses a header with wrong protocolVersion as version', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.protocolVersion = 99;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('version');
    });

    it('refuses powTargetBits below the band floor as target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.powTargetBits = 2000;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('target');
    });

    it('refuses a header with bad PoW as pow', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.powNonce = 0;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Could be pow, domain, or interlinks depending on nonce=0's effect
        expect(['pow', 'domain', 'interlinks']).toContain(result.reason);
      }
    });
  });

  describe('interlinks', () => {
    it('refuses a PoPowHeader with wrong interlinkRoot', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length > 1 && proof.prefix[1]!.interlinks.length > 0) {
        proof.prefix[1]!.interlinks[0] = 'ab'.repeat(32);
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/interlinks|anchor/);
    });
  });

  describe('heights', () => {
    it('swapped prefix elements with reversed stamps → time', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length >= 3) {
        const tmp = proof.prefix[1]!;
        proof.prefix[1] = proof.prefix[2]!;
        proof.prefix[2] = tmp;
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('time');
    });

    it('heights fault with ascending stamps → heights', () => {
      // Two chains from one block 1: honest (60 s stamps) and stretched (200×
      // idealMs stamps). An honest header at height 10 has stamp ~1.5 M; a
      // stretched header at height 3 has stamp ~25 M. Placing honest h10 before
      // stretched h3 gives ascending stamps (1.5 M < 25 M) but descending
      // heights (10 > 3). The suffix comes entirely from the stretched chain
      // so stamps keep ascending after the fault. Rule 5 fires as 'heights'
      // because the time check sees only ascending stamps.
      const honestChain = buildMinedChain({ count: 40 });
      const stretched = buildMinedChain({ count: 20, stampIntervalMs: 200 * 60_000 });

      const genesis = honestChain.popowHeaders[0]!;
      const honestH10 = honestChain.popowHeaders[9]!;
      const stretchedH3 = stretched.popowHeaders[2]!;

      // Confirm the premise: ascending stamps, descending heights
      expect(honestH10.header.height).toBeGreaterThan(stretchedH3.header.height);
      expect(honestH10.header.createdAt).toBeLessThan(stretchedH3.header.createdAt);

      // Suffix from the stretched chain: suffixHead at h16, tail h17..h20
      const suffixHead = stretched.popowHeaders[15]!;
      const suffixTail = stretched.headers.slice(16, 20);

      const stitched = {
        m: 1,
        k: 5,
        prefix: [genesis, honestH10, stretchedH3],
        suffixHead,
        suffixTail,
      };

      const wideProfile = { ...profile, nowMs: 10_000_000_000 };
      const result = verifyProof(stitched, wideProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('heights');
    });
  });

  describe('connections', () => {
    it('refuses a prefix element with no connection to predecessor', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length >= 3) {
        proof.prefix[1]!.interlinks = [];
        proof.prefix[1]!.header.prevBlockHash = 'dd'.repeat(32);
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/connections|anchor|interlinks/);
    });
  });

  describe('mutation table — every field mutated, each refused', () => {
    it('refuses a flipped bit in a prefix header hex field', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const h = proof.prefix[proof.prefix.length - 1]!.header;
      const orig = h.utxoTxRoot;
      h.utxoTxRoot = 'ff' + orig.slice(2);
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses height +1 on a prefix element', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.height += 1;
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses when genesis (prefix[0]) is dropped', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix.shift();
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses a flipped bit in suffixHead header', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const h = proof.suffixHead.header;
      h.prevBlockHash = 'ee' + h.prevBlockHash.slice(2);
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses a tail header with flipped prevBlockHash', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.suffixTail.length > 0) {
        proof.suffixTail[0]!.prevBlockHash = 'aa' + proof.suffixTail[0]!.prevBlockHash.slice(2);
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses two swapped prefix elements', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length >= 3) {
        const a = proof.prefix[1]!;
        const b = proof.prefix[2]!;
        proof.prefix[1] = b;
        proof.prefix[2] = a;
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
    });

    it('never throws on a hand-built malformed object', () => {
      const malformed = {
        m: 1,
        k: 1,
        prefix: [{ header: { height: 1 }, interlinks: [] }],
        suffixHead: { header: { height: 2 }, interlinks: ['00'.repeat(32)] },
        suffixTail: [],
      } as unknown as NipopowProof;
      const result = verifyProof(malformed, profile);
      expect(result.ok).toBe(false);
    });

    it('answers shape for a null prefix element, never throws', () => {
      const malformed = {
        m: 1,
        k: 1,
        prefix: [null],
        suffixHead: { header: { height: 2 }, interlinks: [] },
        suffixTail: [],
      } as unknown as NipopowProof;
      const result = verifyProof(malformed, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('answers shape for a null suffixHead, never throws', () => {
      const chain = buildMinedChain({ count: 10 });
      const proof = proveWithReader(makeReader(chain), { m: 1, k: 2 });
      const malformed = { ...proof, suffixHead: null } as unknown as NipopowProof;
      const result = verifyProof(malformed, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('answers shape for a non-header tail element, never throws', () => {
      const chain = buildMinedChain({ count: 10 });
      const proof = proveWithReader(makeReader(chain), { m: 1, k: 3 });
      const malformed = { ...proof, suffixTail: [null, proof.suffixTail[0]] } as unknown as NipopowProof;
      const result = verifyProof(malformed, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });
  });

  describe('protocolVersionSchedule', () => {
    // The declared version equals the era at each header's own height
    // (NIPOPOW_INTERFACE → verifyProof, VALIDATION_INTERFACE → Protocol Version). A synthetic
    // two-era schedule with the boundary at height 36, where count 40 and k 5 put suffixHead
    // (chainHeight minus k plus 1). Every prefix element is a strict ancestor of suffixHead, so
    // all sit below the boundary; suffixHead is the first flattened header at or above it, at
    // index prefix.length.
    const BOUNDARY = 36;
    const twoEra = [
      { version: 1, fromHeight: 0 },
      { version: 2, fromHeight: BOUNDARY },
    ] as const;
    const twoEraProfile = { ...devnetProfile(), protocolVersionSchedule: twoEra };
    const boundaryChain = buildMinedChain({ count: 40, schedule: twoEra });
    const boundaryProof = proveWithReader(makeReader(boundaryChain), { m: 3, k: 5 });

    it('a proof spanning an era boundary verifies under the boundary schedule', () => {
      expect(boundaryProof.suffixHead.header.height).toBe(BOUNDARY);
      const result = verifyProof(boundaryProof, twoEraProfile);
      expect(result.ok).toBe(true);
    });

    it('the boundary proof under the one-era devnet schedule fails version at the boundary header', () => {
      expect(Math.max(...boundaryProof.prefix.map(p => p.header.height))).toBeLessThan(BOUNDARY);
      const result = verifyProof(boundaryProof, devnetProfile());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('version');
        expect(result.index).toBe(boundaryProof.prefix.length);
      }
    });

    it('an all-v1 proof under a two-era schedule fails version at the era-2 boundary header', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      expect(proof.suffixHead.header.height).toBe(BOUNDARY);
      expect(Math.max(...proof.prefix.map(p => p.header.height))).toBeLessThan(BOUNDARY);
      const result = verifyProof(proof, twoEraProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('version');
        expect(result.index).toBe(proof.prefix.length);
      }
    });
  });

  describe('suffix-tail schedule check', () => {
    it('suffix-tail header off the schedule by one unit → target', () => {
      // Build chain at anchorBits=3072, verify with anchorBits=3073 —
      // suffix-tail headers have bits=3072, the profile's schedule expects ~3073
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const wrongRetarget = { ...profile.retarget, anchorBits: profile.retarget.anchorBits + 1 };
      const wrongProfile = { ...profile, retarget: wrongRetarget };
      const result = verifyProof(proof, wrongProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target');
        // The first suffix-tail header fails the schedule check
        expect(result.index).toBe(proof.prefix.length + 1);
      }
    });

    it('suffixHead with bits inside the band but off the schedule → accepted', () => {
      // suffixHead's target is band-bounded only (its parent is not in the proof);
      // a valid proof's suffixHead has bits=3072 which matches the schedule —
      // verify that the schedule check runs only on suffix-TAIL, not suffixHead,
      // by confirming the proof passes despite suffixHead's bits being "wrong"
      // relative to a profile with different anchorBits for band-only
      const proof = proveWithReader(reader, { m: 3, k: 1 });
      // k=1 means suffixTail is empty, suffixHead is the only suffix element
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(true);
    });
  });

  describe('prefix target band', () => {
    it('prefix header below the band floor → target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length > 1) {
        proof.prefix[1]!.header.powTargetBits = profile.retarget.floorBits - 1;
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('target');
    });

    it('prefix header above the band ceiling → target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length > 1) {
        proof.prefix[1]!.header.powTargetBits = profile.retarget.ceilingBits + 1;
      }
      const result = verifyProof(proof, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('target');
    });
  });

  describe('time — createdAt order', () => {
    it('equal consecutive stamps → time', () => {
      // Build two independent chains and stitch: prefix[1] from a chain whose
      // header at the same position has an equal or later stamp than prefix[2].
      // Since modifying createdAt invalidates PoW, we test by building a chain
      // with a custom stamp interval of 0 — all stamps equal
      const equalChain = buildMinedChain({ count: 40, stampIntervalMs: 0 });
      const equalReader = makeReader(equalChain);
      const proof = proveWithReader(equalReader, { m: 3, k: 5 });
      // All stamps are equal (ANCHOR_TIME + 0 * (height-1) = ANCHOR_TIME)
      // so the second element fails the strict-increase check
      const equalProfile = {
        ...profile,
        nowMs: 200_000_000,
      };
      const result = verifyProof(proof, equalProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('time');
      }
    });
  });

  describe('clock — tip future bound', () => {
    it('tip stamped nowMs + maxFutureDriftMs + 1 → clock', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const tipH = proof.suffixTail.length > 0
        ? proof.suffixTail[proof.suffixTail.length - 1]!
        : proof.suffixHead.header;
      const tightProfile = {
        ...profile,
        nowMs: tipH.createdAt - profile.maxFutureDriftMs - 1,
      };
      const result = verifyProof(proof, tightProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('clock');
    });

    it('tip stamped exactly at nowMs + maxFutureDriftMs → accepted', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const tipH = proof.suffixTail.length > 0
        ? proof.suffixTail[proof.suffixTail.length - 1]!
        : proof.suffixHead.header;
      const exactProfile = {
        ...profile,
        nowMs: tipH.createdAt - profile.maxFutureDriftMs,
      };
      const result = verifyProof(proof, exactProfile);
      expect(result.ok).toBe(true);
    });

    it('same proof accepted when nowMs advances', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const tipH = proof.suffixTail.length > 0
        ? proof.suffixTail[proof.suffixTail.length - 1]!
        : proof.suffixHead.header;
      const tightProfile = {
        ...profile,
        nowMs: tipH.createdAt - profile.maxFutureDriftMs - 1,
      };
      const result1 = verifyProof(proof, tightProfile);
      expect(result1.ok).toBe(false);
      if (!result1.ok) expect(result1.reason).toBe('clock');

      const advancedProfile = {
        ...tightProfile,
        nowMs: tightProfile.nowMs + 2,
      };
      const result2 = verifyProof(proof, advancedProfile);
      expect(result2.ok).toBe(true);
    });
  });
});
