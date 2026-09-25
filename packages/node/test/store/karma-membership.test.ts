import {
  FIXTURE_BOND_KARMA,
  activateProverOverStore,
  fixtureProvenance,
  makeApplicableBlock,
  makeKarmaBox as seededKarmaBox,
  makePostCommit,
  makeTestIdentity,
  signTransaction,
  toHex,
  type TestIdentity,
} from '../helpers.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type { NetNode } from '@dagsocial/net';
import { POST_PRICE_THREAD, PROTOCOL_VERSION } from '@dagsocial/types';

import type {
  AnyBox,
  AnyBoxCandidate,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Dynamic import helpers (reset module-level state between tests)
// ---------------------------------------------------------------------------

async function importDbFresh() {
  const mod = await import('../../src/store/db.js');
  return mod as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importUtxoFresh() {
  const mod = await import('../../src/store/utxo.js');
  return mod as {
    insertBox: (box: AnyBox) => void;
    consumeBox: (boxId: string, consumedAtBlock: number) => void;
    unconsumeBox: (boxId: string) => void;
    deleteBox: (boxId: string) => void;
    getKarmaOwners: () => string[];
    registerKarmaMembershipHook: (hook: {
      onGain: (ownerHex: string) => void;
      onLoss: (ownerHex: string) => void;
    }) => void;
  };
}

async function importTypes() {
  const mod = await import('@dagsocial/types');
  return mod as { computeBoxId: (box: AnyBox) => string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

const OWNER_A = bytes(32);
const OWNER_B = bytes(32);

function ownerHex(owner: Uint8Array): string {
  return Buffer.from(owner).toString('hex');
}

function makeKarmaBox(overrides: Partial<KarmaBox> = {}): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value: 100n,
    createdAtBlock: 1,
    owner: OWNER_A,
    ...overrides,
  };
  return { id: '', ...candidate, ...fixtureProvenance(candidate, 1) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('karma membership hook', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getKarmaOwners returns distinct owners of unspent karma boxes', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, getKarmaOwners, consumeBox } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const boxA1 = makeKarmaBox({ owner: OWNER_A });
    boxA1.id = computeBoxId(boxA1);
    insertBox(boxA1);

    const boxA2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(boxA2, fixtureProvenance(boxA2, 2));
    boxA2.id = computeBoxId(boxA2);
    insertBox(boxA2);

    const boxB = makeKarmaBox({ owner: OWNER_B, value: 50n });
    Object.assign(boxB, fixtureProvenance(boxB, 1));
    boxB.id = computeBoxId(boxB);
    insertBox(boxB);

    const owners = getKarmaOwners();
    expect(owners).toContain(ownerHex(OWNER_A));
    expect(owners).toContain(ownerHex(OWNER_B));
    expect(owners).toHaveLength(2);

    consumeBox(boxB.id!, 5);
    const afterConsume = getKarmaOwners();
    expect(afterConsume).not.toContain(ownerHex(OWNER_B));
    expect(afterConsume).toHaveLength(1);
  });

  it('first karma insert fires onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const gains: string[] = [];
    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: (h) => losses.push(h),
    });

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    expect(gains).toEqual([ownerHex(OWNER_A)]);
    expect(losses).toEqual([]);
  });

  it('second karma insert does not fire onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const gains: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: () => {},
    });

    const box1 = makeKarmaBox({ owner: OWNER_A });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    gains.length = 0;

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    expect(gains).toEqual([]);
  });

  it('consuming last karma box fires onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    consumeBox(box.id!, 5);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });

  it('consuming one of two karma boxes does not fire onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box1 = makeKarmaBox({ owner: OWNER_A });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 200n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    consumeBox(box1.id!, 5);
    expect(losses).toEqual([]);
  });

  it('deleteBox (revert of first insert) fires onLoss', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, deleteBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    deleteBox(box.id!);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });

  it('unconsumeBox (revert of last consume) fires onGain', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, unconsumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box = makeKarmaBox({ owner: OWNER_A });
    box.id = computeBoxId(box);
    insertBox(box);
    consumeBox(box.id!, 5);

    const gains: string[] = [];
    registerKarmaMembershipHook({
      onGain: (h) => gains.push(h),
      onLoss: () => {},
    });

    unconsumeBox(box.id!);
    expect(gains).toEqual([ownerHex(OWNER_A)]);
  });

  // T5: an exact spend of an owner's last karma box fires onLoss; a spend
  // leaving a box does not (TYPES_INTERFACE → Box value domain).
  it('T5: exact spend of last box fires onLoss; a spend leaving a box does not', async () => {
    const { initDb } = await importDbFresh();
    const { insertBox, consumeBox, registerKarmaMembershipHook } = await importUtxoFresh();
    const { computeBoxId } = await importTypes();

    initDb(':memory:');

    const box1 = makeKarmaBox({ owner: OWNER_A, value: 5n });
    box1.id = computeBoxId(box1);
    insertBox(box1);

    const box2 = makeKarmaBox({ owner: OWNER_A, value: 10n });
    Object.assign(box2, fixtureProvenance(box2, 2));
    box2.id = computeBoxId(box2);
    insertBox(box2);

    const losses: string[] = [];
    registerKarmaMembershipHook({
      onGain: () => {},
      onLoss: (h) => losses.push(h),
    });

    // Consume one — a spend leaving a box: no onLoss.
    consumeBox(box1.id!, 5);
    expect(losses).toEqual([]);

    // Consume the last — an exact spend: onLoss fires.
    consumeBox(box2.id!, 5);
    expect(losses).toEqual([ownerHex(OWNER_A)]);
  });
});

