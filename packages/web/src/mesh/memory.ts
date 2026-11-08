// MESH_INTERFACE → What the client remembers — "A client remembers,
// per network, the nodes it found, the proof of the chain it verified,
// and the forks the reader answered". The helpers that judge a node's
// proof against the kept one (`continues`, `judgeByMemory`), that
// name the fork two proofs share (`forkKey`), and that pick the
// entries the client records after a check (`nodesToRemember`).
//
// Pure, browser-safe (`MESH_INTERFACE → Place in the workspace`): no
// `node:` import, no global state.

import { compareProofs } from '@dagsocial/nipopow';
import type { NipopowProof } from '@dagsocial/nipopow';
import { DEFAULT_M, DEFAULT_K, verifierProfile } from '@dagsocial/nipopow-client';
import type { NodeTipResult } from '@dagsocial/nipopow-client';
import type { NetworkProfile } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { multiaddr } from '@multiformats/multiaddr';
import { isPrivate } from '@libp2p/utils';
import type { MeshContact, NodeEntry } from './node-list.js';

/**
 * MESH_INTERFACE → What the client remembers — "A node's chain continues
 * the kept one when `compareProofs(kept, node's)` does not answer the
 * kept proof — the node's wins, or they tie". `incomparable` is not
 * `continues` (`foreign` in `judgeByMemory` speaks for it); the caller
 * uses the client's own `DEFAULT_M` and `DEFAULT_K`
 * (`NIPOPOW_INTERFACE → compareProofs`).
 */
export function continues(
  kept: NipopowProof,
  proof: NipopowProof,
  profile: NetworkProfile,
): boolean {
  const r = compareProofs(
    kept,
    proof,
    { m: DEFAULT_M, k: DEFAULT_K },
    verifierProfile(profile, Date.now()),
  );
  return r.verdict === 'b' || r.verdict === 'tie';
}

/**
 * MESH_INTERFACE → What the client remembers — the per-check verdict
 * over a check's verified proofs. `lost` the indexes whose proof does
 * not continue the kept one; `best` the index of the not-lost proof no
 * other not-lost proof beats under `compareProofs` (earliest index on a
 * tie), `null` with none; `foreign` true when at least one verified
 * proof exists and every one is `incomparable` with the kept proof.
 * An `incomparable` proof is never `best` and never `lost` — `foreign`
 * speaks for it.
 */
export function judgeByMemory(
  kept: NipopowProof,
  nodes: readonly NodeTipResult[],
  profile: NetworkProfile,
): { lost: number[]; best: number | null; foreign: boolean } {
  const vp = verifierProfile(profile, Date.now());
  const params = { m: DEFAULT_M, k: DEFAULT_K };
  const lost: number[] = [];
  const candidates: number[] = [];
  let verifiedWithProof = 0;
  let incomparableCount = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (!n.verified) continue;
    if (n.proof === null) continue;
    verifiedWithProof += 1;
    const r = compareProofs(kept, n.proof, params, vp);
    if (r.verdict === 'a') {
      lost.push(i);
    } else if (r.verdict === 'b' || r.verdict === 'tie') {
      candidates.push(i);
    } else {
      // 'incomparable' — neither best nor lost.
      incomparableCount += 1;
    }
  }
  const foreign = verifiedWithProof > 0 && incomparableCount === verifiedWithProof;
  let best: number | null = null;
  for (const i of candidates) {
    let beaten = false;
    for (const j of candidates) {
      if (i === j) continue;
      const r = compareProofs(nodes[i]!.proof!, nodes[j]!.proof!, params, vp);
      if (r.verdict === 'b') { beaten = true; break; }
    }
    if (!beaten) { best = i; break; }
  }
  return { lost, best, foreign };
}

/**
 * MESH_INTERFACE → No anchor reached → "A disagreement is the reader's
 * question" — the fork the two proofs share: the lowercase hex
 * `blockHash` of `compareProofs`'s `lca`. `null` when the proofs are
 * `incomparable` (no common ancestor, or either proof invalid).
 */
export function forkKey(
  a: NipopowProof,
  b: NipopowProof,
  profile: NetworkProfile,
): string | null {
  const r = compareProofs(
    a,
    b,
    { m: DEFAULT_M, k: DEFAULT_K },
    verifierProfile(profile, Date.now()),
  );
  if (r.verdict === 'incomparable') return null;
  return blockHash(r.lca);
}

/**
 * MESH_INTERFACE → What the client remembers — "After each check it
 * records every node naming a tip on its chain, `ok` or `trailing`,
 * with the addresses it would dial — no private address, never its
 * own key — the most recently seen first, at most
 * `REMEMBERED_NODES_MAX`". `isPrivate` from `@libp2p/utils` reads the
 * first network component of an address; an address whose first
 * component carries no IP (a `/p2p-circuit/` one included) is kept,
 * not refused — a private IP there still gates its own dial through
 * the client's gater.
 */
export function nodesToRemember(
  entries: readonly NodeEntry[],
  ownId: string,
  cap: number,
): MeshContact[] {
  const kept: Array<{ seenMs: number; order: number; contact: MeshContact }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.status !== 'ok' && e.status !== 'trailing') continue;
    if (e.notisId === ownId) continue;
    const addrs: string[] = [];
    for (const addr of e.addrs) {
      if (addressIsPrivate(addr)) continue;
      addrs.push(addr);
    }
    if (addrs.length === 0) continue;
    // `ok`/`trailing` imply a success/trailing event ran and `seenMs`
    // is set; the `-Infinity` fallback is defensive and sorts such an
    // entry to the oldest.
    const seen = e.seenMs ?? -Infinity;
    kept.push({ seenMs: seen, order: i, contact: { notisId: e.notisId, addrs } });
  }
  kept.sort((a, b) => {
    if (a.seenMs !== b.seenMs) return b.seenMs - a.seenMs;
    return a.order - b.order;
  });
  return kept.slice(0, cap).map(k => k.contact);
}

function addressIsPrivate(addr: string): boolean {
  let ma;
  try {
    ma = multiaddr(addr);
  } catch {
    return false;
  }
  return isPrivate(ma);
}
