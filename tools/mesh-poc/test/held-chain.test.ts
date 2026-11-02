import { describe, it, expect } from 'vitest';
import {
  profileFor,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BlockHeader, NetworkProfile, OrderingBlock } from '@dagsocial/types';
import {
  asertTargetBits,
  blockHash,
} from '@dagsocial/validation';
import { verifierProfile } from '@dagsocial/nipopow-client';
import { HeldChain } from '../src/client/held-chain.js';
import { makeBlockAt, makeLinkedChain } from './helpers/devnet-block.js';

// MESH_INTERFACE → The client's node list → "The client's chain" — the
// window holds the last `k` headers of the client's chain and block 1's
// header beside it; `settle` seats both from a verified proof, `place`
// classifies a hash+height, `extend` and `link` move the tip under the
// held rules, and `scheduledTargetBits` reproduces the schedule the proof
// held each header to (NIPOPOW_INTERFACE → verifyProof — the retarget).

const devnetProfile: NetworkProfile = profileFor('devnet');
const K = 5;
const retarget = verifierProfile(devnetProfile, 0).retarget;

function hashOf(h: BlockHeader): string {
  const hex = blockHash(h);
  if (hex === null) throw new Error('header outside the encodable domain');
  return hex;
}

/**
 * Build a chain of `n` ordering blocks, settle a HeldChain with the top-`k`
 * suffix and block 1, and answer the chain and the seated instance so a
 * case can read either (the window alone, or the whole chain for linking
 * cases).
 */
function seatedChain(n: number, k: number = K): {
  chain: OrderingBlock[];
  held: HeldChain;
} {
  const chain = makeLinkedChain(n, devnetProfile);
  const held = new HeldChain(devnetProfile, k);
  const suffix = chain.slice(n - k).map(b => b.header);
  held.settle(suffix, chain[0]!.header);
  return { chain, held };
}

describe('HeldChain — before settle', () => {
  it('settled() is false, tip() is null', () => {
    const h = new HeldChain(devnetProfile, K);
    expect(h.settled()).toBe(false);
    expect(h.tip()).toBeNull();
  });

  it('place answers unplaced for any hash and height', () => {
    const h = new HeldChain(devnetProfile, K);
    expect(h.place('00'.repeat(32), 1)).toBe('unplaced');
    expect(h.place('ff'.repeat(32), 100)).toBe('unplaced');
    expect(h.place(null, 1)).toBe('unplaced');
  });

  it('extend answers gap for any header', () => {
    const h = new HeldChain(devnetProfile, K);
    const [block1] = makeLinkedChain(1, devnetProfile);
    expect(h.extend(block1!.header)).toBe('gap');
  });

  it('standing answers null for any hash', () => {
    const h = new HeldChain(devnetProfile, K);
    expect(h.standing('aa'.repeat(32), 1)).toBeNull();
  });
});

describe('HeldChain — settle', () => {
  it('seats the window and block 1', () => {
    const { chain, held } = seatedChain(10);
    expect(held.settled()).toBe(true);
    const tipHdr = held.tip();
    expect(tipHdr).not.toBeNull();
    expect(tipHdr!.height).toBe(10);
    expect(hashOf(tipHdr!)).toBe(hashOf(chain[9]!.header));
  });

  it('settle twice replaces the window and block 1', () => {
    // First seating: a chain of 10.
    const chainA = makeLinkedChain(10, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chainA.slice(5).map(b => b.header), chainA[0]!.header);
    expect(hashOf(held.tip()!)).toBe(hashOf(chainA[9]!.header));

    // A second, unrelated chain — a fresh block 1 and a longer top-5
    // suffix. `settle` replaces both; the first chain's hashes are gone.
    const chainB = makeLinkedChain(12, devnetProfile);
    held.settle(chainB.slice(7).map(b => b.header), chainB[0]!.header);
    expect(hashOf(held.tip()!)).toBe(hashOf(chainB[11]!.header));
    // The old tip is nowhere to be seen; `standing` reads null for it.
    expect(held.standing(hashOf(chainA[9]!.header), 10)).toBeNull();
    // The new block 1 is held.
    expect(held.standing(hashOf(chainB[0]!.header), 1)).toBe('held');
  });
});

describe('HeldChain — place', () => {
  it('tip hash → tip', () => {
    const { chain, held } = seatedChain(10);
    expect(held.place(hashOf(chain[9]!.header), 10)).toBe('tip');
  });

  it('header below the tip → one-below', () => {
    const { chain, held } = seatedChain(10);
    expect(held.place(hashOf(chain[8]!.header), 9)).toBe('one-below');
  });

  it('a lower held header → below', () => {
    const { chain, held } = seatedChain(10);
    // Window spans heights 6..10; height 7 is "lower held", not one-below.
    expect(held.place(hashOf(chain[6]!.header), 7)).toBe('below');
  });

  it('a height above the tip → above', () => {
    const { held } = seatedChain(10);
    expect(held.place('aa'.repeat(32), 11)).toBe('above');
  });

  it('a held height with another hash → unplaced', () => {
    const { held } = seatedChain(10);
    // Height 9 is in the window but the hash is wrong.
    expect(held.place('aa'.repeat(32), 9)).toBe('unplaced');
  });

  it('hash === null → unplaced', () => {
    const { held } = seatedChain(10);
    expect(held.place(null, 9)).toBe('unplaced');
  });

  it('a height below the held window → under', () => {
    const { held } = seatedChain(10);
    // Window is heights 6..10. Height 3 is below it (and so is block 1).
    expect(held.place('aa'.repeat(32), 3)).toBe('under');
    expect(held.place('bb'.repeat(32), 1)).toBe('under');
  });
});

