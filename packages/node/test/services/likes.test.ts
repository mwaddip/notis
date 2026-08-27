import {
  describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  type KeyObject,
} from 'crypto';
import {
  computeTxId,
  computeContentHash,
  LIKE_KARMA_COST,
  MEMPOOL_EXPIRY_BLOCKS,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { KarmaBox, LikeAccrualBox, Stump, UtxoTransaction, AnyBox } from '@dagsocial/types';

/**
 * The author every post in this suite belongs to — the key the like's marker
 * names, and the one `getTopologyAuthor` resolves.
 */
const POST_AUTHOR = new Uint8Array(32).fill(0x7a);
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  getKarmaBoxes,
  insertBox,
  insertLikeRecord,
  insertPost,
  insertStump,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  hasPendingLike, insertUtxoTx } from '../../src/store/index.js';
import { castLike } from '../../src/services/likes.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';
import {
  rawPublicKey,
  seedProvenance,
  signTransaction,
  type Stored, fixturePostId, fillerTx } from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create and insert a karma box. */
function createKarmaBox(
  owner: Uint8Array,
  value: bigint,
  seed: number,
): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>(
    {
      boxType: 'karma',
      value,
      owner,
    },
    seed,
  );
  insertBox(box);
  return box;
}

/** Create and insert a minimal test post. Returns the post ID. */
function createTestPost(authorId: Uint8Array): string {
  const commit = {
    contentHash: computeContentHash('Test post'),
    author: authorId,
    parentRefs: [] as string[],
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular' as const,
  };
  const postId = fixturePostId(commit);
  insertPost(postId, commit, 'Test post');
  return postId;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('likes service (P2-D: the like is a burn transaction)', () => {
  let db: Database.Database;
  let likerPubKey: Uint8Array;
  let likerPrivKey: KeyObject;
  let likerPubKeyHex: string;
  let likerId: Uint8Array;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => {
        insertBox(box);
      },
      consumeBox: (id: string, atBlock: number) => {
        db.prepare('UPDATE utxo_boxes SET spent_at_block = ? WHERE id = ?').run(atBlock, id);
      },
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      // ⛔ The like marker's author pin: every post this fixture builds is the
      // same author's (NODE_INTERFACE → Karma transition rules).
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => POST_AUTHOR,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    const likerKeys = generateKeyPairSync('ed25519');
    likerPubKey = rawPublicKey(likerKeys.publicKey);
    likerPrivKey = likerKeys.privateKey;
    likerPubKeyHex = Buffer.from(likerPubKey).toString('hex');
    likerId = likerPubKey;
    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  /** Build a signed burn-shape like tx over `karma` targeting `postId`. */
  function buildBurnLikeTx(
    karma: KarmaBox,
    postId: string,
    opts: { deficit?: bigint } = {},
  ): UtxoTransaction {
    // ⛔ **`deficit` is the MARKER'S VALUE now, not a hole in the ledger.** The
    // like conserves: its cost moves into a `LikeAccrualBox` earmarked for the
    // author (ARCHITECTURE → The conservation axiom, third shape). The
    // parameter's name and every caller's intent survive — an "off" figure still
    // makes an invalid like, just against the marker's pin rather than against
    // conservation.
    const deficit = opts.deficit ?? LIKE_KARMA_COST;
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: karma.value - deficit,
          createdAtBlock: 0,
          owner: likerPubKey,
        } as KarmaBox,
        {
          boxType: 'like_accrual',
          value: deficit,
          createdAtBlock: 0,
          author: POST_AUTHOR,
        } as LikeAccrualBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(tx, likerPrivKey, likerPubKeyHex);
    return tx;
  }

  // -----------------------------------------------------------------------
  // 1. Happy path
  // -----------------------------------------------------------------------
  it('castLike returns pending with txId and expiry', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    const tx = buildBurnLikeTx(karma, postId);
    const result = castLike(deps, tx, 5);

    expect(result.castLikeResult).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));
    expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);
    expect(result.tx).toBe(tx);
  });

  // -----------------------------------------------------------------------
  // 2. Mempool insertion + gate metadata from the tx field and signer
  // -----------------------------------------------------------------------
  it('castLike inserts the tx with gate metadata from likeTarget and the signer', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    castLike(deps, buildBurnLikeTx(karma, postId), 5);

    const row = db
      .prepare('SELECT like_target, like_liker FROM mempool WHERE entry_type = ?')
      .get('utxo_tx') as { like_target: string | null; like_liker: string | null };
    expect(row.like_target).toBe(postId);
    expect(row.like_liker).toBe(likerPubKeyHex);
    expect(hasPendingLike(postId, likerPubKeyHex)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. likeTarget gateway checks
  // -----------------------------------------------------------------------
  it('castLike rejects a tx without likeTarget', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    const tx = buildBurnLikeTx(karma, postId);
    delete tx.likeTarget;
    signTransaction(tx, likerPrivKey, likerPubKeyHex);

    expect(() => castLike(deps, tx, 5)).toThrow('likeTarget missing or malformed');
  });

  it('castLike rejects a malformed likeTarget (not 64-hex)', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    createTestPost(likerId);

    // Stamped after signing: `likeTarget` is `opt(b32)` in the txId preimage
    // now, so none of these four has an encoding and `buildBurnLikeTx` would
    // die at `computeTxId` before `castLike` ever saw them. That is not a
    // weakening — `castLike` takes a decoded transaction off the wire and must
    // still refuse one carrying any of these, and its `LIKE_TARGET_RE` check is
    // step 1, ahead of every id derivation and every signature read.
    for (const bad of ['short', 'A'.repeat(64), 'zz'.repeat(32), '']) {
      const tx = buildBurnLikeTx(karma, 'ab'.repeat(32));
      tx.likeTarget = bad;
      expect(() => castLike(deps, tx, 5)).toThrow('likeTarget missing or malformed');
    }
  });

  it('castLike fails if post unknown', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);

    const tx = buildBurnLikeTx(karma, 'ab'.repeat(32));
    expect(() => castLike(deps, tx, 5)).toThrow('Post not found');
  });

  it('castLike rejects a like on a pruned post (stump)', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const stumpId = 'cd'.repeat(32);
    const stump: Stump = {
      rootPostHash: stumpId,
      authorId: likerId,
      replyCount: 3,
      upvoteCount: 0,
      protocolVersion: PROTOCOL_VERSION,
      compactedAtBlockHeight: 4,
    };
    insertStump(stump);

    const tx = buildBurnLikeTx(karma, stumpId);
    expect(() => castLike(deps, tx, 5)).toThrow('Cannot like a pruned or withdrawn post');
  });

  // -----------------------------------------------------------------------
  // 4. Dedup
  // -----------------------------------------------------------------------
  it('castLike rejects a (liker, post) that already holds a like-record — the N1→N2 window closed (N4a)', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    // The state a confirmed like leaves behind since N2b: a like-record,
    // no box. Until N4a the gateway read old-world boxes and accepted this
    // re-like; apply would then reject it as invalid.
    insertLikeRecord(postId, likerId, 3);

    const tx = buildBurnLikeTx(karma, postId);
    expect(() => castLike(deps, tx, 5)).toThrow('Already liked');
  });

  it('castLike fails if already liked (pending in mempool)', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    castLike(deps, buildBurnLikeTx(karma, postId), 5);

    // A fresh tx for the same (liker, post) — different bytes, same pair.
    const karma2 = createKarmaBox(likerPubKey, 50n, 2);
    const tx2 = buildBurnLikeTx(karma2, postId);
    expect(() => castLike(deps, tx2, 5)).toThrow('Already liked');
  });

  // -----------------------------------------------------------------------
  // 4b. The mempool gate sees a pending like past the old 1000-row scan
  //     bound (audit M-8).
  // -----------------------------------------------------------------------
  it('castLike rejects a duplicate whose pending like sits past row 1000', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    // Bury the pending like behind 1000 unrelated entries.
    for (let i = 0; i < 1000; i++) insertUtxoTx(fillerTx(`filler_${i}`), 900);
    castLike(deps, buildBurnLikeTx(karma, postId), 5);

    const karma2 = createKarmaBox(likerPubKey, 50n, 2);
    expect(() => castLike(deps, buildBurnLikeTx(karma2, postId), 5)).toThrow('Already liked');

    // Control — same post, different liker: single-field delta, still accepted.
    const otherKeys = generateKeyPairSync('ed25519');
    const otherPub = rawPublicKey(otherKeys.publicKey);
    const otherKarma = createKarmaBox(otherPub, 100n, 3);
    const otherTx: UtxoTransaction = {
      inputs: [otherKarma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: otherKarma.value - LIKE_KARMA_COST,
          createdAtBlock: 0,
          owner: otherPub,
        } as KarmaBox,
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: POST_AUTHOR,
        } as LikeAccrualBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: postId,
    };
    signTransaction(otherTx, otherKeys.privateKey, Buffer.from(otherPub).toString('hex'));

    expect(castLike(deps, otherTx, 5).castLikeResult).toBe('pending');
  });

  // -----------------------------------------------------------------------
  // 5. Signature-count gate
  // -----------------------------------------------------------------------
  it('castLike rejects a tx with more than one signature', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    const tx = buildBurnLikeTx(karma, postId);
    const otherKeys = generateKeyPairSync('ed25519');
    const otherHex = Buffer.from(rawPublicKey(otherKeys.publicKey)).toString('hex');
    tx.signatures[otherHex] = new Uint8Array(64);

    expect(() => castLike(deps, tx, 5)).toThrow('exactly one signature');
  });

  // -----------------------------------------------------------------------
  // 6. Engine rejection surfaces as a legible client error
  // -----------------------------------------------------------------------
  it('castLike rejects a wrong-deficit tx via validateTx', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    const tx = buildBurnLikeTx(karma, postId, { deficit: 2n });
    expect(() => castLike(deps, tx, 5)).toThrow('Invalid like transaction');
  });

  // -----------------------------------------------------------------------
  // 7. Pending does not change karma
  // -----------------------------------------------------------------------
  it('castLike pending does not change karma immediately', () => {
    const karma = createKarmaBox(likerPubKey, 100n, 1);
    const postId = createTestPost(likerId);

    castLike(deps, buildBurnLikeTx(karma, postId), 5);

    const karmaBox = getKarmaBox(likerPubKey);
    expect(karmaBox).not.toBeNull();
    expect(karmaBox!.value).toBe(100n); // unchanged — pending
  });
});
