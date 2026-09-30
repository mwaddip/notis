import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordBytes,
  hexToBytes,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, KarmaBox } from '@dagsocial/types';
import { seedTreeWrites } from '@dagsocial/consensus';
import type { TreeWrite } from '@dagsocial/consensus';
import {
  createAvlProver,
  bootstrapAvlProver,
  checkpointProver,
  performTreeWrites,
} from '../../src/state/avl-prover.js';
import type { AvlProverHandle } from '../../src/state/avl-prover.js';
import { openAvlDb, seedProvenance, uid } from '../helpers.js';

/**
 * The node's prover (NODE_INTERFACE → AVL+ State Root): `TREE_KEY_LENGTH` wide,
 * performing the writes it is handed in the order handed — a block's are
 * `treeWritesOf`'s, whose order is consensus's (CONSENSUS_INTERFACE → The tree
 * writes) — and seeding genesis as `seedTreeWrites`.
 */

const owner = uid('avl-prover/owner');

function karma(value: bigint, nonce: number): KarmaBox & { id: string } {
  return seedProvenance<KarmaBox>({ boxType: 'karma', value, createdAtBlock: 1, owner }, 1, nonce);
}

function record(lastActivityBlock: number): IdentityRecord {
  return {
    lastActivityBlock,
    lastDecayBlock: 1,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
  };
}

const insertOf = (box: AnyBox): TreeWrite =>
  ({ tag: 'Insert', key: boxKey(hexToBytes(box.id!)), value: boxRecordBytes(box, box.txId, box.index) });
const removeOf = (box: AnyBox): TreeWrite => ({ tag: 'Remove', key: boxKey(hexToBytes(box.id!)) });

const hexOf = (digest: Uint8Array): string => Buffer.from(digest).toString('hex');

describe('avl-prover', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openAvlDb();
  });

  afterEach(() => { db.close(); });

  it('createAvlProver() returns a PersistentBatchAVLProver with non-null digest on empty DB', () => {
    const { prover } = createAvlProver(db);
    expect(prover.digest()).not.toBeNull();
    // Empty tree still has a digest (the sentinel neg-inf leaf)
  });

  it('the prover is TREE_KEY_LENGTH wide: a key of another width is the library\'s throw', () => {
    const { prover } = createAvlProver(db);
    const box = karma(100n, 1);
    expect(boxKey(hexToBytes(box.id)).length).toBe(TREE_KEY_LENGTH);
    expect(() => prover.performOneOperation({ tag: 'Insert', key: hexToBytes(box.id), value: new Uint8Array([1]) }))
      .toThrow(/key length/i);
    expect(prover.performOneOperation(insertOf(box)).success).toBe(true);
  });

  it('performTreeWrites() updates the prover and returns the new digest', () => {
    const { prover } = createAvlProver(db);
    const initialDigest = hexOf(prover.digest());

    const newDigest = performTreeWrites(prover, 1, [insertOf(karma(100n, 1))], 'test');
    expect(hexOf(newDigest)).not.toBe(initialDigest);
    expect(newDigest.length).toBe(33);
    expect(hexOf(newDigest)).toBe(hexOf(prover.digest()));
  });

  it('a remove and an insert produce a different digest than the insert alone', () => {
    const { prover } = createAvlProver(db);
    const box1 = karma(100n, 1);
    const box2 = karma(50n, 2);

    const d1 = performTreeWrites(prover, 1, [insertOf(box1)], 'test');
    const d2 = performTreeWrites(prover, 2, [removeOf(box1), insertOf(box2)], 'test');

    expect(hexOf(d1)).not.toBe(hexOf(d2));
  });

  it('deterministic: same writes produce same digest', () => {
    const { prover: p1 } = createAvlProver(db);
    const { prover: p2 } = createAvlProver(db);

    const box = karma(42n, 1);
    const d1 = performTreeWrites(p1, 1, [insertOf(box)], 'test');
    const d2 = performTreeWrites(p2, 1, [insertOf(box)], 'test');

    expect(hexOf(d1)).toBe(hexOf(d2));
  });

  it('no writes leave the digest unchanged', () => {
    const { prover } = createAvlProver(db);
    performTreeWrites(prover, 1, [insertOf(karma(10n, 1))], 'test');
    const before = hexOf(prover.digest());

    expect(hexOf(performTreeWrites(prover, 2, [], 'test'))).toBe(before);
  });
});

