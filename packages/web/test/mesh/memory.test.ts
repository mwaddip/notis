// MESH_INTERFACE → What the client remembers — "A node's chain
// continues the kept one when `compareProofs(kept, node's)` does not
// answer the kept proof — the node's wins, or they tie". Proof-based
// cases: the `continues` predicate, `judgeByMemory`'s per-check
// verdict, `forkKey` and `nodesToRemember`.
//
// The chains come from `packages/nipopow/test/helpers.ts`'s
// `buildMinedChain` and `makeReader` reached by relative import — the
// same helpers the `compareProofs` suite builds its chains with.

import { describe, it, expect } from 'vitest';
import { profileFor } from '@dagsocial/types';
import { proveWithReader } from '@dagsocial/nipopow';
import type { NipopowProof } from '@dagsocial/nipopow';
import { DEFAULT_M, DEFAULT_K } from '@dagsocial/nipopow-client';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import { blockHash } from '@dagsocial/validation';
import {
  buildMinedChain,
  makeReader,
} from '../../../nipopow/test/helpers.js';
import {
  continues,
  judgeByMemory,
  forkKey,
  nodesToRemember,
} from '../../src/mesh/memory.js';
import { NodeList } from '../../src/mesh/node-list.js';
import type { MeshContact, NodeEntry } from '../../src/mesh/node-list.js';

const PROFILE = profileFor('devnet');
const M = DEFAULT_M;
const K = DEFAULT_K;
const MK = M + K;

function nodeTip(verified: boolean, proof: NipopowProof | null): NodeTipResult {
  return {
    url: 'http://x',
    verified,
    proof,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
    behind: null,
    genesisHash: null,
  };
}

function entry(over: Partial<NodeEntry>): NodeEntry {
  return {
    notisId: '0'.repeat(63) + '1',
    firstContact: false,
    byHand: false,
    status: 'ok',
    failures: 0,
    retryAtMs: 0,
    readMs: null,
    behindBy: null,
    addrs: [],
    droppedAddrs: [],
    evidence: null,
    lastFailure: null,
    lastFailures: {},
    transport: null,
    path: null,
    api: null,
    seenMs: null,
    ...over,
  };
}

describe('memory — continues', () => {
  it('a proof of the same chain one block on continues the kept one', () => {
    const kept = proveWithReader(makeReader(buildMinedChain({ count: MK })), { m: M, k: K });
    const next = proveWithReader(makeReader(buildMinedChain({ count: MK + 1 })), { m: M, k: K });
    expect(continues(kept, next, PROFILE)).toBe(true);
  });

  it('a fork from below the kept tip with less work above the fork does not', () => {
    const kept = proveWithReader(makeReader(buildMinedChain({ count: 100 })), { m: M, k: K });
    // A fork shares only block 1 — the stamp interval differs, so every
    // block from 2 up is a different header. The fork is at the floor
    // of the proof — 44 blocks — so its work above block 1 is well
    // below the kept chain's.
    const forkChain = buildMinedChain({ count: MK, stampIntervalMs: 60_001 });
    const forkProof = proveWithReader(makeReader(forkChain), { m: M, k: K });
    expect(continues(kept, forkProof, PROFILE)).toBe(false);
  });

  it('a heavier fork from below the kept tip does', () => {
    const kept = proveWithReader(makeReader(buildMinedChain({ count: MK })), { m: M, k: K });
    // Same shared block 1 (the stamp interval differs), but the fork is
    // deeper than the kept chain.
    const heavier = proveWithReader(
      makeReader(buildMinedChain({ count: 100, stampIntervalMs: 60_001 })),
      { m: M, k: K },
    );
    expect(continues(kept, heavier, PROFILE)).toBe(true);
  });
});

describe('memory — judgeByMemory', () => {
  it('losers listed, best is the heaviest continuing proof, refused nodes ignored', () => {
    const kept = proveWithReader(makeReader(buildMinedChain({ count: 100 })), { m: M, k: K });
    // Node 0: refused.
    const node0 = nodeTip(false, null);
    // Node 1: a fork at block 1 with less work above — lost.
    const lostProof = proveWithReader(
      makeReader(buildMinedChain({ count: MK, stampIntervalMs: 60_001 })),
      { m: M, k: K },
    );
    const node1 = nodeTip(true, lostProof);
    // Node 2: the same chain extended by one block — continues.
    const cont1 = proveWithReader(
      makeReader(buildMinedChain({ count: 101 })),
      { m: M, k: K },
    );
    const node2 = nodeTip(true, cont1);
    // Node 3: the same chain extended by two blocks — strictly beats
    // node 2 on `compareProofs`, so `best` names node 3.
    const cont2 = proveWithReader(
      makeReader(buildMinedChain({ count: 102 })),
      { m: M, k: K },
    );
    const node3 = nodeTip(true, cont2);

    const r = judgeByMemory(kept, [node0, node1, node2, node3], PROFILE);
    expect(r.lost).toEqual([1]);
    expect(r.best).toBe(3);
    expect(r.foreign).toBe(false);
  });

  it('foreign when every verified proof is incomparable', () => {
    // `forceLevels: new Map([[1, 1]])` solves block 1 for level ≥ 1, so
    // its `powNonce` differs from the default and its hash does too —
    // two chains with different block 1 hashes and therefore no common
    // ancestor. Devnet's profile pins no `genesisId`, so the two
    // proofs still verify.
    const chainA = buildMinedChain({ count: MK });
    const chainB = buildMinedChain({ count: MK, forceLevels: new Map([[1, 1]]) });
    const hashA = blockHash(chainA.headers[0]!);
    const hashB = blockHash(chainB.headers[0]!);
    expect(hashA).not.toBe(hashB);
    const proofA = proveWithReader(makeReader(chainA), { m: M, k: K });
    const proofB = proveWithReader(makeReader(chainB), { m: M, k: K });
    const r = judgeByMemory(proofA, [nodeTip(true, proofB)], PROFILE);
    expect(r.foreign).toBe(true);
    expect(r.best).toBeNull();
    expect(r.lost).toEqual([]);
  });
});

