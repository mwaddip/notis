// Admission's correctness gates on the relay and every HTTP route, and the
// unstake route's shape (MEMPOOL_INTERFACE → Correctness gates; NODE_INTERFACE
// → Service Layer Architecture → "One function admits"; NODE_INTERFACE →
// Backers).
//
// Each case enters through the real seam: `handleRelayedTx` for a relayed
// transaction, the HTTP route for a submission, with the services' own deps
// wired as the server wires them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import {
  computeContentHash,
  computeTxId,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKE_KARMA_COST,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type { CandidateOf } from '@dagsocial/types';
import type {
  BackerStakeBox,
  BondBox,
  CreditBox,
  KarmaBox,
  LikeAccrualBox,
  PostCommit,
  UsernameBox,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { materializeOutput, validateTx } from '@dagsocial/consensus';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getBoxWithPending,
  getKarmaValue,
  getBoxProvenance,
  hasActiveVouchEscrow,
  insertBox,
  insertPost,
  getPendingEntries,
  getIdentityRecord,
  putIdentityRecord,
  getNetworkRecord,
  getVouchBox,
  getUsername,
  getUsernameByOwner,
  getOwnKarmaBoxIdsWithPending,
  insertBlockTopology,
} from '../../src/store/index.js';
import { getCurrentHeight } from '../../src/store/ordering.js';
import { castLike } from '../../src/services/likes.js';
import { createInvite } from '../../src/services/invites.js';
import { executePostWithdraw } from '../../src/services/post-withdraw.js';
import { createRouter as createBackersRouter } from '../../src/routes/backers.js';
import { handleRelayedTx } from '../../src/services/handle-tx.js';
import { config } from '../../src/config.js';
import { admissionOwed } from '../../src/services/karma-admission.js';
import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  type Stored,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';

function hex(u: Uint8Array): string { return Buffer.from(u).toString('hex'); }

function makeKey(): { pub: Uint8Array; hex: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  return { pub, hex: hex(pub), priv: privateKey };
}

/** The pending view wired as `server.ts` wires it. */
function makeDeps(): UtxoEngineDeps {
  const db = getDb();
  return {
    getBox: (id: string) => {
      const b = storeGetBox(id);
      if (b) {
        const r = db.prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?').get(id) as { spent_at_block: number | null } | undefined;
        if (r && r.spent_at_block === null) return b;
      }
      return getBoxWithPending(id);
    },
    insertBox,
    consumeBox: (id: string, atBlock: number) => {
      db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    getKarmaOwed: admissionOwed({ staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS, decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM }),
    getKarmaValue,
    getOwnKarmaBoxIds: (owner: Uint8Array) => getOwnKarmaBoxIdsWithPending(hex(owner)),
    getIdentityRecord,
    hasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: KARMA_DECAY_AMOUNT,
      karmaMinimum: KARMA_MINIMUM,
    },
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => db.transaction(fn)(),
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: 1,
    putIdentityRecord,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    getUsername,
    getUsernameByOwner,
  };
}

/** A karma box for `owner`, seeded. */
function seedKarma(owner: Uint8Array, value: bigint, nonce: number): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>({
    boxType: 'karma', value, createdAtBlock: 0, owner,
  }, 1, nonce);
  insertBox(box);
  return box;
}

function seedCredit(owner: Uint8Array, value: bigint, nonce: number): Stored<CreditBox> {
  const box = seedProvenance<CreditBox>({
    boxType: 'credit', value, createdAtBlock: 0, owner,
  }, 1, nonce);
  insertBox(box);
  return box;
}

function seedStake(owner: Uint8Array, weight: bigint, nonce: number): Stored<BackerStakeBox> {
  const box = seedProvenance<BackerStakeBox>({
    boxType: 'backer_stake', value: 0n as 0n, createdAtBlock: 0, owner, weight,
  }, 1, nonce);
  insertBox(box);
  return box;
}

function seedPost(authorId: Uint8Array, label: string): string {
  const commit: PostCommit = {
    contentHash: computeContentHash(label),
    author: authorId,
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
  };
  // A fixture post id — same shape helpers.ts uses: hash the commit bytes
  const idBuf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) idBuf[i] = (authorId[i] ?? 0) ^ Buffer.from(label).at(0)!;
  const postId = idBuf.toString('hex');
  const txIdBuf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) txIdBuf[i] = (authorId[i] ?? 0) ^ (Buffer.from(label).at(1) ?? 0);
  insertPost(postId, txIdBuf.toString('hex'), commit, 'test ' + label);
  return postId;
}

