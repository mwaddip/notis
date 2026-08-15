/**
 * Full-pipeline integration tests: validate → mempool → mine → confirm.
 *
 * These tests exercise the complete lifecycle of UTXO transactions (likes,
 * invites) through validation, mempool insertion, block mining, and state
 * confirmation.  The block creator applies UTXO transactions during
 * finalizeBlock, so no manual ingestion step is needed.
 */
import {
  fixtureProvenance,
  makeTestConfig,
  mineNextBlock,
  rawPublicKey,
  seedProvenance,
  signTransaction, fixturePostId, seedPostTx } from '../helpers.js';
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  generateKeyPairSync,
  createPrivateKey,
} from 'crypto';
import {
  computeBoxId,
  computeTxId,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  encodePost,
  computePostId,
  decodeTx,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  Post,
  KarmaBox,
  InviteBox,
  BondBox,
  UtxoTransaction,
  AnyBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { IdentityRecord } from '../../src/store/identity-records.js';

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

// Every field this literal already set is kept verbatim; `makeTestConfig` only
// fills the thirteen `Config` requires and this never stated (see its comment
// in helpers.ts — none of them is read from the argument).
const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  creditTreasuryPct: 10,
  treasuryPubKey: '',
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});

// ---------------------------------------------------------------------------
// Dynamic import helpers
// ---------------------------------------------------------------------------

// No hand-written module shapes below. A cast that re-declares a module's
// surface drifts from it silently: a missing export makes the test that needed
// it a compile error rather than a written test, and a parameter typed against
// a local literal instead of `Config` checks the fixture against itself. The
// module's own type cannot rot away from the module.
async function importDb() {
  return import('../../src/store/db.js');
}

async function importBlockCreator() {
  return import('../../src/services/block-creator.js');
}

async function importPosts() {
  return import('../../src/store/posts.js');
}

/**
 * The record store, imported the same way every other module here is: this
 * suite calls `vi.resetModules()` per case, so a static import would bind a
 * different instance from the one `initDb` opened.
 */
async function importIdentityRecords() {
  return await import('../../src/store/identity-records.js');
}

async function importUtxo() {
  return import('../../src/store/utxo.js');
}

/** The read path as server.ts wires it: counts and likers from like_records. */
async function importFeedReadPath() {
  const posts = await import('../../src/store/posts.js');
  const utxo = await import('../../src/store/utxo.js');
  const likes = await import('../../src/store/likes.js');
  const feed = await import('../../src/services/feed-service.js');
  return {
    queryPosts: posts.queryPosts,
    getAncestors: posts.getAncestors,
    getSubtree: posts.getSubtree,
    getLikersForPost: utxo.getLikersForPost,
    getLikeRecordCount: likes.getLikeRecordCount,
    hasLikeRecord: likes.hasLikeRecord,
    FeedService: feed.FeedService,
  };
}

async function importMempool() {
  return (await import('../../src/store/mempool.js')) as {
    insertUtxoTx: (tx: UtxoTransaction, expiresAtHeight: number) => number;
    getPendingEntries: (limit: number) => Array<{
      rowid: number;
      entryType: string;
      utxoTxCbor: Uint8Array | null;
    }>;
    removeEntry: (rowid: number) => void;
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => unknown;
  };
}

type LikesService = {
  castLike: (
    deps: unknown,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { castLikeResult: string; txId: string; expiresAtHeight: number };
};

async function importLikesService(): Promise<LikesService> {
  return (await import('../../src/services/likes.js')) as unknown as LikesService;
}

type InvitesService = {
  createInvite: (
    deps: unknown,
    tx: UtxoTransaction,
    currentBlockHeight: number,
  ) => { status: string; txId: string; expiresAtHeight: number };
};

async function importInvitesService(): Promise<InvitesService> {
  return (await import('../../src/services/invites.js')) as unknown as InvitesService;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: ReturnType<typeof createPrivateKey>;
}

function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  return { userId: pubKey, publicKey: pubKey, privateKey };
}

function makePost(authorId: Uint8Array, content = 'test post'): Post {
  return {
    content,
    author: authorId,
    parentRefs: [],
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
  };
}

