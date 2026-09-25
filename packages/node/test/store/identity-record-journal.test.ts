import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { BlockEffects } from '@dagsocial/consensus';
import type { IdentityRecord, UserId } from '@dagsocial/types';
import type { RecordMutation } from '../../src/store/journal.js';

/**
 * Identity records in the block journal, and their rollback
 * (NODE_INTERFACE → Block Journal).
 *
 * The effects writer journals each record write with the row it replaces,
 * read just before it writes; `revertBlock` replays `mutations` in reverse,
 * which is what makes a record written twice in one block revert to the
 * pre-block value rather than an intra-block intermediate. Each case builds its
 * journal with the writer and undoes it with `revertBlock`.
 */

function uidBytes(): UserId {
  return new Uint8Array(randomBytes(32));
}

function record(fields: Partial<IdentityRecord>): IdentityRecord {
  return {
    lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0, lifetimeLikesReceived: 0n,
    memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    ...fields,
  };
}

async function freshStore() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const records = await import('../../src/store/identity-records.js');
  const journal = await import('../../src/store/journal.js');
  const { writeBlockEffects } = await import('../../src/services/block-apply.js');
  const { revertBlock } = await import('../../src/services/fork-resolution.js');

  /** A block at `height` whose effects are these record writes, its journal persisted. */
  const applyRecordWrites = (height: number, writes: Array<[UserId, IdentityRecord]>) => {
    const effects: BlockEffects = {
      mutations: writes.map(([identityId, written]) => ({ kind: 'record' as const, identityId, record: written })),
      posts: [],
      likeRecords: [],
      withdrawals: [],
      appliedTxs: [],
    };
    const built = writeBlockEffects(effects, height);
    journal.insertBlockJournal(built);
    return built;
  };

  return { ...records, ...journal, applyRecordWrites, revertBlock };
}

describe('identity records in the block journal, and their rollback', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('revertBlock deletes a record the block created', async () => {
    const s = await freshStore();
    const id = uidBytes();
    s.applyRecordWrites(1, [[id, record({ lastActivityBlock: 10 })]]);
    expect(s.getIdentityRecord(id)).not.toBeNull();

    s.revertBlock(1);
    expect(s.getIdentityRecord(id)).toBeNull();
  });

  it('revertBlock restores the exact prior record for a single overwrite', async () => {
    const s = await freshStore();
    const id = uidBytes();
    const pre = record({ lastActivityBlock: 7, lastDecayBlock: 3 });
    s.putIdentityRecord(id, pre);
    s.applyRecordWrites(1, [[id, record({ lastActivityBlock: 99, lastDecayBlock: 3 })]]);

    s.revertBlock(1);
    expect(s.getIdentityRecord(id)).toEqual(pre);
  });

  it('revertBlock restores the pre-block record for a twice-written key', async () => {
    const s = await freshStore();
    const id = uidBytes();
    const preBlock = record({ lastActivityBlock: 5, lastDecayBlock: 2 });
    s.putIdentityRecord(id, preBlock);

    // The load-bearing case: activity bump then decay, at the same height.
    const intermediate = record({ lastActivityBlock: 40, lastDecayBlock: 2 });
    const built = s.applyRecordWrites(1, [
      [id, intermediate],
      [id, record({ lastActivityBlock: 40, lastDecayBlock: 40 })],
    ]);
    // Both entries are kept — the first one's `replaced` is the true pre-block
    // value, and collapsing per key would lose it.
    expect(built.mutations).toHaveLength(2);
    expect((built.mutations[0] as RecordMutation).replaced).toEqual(preBlock);
    expect((built.mutations[1] as RecordMutation).replaced).toEqual(intermediate);

    s.revertBlock(1);
    // {40, 2} is the intra-block intermediate a last-`replaced`-wins restore
    // would leave behind.
    expect(s.getIdentityRecord(id)).toEqual(preBlock);
  });

  it('revertBlock deletes a record the block created and then wrote again', async () => {
    const s = await freshStore();
    const id = uidBytes();
    s.applyRecordWrites(1, [
      [id, record({ lastActivityBlock: 4 })],
      [id, record({ lastActivityBlock: 4, lastDecayBlock: 4 })],
    ]);

    s.revertBlock(1);
    expect(s.getIdentityRecord(id)).toBeNull();
  });

  it('revertBlock restores two identities written interleaved in one block', async () => {
    const s = await freshStore();
    const a = uidBytes();
    const b = uidBytes();
    const preA = record({ lastActivityBlock: 1, lastDecayBlock: 1 });
    s.putIdentityRecord(a, preA);
    // b has no pre-block record.

    s.applyRecordWrites(1, [
      [a, record({ lastActivityBlock: 20, lastDecayBlock: 1 })],
      [b, record({ lastActivityBlock: 21 })],
      [a, record({ lastActivityBlock: 20, lastDecayBlock: 20 })],
    ]);

    s.revertBlock(1);
    expect(s.getIdentityRecord(a)).toEqual(preA);
    expect(s.getIdentityRecord(b)).toBeNull();
  });

  it('the journal round-trips a record mutation through CBOR', async () => {
    const s = await freshStore();
    const id = uidBytes();
    const pre = record({ lastActivityBlock: 3, lastDecayBlock: 1 });
    s.putIdentityRecord(id, pre);
    s.applyRecordWrites(7, [[id, record({ lastActivityBlock: 9, lastDecayBlock: 1 })]]);

    const loaded = s.getBlockJournal(7)!;
    const m = loaded.mutations[0] as RecordMutation;
    expect(m.kind).toBe('record');
    expect(m.record).toEqual(record({ lastActivityBlock: 9, lastDecayBlock: 1 }));
    expect(m.replaced).toEqual(pre);
    // identityId must survive as addressable bytes for the SQL row.
    expect(Buffer.from(m.identityId).equals(Buffer.from(id))).toBe(true);
  });
});