describe('HeldChain — extend', () => {
  it('parent is the tip → extended, window keeps k', () => {
    const { chain, held } = seatedChain(10);
    // Build block 11 whose parent is the current tip (height 10).
    const parent = chain[9]!.header;
    const parentHash = hashOf(parent);
    const scheduled = asertTargetBits(retarget, chain[0]!.header.createdAt, {
      height: parent.height,
      createdAt: parent.createdAt,
    });
    const b11 = makeBlockAt(11, PROTOCOL_VERSION, {
      prevBlockHash: parentHash,
      createdAt: parent.createdAt + devnetProfile.orderingBlockIdealMs,
      powTargetBits: scheduled,
    });
    expect(held.extend(b11.header)).toBe('extended');
    expect(held.tip()!.height).toBe(11);
    // The window kept k entries: the previous lowest (height 6) is gone.
    expect(held.standing(hashOf(chain[5]!.header), 6)).toBeNull();
    expect(held.standing(hashOf(chain[6]!.header), 7)).toBe('held');
  });

  it('parent held below the tip → fork, nothing changes', () => {
    const { chain, held } = seatedChain(10);
    const tipBefore = hashOf(held.tip()!);
    // Build a block whose parent is held at height 8 (below the tip).
    const parent = chain[7]!.header;
    const parentHash = hashOf(parent);
    const scheduled = asertTargetBits(retarget, chain[0]!.header.createdAt, {
      height: parent.height,
      createdAt: parent.createdAt,
    });
    const forkBlock = makeBlockAt(9, PROTOCOL_VERSION, {
      prevBlockHash: parentHash,
      createdAt: parent.createdAt + devnetProfile.orderingBlockIdealMs,
      powTargetBits: scheduled,
    });
    expect(held.extend(forkBlock.header)).toBe('fork');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });

  it('parent not held → gap, nothing changes', () => {
    const { held } = seatedChain(10);
    const tipBefore = hashOf(held.tip()!);
    const orphan = makeBlockAt(50, PROTOCOL_VERSION, {
      prevBlockHash: 'cc'.repeat(32),
    });
    expect(held.extend(orphan.header)).toBe('gap');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });
});