function makeKarmaBox(value: bigint, owner: Uint8Array, seed: number): KarmaBox {
  // `seed` is not a box property: it only varies the fixture's synthetic
  // provenance, so two boxes differing solely by the height a caller passed
  // still get distinct ids rather than colliding on UNIQUE(tx_id, output_index).
  const box = seedProvenance<KarmaBox>({
    boxType: 'karma',
    value,
    owner,
    guard: 'owner_signature',
  }, seed);
  return box;
}

// ---------------------------------------------------------------------------
// Engine deps factory
// ---------------------------------------------------------------------------

interface EngineDeps {
  getBox: (id: string) => AnyBox | null;
  insertBox: (box: AnyBox, postLockTarget?: string) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  getKarmaValue: (owner: Uint8Array) => bigint;
  getIdentityRecord: (id: Uint8Array) => IdentityRecord | null;
  runInTransaction: (fn: () => void) => void;
}

function makeEngineDeps(
  db: Database.Database,
  utxoModule: Awaited<ReturnType<typeof importUtxo>>,
  recordsModule: Awaited<ReturnType<typeof importIdentityRecords>>,
): EngineDeps {
  return {
    getBox: (id: string) => {
      const box = utxoModule.getBox(id);
      if (!box) return null;
      const r = db
        .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
        .get(id) as { spent_at_block: number | null } | undefined;
      return r && r.spent_at_block === null ? box : null;
    },
    insertBox: (box: AnyBox) => utxoModule.insertBox(box),
    consumeBox: (id: string, atBlock: number) => {
      db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
    },
    getKarmaBox: (owner: Uint8Array) => utxoModule.getKarmaBox(owner),
    getKarmaValue: (owner: Uint8Array) =>
      utxoModule.getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
    // The invite-create once-ever bar reads it (NODE_INTERFACE → "Bond
    // transition rules"), and this suite runs the real engine.
    getIdentityRecord: (id: Uint8Array) => recordsModule.getIdentityRecord(id),
    runInTransaction: (fn: () => void) => {
      (db.transaction(fn) as () => void)();
    },
  };
}

