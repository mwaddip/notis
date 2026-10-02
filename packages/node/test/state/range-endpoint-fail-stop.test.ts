import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { openAvlDb } from '../helpers.js';
import {
  INDEX_MARKER,
  bytesToHex,
  creditOfKey,
} from '@dagsocial/types';
import { createAvlProver, performTreeWrites, checkpointProver } from '../../src/state/avl-prover.js';
import { registerRangeEndpoint } from '../../src/state/avl-endpoint.js';

/**
 * A tree that contradicts itself under the page — an index entry naming a
 * box the tree does not hold — fails the node stop through
 * `failStopIfCorruptChain` (NODE_INTERFACE → "A tree that contradicts itself
 * under a route's read is local corruption"). The live root is restored on
 * that path too (via the `withCycle`'s `finally`); the case asks a kept
 * older height so the restore moves the root, not a no-op.
 */
describe('range route — the fail-stop under a tree that contradicts itself', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('an index entry naming a box the tree does not hold fires process.exit(1)', async () => {
    const db = openAvlDb();
    const handle = createAvlProver(db);

    // One stale credit-index entry for `owner` at height 1, no corresponding
    // credit box in the tree. The ring records the height-1 root before a
    // second block at height 2 moves the live root, so an `atHeight=1` ask
    // opens the cycle on the kept root and the `finally` has a root to put
    // back.
    const owner = new Uint8Array(32).fill(0xaa);
    const bogusBoxId = new Uint8Array(32).fill(0xbb);
    performTreeWrites(handle.prover, 1, [
      { tag: 'Insert', key: creditOfKey(owner, bogusBoxId), value: Uint8Array.from(INDEX_MARKER) },
    ], 'test');
    checkpointProver(handle, 1);
    handle.recentRoots.record(1, handle.prover.prover.root, handle.prover.prover.height, 0);

    const otherOwner = new Uint8Array(32).fill(0xcc);
    performTreeWrites(handle.prover, 2, [
      { tag: 'Insert', key: creditOfKey(otherOwner, bogusBoxId), value: Uint8Array.from(INDEX_MARKER) },
    ], 'test');
    checkpointProver(handle, 2);

    // Save the live root (at height 2) so we can assert it is restored across the throw.
    const liveDigestBefore = bytesToHex(handle.prover.digest()!);

    const app = express();
    app.use(express.json());
    registerRangeEndpoint(app, handle);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // The call fires the fail-stop. The mocked process.exit throws inside
    // the handler; whether the client sees a 500 or a dropped socket is not
    // the pin.
    await request(app)
      .get(`/api/v1/range/credit/${bytesToHex(owner)}?atHeight=1`)
      .catch(() => undefined);

    expect(exit).toHaveBeenCalledWith(1);

    // The live root is restored on that path too — `withCycle`'s `finally`
    // runs before the catch's fail-stop.
    expect(bytesToHex(handle.prover.digest()!)).toBe(liveDigestBefore);

    db.close();
  });
});