// ---------------------------------------------------------------------------
// Net's relay gate after a commit (NODE_INTERFACE → Post transactions → "The
// set moves after a commit, never inside a transaction"). One block carries an
// invite by a root (the invitee's first karma box is the grant), a post paid
// from its author's only box (no karma left), and a post paid from one of its
// author's two boxes; a sentinel sits in the set holding no karma, touched by
// no block, so a re-seed and a per-owner move answer differently for it.
// ---------------------------------------------------------------------------

const inviter = makeTestIdentity();
const invitee = makeTestIdentity();
const lastBoxPoster = makeTestIdentity();
const spareBoxPoster = makeTestIdentity();
const SENTINEL = 'ee'.repeat(32);

const hexOf = (who: TestIdentity): string => toHex(who.userId);
const sorted = (owners: Iterable<string>): string[] => [...owners].sort();

/** Net's relay-gate surface over a real set, recording each call. */
function recordingNet() {
  const members = new Set<string>();
  const calls: string[] = [];
  const node = {
    setKarmaMembers(owners: Iterable<string>): void {
      calls.push('set');
      members.clear();
      for (const owner of owners) members.add(owner);
    },
    addKarmaMember(ownerHex: string): void {
      calls.push(`add ${ownerHex}`);
      members.add(ownerHex);
    },
    removeKarmaMember(ownerHex: string): void {
      calls.push(`remove ${ownerHex}`);
      members.delete(ownerHex);
    },
    tipApplied(): void {},
  };
  return { members, calls, node: node as unknown as NetNode };
}

/** The root's invite: its karma back less the bond, and the bond naming the invitee. */
function inviteTx(karma: KarmaBox): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [
      { boxType: 'karma', value: karma.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: inviter.userId },
      { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: inviter.userId, inviteePublicKey: invitee.userId },
    ] as AnyBoxCandidate[],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, inviter.privateKey, hexOf(inviter));
  return tx;
}

/** A thread post paid from one karma box of exactly its price: no karma change. */
function exactPostTx(author: TestIdentity, karma: KarmaBox, content: string): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karma.id!],
    outputs: [{ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: 0 } as AnyBoxCandidate],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post: makePostCommit(author.userId, content),
  };
  signTransaction(tx, author.privateKey, hexOf(author));
  return tx;
}

/**
 * A node over a fresh store — the inviter a root, each poster's boxes, the
 * tree over them — with net's set seeded from the store as `index.ts` seeds it,
 * plus the sentinel.
 */
async function openNode() {
  const db = await import('../../src/store/db.js');
  db.initDb(':memory:');
  db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  const utxo = await import('../../src/store/utxo.js');
  const records = await import('../../src/store/identity-records.js');
  records.putIdentityRecord(inviter.userId, {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
    lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  });
  const inviterKarma = seededKarmaBox(100n, inviter.userId, 0, 1);
  const lastBox = seededKarmaBox(POST_PRICE_THREAD, lastBoxPoster.userId, 0, 2);
  const spentBox = seededKarmaBox(POST_PRICE_THREAD, spareBoxPoster.userId, 0, 3);
  const spareBox = seededKarmaBox(50n, spareBoxPoster.userId, 0, 4);
  for (const box of [inviterKarma, lastBox, spentBox, spareBox]) utxo.insertBox(box);
  await activateProverOverStore();

  const net = recordingNet();
  (await import('../../src/services/net-instance.js')).setNet(net.node);
  net.node.setKarmaMembers([...utxo.getKarmaOwners(), SENTINEL]);
  net.calls.length = 0;

  return {
    db,
    net,
    txs: [
      inviteTx(inviterKarma),
      exactPostTx(lastBoxPoster, lastBox, 'paid from the last box'),
      exactPostTx(spareBoxPoster, spentBox, 'paid from one of two'),
    ],
    blockApply: await import('../../src/services/block-apply.js'),
    forks: await import('../../src/services/fork-resolution.js'),
    corrupt: await import('../../src/services/corrupt-state.js'),
  };
}

