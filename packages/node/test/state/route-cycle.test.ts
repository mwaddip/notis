import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { bytesToHex, hash32, networkKey } from '@dagsocial/types';

/**
 * Both routes called several times at several heights, including a call that
 * throws midway, do not leak into the next block's cycle (NODE_INTERFACE →
 * "A proof at an older height restores a kept root"; → The block proof,
 * "A proof route records in a cycle of its own"). The next block the node
 * applies after the routes carries the proof a node that served no route
 * writes — one node shows it because a block's header is its own twin: the
 * block built first (`makeApplicableBlock`) commits to the honest proof's
 * `adProofsRoot`, and the funnel refuses a block whose cycle opened with
 * anything else.
 */

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  return db;
}

describe('a route\'s cycle does not leak into the next block\'s', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('both routes called at several heights (plus a 400, a throw, and a 404), then the next block applies and its stored proof is the honest one', async () => {
    await freshStore();
    const {
      activateProverOverStore,
      makeApplicableBlock,
      makeTestConfig,
      makeTestIdentity,
      makeCreditBox,
    } = await import('../helpers.js');
    const { createApp } = await import('../../src/server.js');
    const { applyOrderingBlock } = await import('../../src/services/block-apply.js');

    // Pre-seed a credit box for an owner so the range route has something to
    // walk at every height.
    const owner = makeTestIdentity();
    const { insertBox } = await import('../../src/store/utxo.js');
    insertBox(makeCreditBox(1_000_000n, owner.userId, 0, 1));

    const handle = await activateProverOverStore();
    const { getBlockProof } = await import('../../src/store/block-proofs.js');

    // Apply three coinbase-only blocks so the ring holds {0, 1, 2, 3}.
    for (let h = 1; h <= 3; h++) {
      expect(applyOrderingBlock(await makeApplicableBlock({ height: h }))).toBe(true);
    }

    // Build the honest next block FIRST — its adProofsRoot is the hash of
    // the proof the block makes with no route in the cycle.
    const honest = await makeApplicableBlock({ height: 4 });

    const liveDigestBefore = bytesToHex(handle.prover.digest()!);

    const app = createApp(makeTestConfig({ nodeRole: 'server' }));

    const ownerHex = bytesToHex(owner.userId);
    const anyKey = bytesToHex(networkKey());

    async function assertLiveDigestUnchanged() {
      expect(bytesToHex(handle.prover.digest()!)).toBe(liveDigestBefore);
    }

    // Single-key route — tip (no `atHeight`) and two older heights.
    for (const q of [`/api/v1/proof/${anyKey}`, `/api/v1/proof/${anyKey}?atHeight=2`, `/api/v1/proof/${anyKey}?atHeight=1`]) {
      await request(app).get(q).expect(200);
      await assertLiveDigestUnchanged();
    }

    // Range route — tip and two older heights.
    for (const q of [`/api/v1/range/credit/${ownerHex}`, `/api/v1/range/credit/${ownerHex}?atHeight=2`, `/api/v1/range/credit/${ownerHex}?atHeight=1`]) {
      await request(app).get(q).expect(200);
      await assertLiveDigestUnchanged();
    }

    // A range call answered 400 by `pageRange` — a `from` outside the kind's
    // range for `owner`. The throw is inside the cycle, after the kept root
    // is restored, so the `finally` must still close.
    const outsideRangeKey = '00' + ownerHex.padEnd(128, '0'); // not inside the credit range
    await request(app)
      .get(`/api/v1/range/credit/${ownerHex}?from=${outsideRangeKey}&atHeight=2`)
      .expect(400);
    await assertLiveDigestUnchanged();

    // A range call that throws after its first recorded lookup — spy on the
    // prover's `performLookupWithNeighbors` throwing on its third call (the
    // range walk's first lookup is the range's start; its box lookup is the
    // second; the next walk step is the third). The route answers 500 and
    // the live digest is still what it was.
    const original = handle.prover.performLookupWithNeighbors.bind(handle.prover);
    let calls = 0;
    const spy = vi.spyOn(handle.prover, 'performLookupWithNeighbors').mockImplementation((key: Uint8Array) => {
      calls++;
      if (calls === 3) throw new Error('injected throw inside the cycle');
      return original(key);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get(`/api/v1/range/credit/${ownerHex}?limit=10`).expect(500);
    spy.mockRestore();
    expect(calls).toBeGreaterThanOrEqual(3);
    await assertLiveDigestUnchanged();

    // A height outside the ring — 404.
    await request(app).get(`/api/v1/proof/${anyKey}?atHeight=999`).expect(404);
    await assertLiveDigestUnchanged();

    // Apply the pre-built honest block. The funnel recomputes the proof and
    // refuses a block whose cycle opened with anything else — a successful
    // apply therefore proves no route left anything in the cycle.
    expect(applyOrderingBlock(honest)).toBe(true);

    // The stored proof's hash32 is the header's adProofsRoot.
    const stored = getBlockProof(4);
    expect(stored).not.toBeNull();
    expect(bytesToHex(hash32(stored!))).toBe(honest.header.adProofsRoot);

  });
});