function seedMember(key: Uint8Array, overrides: { memberVouches?: number; invitesUsed?: number } = {}): void {
  putIdentityRecord(key, {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 1, memberBar: 0,
    memberVouches: overrides.memberVouches ?? 1,
    memberLikes: 0n,
    invitesUsed: overrides.invitesUsed ?? 0,
  });
}

function seedRoot(key: Uint8Array): void {
  putIdentityRecord(key, {
    lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 1, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  });
}

async function postReq(router: express.Router, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const data = JSON.stringify(body);
      const req = http.request(
        { hostname: 'localhost', port: addr.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { server.close(); try { resolve({ status: res.statusCode!, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode!, body: { raw: d } }); } });
        },
      );
      req.write(data);
      req.end();
    });
  });
}

describe('admission runs the pool\'s correctness gates on every path', () => {
  beforeEach(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
  });
  afterEach(() => { closeDb(); });

  // -------------------------------------------------------------------------
  // The relay meets the like gate.
  // -------------------------------------------------------------------------
  it('the relay refuses a second like of one post by one liker', async () => {
    const liker = makeKey();
    seedMember(liker.pub);
    const karma = seedKarma(liker.pub, 100n, 1);
    const author = makeKey();
    const postId = seedPost(author.pub, 'post1');

    // The first like pools via castLike (admission runs the gate but finds
    // nothing).
    const deps = makeDeps();
    const tx1: UtxoTransaction = {
      inputs: [karma.id],
      outputs: [
        { boxType: 'karma', value: karma.value - LIKE_KARMA_COST, createdAtBlock: 0, owner: liker.pub } as CandidateOf<KarmaBox>,
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author: author.pub } as CandidateOf<LikeAccrualBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(tx1, liker.priv, liker.hex);
    // Point `getTopologyAuthor` at this post's author for castLike/validateTx.
    const likeDeps = { ...deps, getTopologyAuthor: () => author.pub };
    expect(castLike(likeDeps, tx1, 2).castLikeResult).toBe('pending');
    expect(getPendingEntries(10)).toHaveLength(1); // control

    // The second — chained through the first's change — reaches the relay.
    const change1 = materializeOutput(tx1.outputs[0]!, computeTxId(tx1), 0) as KarmaBox;
    const tx2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value - LIKE_KARMA_COST, createdAtBlock: 0, owner: liker.pub } as CandidateOf<KarmaBox>,
        { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: 0, author: author.pub } as CandidateOf<LikeAccrualBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(tx2, liker.priv, liker.hex);

    // The relay reads the real wiring (`server.ts`); `handle-tx.ts` reads
    // `getTopologyAuthor` from `getTopologyAuthorBytes`, which needs a
    // topology row. Insert one for this post so the relay's `validateTx`
    // sees the author.
    insertBlockTopology(postId, [], hex(author.pub), 1);

    const admitted = handleRelayedTx(tx2, undefined, 'peer');
    expect(admitted).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The relay meets the claim gates (name and claimant).
  // -------------------------------------------------------------------------
  it('the relay refuses a second claim of one canonical name', async () => {
    const first = makeKey();
    seedRoot(first.pub);
    const karma1 = seedKarma(first.pub, 100n, 1);
    const tx1: UtxoTransaction = {
      inputs: [karma1.id],
      outputs: [
        { boxType: 'karma', value: karma1.value, createdAtBlock: 0, owner: first.pub } as CandidateOf<KarmaBox>,
        { boxType: 'username', value: 0n, createdAtBlock: 0, owner: first.pub, name: Buffer.from('Alice', 'utf8') } as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx1, first.priv, first.hex);
    expect(handleRelayedTx(tx1, undefined, 'peer')).toBe(true);

    const second = makeKey();
    seedRoot(second.pub);
    const karma2 = seedKarma(second.pub, 100n, 2);
    const tx2: UtxoTransaction = {
      inputs: [karma2.id],
      outputs: [
        { boxType: 'karma', value: karma2.value, createdAtBlock: 0, owner: second.pub } as CandidateOf<KarmaBox>,
        { boxType: 'username', value: 0n, createdAtBlock: 0, owner: second.pub, name: Buffer.from('ALICE', 'utf8') } as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, second.priv, second.hex);
    expect(handleRelayedTx(tx2, undefined, 'peer')).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  it('the relay refuses a second claim by one identity', async () => {
    const c = makeKey();
    seedRoot(c.pub);
    const karma = seedKarma(c.pub, 200n, 3);
    const tx1: UtxoTransaction = {
      inputs: [karma.id],
      outputs: [
        { boxType: 'karma', value: karma.value, createdAtBlock: 0, owner: c.pub } as CandidateOf<KarmaBox>,
        { boxType: 'username', value: 0n, createdAtBlock: 0, owner: c.pub, name: Buffer.from('NameA', 'utf8') } as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx1, c.priv, c.hex);
    expect(handleRelayedTx(tx1, undefined, 'peer')).toBe(true);

    const change1 = materializeOutput(tx1.outputs[0]!, computeTxId(tx1), 0) as KarmaBox;
    const tx2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value, createdAtBlock: 0, owner: c.pub } as CandidateOf<KarmaBox>,
        { boxType: 'username', value: 0n, createdAtBlock: 0, owner: c.pub, name: Buffer.from('NameB', 'utf8') } as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, c.priv, c.hex);
    expect(handleRelayedTx(tx2, undefined, 'peer')).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The relay meets the vouch gate.
  // -------------------------------------------------------------------------
  it('the relay refuses a second vouch for one (voucher, target)', async () => {
    const voucher = makeKey();
    const target = makeKey();
    seedMember(voucher.pub);
    seedMember(target.pub);
    const karma = seedKarma(voucher.pub, 100n, 4);
    const tx1: UtxoTransaction = {
      inputs: [karma.id],
      outputs: [
        { boxType: 'karma', value: karma.value - VOUCH_KARMA_AMOUNT, createdAtBlock: 0, owner: voucher.pub } as CandidateOf<KarmaBox>,
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 0, voucherId: voucher.pub, targetId: target.pub } as CandidateOf<VouchBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx1, voucher.priv, voucher.hex);
    expect(handleRelayedTx(tx1, undefined, 'peer')).toBe(true);

    const change1 = materializeOutput(tx1.outputs[0]!, computeTxId(tx1), 0) as KarmaBox;
    const tx2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value - VOUCH_KARMA_AMOUNT, createdAtBlock: 0, owner: voucher.pub } as CandidateOf<KarmaBox>,
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 0, voucherId: voucher.pub, targetId: target.pub } as CandidateOf<VouchBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx2, voucher.priv, voucher.hex);
    expect(handleRelayedTx(tx2, undefined, 'peer')).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // One pending bond per invitee (HTTP + relay).
  // -------------------------------------------------------------------------
  it('two invites naming one invitee: HTTP refuses the second 409, the relay false', async () => {
    const inviterA = makeKey();
    const inviterB = makeKey();
    seedRoot(inviterA.pub);
    seedRoot(inviterB.pub);
    const invitee = makeKey();
    const kA = seedKarma(inviterA.pub, 100n, 10);
    const kB = seedKarma(inviterB.pub, 100n, 11);

    const txA: UtxoTransaction = {
      inputs: [kA.id],
      outputs: [
        { boxType: 'karma', value: kA.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: inviterA.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: inviterA.pub, inviteePublicKey: invitee.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txA, inviterA.priv, inviterA.hex);

    const depsA = makeDeps();
    expect(createInvite(depsA, txA, 2).status).toBe('pending');
    expect(getPendingEntries(10)).toHaveLength(1);

    const txB: UtxoTransaction = {
      inputs: [kB.id],
      outputs: [
        { boxType: 'karma', value: kB.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: inviterB.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: inviterB.pub, inviteePublicKey: invitee.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txB, inviterB.priv, inviterB.hex);
    const depsB = makeDeps();
    let caught: Error | null = null;
    try { createInvite(depsB, txB, 2); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect((caught as unknown as { statusCode: number }).statusCode).toBe(409);
    expect(caught!.message).toBe('A pending invite already names this key');

    // The relay too.
    expect(handleRelayedTx(txB, undefined, 'peer')).toBe(false);
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // A member's pending bonds hold to its invites; a root is uncapped.
  // -------------------------------------------------------------------------
  it('a member\'s second pending bond is refused; a root\'s is admitted', async () => {
    const member = makeKey();
    seedMember(member.pub, { memberVouches: 1, invitesUsed: 0 });
    const km = seedKarma(member.pub, 500n, 20);
    const invitee1 = makeKey();
    const invitee2 = makeKey();
    const txM1: UtxoTransaction = {
      inputs: [km.id],
      outputs: [
        { boxType: 'karma', value: km.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: member.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: member.pub, inviteePublicKey: invitee1.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txM1, member.priv, member.hex);
    const deps1 = makeDeps();
    expect(createInvite(deps1, txM1, 2).status).toBe('pending');

    const change1 = materializeOutput(txM1.outputs[0]!, computeTxId(txM1), 0) as KarmaBox;
    const txM2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: member.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: member.pub, inviteePublicKey: invitee2.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txM2, member.priv, member.hex);
    const deps2 = makeDeps();
    let caught: Error | null = null;
    try { createInvite(deps2, txM2, 2); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect((caught as unknown as { statusCode: number }).statusCode).toBe(400);
    expect(caught!.message).toBe('Every invite this member has is already pending');
    expect(getPendingEntries(10)).toHaveLength(1);

    // The root arm.
    const root = makeKey();
    seedRoot(root.pub);
    const krootA = seedKarma(root.pub, 500n, 30);
    const inviteeR1 = makeKey();
    const inviteeR2 = makeKey();
    const txR1: UtxoTransaction = {
      inputs: [krootA.id],
      outputs: [
        { boxType: 'karma', value: krootA.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: root.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: root.pub, inviteePublicKey: inviteeR1.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txR1, root.priv, root.hex);
    const depsR1 = makeDeps();
    expect(createInvite(depsR1, txR1, 2).status).toBe('pending');

    const changeR = materializeOutput(txR1.outputs[0]!, computeTxId(txR1), 0) as KarmaBox;
    const txR2: UtxoTransaction = {
      inputs: [changeR.id!],
      outputs: [
        { boxType: 'karma', value: changeR.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: root.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: root.pub, inviteePublicKey: inviteeR2.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txR2, root.priv, root.hex);
    const depsR2 = makeDeps();
    expect(createInvite(depsR2, txR2, 2).status).toBe('pending');
  });

  // The gate reads D(N) from the live network record: a member whose
  // pending bonds have reached ⌊memberVouches / D(N)⌋ has no budget left,
  // and the next invite is refused (CONSENSUS_INTERFACE → What it holds →
  // "Who may invite, and how many, is one function"; ARCHITECTURE →
  // Membership — D(N) = max(1, icbrt(k·N))).
  it("a member with memberVouches = D(N) and one pending bond: the second invite is refused", async () => {
    // N = 8, k = 1 ⇒ D(N) = max(1, icbrt(8)) = 2.
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 8)').run();
    const member = makeKey();
    seedMember(member.pub, { memberVouches: 2, invitesUsed: 0 });
    const km = seedKarma(member.pub, 500n, 50);
    const invitee1 = makeKey();
    const invitee2 = makeKey();
    const txM1: UtxoTransaction = {
      inputs: [km.id],
      outputs: [
        { boxType: 'karma', value: km.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: member.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: member.pub, inviteePublicKey: invitee1.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txM1, member.priv, member.hex);
    expect(createInvite(makeDeps(), txM1, 2).status).toBe('pending');

    const change1 = materializeOutput(txM1.outputs[0]!, computeTxId(txM1), 0) as KarmaBox;
    const txM2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value - FIXTURE_BOND_KARMA, createdAtBlock: 0, owner: member.pub } as CandidateOf<KarmaBox>,
        { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: member.pub, inviteePublicKey: invitee2.pub } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(txM2, member.priv, member.hex);
    let caught: Error | null = null;
    try { createInvite(makeDeps(), txM2, 2); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect(caught!.message).toBe('Every invite this member has is already pending');
  });

  // -------------------------------------------------------------------------
  // One pending withdrawal per post.
  // -------------------------------------------------------------------------
  it('two withdrawals of one post: the second is 409 with its words', async () => {
    const author = makeKey();
    seedMember(author.pub);
    const km = seedKarma(author.pub, 100n, 40);

    // A confirmed post with a committed topology row.
    const commit: PostCommit = {
      contentHash: computeContentHash('post'),
      author: author.pub,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const createTxBuf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) createTxBuf[i] = (author.pub[i] ?? 0) ^ 0x5a;
    const createTxId = createTxBuf.toString('hex');
    const postIdBuf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) postIdBuf[i] = (author.pub[i] ?? 0) ^ 0xa5;
    const postId = postIdBuf.toString('hex');
    insertPost(postId, createTxId, commit, 'post body');
    insertBlockTopology(postId, [], hex(author.pub), 1);

    const txW1: UtxoTransaction = {
      inputs: [km.id],
      outputs: [
        { boxType: 'karma', value: km.value, createdAtBlock: 0, owner: author.pub } as CandidateOf<KarmaBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    };
    signTransaction(txW1, author.priv, author.hex);
    const deps = { ...makeDeps(), getTopologyAuthor: () => author.pub };
    expect(executePostWithdraw(deps, txW1, 3).txId).toBeTruthy();

    const change1 = materializeOutput(txW1.outputs[0]!, computeTxId(txW1), 0) as KarmaBox;
    const txW2: UtxoTransaction = {
      inputs: [change1.id!],
      outputs: [
        { boxType: 'karma', value: change1.value, createdAtBlock: 0, owner: author.pub } as CandidateOf<KarmaBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      postWithdraw: { postId },
    };
    signTransaction(txW2, author.priv, author.hex);
    let caught: Error | null = null;
    try { executePostWithdraw(deps, txW2, 3); } catch (err) { caught = err as Error; }
    expect(caught).not.toBeNull();
    expect((caught as unknown as { statusCode: number }).statusCode).toBe(409);
    expect(caught!.message).toBe('A withdrawal of this post is already pending');
    expect(getPendingEntries(10)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // The unstake route's shape.
  // -------------------------------------------------------------------------
  it('POST /backers/unstake refuses a credit transfer and admits a well-formed unstake', async () => {
    const holder = makeKey();
    seedRoot(holder.pub);
    const stake = seedStake(holder.pub, 100n, 50);
    // The route needs a backer pool for other routes, but unstake's shape
    // check runs ahead of admission. Seed one so the router is happy.
    const pool = seedProvenance({ boxType: 'backer_pool' as const, value: 0n as 0n, staked: 100n, accrual: 0n, createdAtBlock: 0 }, 1, 999);
    insertBox(pool as never);
    const credit = seedCredit(holder.pub, 100n, 60);

    const deps = makeDeps();
    const router = createBackersRouter({
      ...deps,
      getCurrentHeight,
      validateTx: (tx, h) => validateTx(deps, tx, h),
      getBackerPoolBox: () => pool as never,
      getBackerStakeBox: () => stake,
      backerSupply: 100n,
      creditFixedRateBlocks: 1_000_000,
    });

    // A credit transfer — not an unstake shape.
    const bad: UtxoTransaction = {
      inputs: [credit.id],
      outputs: [
        { boxType: 'credit', value: credit.value - 1n, createdAtBlock: 0, owner: holder.pub } as CandidateOf<CreditBox>,
        { boxType: 'fee', value: 1n, createdAtBlock: 0 } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(bad, holder.priv, holder.hex);
    const r1 = await postReq(router, '/unstake', { tx: txToJson(bad) });
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe('unstake outputs must be one backer_unstake marker and at most one backer_stake successor');
    expect(getPendingEntries(10)).toHaveLength(0);

    // A well-formed unstake.
    const good: UtxoTransaction = {
      inputs: [stake.id],
      outputs: [
        { boxType: 'backer_stake', value: 0n, createdAtBlock: 0, owner: holder.pub, weight: 60n } as never,
        { boxType: 'backer_unstake', value: 0n, createdAtBlock: 0, owner: holder.pub, weight: 40n } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(good, holder.priv, holder.hex);
    const r2 = await postReq(router, '/unstake', { tx: txToJson(good) });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('pending');
  });
});

// JSON form of a tx — hex for bytes, decimal strings for bigint values. The
// shape `checkRequestTx` reads.
function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  const out: Record<string, unknown> = {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => {
      const box: Record<string, unknown> = { ...o as Record<string, unknown> };
      // bigints → strings
      for (const k of Object.keys(box)) {
        const v = (box as Record<string, unknown>)[k];
        if (typeof v === 'bigint') box[k] = v.toString();
        else if (v instanceof Uint8Array) box[k] = Buffer.from(v).toString('hex');
      }
      return box;
    }),
    signatures: Object.fromEntries(Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')])),
    protocolVersion: tx.protocolVersion,
  };
  if (tx.likeTarget !== undefined) out.likeTarget = tx.likeTarget;
  if (tx.post !== undefined) out.post = tx.post;
  if (tx.postWithdraw !== undefined) out.postWithdraw = tx.postWithdraw;
  return out;
}
