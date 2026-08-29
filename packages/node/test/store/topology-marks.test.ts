import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedProvenance, uid, uidHex } from '../helpers.js';
import type { VouchEscrowBox, BondBox } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (module-level singleton state resets between tests)
// ---------------------------------------------------------------------------

async function importAll() {
  const db = await import('../../src/store/db.js');
  const topology = await import('../../src/store/topology.js');
  const utxo = await import('../../src/store/utxo.js');
  const journal = await import('../../src/store/journal.js');
  const identityRecords = await import('../../src/store/identity-records.js');
  return { ...db, ...topology, ...utxo, ...journal, ...identityRecords };
}

// ---------------------------------------------------------------------------
// Box factories
// ---------------------------------------------------------------------------

function makeEscrowBox(
  value: bigint,
  owner: Uint8Array,
  releaseAtBlock: number,
  nonce = 0,
): VouchEscrowBox {
  const candidate = {
    boxType: 'vouch_escrow' as const,
    value,
    createdAtBlock: 1,
    owner,
    releaseAtBlock,
  };
  return seedProvenance<VouchEscrowBox>(candidate, 1, nonce);
}

function makeBondBox(
  inviterId: Uint8Array,
  inviteePublicKey: Uint8Array,
  value = 25n,
  nonce = 0,
): BondBox {
  const candidate = {
    boxType: 'bond' as const,
    value,
    createdAtBlock: 1,
    inviterId,
    inviteePublicKey,
  };
  return seedProvenance<BondBox>(candidate, 1, nonce);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('topology marks (pruned_at_height / pruned_root)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('markPrunedTopology sets columns, clearPrunedTopology resets them', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.insertBlockTopology('p1', [], uidHex('author1'), 10);
    s.insertBlockTopology('p2', ['p1'], uidHex('author2'), 10);

    s.beginBlockJournal(11);
    s.markPrunedTopology(['p1', 'p2'], 11, 'p1');
    const j = s.finishBlockJournal();

    const db = s.getDb();
    const r1 = db.prepare('SELECT pruned_at_height, pruned_root FROM block_topology WHERE post_id = ?').get('p1') as any;
    expect(r1.pruned_at_height).toBe(11);
    expect(r1.pruned_root).toBe('p1');

    const r2 = db.prepare('SELECT pruned_at_height, pruned_root FROM block_topology WHERE post_id = ?').get('p2') as any;
    expect(r2.pruned_at_height).toBe(11);
    expect(r2.pruned_root).toBe('p1');

    expect(j.prunedTopologyRows).toEqual(['p1', 'p2']);

    s.clearPrunedTopology(['p1', 'p2']);
    const c1 = db.prepare('SELECT pruned_at_height, pruned_root FROM block_topology WHERE post_id = ?').get('p1') as any;
    expect(c1.pruned_at_height).toBeNull();
    expect(c1.pruned_root).toBeNull();
  });

  it('clearPrunedTopology is a no-op on an empty list', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    expect(() => s.clearPrunedTopology([])).not.toThrow();
  });

  it('markPrunedTopology is a no-op on an empty list', async () => {
    const s = await importAll();
    s.initDb(':memory:');
    s.beginBlockJournal(1);
    s.markPrunedTopology([], 1, 'root');
    const j = s.finishBlockJournal();
    expect(j.prunedTopologyRows).toEqual([]);
  });
});

