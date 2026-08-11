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
  rawPublicKey,
  seedProvenance,
  signTransaction,
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
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  encodePost,
  computePostId,
  decodeTx,
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
  postPowTargetBits: 20,
  challengeWindowBlocks: 10,
  orderingBlockIntervalMs: 60000,
  orderingBlockMinSubBlocks: 1,
  maxSubBlocksPerBlock: 1000,
  miningMode: 'internal' as const,
  orderingBlockPowTargetBits: 12,
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
    insertUtxoTx: (tx: UtxoTransaction, batchId: string | null, expiresAtHeight: number) => number;
    insertSubBlock: (postId: string, expiresAtHeight: number, batchId?: string | null) => number;
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
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
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
    proofSource: 'genesis',
  }, seed);
  return box;
}

// ---------------------------------------------------------------------------
// Engine deps factory
// ---------------------------------------------------------------------------

interface EngineDeps {
  getBox: (id: string) => AnyBox | null;
  insertBox: (box: AnyBox) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  getKarmaValue: (owner: Uint8Array) => bigint;
  runInTransaction: (fn: () => void) => void;
}

function makeEngineDeps(
  db: Database.Database,
  utxoModule: Awaited<ReturnType<typeof importUtxo>>,
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

    const post = makePost(author.userId, 'full-pipeline like test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // ---- Step 0: Confirm the target first. A like on an unconfirmed post is
    // invalid at apply, so the canonical flow likes an already-confirmed post;
    // the confirm-and-like-in-one-block shape is test 2 below. Block 1 carries
    // the sub-block alone.
    const mempool = await importMempool();
    mempool.insertSubBlock(postId, 1000);
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(bc.createOrderingBlock()).not.toBeNull();

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
          proofSource: 'like_op',
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
    const deps = makeEngineDeps(db, utxo);
    const result = likesSvc.castLike(deps, likeTx, 1);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block (mempool entry removed during finalizeBlock) ----
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
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

    const post = makePost(author.userId, 'multi-op test');
    const postId = computePostId(post);
    const posts = await importPosts();
    posts.insertPost(post, encodePost(post));

    // Insert sub-block into mempool
    const mempool = await importMempool();
    mempool.insertSubBlock(postId, 1000);

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
          proofSource: 'like_op',
        } as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    const likerPubHex = Buffer.from(liker.userId).toString('hex');
    signTransaction(likeTx, liker.privateKey, likerPubHex);

    const likesSvc = await importLikesService();
    const deps = makeEngineDeps(db, utxo);
    const likeResult = likesSvc.castLike(deps, likeTx, 0);
    expect(likeResult.castLikeResult).toBe('pending');

    // ---- Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
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

    // Build invite tx with 3 outputs: karma change + invite + bond.
    //
    // ⚠ The guard-shape pin rejects a lying invite fixture, and this one has to
    // stay honest: no stray `inviteeId` key (`InviteBox` has no such field —
    // the invitee is unknown until commit), and the canonical guard strings
    // 'hash_preimage_with_bond' / 'bond_dual' (TYPES_INTERFACE → BoxGuard).
    // Both are box CONTENT, so a fixture that gets either wrong stores boxes
    // that disagree with every reconstruction of them.
    const changeVal = 100n - INVITE_KARMA_AMOUNT - INVITE_BOND_KARMA;
    const inviteTx: UtxoTransaction = {
      inputs: [karmaBox.id!],
      outputs: [
        {
          boxType: 'karma',
          value: changeVal,
          owner: inviter.userId,
          guard: 'owner_signature',
          proofSource: 'invite_create',
        } as KarmaBox,
        {
          boxType: 'invite',
          value: INVITE_KARMA_AMOUNT,
          inviterId: inviter.userId,
          secretHash: new Uint8Array(32),
          guard: 'hash_preimage_with_bond',
        } as InviteBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          inviterId: inviter.userId,
          // The invite is output 1 of this transaction ([karma, invite, bond]).
          inviteOutputIndex: 1,
          inviteePublicKey: new Uint8Array(0), // unset until claimed
          probationStartBlock: 0,
          probationEndBlock: 0,
          guard: 'bond_dual',
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const inviterPubHex = Buffer.from(inviter.userId).toString('hex');
    signTransaction(inviteTx, inviter.privateKey, inviterPubHex);

    // ---- Step 1: Create invite (validateTx + mempool) ----
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo);
    const result = invitesSvc.createInvite(deps, inviteTx, 0);

    expect(result.status).toBe('pending');
    expect(result.txId).toBeTruthy();

    // ---- Step 2: Mine block ----
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    const block = bc.createOrderingBlock() as Record<string, unknown> | null;
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
  // No flow predicts a box id: a like is a burn transaction rather than a box,
  // and the invite path names an OUTPUT INDEX instead of an id. So the property
  // to prove is not exactness of a prediction but that a bond pointing at the
  // wrong output is REJECTED AT CREATE — which is what pairing by index buys,
  // and what makes a mispaired bond inexpressible rather than surfacing one
  // transaction later as a dangling reference.
  // -------------------------------------------------------------------------

  it('invite: a bond naming the wrong output index is rejected at create — and the right one still applies', async () => {
    const dbModule = await importDb();
    dbModule.initDb(':memory:');
    const db = dbModule.getDb();

    const inviter = makeTestIdentity();
    const utxo = await importUtxo();
    const invitesSvc = await importInvitesService();
    const deps = makeEngineDeps(db, utxo);

    const secretHash = new Uint8Array(32).fill(0x5a);
    const total = INVITE_KARMA_AMOUNT + INVITE_BOND_KARMA;

    // outputs are [karma, invite, bond] — the invite is at index 1.
    const buildInviteTx = (inviteOutputIndex: number, karmaIn: KarmaBox): UtxoTransaction => {
      const tx: UtxoTransaction = {
        inputs: [karmaIn.id!],
        outputs: [
          {
            boxType: 'karma', value: karmaIn.value - total, owner: inviter.userId,
            guard: 'owner_signature', proofSource: 'invite-create',
          },
          {
            boxType: 'invite', value: INVITE_KARMA_AMOUNT, secretHash,
            inviterId: inviter.userId, guard: 'hash_preimage_with_bond',
          },
          {
            boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: inviter.userId,
            inviteOutputIndex,
            inviteePublicKey: new Uint8Array(0),
            probationStartBlock: 0, probationEndBlock: 0, guard: 'bond_dual',
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
    // Index 0 is the KARMA output, not the invite. `createInvite` validates the
    // index against its own outputs, so a wrong value is a rejected transaction
    // here rather than an "InviteBox not found for bond commit" one
    // transaction later.
    const karmaA = makeKarmaBox(100n, inviter.userId, 0);
    utxo.insertBox(karmaA);
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(0, karmaA), 0))
      .toThrow(/inviteOutputIndex must address the InviteBox output/);

    // Out of range entirely — the same rejection, not a crash on undefined.
    expect(() => invitesSvc.createInvite(deps, buildInviteTx(7, karmaA), 0))
      .toThrow(/inviteOutputIndex must address the InviteBox output/);

    // ---- Non-vacuity control: the CORRECT index still applies cleanly ----
    //
    // Without this the rejection test above would pass just as well against an
    // implementation that rejected every invite. This is the same fixture and
    // the same funnel, differing only in the field under test.
    const correct = buildInviteTx(1, karmaA);
    expect(invitesSvc.createInvite(deps, correct, 0).status).toBe('pending');

    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    expect(bc.createOrderingBlock()).not.toBeNull();

    // Applied: the karma is consumed and both boxes exist.
    expect(deps.getBox(karmaA.id!)).toBeNull();
    const storedBond = db
      .prepare("SELECT id, tx_id, output_index FROM utxo_boxes WHERE box_type = 'bond' AND spent_at_block IS NULL")
      .get() as { id: string; tx_id: string; output_index: number };
    expect(storedBond).toBeDefined();

    // And the pairing RESOLVES the way the commit path will resolve it: the
    // bond's own txId plus its `inviteOutputIndex` names the InviteBox that
    // shipped with it. This is the assertion that the index is meaningful
    // rather than merely present.
    const bondBox = deps.getBox(storedBond.id) as BondBox;
    const paired = utxo.getBoxByProvenance(bondBox.txId, bondBox.inviteOutputIndex);
    expect(paired).not.toBeNull();
    expect(paired!.boxType).toBe('invite');
    expect((paired as InviteBox).secretHash).toEqual(secretHash);
  });
});
