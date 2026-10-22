// NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending view, as
// admission spends from it": on either listing, `boxes`, `boxCount`, `next`
// and `total` range over the owner's boxes under the pool's view, and on
// `/karma` `effective` is admission's `remaining` at `tip + 1`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { insertBox } from '../../src/store/utxo.js';
import { putIdentityRecord } from '../../src/store/identity-records.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { makeTestConfig, seedProvenance, toHex, txToJson } from '../helpers.js';
import { config as nodeConfig } from '../../src/config.js';
import {
  computeCandidateBoxId,
  computeTxId,
  encodeHeader,
  encodeInterlinks,
  encodeUtxoTxTree,
  generateKeyPair,
  hash32,
  KARMA_MINIMUM,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  BlockHeader,
  CandidateOf,
  CreditBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';

// NODE_INTERFACE → "Route error policy": a route carries either a
// `{ error: <message> }` body or `{ error: <status>, reason: <message> }`.
function messageOf(data: unknown): string {
  const d = data as Record<string, unknown>;
  if (typeof d?.reason === 'string') return d.reason;
  return String(d?.error);
}

interface Response { status: number; data: unknown; }

async function send(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<Response> {
  return new Promise((resolve) => {
    const url = new URL(baseUrl + path);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: d });
          }
        });
      },
    );
    if (payload) req.write(payload);
    req.end();
  });
}

