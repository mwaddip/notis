import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import {
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  hexToBytes,
} from '@dagsocial/types';
import type { KarmaBox } from '@dagsocial/types';
import type { TreeWrite } from '@dagsocial/consensus';
import { BatchAVLVerifier } from '@dagsocial/avltree';
import { openAvlDb, ringHeights, seedProvenance } from '../helpers.js';
import { createAvlProver, performTreeWrites, checkpointProver } from '../../src/state/avl-prover.js';
import { registerProofEndpoint, registerRangeEndpoint } from '../../src/state/avl-endpoint.js';
import { InconsistentAvlNodeRowsError } from '../../src/services/corrupt-state.js';

/**
 * The proof window — the tip and the `PROOF_WINDOW_BLOCKS − 1` heights below
 * it — is answered on both proof routes at every height the store holds a
 * version of (NODE_INTERFACE → AVL+ State Root → "A height of the proof
 * window with no kept root is served from the store"). The kept-root fast
 * path and the store-served path answer byte-equal proofs and `stateRoot`s;
 * neither records in the ring; the live root is restored on every path, a
 * loader throw included; a loader throw is fail-stop.
 */

const owner = new Uint8Array(32).fill(0xaa);
const box = seedProvenance<KarmaBox>({ boxType: 'karma', value: 100n, createdAtBlock: 0, owner }, 1);
const BOX_KEY = bytesToHex(boxKey(hexToBytes(box.id)));

/** A tree with versions at heights 1..`tip`, each a fresh key insert. */
function buildChain(db: Database.Database, tip: number): ReturnType<typeof createAvlProver> {
  const handle = createAvlProver(db);
  // Height 1 holds the seed box; later heights add a distinct key each.
  performTreeWrites(handle.prover, 1, [
    { tag: 'Insert', key: boxKey(hexToBytes(box.id)), value: boxRecordBytes(box, box.txId, box.index) },
  ], 'test');
  checkpointProver(handle, 1);
  for (let h = 2; h <= tip; h++) {
    const filler = seedProvenance<KarmaBox>(
      { boxType: 'karma', value: BigInt(h), createdAtBlock: h - 1, owner }, h,
    );
    const w: TreeWrite = {
      tag: 'Insert',
      key: boxKey(hexToBytes(filler.id)),
      value: boxRecordBytes(filler, filler.txId, filler.index),
    };
    performTreeWrites(handle.prover, h, [w], 'test');
    checkpointProver(handle, h);
  }
  return handle;
}