/**
 * Apply a single UTXO transaction as the block ingestion step would:
 * re-validate in context, then apply the state transition.
 * Returns true if applied successfully, false if revalidation failed.
 */
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('full-pipeline', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const bc = await importBlockCreator();
      bc.stopBlockCreator();
    } catch {
      // Module might not have been imported
    }
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // 1. Like tx: validate → mempool → mine → apply → confirm
  // -------------------------------------------------------------------------

  it('like tx flows through validate, mempool, mine, apply, and confirm', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const author = makeTestIdentity();
    const liker = makeTestIdentity();


    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'full-pipeline like test');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    // ---- Step 0: Confirm the target first. A like on an unconfirmed post is
    // invalid at apply, so the canonical flow likes an already-confirmed post;
    // the confirm-and-like-in-one-block shape is test 2 below. Block 1 carries
    // the sub-block alone.
    const mempool = await importMempool();
    mempool.insertUtxoTx(postTx, 1000);
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(await mineNextBlock(bc)).not.toBeNull();

    // Build and sign the burn-shape like tx: one karma output at
    // −LIKE_KARMA_COST, likeTarget inside the signed bytes, no box output.
    const changeVal = karmaBox.value - LIKE_KARMA_COST;
    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: liker.userId,
          guard: 'owner_signature',
        } as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    // ---- Step 1: Cast like (validateTx + mempool) ----
    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo, await importIdentityRecords());
    const result = likesSvc.castLike(deps, likeTx, 1);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block (mempool entry removed during finalizeBlock) ----
    const block = (await mineNextBlock(bc)) as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = (block!.header as Record<string, unknown>).height as number;
    expect(blockHeight).toBe(2);

    // ---- Step 3: Verify confirmed state (UTXO txs applied by block creator) ----
    // Old karma box consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // New karma box (change) exists at −LIKE_KARMA_COST: the karma is gone
    // from the UTXO set entirely, not parked in a box.
    const newKarma = utxo.getKarmaBox(liker.userId);
    expect(newKarma).not.toBeNull();
    expect(newKarma!.value).toBe(changeVal);

    // ---- Step 4: the feed/read path reports the applied like-record ----
    // Apply wrote the record; the API's likeCount and likers must come from it.
    const f = await importFeedReadPath();
    expect(f.hasLikeRecord(postId, liker.userId)).toBe(true);
    const feed = new f.FeedService({
      getPost: posts.getPost,
      queryPosts: f.queryPosts,
      getLikeRecordCount: f.getLikeRecordCount,
      getLikersForPost: f.getLikersForPost,
      getAncestors: f.getAncestors,
      getSubtree: f.getSubtree,
    });
    const postJson = feed.getPost(postId) as { likeCount: number; likers: string[] };
    expect(postJson.likeCount).toBe(1);
    expect(postJson.likers).toEqual([likerPubHex]);
  });

  // -------------------------------------------------------------------------
  // 2. Sub-block + like tx confirmed together
  // -------------------------------------------------------------------------

  it('sub-block and like tx confirmed together in one block', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const author = makeTestIdentity();
    const liker = makeTestIdentity();


    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, liker.userId, 0);
    utxo.insertBox(karmaBox);

    const { post: post, tx: postTx, postId: postId } = await seedPostTx(author, 'multi-op test');
    const posts = await importPosts();
    posts.insertPost(postId, post, encodePost(post));

    // Insert sub-block into mempool
    const mempool = await importMempool();
    mempool.insertUtxoTx(postTx, 1000);

    // Cast like via service — the burn shape
    const changeVal = karmaBox.value - LIKE_KARMA_COST;
    const likeTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: liker.userId,
          guard: 'owner_signature',
        } as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo, await importIdentityRecords());
    const likeResult = likesSvc.castLike(deps, likeTx, 0);
    expect(likeResult.castLikeResult).toBe('pending');

    // ---- Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = (await mineNextBlock(bc)) as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = (block!.header as Record<string, unknown>).height as number;

    // ---- Verify ----
    // Post confirmed (sub-block path)
    const confirmedPost = posts.getPost(postId);
    expect(confirmedPost).not.toBeNull();

    // The UTXO path is a pure burn: the change box carries the deficit and
    // the input is spent.
    const newKarma = utxo.getKarmaBox(liker.userId);
    expect(newKarma).not.toBeNull();
    expect(newKarma!.value).toBe(changeVal);

    // Old karma consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // Block stored in ordering
    const ordering = await importOrdering();
    const storedBlock = ordering.getOrderingBlock(blockHeight);
    expect(storedBlock).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // 3. Invite tx: validate → mempool → mine → apply → confirm
  // -------------------------------------------------------------------------

  it('invite tx flows through validate, mempool, mine, apply, and confirm', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    // ---- Setup ----
    const inviter = makeTestIdentity();

    const utxo = await importUtxo();
    const karmaBox = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaBox);

    // Build invite tx with 3 outputs: karma change + invite + bond. Only the
    // bond is paid — INVITE_KARMA_AMOUNT is minted at the claim.
    //
    // ⚠ The guard-shape pin rejects a lying invite fixture, and this one has to
    // stay honest: the canonical guard strings 'invite_dual' / 'block_apply'
    // (TYPES_INTERFACE → BoxGuard), and one invitee key on both boxes. All of it
    // is box CONTENT, so a fixture that gets any of it wrong stores boxes that
    // disagree with every reconstruction of them.
    const invitee = makeTestIdentity().userId;
    const changeVal = 100n - INVITE_BOND_KARMA;
    const inviteTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: inviter.userId,
          guard: 'owner_signature',
        } as KarmaBox,
        {
          boxType: 'invite',
          value: 0n,
          inviterId: inviter.userId,
          inviteePublicKey: invitee,
          guard: 'invite_dual',
        } as InviteBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          inviterId: inviter.userId,
          inviteePublicKey: invitee,
          guard: 'block_apply',
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const inviterPubHex = Buffer.from(inviter.userId).toString('hex');
    signTransaction(inviteTx, inviter.privateKey, inviterPubHex);

    // ---- Step 1: Create invite (validateTx + mempool) ----
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo, await importIdentityRecords());
    const result = invitesSvc.createInvite(deps, inviteTx, 0);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = (await mineNextBlock(bc)) as Record<string, unknown> | null;
    expect(block).not.toBeNull();
    const blockHeight = (block!.header as Record<string, unknown>).height as number;

    // ---- Step 3: Verify confirmed state (UTXO txs applied by block creator) ----
    // Old karma consumed (check via deps, which filters by spent_at_block)
    expect(deps.getBox(karmaBox.id!)).toBeNull();

    // Invite box created
    const inviteRows = db
      .prepare(
        "SELECT id FROM utxo_boxes WHERE box_type = 'invite' AND spent_at_block IS NULL",
      )
      .all() as Array<{ id: string }>;
    expect(inviteRows.length).toBe(1);

    // Bond box created
    const bondRows = db
      .prepare(
        "SELECT id FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL",
      )
      .all() as Array<{ id: string }>;
    expect(bondRows.length).toBe(1);

    // New karma box for inviter (change)
    const newKarma = utxo.getKarmaBox(inviter.userId);
    expect(newKarma).not.toBeNull();
    expect(newKarma!.value).toBe(changeVal);
  });
  // -------------------------------------------------------------------------
  // 4. The invite pairing through a real block funnel
  //
  // The pairing is `inviteePublicKey`, carried by both boxes and pinned equal at
  // creation. No id and no output index is involved, so the property to prove is
  // that a pair naming two different invitees is REJECTED AT CREATE — which is
  // what makes a mispaired bond inexpressible rather than a dangling reference
  // discovered at settlement.
  // -------------------------------------------------------------------------

  it('invite: a bond naming a different invitee is rejected at create — and the matching one still applies', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    const inviter = makeTestIdentity();
    const utxo = await importUtxo();
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo, await importIdentityRecords());

    const invitee = makeTestIdentity().userId;
    const stranger = makeTestIdentity().userId;

    // outputs are [karma, invite, bond]
    const buildInviteTx = (bondInvitee: Uint8Array, karmaIn: KarmaBox): UtxoTransaction => {
      const tx: UtxoTransaction = {
        inputs: [karmaIn.id!],
        outputs: [
          {
            boxType: 'karma', value: karmaIn.value - INVITE_BOND_KARMA,
            owner: inviter.userId, guard: 'owner_signature',
          },
          {
            boxType: 'invite', value: 0n, inviterId: inviter.userId,
            inviteePublicKey: invitee, guard: 'invite_dual',
          },
          {
            boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: inviter.userId,
            inviteePublicKey: bondInvitee, guard: 'block_apply',
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, inviter.privateKey, Buffer.from(inviter.userId).toString('hex'));
      return tx;
    };

    // ---- The property: a mispaired bond cannot be created ----
    //
    // A bond naming someone else would settle against a stranger's likes, and
    // the claim would start a probation clock no bond is dated by.
    const karmaA = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaA);
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(stranger, karmaA), 0))
      .toThrow(/same inviteePublicKey/);

    // ---- Non-vacuity control: the MATCHING pair still applies cleanly ----
    //
    // Without this the rejection above would pass just as well against an
    // implementation that rejected every invite. Same fixture, same funnel,
    // differing only in the field under test.
    const correct = buildInviteTx(invitee, karmaA);
    expect(invitesSvc.createInvite(deps, correct, 0).status).toBe('pending');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(await mineNextBlock(bc)).not.toBeNull();

    // Applied: the karma is consumed and both boxes exist.
    expect(deps.getBox(karmaA.id!)).toBeNull();
    const storedBond = db
      .prepare("SELECT id FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL")
      .get() as { id: string };
    expect(storedBond).toBeDefined();

    // And the pairing RESOLVES the way block application resolves it: the
    // invitee key names exactly one live pair, with no provenance walk.
    const bondBox = deps.getBox(storedBond.id) as BondBox;
    expect(Buffer.from(bondBox.inviteePublicKey).toString('hex'))
      .toBe(Buffer.from(invitee).toString('hex'));
    expect(utxo.getBondFor(invitee)!.id).toBe(storedBond.id);
    expect(utxo.getInviteFor(invitee)!.inviterId).toEqual(inviter.userId);
  });
});
