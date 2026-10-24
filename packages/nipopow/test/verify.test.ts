import { describe, it, expect } from 'vitest';
import { verifyProof, encodeNipopowProof } from '../src/index.js';
import { proveWithReader } from '../src/prover.js';
import {
  buildMinedChain,
  makeReader,
  devnetProfile,
  devnetProfileWithGenesisId,
  solveHeaderPow,
  DEVNET_RETARGET,
} from './helpers.js';
import type { NipopowProof, PoPowHeader } from '../src/index.js';
import type { BlockHeader } from '@dagsocial/types';
import {
  EMPTY_STATE_ROOT,
  NETWORK_PROFILES,
  interlinkRoot,
  protocolVersionAt,
  updateInterlinks,
} from '@dagsocial/types';
import {
  asertTargetBits,
  blockHash,
  level as headerLevel,
  verifyOrderingBlockPoW,
} from '@dagsocial/validation';

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
    const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tipHeight).toBe(chain.headers.length);
      expect(result.suffixHead.header.height).toBe(chain.headers.length - 5 + 1);
    }
  });

  it('accepts a valid proof from bytes', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const bytes = encodeNipopowProof(proof);
    const result = verifyProof(bytes, { m: proof.m, k: proof.k }, profile);
    expect(result.ok).toBe(true);
  });

  it('refuses garbage bytes as parse-failed', () => {
    const result = verifyProof(new Uint8Array([0xff, 0x00, 0x01]), { m: 1, k: 1 }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-failed');
  });

  it('refuses empty bytes as parse-failed', () => {
    const result = verifyProof(new Uint8Array(0), { m: 1, k: 1 }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-failed');
  });

  describe('shape', () => {
    it('refuses m = 0', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.m = 0;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses k = 0', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.k = 0;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses empty prefix', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix = [];
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('refuses suffixTail.length > k - 1', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      // Add an extra tail header
      proof.suffixTail.push(proof.suffixTail[proof.suffixTail.length - 1]!);
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });
  });

  describe('anchor', () => {
    it('refuses prefix[0] not at height 1', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[0]!.header.height = 2;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('refuses prefix[0] with non-empty interlinks', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[0]!.interlinks = ['00'.repeat(32)];
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('genesisId pinned-match accepts', () => {
      const pinnedProfile = devnetProfileWithGenesisId(chain);
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, pinnedProfile);
      expect(result.ok).toBe(true);
    });

    it('genesisId pinned-mismatch refuses', () => {
      const pinnedProfile = {
        ...devnetProfile(),
        genesisId: 'ff'.repeat(32),
      };
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, pinnedProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('anchor');
    });

    it('genesisId empty accepts any genesis', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, { ...devnetProfile(), genesisId: '' });
      expect(result.ok).toBe(true);
    });
  });

  describe('domain / version / target / pow', () => {
    it('refuses a header with wrong protocolVersion as version', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.protocolVersion = 99;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('version');
    });

    it('refuses powTargetBits below the band floor as target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.powTargetBits = 2000;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('target');
    });

    it('refuses a header with bad PoW as pow', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.powNonce = 0;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(stitched, { m: stitched.m, k: stitched.k }, wideProfile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses height +1 on a prefix element', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix[1]!.header.height += 1;
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses when genesis (prefix[0]) is dropped', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      proof.prefix.shift();
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses a flipped bit in suffixHead header', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const h = proof.suffixHead.header;
      h.prevBlockHash = 'ee' + h.prevBlockHash.slice(2);
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
    });

    it('refuses a tail header with flipped prevBlockHash', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.suffixTail.length > 0) {
        proof.suffixTail[0]!.prevBlockHash = 'aa' + proof.suffixTail[0]!.prevBlockHash.slice(2);
      }
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(malformed, { m: 1, k: 1 }, profile);
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
      const result = verifyProof(malformed, { m: 1, k: 1 }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('answers shape for a null suffixHead, never throws', () => {
      const chain = buildMinedChain({ count: 10 });
      const proof = proveWithReader(makeReader(chain), { m: 1, k: 2 });
      const malformed = { ...proof, suffixHead: null } as unknown as NipopowProof;
      const result = verifyProof(malformed, { m: 1, k: 1 }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('shape');
    });

    it('answers shape for a non-header tail element, never throws', () => {
      const chain = buildMinedChain({ count: 10 });
      const proof = proveWithReader(makeReader(chain), { m: 1, k: 3 });
      const malformed = { ...proof, suffixTail: [null, proof.suffixTail[0]] } as unknown as NipopowProof;
      const result = verifyProof(malformed, { m: 1, k: 1 }, profile);
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
      const result = verifyProof(boundaryProof, { m: boundaryProof.m, k: boundaryProof.k }, twoEraProfile);
      expect(result.ok).toBe(true);
    });

    it('the boundary proof under the one-era devnet schedule fails version at the boundary header', () => {
      expect(Math.max(...boundaryProof.prefix.map(p => p.header.height))).toBeLessThan(BOUNDARY);
      const result = verifyProof(boundaryProof, { m: boundaryProof.m, k: boundaryProof.k }, devnetProfile());
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, twoEraProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('version');
        expect(result.index).toBe(proof.prefix.length);
      }
    });
  });

  describe('suffix-tail schedule check', () => {
    it('suffix-tail header off the schedule by one unit → target', () => {
      // NIPOPOW_INTERFACE → verifyProof. The chain is on the profile's schedule;
      // the first tail header's powTargetBits is moved one unit inside the band
      // and its nonce re-solved, so PoW holds and the schedule check is reached.
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const tail0 = proof.suffixTail[0]!;
      tail0.powTargetBits = tail0.powTargetBits + 1;
      tail0.powNonce = solveHeaderPow(tail0);
      expect(verifyOrderingBlockPoW(tail0)).toBe(true);
      expect(tail0.powTargetBits).toBeGreaterThanOrEqual(profile.retarget.floorBits);
      expect(tail0.powTargetBits).toBeLessThanOrEqual(profile.retarget.ceilingBits);
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target');
        // The first suffix-tail header fails the schedule check
        expect(result.index).toBe(proof.prefix.length + 1);
      }
    });

    // NIPOPOW_INTERFACE → verifyProof. The suffix head's parent is the last
    // prefix element in an honest proof, so under the schedule rule its bits
    // are refused at index prefix.length when they move one unit inside the
    // band and the nonce is re-solved so PoW holds.
    it('the suffix head, parent-linked, off by one unit → target at prefix.length', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      const lastPrefix = proof.prefix[proof.prefix.length - 1]!;
      const lastPrefixHash = blockHash(lastPrefix.header);
      expect(proof.suffixHead.header.prevBlockHash).toBe(lastPrefixHash);

      const sh = proof.suffixHead.header;
      sh.powTargetBits = sh.powTargetBits + 1;
      sh.powNonce = solveHeaderPow(sh);
      expect(verifyOrderingBlockPoW(sh)).toBe(true);
      expect(sh.powTargetBits).toBeGreaterThanOrEqual(profile.retarget.floorBits);
      expect(sh.powTargetBits).toBeLessThanOrEqual(profile.retarget.ceilingBits);

      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target');
        expect(result.index).toBe(proof.prefix.length);
      }
    });
  });

  // NIPOPOW_INTERFACE → verifyProof. The chained-target rule across the
  // flattened sequence: block 1 carries profile.retarget.anchorBits; every
  // other element whose prevBlockHash is the blockHash of the element before
  // it carries asertTargetBits over that previous element.
  describe('chained-target schedule — the rule across the flattened sequence', () => {
    it('block 1 off the profile anchor by one unit → target at index 0', () => {
      const proof = proveWithReader(reader, { m: 3, k: 5 });
      const wrongRetarget = { ...profile.retarget, anchorBits: profile.retarget.anchorBits + 1 };
      const wrongProfile = { ...profile, retarget: wrongRetarget };
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, wrongProfile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target');
        expect(result.index).toBe(0);
      }
    });

    // A chain of 100 at the client's m places anchoringHeight well below the
    // suffix on an honest chain, so the level-0 sweep carries at least three
    // contiguous heights; the picked header is neither the sweep's first
    // (where the predecessor in the proof is a vector hop) nor its last.
    it('a level-0 sweep header, parent-linked, off by one unit → target at its index', () => {
      const localChain = buildMinedChain({ count: 100 });
      const localReader = makeReader(localChain);
      const proof = clone(proveWithReader(localReader, { m: 24, k: 5 }));

      const heights = proof.prefix.map(ph => ph.header.height);
      let idx = -1;
      for (let i = 2; i < heights.length - 1; i++) {
        if (heights[i]! === heights[i - 1]! + 1 && heights[i + 1]! === heights[i]! + 1) {
          idx = i;
          break;
        }
      }
      expect(idx).toBeGreaterThan(-1);
      expect(proof.prefix[idx]!.header.prevBlockHash).toBe(blockHash(proof.prefix[idx - 1]!.header));

      const h = proof.prefix[idx]!.header;
      h.powTargetBits = h.powTargetBits + 1;
      h.powNonce = solveHeaderPow(h);
      expect(verifyOrderingBlockPoW(h)).toBe(true);
      expect(h.powTargetBits).toBeGreaterThanOrEqual(profile.retarget.floorBits);
      expect(h.powTargetBits).toBeLessThanOrEqual(profile.retarget.ceilingBits);

      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('target');
        expect(result.index).toBe(idx);
      }
    });

    // A stretched chain whose targets walk to the floor by block 7, with
    // forced level-1 at heights 2, 5 and 15 so the proof contains vector hops
    // below the sweep. The flattened sequence carries at least two distinct
    // powTargetBits across its parent-linked members, and at least one
    // vector-hop element whose bits differ from asertTargetBits over the
    // element before it — the band-alone arm.
    it('a proof over a chain whose targets move passes', () => {
      const forced = new Map<number, number>([[2, 1], [5, 1], [15, 1]]);
      const stretched = buildMinedChain({ count: 20, stampIntervalMs: 200 * 60_000, forceLevels: forced });
      const stretchedReader = makeReader(stretched);
      const stretchedProof = proveWithReader(stretchedReader, { m: 1, k: 5 });

      const flat: BlockHeader[] = [
        ...stretchedProof.prefix.map(ph => ph.header),
        stretchedProof.suffixHead.header,
        ...stretchedProof.suffixTail,
      ];
      const t_a = stretchedProof.prefix[0]!.header.createdAt;

      const parentLinkedBits = new Set<number>();
      let hopOffSchedule = false;
      for (let i = 1; i < flat.length; i++) {
        const prev = flat[i - 1]!;
        const cur = flat[i]!;
        const prevHash = blockHash(prev);
        if (prevHash !== null && cur.prevBlockHash === prevHash) {
          parentLinkedBits.add(cur.powTargetBits);
        } else {
          const scheduled = asertTargetBits(DEVNET_RETARGET, t_a, {
            height: prev.height,
            createdAt: prev.createdAt,
          });
          if (cur.powTargetBits !== scheduled) hopOffSchedule = true;
        }
      }
      expect(parentLinkedBits.size).toBeGreaterThanOrEqual(2);
      expect(hopOffSchedule).toBe(true);

      const nowMs = flat[flat.length - 1]!.createdAt + 1_000;
      const stretchedProfile = { ...devnetProfile(), nowMs };
      const result = verifyProof(stretchedProof, { m: stretchedProof.m, k: stretchedProof.k }, stretchedProfile);
      expect(result.ok).toBe(true);
    });
  });

  describe('prefix target band', () => {
    it('prefix header below the band floor → target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length > 1) {
        proof.prefix[1]!.header.powTargetBits = profile.retarget.floorBits - 1;
      }
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('target');
    });

    it('prefix header above the band ceiling → target', () => {
      const proof = clone(proveWithReader(reader, { m: 3, k: 5 }));
      if (proof.prefix.length > 1) {
        proof.prefix[1]!.header.powTargetBits = profile.retarget.ceilingBits + 1;
      }
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, profile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, equalProfile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, tightProfile);
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
      const result = verifyProof(proof, { m: proof.m, k: proof.k }, exactProfile);
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
      const result1 = verifyProof(proof, { m: proof.m, k: proof.k }, tightProfile);
      expect(result1.ok).toBe(false);
      if (!result1.ok) expect(result1.reason).toBe('clock');

      const advancedProfile = {
        ...tightProfile,
        nowMs: tightProfile.nowMs + 2,
      };
      const result2 = verifyProof(proof, { m: proof.m, k: proof.k }, advancedProfile);
      expect(result2.ok).toBe(true);
    });
  });
});