describe('HeldChain — link', () => {
  it('linked: highest first, each links to the next, the last to a held header', () => {
    // Chain of 13; held window is heights 5..9 (k=5), block 1 held
    // separately. The gap-fill reads headers 13, 12, 11, 10 downward (highest
    // first) and the last (height 10) links to the tip (height 9).
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const headers = [
      chain[12]!.header, // highest
      chain[11]!.header,
      chain[10]!.header,
      chain[9]!.header,  // lowest, links to the held tip (height 9)
    ];
    expect(held.link(headers)).toBe('linked');
    expect(held.tip()!.height).toBe(13);
    // k headers kept, lowest dropped past k.
    expect(held.standing(hashOf(chain[4]!.header), 5)).toBeNull();
  });

  it('failed: a header whose bits are off by one (schedule check)', () => {
    // Re-mine the highest header with bits one past the schedule's — the
    // header still verifies at its own bits, but `link`'s schedule check
    // compares against `asertTargetBits(retarget, t_a, parent)` and
    // refuses the mismatch.
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const tipBefore = hashOf(held.tip()!);
    const parent12 = chain[11]!.header;
    const scheduled = asertTargetBits(retarget, chain[0]!.header.createdAt, {
      height: parent12.height,
      createdAt: parent12.createdAt,
    });
    const parent12Hash = hashOf(parent12);
    const bent = makeBlockAt(13, PROTOCOL_VERSION, {
      prevBlockHash: parent12Hash,
      createdAt: parent12.createdAt + devnetProfile.orderingBlockIdealMs,
      powTargetBits: scheduled + 1,
    });
    const headers = [
      bent.header,
      chain[11]!.header,
      chain[10]!.header,
      chain[9]!.header,
    ];
    expect(held.link(headers)).toBe('failed');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });

  it('failed: the last header links to nothing held', () => {
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const tipBefore = hashOf(held.tip()!);
    // Build a header at height 10 whose prevBlockHash points at nothing in
    // the window; the chain above it is self-consistent but the whole chain
    // dangles.
    const orphan = makeBlockAt(10, PROTOCOL_VERSION, {
      prevBlockHash: 'cc'.repeat(32),
      createdAt: chain[9]!.header.createdAt,
      powTargetBits: chain[9]!.header.powTargetBits,
    });
    const headers = [orphan.header];
    expect(held.link(headers)).toBe('failed');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });

  it('failed: a middle header does not link to the one below', () => {
    // The lowest and the highest are from the chain; the middle one is
    // a freshly mined header at the same height with the right bits, but
    // its `prevBlockHash` points at nothing — so headers[1]'s prev no
    // longer matches headers[2]'s hash. The inner link check catches
    // this; nothing above it would.
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const tipBefore = hashOf(held.tip()!);
    const parent10 = chain[9]!.header;
    const scheduled11 = asertTargetBits(retarget, chain[0]!.header.createdAt, {
      height: parent10.height,
      createdAt: parent10.createdAt,
    });
    const detachedMid = makeBlockAt(11, PROTOCOL_VERSION, {
      prevBlockHash: 'dd'.repeat(32),
      createdAt: parent10.createdAt + devnetProfile.orderingBlockIdealMs,
      powTargetBits: scheduled11,
    });
    const headers = [
      chain[12]!.header,
      chain[11]!.header,
      detachedMid.header, // headers[2]; headers[1].prevBlockHash points at chain[11]'s hash, not this one
      chain[9]!.header,
    ];
    expect(held.link(headers)).toBe('failed');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });

  it('failed: a header whose PoW does not verify', () => {
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const tipBefore = hashOf(held.tip()!);
    // Swap the nonce for one the hash cannot clear.
    const bent: BlockHeader = { ...chain[12]!.header, powNonce: 0xffffff };
    const headers = [
      bent,
      chain[11]!.header,
      chain[10]!.header,
      chain[9]!.header,
    ];
    expect(held.link(headers)).toBe('failed');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });

  it('failed: more than k headers', () => {
    // The gap fill stops at `k` headers; a longer input is refused.
    const chain = makeLinkedChain(13, devnetProfile);
    const held = new HeldChain(devnetProfile, K);
    held.settle(chain.slice(4, 9).map(b => b.header), chain[0]!.header);
    const tipBefore = hashOf(held.tip()!);
    // Highest first, k + 1 = 6 headers.
    const headers = [
      chain[12]!.header,
      chain[11]!.header,
      chain[10]!.header,
      chain[9]!.header,
      chain[8]!.header,
      chain[7]!.header,
    ];
    expect(held.link(headers)).toBe('failed');
    expect(hashOf(held.tip()!)).toBe(tipBefore);
  });
});

describe('HeldChain — scheduledTargetBits', () => {
  it('height 1 → the retarget\'s anchorBits', () => {
    const { held } = seatedChain(10);
    const [block1] = makeLinkedChain(1, devnetProfile);
    expect(held.scheduledTargetBits(block1!.header)).toBe(retarget.anchorBits);
  });

  it('parent held → asertTargetBits(retarget, block1.createdAt, parent)', () => {
    const { chain, held } = seatedChain(10);
    // Build a header at height 11 whose parent is the tip (height 10).
    const parent = chain[9]!.header;
    const parentHash = hashOf(parent);
    const header11: BlockHeader = {
      ...parent,
      height: 11,
      prevBlockHash: parentHash,
      createdAt: parent.createdAt + devnetProfile.orderingBlockIdealMs,
    };
    const expected = asertTargetBits(retarget, chain[0]!.header.createdAt, {
      height: parent.height,
      createdAt: parent.createdAt,
    });
    expect(held.scheduledTargetBits(header11)).toBe(expected);
  });

  it('parent not held → null', () => {
    const { held } = seatedChain(10);
    const orphan = makeBlockAt(50, PROTOCOL_VERSION, {
      prevBlockHash: 'cc'.repeat(32),
    });
    expect(held.scheduledTargetBits(orphan.header)).toBeNull();
  });
});

describe('HeldChain — standing', () => {
  it('held for a window header', () => {
    const { chain, held } = seatedChain(10);
    expect(held.standing(hashOf(chain[8]!.header), 9)).toBe('held');
  });

  it('held for block 1', () => {
    const { chain, held } = seatedChain(10);
    expect(held.standing(hashOf(chain[0]!.header), 1)).toBe('held');
  });

  it('null for any other hash', () => {
    const { held } = seatedChain(10);
    expect(held.standing('cc'.repeat(32), 42)).toBeNull();
  });
});

describe('HeldChain — headerAt', () => {
  it('reads a window header by height', () => {
    const { chain, held } = seatedChain(10);
    const h = held.headerAt(8);
    expect(h).not.toBeNull();
    expect(hashOf(h!)).toBe(hashOf(chain[7]!.header));
  });

  it('reads block 1 by height 1', () => {
    const { chain, held } = seatedChain(10);
    const h = held.headerAt(1);
    expect(h).not.toBeNull();
    expect(hashOf(h!)).toBe(hashOf(chain[0]!.header));
  });

  it('null for a height outside the window and not block 1', () => {
    const { held } = seatedChain(10);
    expect(held.headerAt(4)).toBeNull();
    expect(held.headerAt(100)).toBeNull();
  });
});