describe('block-apply integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openAvlDb();
  });

  afterEach(() => { db.close(); });

  it('the prover tracks an insert and a later remove across checkpoints', () => {
    const handle = createAvlProver(db);

    // Simulate block application: create two boxes, consume one
    const box1 = karma(100n, 1);
    const box2 = karma(50n, 2);
    performTreeWrites(handle.prover, 1, [insertOf(box1), insertOf(box2)], 'test');
    checkpointProver(handle, 1);
    const digestAfterCreate = hexOf(handle.prover.digest());

    // Consume box1, create box3
    const box3 = karma(25n, 3);
    performTreeWrites(handle.prover, 2, [removeOf(box1), insertOf(box3)], 'test');
    checkpointProver(handle, 2);
    const digestAfterConsume = hexOf(handle.prover.digest());

    expect(digestAfterCreate).not.toBe(digestAfterConsume);
    expect(handle.storage.versionAtOrBeforeHeight(1)).toEqual(hexToBytes(digestAfterCreate));
    expect(handle.storage.versionAtOrBeforeHeight(2)).toEqual(hexToBytes(digestAfterConsume));
  });

  it('prover state survives checkpoint and can be queried', () => {
    const handle = createAvlProver(db);

    const box1 = karma(100n, 1);
    performTreeWrites(handle.prover, 1, [insertOf(box1)], 'test');
    checkpointProver(handle, 1);

    // After checkpoint, digest should still be accessible, and the box's value
    const digest = handle.prover.digest();
    expect(digest.length).toBe(33);
    expect(handle.prover.unauthenticatedLookup(boxKey(hexToBytes(box1.id))))
      .toEqual(boxRecordBytes(box1, box1.txId, box1.index));
  });
});

// ---------------------------------------------------------------------------
// Genesis is `seedTreeWrites` performed (CONSENSUS_INTERFACE → The tree writes
// → "`seedTreeWrites(boxes, records, network)` is genesis"): its order is the
// seed's, never the caller's, and every input is committed.
// ---------------------------------------------------------------------------

describe('bootstrapAvlProver', () => {
  let db: Database.Database;
  let db2: Database.Database;

  beforeEach(() => {
    db = openAvlDb();
    db2 = openAvlDb();
  });

  afterEach(() => {
    db.close();
    db2.close();
  });

  const digestOf = (h: AvlProverHandle): string => hexOf(h.prover.digest());
  const boxes = (): Array<KarmaBox & { id: string }> => [5, 1, 4, 2, 3].map((n) => karma(12n, n));
  const records = (clock = 4) => ['ee', '77', '55'].map((label) => ({
    identityId: uid(`avl-prover/${label}`),
    record: record(clock),
  }));

  it('is the performance of seedTreeWrites, checkpointed at its height', () => {
    const seeded = createAvlProver(db);
    bootstrapAvlProver(seeded, boxes(), 0, records(), { memberCount: 3 });

    const performed = createAvlProver(db2);
    performTreeWrites(performed.prover, 0, seedTreeWrites(boxes(), records(), { memberCount: 3 }), 'test');

    expect(digestOf(seeded)).toBe(digestOf(performed));
    expect(seeded.storage.versionAtOrBeforeHeight(0)).toEqual(seeded.prover.digest());
  });

  it('same unspent set in shuffled orders → identical digest', () => {
    const h1 = createAvlProver(db);
    const h2 = createAvlProver(db2);

    bootstrapAvlProver(h1, boxes(), 0, [], { memberCount: 0 });
    bootstrapAvlProver(h2, [...boxes()].reverse(), 0, [], { memberCount: 0 });

    expect(digestOf(h1)).toBe(digestOf(h2));
  });

  it('shuffled records → identical digest', () => {
    const h1 = createAvlProver(db);
    const h2 = createAvlProver(db2);

    bootstrapAvlProver(h1, [], 0, records(), { memberCount: 3 });
    bootstrapAvlProver(h2, [], 0, [...records()].reverse(), { memberCount: 3 });

    expect(digestOf(h1)).toBe(digestOf(h2));
  });

  it('a seed without the records does NOT reach the seed with them', () => {
    const h1 = createAvlProver(db);
    const h2 = createAvlProver(db2);

    bootstrapAvlProver(h1, boxes(), 0, records(), { memberCount: 3 });
    bootstrapAvlProver(h2, boxes(), 0, [], { memberCount: 3 });

    expect(digestOf(h1)).not.toBe(digestOf(h2));
  });

  it('bootstrap record values are committed, not just their keys', () => {
    // Two trees over the same key with different clocks must differ, or the
    // record would be a membership marker rather than committed state.
    const a = createAvlProver(db);
    const b = createAvlProver(db2);

    bootstrapAvlProver(a, [], 0, records(10), { memberCount: 3 });
    bootstrapAvlProver(b, [], 0, records(11), { memberCount: 3 });

    expect(digestOf(a)).not.toBe(digestOf(b));
  });

  it('the network record is committed too', () => {
    const a = createAvlProver(db);
    const b = createAvlProver(db2);

    bootstrapAvlProver(a, [], 0, [], { memberCount: 1 });
    bootstrapAvlProver(b, [], 0, [], { memberCount: 2 });

    expect(digestOf(a)).not.toBe(digestOf(b));
  });
});