// NIPOPOW_INTERFACE → verifyProof — "Shape": `m` and `k` equal `params.m` and `params.k`,
// each at least 1; `prefix` non-empty; `suffixTail.length === k − 1` (`shape`). Also:
// NIPOPOW_INTERFACE → "A proof is held to the client's own parameters".
describe('shape — tail length exactly k − 1', () => {
  const chain = buildMinedChain({ count: 40 });
  const reader = makeReader(chain);
  const profile = devnetProfile();

  it('a proof whose tail is shorter than k − 1 is refused shape as an object', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    expect(proof.suffixTail.length).toBe(4);
    const shortened: NipopowProof = { ...proof, suffixTail: proof.suffixTail.slice(0, 3) };
    expect(shortened.suffixTail.length).toBe(3);
    const result = verifyProof(shortened, { m: shortened.m, k: shortened.k }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shape');
  });

  it('a proof whose tail is shorter than k − 1 is refused parse-failed by verifyProof on bytes', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const shortened: NipopowProof = { ...proof, suffixTail: proof.suffixTail.slice(0, 3) };
    const bytes = encodeNipopowProof(shortened);
    const result = verifyProof(bytes, { m: proof.m, k: proof.k }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('parse-failed');
  });
});

// NIPOPOW_INTERFACE → verifyProof — "Shape": `m` and `k` equal `params.m` and `params.k`.
describe('params rule 1 — verifyProof holds the proof to its own m and k', () => {
  const chain = buildMinedChain({ count: 40 });
  const reader = makeReader(chain);
  const profile = devnetProfile();

  it('a proof built with { m: 3, k: 5 } is accepted under { m: 3, k: 5 }', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    const result = verifyProof(proof, { m: 3, k: 5 }, profile);
    expect(result.ok).toBe(true);
  });

  it('a proof built with { m: 3, k: 5 } is refused shape under { m: 3, k: 6 }', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    expect(proof.k).toBe(5);
    const result = verifyProof(proof, { m: 3, k: 6 }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shape');
  });

  it('a proof built with { m: 3, k: 5 } is refused shape under { m: 4, k: 5 }', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    expect(proof.m).toBe(3);
    const result = verifyProof(proof, { m: 4, k: 5 }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('shape');
  });
});