describe("net's karma membership moves after a commit", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a committed block moves each owner whose karma boxes it inserted or spent, present iff it holds one, and no other', async () => {
    const node = await openNode();
    const block = await makeApplicableBlock({ utxoTxs: node.txs });

    expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    expect(sorted(node.net.members)).toEqual(
      sorted([hexOf(inviter), hexOf(invitee), hexOf(spareBoxPoster), SENTINEL]),
    );
    expect(sorted(node.net.calls)).toEqual(sorted([
      `add ${hexOf(inviter)}`,
      `add ${hexOf(invitee)}`,
      `add ${hexOf(spareBoxPoster)}`,
      `remove ${hexOf(lastBoxPoster)}`,
    ]));
  });

  it('a committed reorg re-seeds the set from the store, the blocks it reverts and applies moving nothing on their own', async () => {
    const node = await openNode();
    // Both over the pre-block state: the reorg reverts `block` and applies `rival`.
    const rival = await makeApplicableBlock({ utxoTxs: [node.txs[0]!] });
    const block = await makeApplicableBlock({ utxoTxs: node.txs });
    expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    node.net.calls.length = 0;

    node.forks.reorg(0, [rival]);

    expect(sorted(node.net.members)).toEqual(
      sorted([hexOf(inviter), hexOf(invitee), hexOf(lastBoxPoster), hexOf(spareBoxPoster)]),
    );
    expect(node.net.calls).toEqual(['set']);
  });

  it('a block the funnel refuses moves nothing', async () => {
    const node = await openNode();
    const before = sorted(node.net.members);
    const liar = await makeApplicableBlock({ utxoTxs: node.txs, stateRoot: 'ff'.repeat(33) });

    expect(node.blockApply.applyOrderingBlockVerdict(liar)).toEqual({ applied: false, class: 'consensus' });
    expect(sorted(node.net.members)).toEqual(before);
    expect(node.net.calls).toEqual([]);
  });

  it('a block whose writes fail inside its transaction moves nothing', async () => {
    const node = await openNode();
    const before = sorted(node.net.members);
    const block = await makeApplicableBlock({ utxoTxs: node.txs });
    // The block's last write refused: every effect is written, then the
    // transaction rolls back.
    node.db.getDb().exec(
      "CREATE TRIGGER refuse_journal BEFORE INSERT ON block_journal BEGIN SELECT RAISE(ABORT, 'journal refused'); END",
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(node.blockApply.applyOrderingBlockVerdict(block)).toMatchObject({ applied: false, class: 'local' });
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
    expect(sorted(node.net.members)).toEqual(before);
    expect(node.net.calls).toEqual([]);
  });

  it('the speculative run moves nothing', async () => {
    const node = await openNode();
    const before = sorted(node.net.members);
    const block = await makeApplicableBlock({ utxoTxs: node.txs });

    expect(node.blockApply.computePostBlockStateRoot(block)).toEqual({ kind: 'computed', stateRoot: block.header.stateRoot });
    expect(sorted(node.net.members)).toEqual(before);
    expect(node.net.calls).toEqual([]);
  });

  it('a reorg that rolls back moves nothing', async () => {
    const node = await openNode();
    const liar = await makeApplicableBlock({ utxoTxs: node.txs, stateRoot: 'ff'.repeat(33) });
    const block = await makeApplicableBlock({ utxoTxs: node.txs });
    expect(node.blockApply.applyOrderingBlockVerdict(block)).toEqual({ applied: true });
    const after = sorted(node.net.members);
    node.net.calls.length = 0;

    expect(() => node.forks.reorg(0, [liar])).toThrow(node.corrupt.ReorgBlockRejectedError);
    expect(sorted(node.net.members)).toEqual(after);
    expect(node.net.calls).toEqual([]);
  });
});