// A hashable ordering-block row at `height` so `getCurrentHeight` reads
// it (NODE_INTERFACE → Blocks); the row carries an empty body and a
// 64-byte validator signature. One row writes `MAX(height)` from
// `ordering_blocks`.
function pinTipAt(height: number): void {
  const header: BlockHeader = {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 1,
    createdAt: height * 60_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  const headerBytes = encodeHeader(header);
  const blockHashHex = Buffer.from(hash32(headerBytes)).toString('hex');
  getDb().prepare(
    `INSERT INTO ordering_blocks
       (height, header_bytes, utxotx_tree_bytes, validator_signature,
        created_at, block_hash, interlinks)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    height,
    Buffer.from(headerBytes),
    Buffer.from(encodeUtxoTxTree({ utxoTxIds: [], utxoTxs: [] })),
    Buffer.from(new Uint8Array(64)),
    header.createdAt,
    blockHashHex,
    Buffer.from(encodeInterlinks([])),
  );
}

interface Identity {
  pub: Uint8Array;
  pubHex: string;
  priv: ReturnType<typeof createPrivateKey>;
}

function newIdentity(): Identity {
  const kp = generateKeyPair();
  return {
    pub: kp.publicKey,
    pubHex: toHex(kp.publicKey),
    priv: createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }),
  };
}

function signTx(tx: UtxoTransaction, by: Identity): void {
  const sig = cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), by.priv);
  tx.signatures[by.pubHex] = new Uint8Array(sig);
}

// NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending view, as
// admission spends from it": the five fields that range the owner's karma
// under the flag — the rest reads as without it.
const KARMA_FLAG_FIELDS = ['total', 'effective', 'boxes', 'boxCount', 'next'] as const;

function withoutKeys<K extends string>(obj: Record<string, unknown>, keys: readonly K[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (!(keys as readonly string[]).includes(k)) out[k] = obj[k];
  }
  return out;
}

function makeConfig(): Config {
  return makeTestConfig({
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
    orderingBlockPowTargetBits: 3072,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
  });
}

// NODE_INTERFACE → UTXO queries: the pending view by owner, through the
// public app's `/karma` and `/credits` listings.
describe('the listings under pending=1', () => {
  let server: http.Server;
  let baseUrl: string;

  // A monotonically rising seed so no two seeded boxes collide on
  // `(tx_id, output_index)` even inside one file.
  let seedNonce = 1_000;

  beforeAll(() => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const app = createApp(makeConfig());
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // The decay clock reads this height; the module-level config supplies
    // the running node's `staleThresholdBlocks` and `decayIntervalBlocks`
    // (NODE_INTERFACE → Karma transition rules → "Engine inputs the rule
    // needs"), and the two numbers decide what owed decay reads at
    // `tip + 1`. One past the threshold so an owner with
    // `lastActivityBlock = 0` is stale under both `tip` and `tip + 1`
    // (TYPES_INTERFACE → Identity record and karma valuation).
    pinTipAt(nodeConfig.karmaStaleThresholdBlocks + 1);
  });

  afterAll(() => {
    server.close();
    closeDb();
  });

  // A root record (ARCHITECTURE → Roots) with its clocks fresh at the
  // pinned tip — not stale by the valuation above
  // (TYPES_INTERFACE → Identity record and karma valuation).
  function freshRootRecord(): Parameters<typeof putIdentityRecord>[1] {
    return {
      lastActivityBlock: nodeConfig.karmaStaleThresholdBlocks,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 1,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    };
  }

  // Stale from genesis: `lastActivityBlock = 0` with the pinned tip at
  // `karmaStaleThresholdBlocks` makes `isIdentityStale` true at
  // `tip + 1 = karmaStaleThresholdBlocks + 1`.
  function staleRootRecord(): Parameters<typeof putIdentityRecord>[1] {
    return {
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 1,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    };
  }

  function seedCredit(owner: Uint8Array, value: bigint): CreditBox {
    const box = seedProvenance<CreditBox>({
      boxType: 'credit',
      value,
      createdAtBlock: 0,
      owner,
    }, 1, ++seedNonce);
    insertBox(box);
    return box;
  }

  function seedKarma(owner: Uint8Array, value: bigint, income?: true): KarmaBox {
    const base: Record<string, unknown> = {
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner,
    };
    if (income === true) base['income'] = true;
    const box = seedProvenance<KarmaBox>(base, 1, ++seedNonce);
    insertBox(box);
    return box;
  }

  function buildCreditTransfer(
    from: Identity,
    inputBox: CreditBox,
    to: Uint8Array,
    amount: bigint,
  ): UtxoTransaction {
    const change = inputBox.value - amount;
    const outputs: CandidateOf<CreditBox>[] = [{
      boxType: 'credit',
      value: amount,
      createdAtBlock: 0,
      owner: to,
    }];
    if (change > 0n) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: 0,
        owner: from.pub,
      });
    }
    const tx: UtxoTransaction = {
      inputs: [inputBox.id!],
      outputs,
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTx(tx, from);
    return tx;
  }

  function buildCreditTransferFromId(
    from: Identity,
    inputId: string,
    inputValue: bigint,
    to: Uint8Array,
    amount: bigint,
  ): UtxoTransaction {
    const change = inputValue - amount;
    const outputs: CandidateOf<CreditBox>[] = [{
      boxType: 'credit',
      value: amount,
      createdAtBlock: 0,
      owner: to,
    }];
    if (change > 0n) {
      outputs.push({
        boxType: 'credit',
        value: change,
        createdAtBlock: 0,
        owner: from.pub,
      });
    }
    const tx: UtxoTransaction = {
      inputs: [inputId],
      outputs,
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTx(tx, from);
    return tx;
  }

  function buildInvite(
    inviter: Identity,
    inputKarma: KarmaBox,
    bond: bigint,
    invitee: Uint8Array,
  ): UtxoTransaction {
    const outputs: unknown[] = [];
    const change = inputKarma.value - bond;
    if (change > 0n) {
      outputs.push({
        boxType: 'karma',
        value: change,
        createdAtBlock: 0,
        owner: inviter.pub,
      });
    }
    outputs.push({
      boxType: 'bond',
      value: bond,
      createdAtBlock: 0,
      inviterId: inviter.pub,
      inviteePublicKey: invitee,
    });
    const tx: UtxoTransaction = {
      inputs: [inputKarma.id!],
      outputs: outputs as UtxoTransaction['outputs'],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTx(tx, inviter);
    return tx;
  }

  // -------------------------------------------------------------------------
  // Credits: a transfer, its change box in the sender's pending listing;
  // without the flag, the sender's confirmed box the transfer spends.
  // -------------------------------------------------------------------------

  it('a credit transfer: the sender lists the change under pending=1, the payment lands with the recipient, the confirmed listing is unmoved', async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const seeded = seedCredit(alice.pub, 1_000_000n);

    const tx = buildCreditTransfer(alice, seeded, bob.pub, 400_000n);
    const posted = await send(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(tx) });
    expect(posted.status, JSON.stringify(posted.data)).toBe(200);

    const txId = computeTxId(tx);
    const paymentId = computeCandidateBoxId(tx.outputs[0]!, txId, 0);
    const changeId = computeCandidateBoxId(tx.outputs[1]!, txId, 1);

    // The sender's pending listing: the change, and no `lockedUntilBlock`
    // key on a pooled row (NODE_INTERFACE → UTXO queries → "`pending=1`
    // answers the pending view, as admission spends from it").
    const senderPending = await send(baseUrl, `/credits/${alice.pubHex}?pending=1`, 'GET');
    expect(senderPending.status).toBe(200);
    const senderBody = senderPending.data as Record<string, unknown>;
    const senderBoxes = senderBody.boxes as Array<Record<string, unknown>>;
    expect(senderBoxes.map((b) => b['boxId'])).toEqual([changeId]);
    expect(senderBoxes[0]!['lockedUntilBlock']).toBeUndefined();
    expect(senderBody.boxCount).toBe(1);
    expect(senderBody.total).toBe('600000');

    // The recipient's pending listing: the payment alone.
    const recipientPending = await send(baseUrl, `/credits/${bob.pubHex}?pending=1`, 'GET');
    expect(recipientPending.status).toBe(200);
    const recipientBody = recipientPending.data as Record<string, unknown>;
    const recipientBoxes = recipientBody.boxes as Array<Record<string, unknown>>;
    expect(recipientBoxes.map((b) => b['boxId'])).toEqual([paymentId]);
    expect(recipientBody.boxCount).toBe(1);
    expect(recipientBody.total).toBe('400000');

    // Without the flag, the sender's listing holds the box the transfer
    // spends — the confirmed set is as the chain left it.
    const senderConfirmed = await send(baseUrl, `/credits/${alice.pubHex}`, 'GET');
    expect(senderConfirmed.status).toBe(200);
    const confirmedBody = senderConfirmed.data as Record<string, unknown>;
    const confirmedBoxes = confirmedBody.boxes as Array<Record<string, unknown>>;
    expect(confirmedBoxes.map((b) => b['boxId'])).toEqual([seeded.id!]);
    expect(confirmedBody.total).toBe('1000000');
  });

  // -------------------------------------------------------------------------
  // A chain: the second transfer spends the first's pooled change
  // (`getBoxWithPending` resolves the input over the pending view).
  // -------------------------------------------------------------------------

  it('a second transfer built on the first\'s pooled change is admitted, and the sender\'s pending listing holds the second\'s change alone', async () => {
    const alice = newIdentity();
    const bob = newIdentity();
    const carol = newIdentity();
    const seeded = seedCredit(alice.pub, 1_000_000n);

    const first = buildCreditTransfer(alice, seeded, bob.pub, 200_000n);
    const firstPosted = await send(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(first) });
    expect(firstPosted.status, JSON.stringify(firstPosted.data)).toBe(200);

    const firstTxId = computeTxId(first);
    const firstChangeId = computeCandidateBoxId(first.outputs[1]!, firstTxId, 1);
    const firstChangeValue = 800_000n;

    const second = buildCreditTransferFromId(alice, firstChangeId, firstChangeValue, carol.pub, 300_000n);
    const secondPosted = await send(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(second) });
    expect(secondPosted.status, JSON.stringify(secondPosted.data)).toBe(200);

    const secondTxId = computeTxId(second);
    const secondChangeId = computeCandidateBoxId(second.outputs[1]!, secondTxId, 1);

    const pending = await send(baseUrl, `/credits/${alice.pubHex}?pending=1`, 'GET');
    expect(pending.status).toBe(200);
    const body = pending.data as Record<string, unknown>;
    const boxes = body.boxes as Array<Record<string, unknown>>;
    expect(boxes.map((b) => b['boxId'])).toEqual([secondChangeId]);
    expect(body.boxCount).toBe(1);
    expect(body.total).toBe('500000');
  });

  // -------------------------------------------------------------------------
  // Karma: pooled karma change beside the income box; the mark stays only
  // on the income row (NODE_INTERFACE → Karma transition rules → "No karma
  // output carries the mark").
  // -------------------------------------------------------------------------

  it('a pooled invite: the sender\'s karma listing holds the change (no `income` key) beside the income box (its mark kept); only the flag-ranged fields differ from the unflagged answer', async () => {
    const inviter = newIdentity();
    putIdentityRecord(inviter.pub, freshRootRecord());

    const ownBox = seedKarma(inviter.pub, 200n);
    const incomeBox = seedKarma(inviter.pub, 50n, true);
    const invitee = newIdentity().pub;

    const invite = buildInvite(inviter, ownBox, 100n, invitee);
    const posted = await send(baseUrl, '/invites', 'POST', { tx: txToJson(invite) });
    expect(posted.status, JSON.stringify(posted.data)).toBe(201);

    const txId = computeTxId(invite);
    const changeId = computeCandidateBoxId(invite.outputs[0]!, txId, 0);

    const pending = await send(baseUrl, `/karma/${inviter.pubHex}?pending=1`, 'GET');
    expect(pending.status).toBe(200);
    const pendingBody = pending.data as Record<string, unknown>;
    const pendingBoxes = pendingBody.boxes as Array<Record<string, unknown>>;
    const pendingById = new Map(pendingBoxes.map((b) => [b['boxId'] as string, b]));

    expect(pendingById.get(changeId)).toBeDefined();
    expect(pendingById.get(changeId)!['income']).toBeUndefined();
    expect(pendingById.get(incomeBox.id!)).toBeDefined();
    expect(pendingById.get(incomeBox.id!)!['income']).toBe(true);
    expect(pendingBody.boxCount).toBe(2);
    expect(pendingBody.total).toBe('150');

    const unflagged = await send(baseUrl, `/karma/${inviter.pubHex}`, 'GET');
    expect(unflagged.status).toBe(200);

    const pendingNonFlag = withoutKeys(pendingBody, KARMA_FLAG_FIELDS);
    const unflaggedNonFlag = withoutKeys(unflagged.data as Record<string, unknown>, KARMA_FLAG_FIELDS);
    expect(pendingNonFlag).toEqual(unflaggedNonFlag);
  });

  // -------------------------------------------------------------------------
  // Admission's measure — the boundary. A stale inviter with a pooled
  // invite; `E` from `/karma?pending=1` is `remaining` at `tip + 1`
  // (NODE_INTERFACE → Karma transition rules → "A karma spend is covered
  // by effective karma, over the block's body as a whole").
  // -------------------------------------------------------------------------

  it('effective under pending=1 is admission\'s remaining: a second invite whose bond leaves KARMA_MINIMUM of E standing is admitted; a fresh identity\'s invite leaving KARMA_MINIMUM − 1 is refused', async () => {
    // The owner holds enough karma to clear the floor past decay at the
    // pinned tip (NODE_INTERFACE → Karma transition rules → "Only a post
    // spends the floor"); the first bond leaves `admissionHeld` below
    // `getKarmaTotal`. The bonds pass the running range
    // (`[nodeConfig.inviteBondMin, nodeConfig.inviteBondMax]`), and the
    // boundary pair sits strictly inside it.
    const seedKarmaValue = 1000n;
    const firstBond = nodeConfig.inviteBondMin;

    const admittedInviter = newIdentity();
    putIdentityRecord(admittedInviter.pub, staleRootRecord());
    const admittedOwn = seedKarma(admittedInviter.pub, seedKarmaValue);
    const admittedInvitee1 = newIdentity().pub;
    const admittedFirst = buildInvite(admittedInviter, admittedOwn, firstBond, admittedInvitee1);
    const admittedFirstPost = await send(baseUrl, '/invites', 'POST', { tx: txToJson(admittedFirst) });
    expect(admittedFirstPost.status, JSON.stringify(admittedFirstPost.data)).toBe(201);
    const admittedFirstTxId = computeTxId(admittedFirst);
    const admittedChangeId = computeCandidateBoxId(admittedFirst.outputs[0]!, admittedFirstTxId, 0);
    const admittedChangeValue = seedKarmaValue - firstBond;

    const admittedPending = await send(baseUrl, `/karma/${admittedInviter.pubHex}?pending=1`, 'GET');
    expect(admittedPending.status).toBe(200);
    const admittedBody = admittedPending.data as Record<string, unknown>;
    const E = BigInt(admittedBody.effective as string);

    // The ceiling spend an invite admits — `E − KARMA_MINIMUM` leaves
    // exactly the floor.
    const admittedBond = E - KARMA_MINIMUM;
    const admittedInvitee2 = newIdentity().pub;
    const admittedSecond = buildInvite(
      admittedInviter,
      { ...admittedOwn, id: admittedChangeId, value: admittedChangeValue } as KarmaBox,
      admittedBond,
      admittedInvitee2,
    );
    const admittedSecondPost = await send(baseUrl, '/invites', 'POST', { tx: txToJson(admittedSecond) });
    expect(admittedSecondPost.status, JSON.stringify(admittedSecondPost.data)).toBe(201);

    // A fresh identity holding the same arrangement: the invite that
    // leaves `KARMA_MINIMUM − 1` of `E` standing is refused.
    const refusedInviter = newIdentity();
    putIdentityRecord(refusedInviter.pub, staleRootRecord());
    const refusedOwn = seedKarma(refusedInviter.pub, seedKarmaValue);
    const refusedInvitee1 = newIdentity().pub;
    const refusedFirst = buildInvite(refusedInviter, refusedOwn, firstBond, refusedInvitee1);
    const refusedFirstPost = await send(baseUrl, '/invites', 'POST', { tx: txToJson(refusedFirst) });
    expect(refusedFirstPost.status, JSON.stringify(refusedFirstPost.data)).toBe(201);
    const refusedFirstTxId = computeTxId(refusedFirst);
    const refusedChangeId = computeCandidateBoxId(refusedFirst.outputs[0]!, refusedFirstTxId, 0);
    const refusedChangeValue = seedKarmaValue - firstBond;

    const refusedPending = await send(baseUrl, `/karma/${refusedInviter.pubHex}?pending=1`, 'GET');
    expect(refusedPending.status).toBe(200);
    const refusedE = BigInt((refusedPending.data as Record<string, unknown>).effective as string);
    expect(refusedE).toBe(E); // the two arrangements agree

    const refusedBond = E - (KARMA_MINIMUM - 1n);
    const refusedInvitee2 = newIdentity().pub;
    const refusedSecond = buildInvite(
      refusedInviter,
      { ...refusedOwn, id: refusedChangeId, value: refusedChangeValue } as KarmaBox,
      refusedBond,
      refusedInvitee2,
    );
    const refusedSecondPost = await send(baseUrl, '/invites', 'POST', { tx: txToJson(refusedSecond) });
    expect(refusedSecondPost.status).toBe(400);
    expect(messageOf(refusedSecondPost.data).toLowerCase()).toContain('insufficient karma');

    // Controls: `E` is below the unflagged `effective` by at least the
    // pooled spend, and the owner owes decay (`owed > 0`) — the record's
    // clocks are at 0 and the chain's tip past `KARMA_STALE_THRESHOLD_BLOCKS`.
    const unflagged = await send(baseUrl, `/karma/${admittedInviter.pubHex}`, 'GET');
    const unflaggedE = BigInt((unflagged.data as Record<string, unknown>).effective as string);
    const unflaggedTotal = BigInt((unflagged.data as Record<string, unknown>).total as string);
    expect(unflaggedE - E).toBeGreaterThanOrEqual(firstBond);
    expect(unflaggedTotal - unflaggedE).toBeGreaterThan(0n); // owed > 0
  });

  // -------------------------------------------------------------------------
  // The clamp: owed exceeds held once decay catches up with the pool. The
  // route answers `effective: "0"` (NODE_INTERFACE → UTXO queries →
  // "`pending=1` answers the pending view, as admission spends from it").
  // -------------------------------------------------------------------------

  it('effective is "0" when owed exceeds held through decay catching up with a pooled spend', async () => {
    // The pool runs while the owner is fresh: `lastActivityBlock` at the
    // seeded tip puts them inside the stale window, so the invite admits
    // (NODE_INTERFACE → Karma transition rules → "A karma spend is
    // covered by effective karma, over the block's body as a whole").
    // Advancing the tip by `KARMA_STALE_THRESHOLD_BLOCKS` then makes the
    // owner stale under the pool-reduced `held`, and `owed > held`.
    const owner = newIdentity();
    putIdentityRecord(owner.pub, freshRootRecord());
    const ownKarma = seedKarma(owner.pub, 150n);
    const invitee = newIdentity().pub;
    const invite = buildInvite(owner, ownKarma, 140n, invitee);
    const posted = await send(baseUrl, '/invites', 'POST', { tx: txToJson(invite) });
    expect(posted.status, JSON.stringify(posted.data)).toBe(201);

    // Advance the tip so the pooled owner's record goes stale: the
    // valuation reads `height - lastActivityBlock >= staleThresholdBlocks`
    // (TYPES_INTERFACE → Identity record and karma valuation).
    pinTipAt(nodeConfig.karmaStaleThresholdBlocks * 3);

    const pending = await send(baseUrl, `/karma/${owner.pubHex}?pending=1`, 'GET');
    expect(pending.status).toBe(200);
    const body = pending.data as Record<string, unknown>;
    expect(body.effective).toBe('0');
  });

  // -------------------------------------------------------------------------
  // Paging through the route under `pending=1`. One row per page, every
  // row once, `value DESC, id`.
  // -------------------------------------------------------------------------

  it('paging through /credits?pending=1 at limit=1 walks every row once in value DESC order; boxCount is the whole set on every page', async () => {
    const owner = newIdentity();
    const sender = newIdentity();

    // Three values above the per-byte credit floor
    // (TYPES_INTERFACE → Box value domain → "A `credit` output carries a
    // per-byte MINIMUM, and no other box type does"); the pooled 200_000
    // lies between the two confirmed rows in value DESC order.
    const highConfirmed = seedCredit(owner.pub, 300_000n);
    const lowConfirmed = seedCredit(owner.pub, 100_000n);

    const senderBox = seedCredit(sender.pub, 250_000n);
    const payTx = buildCreditTransfer(sender, senderBox, owner.pub, 200_000n);
    const payPost = await send(baseUrl, '/credits/transfer', 'POST', { tx: txToJson(payTx) });
    expect(payPost.status, JSON.stringify(payPost.data)).toBe(200);
    const payTxId = computeTxId(payTx);
    const pooledId = computeCandidateBoxId(payTx.outputs[0]!, payTxId, 0);

    const expectedOrder = [
      { value: '300000', boxId: highConfirmed.id! },
      { value: '200000', boxId: pooledId },
      { value: '100000', boxId: lowConfirmed.id! },
    ];

    let after: string | null = null;
    const seen: Array<{ value: string; boxId: string }> = [];
    for (let i = 0; i < expectedOrder.length; i++) {
      const path = after === null
        ? `/credits/${owner.pubHex}?pending=1&limit=1`
        : `/credits/${owner.pubHex}?pending=1&limit=1&after=${after}`;
      const page = await send(baseUrl, path, 'GET');
      expect(page.status).toBe(200);
      const body = page.data as Record<string, unknown>;
      const boxes = body.boxes as Array<Record<string, unknown>>;
      expect(boxes.length).toBe(1);
      expect(body.boxCount).toBe(3);
      seen.push({ value: boxes[0]!['value'] as string, boxId: boxes[0]!['boxId'] as string });
      after = (body.next as string | null) ?? null;
    }
    expect(seen).toEqual(expectedOrder);
    expect(after).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The flag's refusals — on either route; the strict-parser's duplicate
  // name reaches ahead of the route (NODE_INTERFACE → HTTP API → "A query
  // parameter is one string").
  // -------------------------------------------------------------------------

  it('/karma and /credits refuse a pending that is not 1 with a 400', async () => {
    const anyone = newIdentity();

    for (const kind of ['karma', 'credits']) {
      for (const bad of ['0', 'true', '']) {
        const r = await send(baseUrl, `/${kind}/${anyone.pubHex}?pending=${bad}`, 'GET');
        expect(r.status, `${kind} pending=${bad}`).toBe(400);
      }
      const dup = await send(baseUrl, `/${kind}/${anyone.pubHex}?pending=1&pending=1`, 'GET');
      expect(dup.status, `${kind} pending=1&pending=1`).toBe(400);
    }
  });
});