describe('proof window — store-served heights', () => {
  let db: Database.Database;
  beforeEach(() => {
    vi.restoreAllMocks();
    db = openAvlDb();
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  // §5.1 — the store-served answer and the kept-root answer are byte-equal.
  it('kept-root and store-served answers at the same height are byte-equal on both routes', async () => {
    const handle = buildChain(db, 3);
    const app = express();
    registerProofEndpoint(app, handle);
    registerRangeEndpoint(app, handle);

    // Height 2 is kept now; answer it.
    const kept = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    const keptRange = await request(app).get(`/api/v1/range/karma/${bytesToHex(owner)}?atHeight=2`).expect(200);

    // Drop height 2 from the ring; the same ask now serves from the store.
    handle.recentRoots.drop(2);
    const served = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    const servedRange = await request(app).get(`/api/v1/range/karma/${bytesToHex(owner)}?atHeight=2`).expect(200);

    expect(served.body.stateRoot).toBe(kept.body.stateRoot);
    expect(served.body.proof).toBe(kept.body.proof);
    expect(servedRange.body.stateRoot).toBe(keptRange.body.stateRoot);
    expect(servedRange.body.proof).toBe(keptRange.body.proof);
  });

  // §5.2 — a fresh prover handle over a store with a chain answers tip − 19.
  it('a fresh prover handle over a store with a chain answers tip − 19 on both routes', async () => {
    buildChain(db, 25);
    // Fresh handle — the ring is seeded with the loaded tip alone (NODE_INTERFACE
    // → "After a restart the node holds its tip's root alone").
    const handle = createAvlProver(db);
    const app = express();
    registerProofEndpoint(app, handle);
    registerRangeEndpoint(app, handle);

    const target = 25 - 19;
    expect(handle.recentRoots.get(target)).toBeNull();
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=${target}`).expect(200);
    await request(app).get(`/api/v1/range/karma/${bytesToHex(owner)}?atHeight=${target}`).expect(200);
  });

  // §5.3 — a ring that keeps fewer than 20 answers tip − 19 from the store.
  it('a ring tight enough to keep fewer than 20 answers tip − 19', async () => {
    const handle = buildChain(db, 25);
    // Drop every entry below the tip — a `PROOF_WINDOW_NODES` tight enough
    // leaves the ring at the tip alone.
    for (const h of ringHeights(handle.recentRoots)) if (h !== 25) handle.recentRoots.drop(h);
    const app = express();
    registerProofEndpoint(app, handle);
    const target = 25 - 19;
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=${target}`).expect(200);
  });

  // §5.4 — the window's edges (the test module reads the default window of 64).
  it('window edges: tip and (tip − window + 1) answer; one below is 404, above the tip is 404', async () => {
    const handle = buildChain(db, 100);
    const app = express();
    registerProofEndpoint(app, handle);

    // The default window is 64; the floor is `tip − 63` = 37.
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=100`).expect(200);
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=37`).expect(200);
    const below = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=36`).expect(404);
    expect(below.body).toEqual({ error: 'height not available' });
    const above = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=101`).expect(404);
    expect(above.body).toEqual({ error: 'height not available' });
  });

  // §5.4 continued — a window height the store has no version of is a 404.
  it('a window height the store has no version of is a 404 (chain shorter than the window)', async () => {
    const handle = buildChain(db, 2);
    // The store lists heights 0 (constructor's empty root), 1 and 2 — but it
    // deletes the row at 0 only through `bootstrapAvlProver`, which this
    // helper does not call. The window is 64; a height outside the chain
    // 2 above the tip, 3, is a 404 above-tip (`tip − 63 = -61`, inWindow is
    // false for any `h > tip`). Delete the row at 1 and ask it: the window
    // still contains it, and the store answers no version of it.
    db.prepare('DELETE FROM avl_tree_versions WHERE height = ?').run(1);
    handle.recentRoots.drop(1);
    const app = express();
    registerProofEndpoint(app, handle);
    const res = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=1`).expect(404);
    expect(res.body).toEqual({ error: 'height not available' });
  });

  // §5.5 — a light-client verifier accepts a store-served proof.
  it('a light-client verifier accepts a store-served single-key proof against the answered stateRoot', async () => {
    const handle = buildChain(db, 3);
    handle.recentRoots.drop(2);
    const app = express();
    registerProofEndpoint(app, handle);
    const res = await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    const proof = new Uint8Array(Buffer.from(res.body.proof as string, 'base64'));
    const stateRoot = hexToBytes(res.body.stateRoot as string);
    const verifier = new BatchAVLVerifier(stateRoot, proof, {
      keyLength: TREE_KEY_LENGTH,
      valueLengthOpt: null,
    });
    const result = verifier.performOneOperation({ tag: 'Lookup', key: hexToBytes(BOX_KEY) });
    expect(result.success).toBe(true);
  });

  // §5.6 — the live root is restored after a store-served call, and after one
  // whose loader throws.
  it('the live root is restored after a store-served call and after one whose loader throws', async () => {
    const handle = buildChain(db, 3);
    handle.recentRoots.drop(2);
    const liveDigest = bytesToHex(handle.prover.digest());
    const app = express();
    registerProofEndpoint(app, handle);

    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    expect(bytesToHex(handle.prover.digest())).toBe(liveDigest);

    // Corrupt the row for the root at height 2 so the loader throws.
    const v2 = handle.storage.versionAtHeight(2)!;
    const rootLabel = v2.slice(0, 32);
    db.prepare('DELETE FROM avl_tree_nodes WHERE label = ?').run(rootLabel);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).catch(() => undefined);
    expect(exit).toHaveBeenCalledWith(1);
    // The live root is restored across the loader throw (withCycle's finally
    // runs before the catch's fail-stop).
    expect(bytesToHex(handle.prover.digest())).toBe(liveDigest);
  });

  // §5.7 — a missing row and a doubled row under a listed version fail-stop.
  it('a missing row at a store-served height fires process.exit(1) through the route', async () => {
    const handle = buildChain(db, 3);
    handle.recentRoots.drop(2);
    const v2 = handle.storage.versionAtHeight(2)!;
    db.prepare('DELETE FROM avl_tree_nodes WHERE label = ?').run(v2.slice(0, 32));
    const app = express();
    registerProofEndpoint(app, handle);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).catch(() => undefined);
    expect(exit).toHaveBeenCalledWith(1);
    expect(exit.mock.calls.some(([code]) => code === 1)).toBe(true);
  });

  it('a doubled row at a store-served height fires process.exit(1) through the route', async () => {
    const handle = buildChain(db, 3);
    handle.recentRoots.drop(2);
    const v2 = handle.storage.versionAtHeight(2)!;
    const rootLabel = v2.slice(0, 32);
    // The row for the height-2 root (first_seen=2, orphaned at 3 when height
    // 3 moved the root). A second row at first_seen=0 is alive at height 2
    // under the same predicate; the row check reads two.
    const row = db.prepare(
      'SELECT node_data FROM avl_tree_nodes WHERE label = ? LIMIT 1',
    ).get(rootLabel) as { node_data: Buffer };
    db.prepare(
      'INSERT INTO avl_tree_nodes (label, node_data, first_seen_height, orphaned_at_height) VALUES (?, ?, 0, NULL)',
    ).run(rootLabel, row.node_data);
    const app = express();
    registerProofEndpoint(app, handle);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).catch(() => undefined);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a direct loader throw is InconsistentAvlNodeRowsError (the class the route funnels)', () => {
    const handle = buildChain(db, 3);
    const v2 = handle.storage.versionAtHeight(2)!;
    db.prepare('DELETE FROM avl_tree_nodes WHERE label = ?').run(v2.slice(0, 32));
    const loader = handle.storage.nodeLoaderAtHeight(2, 'test');
    expect(() => loader(v2.slice(0, 32))).toThrow(InconsistentAvlNodeRowsError);
  });

  // §5.8 — rollback is not called on either proof path (the kept-root
  // assertion extended to store-served).
  it('rollback is not called on either proof path, kept or store-served', async () => {
    const handle = buildChain(db, 3);
    const storageSpy = vi.spyOn(handle.storage, 'rollback');
    const proverSpy = vi.spyOn(handle.prover, 'rollback');
    const app = express();
    registerProofEndpoint(app, handle);
    registerRangeEndpoint(app, handle);

    // Kept height, store-served height, tip — all three.
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    handle.recentRoots.drop(2);
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    await request(app).get(`/api/v1/proof/${BOX_KEY}`).expect(200);
    await request(app).get(`/api/v1/range/karma/${bytesToHex(owner)}?atHeight=2`).expect(200);

    expect(storageSpy).not.toHaveBeenCalled();
    expect(proverSpy).not.toHaveBeenCalled();
  });

  // §5.10 — nothing is added to the ring by a store-served call.
  it('nothing is added to the ring by a store-served call', async () => {
    const handle = buildChain(db, 3);
    handle.recentRoots.drop(2);
    const heightsBefore = ringHeights(handle.recentRoots);
    const app = express();
    registerProofEndpoint(app, handle);
    registerRangeEndpoint(app, handle);
    await request(app).get(`/api/v1/proof/${BOX_KEY}?atHeight=2`).expect(200);
    await request(app).get(`/api/v1/range/karma/${bytesToHex(owner)}?atHeight=2`).expect(200);
    expect(ringHeights(handle.recentRoots)).toEqual(heightsBefore);
    expect(handle.recentRoots.get(2)).toBeNull();
  });
});