describe('memory — forkKey', () => {
  it('the hash of the highest header the two proofs share', () => {
    const chainA = buildMinedChain({ count: MK });
    const chainB = buildMinedChain({ count: MK, stampIntervalMs: 60_001 });
    const sharedHash = blockHash(chainA.headers[0]!);
    expect(blockHash(chainB.headers[0]!)).toBe(sharedHash);
    const proofA = proveWithReader(makeReader(chainA), { m: M, k: K });
    const proofB = proveWithReader(makeReader(chainB), { m: M, k: K });
    const fk = forkKey(proofA, proofB, PROFILE);
    expect(fk).toBe(sharedHash);
  });
});

describe('memory — nodesToRemember', () => {
  it('ok and trailing only, own key and blacklisted left out, private addresses dropped, capped, latest seen first', () => {
    const own = '0'.repeat(63) + '1';
    const idOf = (n: number): string => n.toString(16).padStart(64, '0');
    const addrPub = (ip: string): string => `/ip4/${ip}/udp/3456/webrtc-direct/certhash/uEiDXXXX/p2p/${'a'.repeat(52)}`;
    // One own entry, one private-address entry, one blacklisted, one
    // retry, two `ok` and two `trailing` seen at known times. The own
    // entry is excluded; the blacklisted and retry are too; the
    // private entry is dropped as its one address falls through
    // `isPrivate`. The remaining four are ordered latest-first by
    // `seenMs` and capped at 3 for the assertion.
    const entries: NodeEntry[] = [
      entry({ notisId: own, status: 'ok', addrs: [addrPub('1.1.1.1')], seenMs: 1000 }),
      entry({ notisId: idOf(0xa1), status: 'ok', addrs: [addrPub('192.168.1.5')], seenMs: 2000 }),
      entry({ notisId: idOf(0xa2), status: 'blacklisted', addrs: [addrPub('2.2.2.2')], seenMs: 3000 }),
      entry({ notisId: idOf(0xa3), status: 'retry', addrs: [addrPub('3.3.3.3')], seenMs: 4000 }),
      entry({ notisId: idOf(0xa4), status: 'ok', addrs: [addrPub('4.4.4.4')], seenMs: 5000 }),
      entry({ notisId: idOf(0xa5), status: 'trailing', addrs: [addrPub('5.5.5.5')], seenMs: 8000 }),
      entry({ notisId: idOf(0xa6), status: 'trailing', addrs: [addrPub('6.6.6.6')], seenMs: 7000 }),
      entry({ notisId: idOf(0xa7), status: 'ok', addrs: [addrPub('7.7.7.7')], seenMs: 6000 }),
    ];
    const out: MeshContact[] = nodesToRemember(entries, own, 3);
    // Latest first: a5 (8000), a6 (7000), a7 (6000). a4 (5000) is cut
    // by the cap. The private-address entry (a1) is dropped — its
    // one `192.168.*` address is refused by `isPrivate`.
    expect(out.map(n => n.notisId)).toEqual([idOf(0xa5), idOf(0xa6), idOf(0xa7)]);
    // None carry an `api` row (the brief: "no api").
    for (const n of out) expect(n.api).toBeUndefined();
  });

  it('entries with a public address come through — the NodeList itself drives seenMs', () => {
    // A NodeList success sets `seenMs` to the list's clock. Two
    // successes at distinct times, then `nodesToRemember` reads the
    // list's `entries()`: the latest-seen comes first, both carry an
    // `addrs` and no `api`.
    const own = '0'.repeat(63) + '1';
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    let t = 100;
    const list = new NodeList(
      [
        { notisId: idA, addrs: ['/ip4/8.8.8.8/udp/1/webrtc-direct'] },
        { notisId: idB, addrs: ['/ip4/9.9.9.9/udp/1/webrtc-direct'] },
      ],
      own,
      () => t,
    );
    t = 200; list.success(idA);
    t = 300; list.success(idB);
    const out = nodesToRemember(list.entries(), own, 16);
    expect(out.map(n => n.notisId)).toEqual([idB, idA]);
  });
});