describe('getBondsInvitedAt — range, limit, order', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('returns bonds whose invitee invited_at_block is in (0, maxInvitedAt], ascending (invited_at_block, id)', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const inviter = uid('inviter');
    const invitee1 = uid('invitee1');
    const invitee2 = uid('invitee2');
    const invitee3 = uid('invitee3');

    // Create identity records with different invited_at_block values
    s.putIdentityRecord(invitee1, {
      invitedAtBlock: 5,
      lastActivityBlock: 5,
      lastDecayBlock: 5,
      lifetimeLikesReceived: 0n,
    });
    s.putIdentityRecord(invitee2, {
      invitedAtBlock: 3,
      lastActivityBlock: 3,
      lastDecayBlock: 3,
      lifetimeLikesReceived: 0n,
    });
    s.putIdentityRecord(invitee3, {
      invitedAtBlock: 0,
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      lifetimeLikesReceived: 0n,
    });

    const bond1 = makeBondBox(inviter, invitee1, 25n, 1);
    const bond2 = makeBondBox(inviter, invitee2, 25n, 2);
    const bond3 = makeBondBox(inviter, invitee3, 25n, 3);
    s.insertBox(bond1);
    s.insertBox(bond2);
    s.insertBox(bond3);

    // Range (0, 5]: should return invitee2 (invited_at_block=3) then invitee1 (invited_at_block=5)
    // invitee3 (invited_at_block=0) is excluded by the > 0 guard
    const result = s.getBondsInvitedAt(5, 10);
    expect(result).toHaveLength(2);
    // Ordered by (invited_at_block, box id): invitee2 at 3 comes first
    expect(result[0]!.inviteePublicKey).toEqual(invitee2);
    expect(result[1]!.inviteePublicKey).toEqual(invitee1);

    // Limit = 1
    const limited = s.getBondsInvitedAt(5, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.inviteePublicKey).toEqual(invitee2);

    // Range that excludes invitee1 (invited_at_block=5)
    const narrow = s.getBondsInvitedAt(4, 10);
    expect(narrow).toHaveLength(1);
    expect(narrow[0]!.inviteePublicKey).toEqual(invitee2);
  });

  it('the sentinel invited_at_block=0 is never returned', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const inviter = uid('inviter-s');
    const invitee = uid('invitee-s');

    s.putIdentityRecord(invitee, {
      invitedAtBlock: 0,
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      lifetimeLikesReceived: 0n,
    });
    const bond = makeBondBox(inviter, invitee, 25n);
    s.insertBox(bond);

    expect(s.getBondsInvitedAt(100, 64)).toHaveLength(0);
  });
});

describe('getVouchEscrowsReleasableAt — order and limit', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('orders by (releaseAtBlock, id) and respects limit', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    const owner = uid('escrow-owner');

    // Insert with different release heights, out of ascending order
    const e1 = makeEscrowBox(3n, owner, 20, 1);
    const e2 = makeEscrowBox(3n, owner, 10, 2);
    const e3 = makeEscrowBox(3n, owner, 10, 3);
    s.insertBox(e1);
    s.insertBox(e2);
    s.insertBox(e3);

    // All three releasable at height 20
    const result = s.getVouchEscrowsReleasableAt(20, 10);
    expect(result).toHaveLength(3);

    // Ordered by (releaseAtBlock, id): the two at height 10 come first
    expect(result[0]!.releaseAtBlock).toBe(10);
    expect(result[1]!.releaseAtBlock).toBe(10);
    expect(result[2]!.releaseAtBlock).toBe(20);

    // Within the same releaseAtBlock, ascending id
    expect(result[0]!.id! < result[1]!.id!).toBe(true);

    // Limit = 2
    const limited = s.getVouchEscrowsReleasableAt(20, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]!.releaseAtBlock).toBe(10);
    expect(limited[1]!.releaseAtBlock).toBe(10);
  });
});

describe('journal round-trip for prunedTopologyRows', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('round-trips through CBOR', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    s.beginBlockJournal(50);
    s.insertBlockTopology('rt1', [], uidHex('rtauthor'), 49);
    s.insertBlockTopology('rt2', ['rt1'], uidHex('rtauthor'), 49);
    s.markPrunedTopology(['rt1', 'rt2'], 50, 'rt1');
    const journal = s.finishBlockJournal();

    expect(journal.prunedTopologyRows).toEqual(['rt1', 'rt2']);

    s.insertBlockJournal(journal);
    const loaded = s.getBlockJournal(50);
    expect(loaded).not.toBeNull();
    expect(loaded!.prunedTopologyRows).toEqual(['rt1', 'rt2']);
  });

  it('journals written before the field existed read as undefined, and ?? [] guards it', async () => {
    const s = await importAll();
    s.initDb(':memory:');

    // Simulate an old journal without the field
    const oldJournal = {
      blockHeight: 99,
      mutations: [],
      confirmedPostIds: [],
      appliedUtxoTxs: [],
      likeRecordInsertions: [],
      likeRecordDeletions: [],
      deletedPosts: [],
      insertedStumps: [],
      withdrawnPosts: [],
    };
    s.insertBlockJournal(oldJournal as any);
    const loaded = s.getBlockJournal(99);
    expect(loaded).not.toBeNull();
    // The field is absent from the CBOR, so it reads as undefined
    const rows = loaded!.prunedTopologyRows ?? [];
    expect(rows).toEqual([]);
  });
});