// NIPOPOW_INTERFACE → verifyProof — "Heights": heights strictly increase across the
// flattened sequence, and an element whose `prevBlockHash` is the `blockHash` of the
// element before it sits exactly one height above it (`heights`).
describe('heights rule 5 — parent-linked and exactly one above', () => {
  const chain = buildMinedChain({ count: 40 });
  const reader = makeReader(chain);
  const profile = devnetProfile();
  const schedule = NETWORK_PROFILES.devnet.protocolVersionSchedule;

  it('a tail header one height above its parent is refused heights at its index', () => {
    const proof = proveWithReader(reader, { m: 3, k: 5 });
    expect(proof.suffixTail.length).toBe(4);
    const prev = proof.suffixTail[proof.suffixTail.length - 2]!;
    const prevHash = blockHash(prev);
    expect(prevHash).not.toBeNull();

    const t_a = chain.headers[0]!.createdAt;
    const scheduledBits = asertTargetBits(DEVNET_RETARGET, t_a, {
      height: prev.height,
      createdAt: prev.createdAt,
    });
    const forgedHeight = prev.height + 2;
    const forgedCreatedAt = prev.createdAt + DEVNET_RETARGET.idealMs;
    const version = protocolVersionAt(schedule, forgedHeight);
    expect(version).not.toBeNull();
    const forged: BlockHeader = {
      protocolVersion: version!,
      height: forgedHeight,
      prevBlockHash: prevHash!,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: scheduledBits,
      createdAt: forgedCreatedAt,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    };
    forged.powNonce = solveHeaderPow(forged);
    expect(verifyOrderingBlockPoW(forged)).toBe(true);
    expect(forged.height).toBe(prev.height + 2);

    const mutated: NipopowProof = {
      ...proof,
      suffixTail: [...proof.suffixTail.slice(0, -1), forged],
    };
    const faultIndex = mutated.prefix.length + 1 + (mutated.suffixTail.length - 1);
    const result = verifyProof(mutated, { m: mutated.m, k: mutated.k }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('heights');
      expect(result.index).toBe(faultIndex);
    }
  });

  it('a prefix header one height above its parent in the level-0 span is refused heights at its index', () => {
    const smallChain = buildMinedChain({ count: 10 });
    const anchor = smallChain.popowHeaders[0]!;
    const base = smallChain.popowHeaders[4]!;
    const baseHash = blockHash(base.header);
    expect(baseHash).not.toBeNull();

    const anchorBits = DEVNET_RETARGET.anchorBits;
    const baseLevel = headerLevel(base.header, anchorBits);

    const forgedPrefixHeight = base.header.height + 2;
    const forgedCreatedAt = base.header.createdAt + 2 * DEVNET_RETARGET.idealMs;
    const forgedInterlinks = updateInterlinks(base.interlinks, baseHash!, baseLevel);
    const forgedPrefixHeader: BlockHeader = {
      protocolVersion: protocolVersionAt(schedule, forgedPrefixHeight)!,
      height: forgedPrefixHeight,
      prevBlockHash: baseHash!,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: anchorBits,
      createdAt: forgedCreatedAt,
      interlinkRoot: interlinkRoot(forgedInterlinks),
      adProofsRoot: '00'.repeat(32),
    };
    forgedPrefixHeader.powNonce = solveHeaderPow(forgedPrefixHeader);
    expect(verifyOrderingBlockPoW(forgedPrefixHeader)).toBe(true);
    const forgedPrefix: PoPowHeader = {
      header: forgedPrefixHeader,
      interlinks: forgedInterlinks,
    };
    const forgedPrefixHash = blockHash(forgedPrefixHeader);
    expect(forgedPrefixHash).not.toBeNull();
    const forgedPrefixLevel = headerLevel(forgedPrefixHeader, anchorBits);

    const headHeight = forgedPrefixHeight + 1;
    const headCreatedAt = forgedCreatedAt + DEVNET_RETARGET.idealMs;
    const headInterlinks = updateInterlinks(
      forgedInterlinks,
      forgedPrefixHash!,
      forgedPrefixLevel,
    );
    const headHeader: BlockHeader = {
      protocolVersion: protocolVersionAt(schedule, headHeight)!,
      height: headHeight,
      prevBlockHash: forgedPrefixHash!,
      utxoTxRoot: '00'.repeat(32),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32),
      powNonce: 0,
      powTargetBits: anchorBits,
      createdAt: headCreatedAt,
      interlinkRoot: interlinkRoot(headInterlinks),
      adProofsRoot: '00'.repeat(32),
    };
    headHeader.powNonce = solveHeaderPow(headHeader);
    expect(verifyOrderingBlockPoW(headHeader)).toBe(true);
    const suffixHead: PoPowHeader = { header: headHeader, interlinks: headInterlinks };

    const stitched: NipopowProof = {
      m: 1,
      k: 1,
      prefix: [anchor, base, forgedPrefix],
      suffixHead,
      suffixTail: [],
    };
    const faultIndex = 2;
    const result = verifyProof(stitched, { m: stitched.m, k: stitched.k }, profile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('heights');
      expect(result.index).toBe(faultIndex);
    }
  });
});
