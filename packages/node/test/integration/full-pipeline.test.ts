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
  signTransaction, fixturePostId, seedPostTx, seedKarmaPoolBox,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
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
  computePostId,
  decodeTx,
  MAX_BLOCK_BODY_BYTES,
} from '@dagsocial/types';
import type {
  Post,
  KarmaBox,
  BondBox,
  UtxoTransaction,
  AnyBox,
} from '@dagsocial/types';
import type Database from 'better-sqlite3';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import { config } from '../../src/config.js';

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
    getBlockCreatedAt: (height: number) => number | null;
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
    type: 'regular',
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
  hasActiveVouchEscrow: (voucherId: Uint8Array) => boolean;
  vouchCooldownBlocks: number;
  inviteBondMin: bigint;
  inviteBondMax: bigint;
  decayCfg: {
    staleThresholdBlocks: number;
    decayIntervalBlocks: number;
    decayAmount: bigint;
    karmaMinimum: bigint;
  };
  getTopologyAuthor: (postId: string) => Uint8Array | null;
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
    hasActiveVouchEscrow: (voucherId: Uint8Array) =>
      utxoModule.hasActiveVouchEscrow(voucherId),
    vouchCooldownBlocks: 2,
    // ⛔ The like marker's author pin, read from `block_topology` and never
    // `dag_posts.author` (ARCHITECTURE → Likes). This suite runs the real
    // engine end to end, so it resolves the real row.
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg: {
      staleThresholdBlocks: config.karmaStaleThresholdBlocks,
      decayIntervalBlocks: config.karmaDecayIntervalBlocks,
      decayAmount: config.karmaDecayAmount,
      karmaMinimum: config.karmaMinimum,
    },
    getTopologyAuthor: (postId: string) => {
      const row = db
        .prepare('SELECT author FROM block_topology WHERE post_id = ?')
        .get(postId) as { author: string } | undefined;
      return row ? new Uint8Array(Buffer.from(row.author, 'hex')) : null;
    },
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

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'full-pipeline like test');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);
    // ⛔ **The target must be CONFIRMED before a like can be built, and that is
    // new.** The like's marker names the post's author, and the author is
    // knowable only from `block_topology` — which an applied block writes
    // (NODE_INTERFACE → Karma transition rules). A like on an unconfirmed post
    // is unbuildable, so the row a confirming block would write is seeded here
    // rather than the flow being reordered around it.
    const topology = await import('../../src/store/topology.js');
    topology.insertBlockTopology(
      postId,
      commit.parentRefs ?? [],
      Buffer.from(author.userId).toString('hex'),
      1,
    );

    // ---- Step 0: Confirm the target first. A like on an unconfirmed post is
    // invalid at apply, so the canonical flow likes an already-confirmed post;
    // the confirm-and-like-in-one-block shape is test 2 below. Block 1 carries
    // the post transaction alone.
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
          createdAtBlock: 0,
          owner: liker.userId,
        } as KarmaBox,
        // ⛔ **The marker carries the cost.** The like conserves: its karma moves
        // into a `LikeAccrualBox` earmarked for the author rather than leaving
        // the ledger (ARCHITECTURE → The conservation axiom, third shape).
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: author.userId,
        } as unknown as KarmaBox,
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
    const ordering = await importOrdering();
    const feed = new f.FeedService({
      getPost: posts.getPost,
      queryPosts: f.queryPosts,
      getLikeRecordCount: f.getLikeRecordCount,
      getLikersForPost: f.getLikersForPost,
      getAncestors: f.getAncestors,
      getSubtree: f.getSubtree,
      getBlockCreatedAt: ordering.getBlockCreatedAt,
    });
    const postJson = feed.getPost(postId) as { likeCount: number; likers: string[] };
    expect(postJson.likeCount).toBe(1);
    expect(postJson.likers).toEqual([likerPubHex]);
  });

  // -------------------------------------------------------------------------
  // 2. Post transaction + like tx confirmed together
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

    const { commit, tx: postTx, postId, content } = await seedPostTx(author, 'multi-op test');
    const posts = await importPosts();
    posts.insertPost(postId, commit, content);
    // ⛔ The target must be confirmed before a like can be built — the marker
    // names its author, and `block_topology` is the only source for that
    // (NODE_INTERFACE → Karma transition rules).
    const topology = await import('../../src/store/topology.js');
    topology.insertBlockTopology(
      postId,
      commit.parentRefs ?? [],
      Buffer.from(author.userId).toString('hex'),
      1,
    );

    // Insert post transaction into mempool
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
          createdAtBlock: 0,
          owner: liker.userId,
        } as KarmaBox,
        // ⛔ **The marker carries the cost.** The like conserves: its karma moves
        // into a `LikeAccrualBox` earmarked for the author rather than leaving
        // the ledger (ARCHITECTURE → The conservation axiom, third shape).
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: author.userId,
        } as unknown as KarmaBox,
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
    // Post confirmed
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
    // ⛔ The settlement spends the pool to grant the invitee, so a chain without
    // one cannot produce the block at all.
    await seedKarmaPoolBox();
    const karmaBox = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaBox);

    // Build the invite tx: karma change + bond. Only the bond is paid —
    // FIXTURE_BOND_KARMA comes out of the pool at settlement, so the
    // transaction conserves.
    const invitee = makeTestIdentity().userId;
    const changeVal = 100n - FIXTURE_BOND_KARMA;
    const inviteTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          createdAtBlock: 0,
          owner: inviter.userId,
        } as KarmaBox,
        {
          boxType: 'bond',
          value: FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
          inviterId: inviter.userId,
          inviteePublicKey: invitee,
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
  // 4. The invite through a real block funnel
  //
  // ⛔ **The bond IS the request** (ARCHITECTURE → Invite System). One bond, one
  // grant, and the pairing is structural — so what has to be proved is that the
  // bond names its own inviter, and that the block's settlement pays the
  // invitee out of the pool in the same block.
  // -------------------------------------------------------------------------

  it('invite: the bond applies and the settlement grants the invitee out of the pool', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    const inviter = makeTestIdentity();
    const utxo = await importUtxo();
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo, await importIdentityRecords());
    await seedKarmaPoolBox();

    const invitee = makeTestIdentity().userId;
    const stranger = makeTestIdentity().userId;

    // outputs are [karma, bond] — the whole invite (ARCHITECTURE → Invite System)
    const buildInviteTx = (bondInviterId: Uint8Array, karmaIn: KarmaBox): UtxoTransaction => {
      const tx: UtxoTransaction = {
        inputs: [karmaIn.id!],
        outputs: [
          {
            boxType: 'karma', value: karmaIn.value - FIXTURE_BOND_KARMA, createdAtBlock: 0,
            owner: inviter.userId,
          },
          {
            boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0, inviterId: bondInviterId,
            inviteePublicKey: invitee,
          },
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
      };
      signTransaction(tx, inviter.privateKey, Buffer.from(inviter.userId).toString('hex'));
      return tx;
    };

    // ---- The property: a bond naming a stranger as inviter cannot be created ----
    //
    // It would hand the probation-deadline settlement to someone who staked
    // nothing.
    const karmaA = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaA);
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(stranger, karmaA), 0))
      .toThrow(/inviterId must be the karma input's owner/);

    // ---- Non-vacuity control: the correct bond still applies cleanly ----
    //
    // Without this the rejection above would pass just as well against an
    // implementation that rejected every invite. Same fixture, same funnel,
    // differing only in the field under test.
    const correct = buildInviteTx(inviter.userId, karmaA);
    expect(invitesSvc.createInvite(deps, correct, 0).status).toBe('pending');

    const poolBefore = utxo.getKarmaPoolBox()!.value;

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(await mineNextBlock(bc)).not.toBeNull();

    // Applied: the karma is consumed and the bond exists.
    expect(deps.getBox(karmaA.id!)).toBeNull();
    const storedBond = db
      .prepare("SELECT id FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL")
      .get() as { id: string };
    expect(storedBond).toBeDefined();

    // The pairing RESOLVES the way block application resolves it: the invitee
    // key names exactly one live bond, with no provenance walk.
    const bondBox = deps.getBox(storedBond.id) as BondBox;
    expect(Buffer.from(bondBox.inviteePublicKey).toString('hex'))
      .toBe(Buffer.from(invitee).toString('hex'));
    expect(utxo.getBondFor(invitee)!.id).toBe(storedBond.id);

    // ⛔ **And the settlement paid the invitee out of the POOL**, in the same
    // block — one bond, one grant, with a named source and a named sink
    // (ARCHITECTURE → The conservation axiom).
    expect(utxo.getKarmaValue(invitee)).toBe(FIXTURE_BOND_KARMA);
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolBefore - FIXTURE_BOND_KARMA);
  });
});
