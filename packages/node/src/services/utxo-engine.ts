import { verify as cryptoVerify } from 'crypto';
import {
  BOX_VALUE_BOUND,
  computeBoxId,
  computeTxId,
  LIKE_KARMA_COST,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
  VOUCH_MIN_BALANCE,
} from '@dagsocial/types';
import type { UtxoTransaction, AnyBox, AnyBoxCandidate, KarmaBox, CreditBox, BondBox, VouchBox, VouchEscrowBox, LikeAccrualBox, PostLockBox, Post } from '@dagsocial/types';

// `computeTxId` has exactly one implementation and it is types'. This engine
// must never grow a local copy: the id it returns is both the hash
// `checkAuthorization` verifies signatures against and the `txId` every output
// is materialized under,
// so a second hasher is a divergence surface that agrees only by coincidence —
// same `Encoder` options, same strip rule, same domain tag, all by hand
// (NODE_INTERFACE → "Box Identity and Mint Provenance").

import { ed25519PublicKeyToKeyObject, verifyPostFieldDomains } from '@dagsocial/validation';
// Type-only: erased at compile time, so the engine gains no runtime edge into
// the store module graph. Same seam `DecayDeps` uses for the same record.
import type { IdentityRecord } from '../store/identity-records.js';

// ---------------------------------------------------------------------------
// The karma transition set
// ---------------------------------------------------------------------------

/**
 * The box types a karma spend may create. The karma transition arm below admits
 * exactly these as its outputs and refuses every other type, which is what keeps
 * a `fee` output off the karma side with no clause naming `fee`.
 *
 * ⛔ **Not the set `/status` sums into `totalKarma`** — that is
 * `KARMA_SUPPLY_TYPES` in `karma-supply.ts`, and no set here is defined as,
 * spread from or derived from another (NODE_INTERFACE → "Three karma sets, and
 * none derives from another"). This one answers whether a karma spend may create
 * the type; that one whether the type's value is karma in existence; the
 * conservation set whether it belongs to the total that never changes. A
 * karma-bearing type is added to each separately.
 *
 * ⚠ **The three coincide here only by accident of the current type list.**
 * `karma_pool` already answers them differently — transition no, supply no,
 * conservation yes — which is what makes the separation load-bearing rather
 * than tidy.
 */
export const KARMA_TRANSITION_TYPES = [
  'karma',
  'bond',
  'post_lock',
  'vouch',
  'like_accrual',
] as const;

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface UtxoEngineDeps {
  /** Return the box if it exists AND is unspent. Return null for spent or missing boxes. */
  getBox: (id: string) => AnyBox | null;
  insertBox: (box: AnyBox) => void;
  consumeBox: (id: string, atBlock: number) => void;
  getKarmaBox: (owner: Uint8Array) => KarmaBox | null;
  /**
   * Summed value of every unspent KarmaBox owned by `owner`.
   *
   * Consensus input, not a convenience read: the vouch cast is a predicate on
   * the voucher's *current* karma (ARCHITECTURE → "Vouch boxes"). Summed rather
   * than `getKarmaBox().value` because multiple unspent karma boxes per owner is
   * reachable — an invite grant alongside a mint, or a plain karma split — and
   * reading one box would let the threshold be evaded, or met, by how the karma
   * happens to be partitioned.
   */
  getKarmaValue: (owner: Uint8Array) => bigint;
  /**
   * The committed per-identity record, or null when the identity has none.
   *
   * Consensus input: an invite rejects an `inviteePublicKey` that already has
   * one, which is where "an invite may only name a key that is not already an
   * account" is enforced. **Existence is the whole test** — the record's
   * contents decide nothing here (NODE_INTERFACE → Legal box transitions;
   * ARCHITECTURE → Invite creation argues why the weaker "never invited before"
   * test prints karma).
   *
   * ⚠ **This gate cannot see a sibling transaction in the same block.** The
   * settlement grants from the pool after every embedded transaction has
   * applied, so a second invite naming the same key in the same block still
   * finds no record here. The within-block half of the rule is block
   * application's — `block-apply` §11's duplicate-invitee refusal.
   */
  getIdentityRecord: (identityId: Uint8Array) => IdentityRecord | null;
  /**
   * True while a cooldown row exists for `(voucherId, targetId)`.
   *
   * Consensus input (NODE_INTERFACE → "Vouch transition rules"): a vouch cast
   * is invalid while the pair is cooling down. Without the gate a
   * block-embedded vouch→unvouch pair for a pair with a live cooldown reaches
   * `insertVouchCooldown`'s INSERT OR REPLACE and destroys the first escrow's
   * pending re-mint on the forward path. Backed by the store's `hasActiveVouchCooldown` at every production
   * site — row existence IS activity, since matured rows are deleted by
   * `processVouchCooldowns` in the same block application that mints them.
   */
  hasActiveVouchEscrow: (voucherId: Uint8Array) => boolean;
  /**
   * `NetworkProfile.vouchCooldownBlocks` — how long an unvouched stake waits.
   *
   * Injected rather than imported, like every other consensus input here: it is
   * per-network (`compress time, never economics`), so a second reader holding
   * the constant would agree with the profile on mainnet and disagree on
   * devnet — the failure `inviteProbationBlocks` already had.
   */
  vouchCooldownBlocks: number;
  /**
   * The consensus-recorded author of a confirmed post, raw 32 bytes, or null
   * when no applied block has confirmed it.
   *
   * ⛔ **Consensus input, and the source is the whole of its correctness.** It
   * reads `block_topology` and never `dag_posts.author` (ARCHITECTURE → Likes):
   * a placeholder row carries a zeroed author, so a marker built from the wrong
   * source earmarks the liker's karma to the zero key.
   *
   * ⚠ **A like on an UNCONFIRMED post is now unbuildable, and that is a
   * consequence rather than a decision.** The marker has to name the author, and
   * the author is knowable only once a block has confirmed the post — so the
   * confirmation the apply rule already demanded at apply height is demanded at
   * build time too.
   */
  getTopologyAuthor: (postId: string) => Uint8Array | null;
  /** Wrap fn in a better-sqlite3 transaction. */
  runInTransaction: (fn: () => void) => void;
  /**
   * The inclusive range an invite's bond may take, and therefore the range its
   * grant may take — the grant equals the bond.
   *
   * Injected rather than read from the module config, for the reason
   * `vouchCooldownBlocks` is: a module-singleton read is config-at-a-distance,
   * and a rule that decides how much karma leaves the pool is a poor place to
   * keep one.
   */
  inviteBondMin: bigint;
  inviteBondMax: bigint;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface UtxoResult {
  valid: boolean;
  error?: string;
  computedOutputs?: AnyBox[];
  txId?: string;
}

// ---------------------------------------------------------------------------
// Stateless validation helpers
// ---------------------------------------------------------------------------

/**
 * Verify a signature for a given public key.
 * Returns true if a valid signature exists in tx.signatures for that key.
 */
function verifyGuardSignature(
  tx: UtxoTransaction,
  txHash: Buffer,
  pubKey: Uint8Array,
): boolean {
  const hexKey = Buffer.from(pubKey).toString('hex');
  const signature = tx.signatures[hexKey];
  if (!signature) return false;
  try {
    const keyObj = ed25519PublicKeyToKeyObject(pubKey);
    return Boolean(cryptoVerify(null, txHash, keyObj, Buffer.from(signature)));
  } catch {
    return false;
  }
}

/**
 * Check legal box transitions for a given set of inputs and outputs.
 * Assumes all inputs have the same boxType (`validateTx` step 3 pins it).
 *
 * Height-free: no transition is a predicate on the settle height any more
 * (NODE_INTERFACE → "Bond transition rules"). A bond's probation is dated from
 * `IdentityRecord.invitedAtBlock` and settled by block application, which this
 * gate does not govern.
 */
function checkTransitions(
  inputs: AnyBox[],
  outputs: AnyBoxCandidate[],
  deps: UtxoEngineDeps,
  likeTarget: string | undefined,
  post: Post | undefined,
  currentBlockHeight: number,
): { valid: boolean; error?: string } {
  // ⛔ **THE MARKER'S CONVERSE, AND IT HAS NO PREDECESSOR** (NODE_INTERFACE →
  // Karma transition rules — the like accrual marker is an exemption from the
  // rule above). A `LikeAccrualBox` is a karma-bearing output earmarked for
  // someone other than the input's owner, which is precisely the shape
  // *"Karma cannot be transferred"* exists to refuse.
  //
  // ⛔ **A MARKER BALANCES, so nothing else in the funnel fires on it.**
  // `myKarma(K) → myKarma(K−n) + LikeAccrualBox(n, author=Bob)` conserves, its
  // output shape is legal, its signature is the owner's, and the same-owner rule
  // pins only *karma* outputs — the marker is not one. Without this line that is
  // an accepted transaction, and it pays Bob at settlement.
  //
  // Ahead of the switch rather than inside the karma arm, so it holds for every
  // input type and not only for the one that can legitimately emit a marker.
  if (likeTarget === undefined && outputs.some((o) => o.boxType === 'like_accrual')) {
    return {
      valid: false,
      error: `a LikeAccrualBox output is only legal on a like transaction`,
    };
  }
  // A like transaction (`likeTarget` present) has exactly one legal shape — the
  // liker's karma boxes in, one karma box out (the arm in the karma case below).
  // Gated here as well as in the conservation carve, which independently
  // requires all-karma inputs.
  if (likeTarget !== undefined && inputs.some((b) => b.boxType !== 'karma')) {
    return {
      valid: false,
      error: `likeTarget is only legal on an all-karma burn transaction`,
    };
  }

  const inputType = inputs[0]!.boxType;

  switch (inputType) {
    // ------------------------------------------------------------------
    // KarmaBox → KarmaBox (same owner, balance change; the like burn
    //                      when `likeTarget` is present)
    // KarmaBox → KarmaBox + BondBox (the invite)
    // ------------------------------------------------------------------
    case 'karma': {
      const karmaOutputs = outputs.filter((o) => o.boxType === 'karma');
      const bondOutputs = outputs.filter((o) => o.boxType === 'bond');
      const postLockOutputs = outputs.filter((o) => o.boxType === 'post_lock');
      const vouchOutputs = outputs.filter((o) => o.boxType === 'vouch');
      const accrualOutputs = outputs.filter((o) => o.boxType === 'like_accrual');

      // A karma spend produces the transition set's types and nothing else. A
      // 'like'-type output is an illegal transition in particular: a like moves
      // its cost into a marker named by `likeTarget`, never into a `LikeBox`.
      const allowedOutputTypes: readonly string[] = KARMA_TRANSITION_TYPES;
      if (outputs.some((o) => !allowedOutputTypes.includes(o.boxType))) {
        return {
          valid: false,
          error: `Illegal karma transition: outputs contain non-${KARMA_TRANSITION_TYPES.join('/')} boxes`,
        };
      }

      // All karma inputs must share one owner (NODE_INTERFACE → "Karma
      // transition rules"). Every karma output is pinned to `inputKarma.owner`
      // below, but nothing else binds the inputs to each other — validateTx
      // step 3 only requires a common boxType — so without this check
      // [karmaA, karmaB] → karmaA validates with both owners co-signing, and
      // B's karma becomes A's. Consensual, but karma is
      // non-transferable by rule: a consensual transfer is still a transfer,
      // and it prices off-chain. Self-consolidation of one owner's boxes is
      // the legitimate multi-input case and stays legal; credits are
      // deliberately exempt — tradeable, so multi-owner credit inputs are an
      // ordinary multi-party payment.
      const inputKarma = inputs[0] as KarmaBox;
      const inputOwnerHex = Buffer.from(inputKarma.owner).toString('hex');
      for (const box of inputs) {
        if (Buffer.from((box as KarmaBox).owner).toString('hex') !== inputOwnerHex) {
          return {
            valid: false,
            error: `Karma cannot be transferred (karma inputs have different owners)`,
          };
        }
      }

      // Every karma output belongs to the same owner as the consumed karma.
      //
      // ⛔ **No box and no signer is exempt** (NODE_INTERFACE → Karma transition
      // rules). The karma a newcomer receives is a POOL DRAW in the block's
      // settlement, never a transfer from a holder — so there is no shape a
      // holder can sign that moves karma to someone else, and no configured key
      // that makes one legal.
      for (const ko of karmaOutputs) {
        const k = ko as KarmaBox;
        if (Buffer.from(k.owner).toString('hex') !== Buffer.from(inputKarma.owner).toString('hex')) {
          return {
            valid: false,
            error: `Karma cannot be transferred (owner change on karma box)`,
          };
        }
      }

      // At least one karma output required
      if (karmaOutputs.length === 0) {
        return {
          valid: false,
          error: `Karma transition must produce at least one karma output`,
        };
      }

      if (likeTarget !== undefined) {
        // ⛔ **The forward half of the biconditional** (NODE_INTERFACE → Karma
        // transition rules). `likeTarget` present ⇒ this exact shape and nothing
        // else: all inputs are karma boxes sharing one owner (pinned above), one
        // karma output carries the liker's change with that same owner (pinned
        // above), and one `LikeAccrualBox` carries the cost to the author.
        //
        // ⛔ **The transaction CONSERVES — there is no deficit any more.** The
        // cost lands in a box rather than leaving the ledger (ARCHITECTURE →
        // The conservation axiom: a marker must carry its value), so step 5's
        // unconditional sum is what pins the total and this arm pins the shape.
        if (outputs.length !== 2 || karmaOutputs.length !== 1 || accrualOutputs.length !== 1) {
          return {
            valid: false,
            error:
              `Invalid like transition: exactly one karma output and one ` +
              `like_accrual marker expected`,
          };
        }
        const marker = accrualOutputs[0] as LikeAccrualBox;
        if (marker.value !== LIKE_KARMA_COST) {
          return {
            valid: false,
            error:
              `Like marker must carry exactly ${LIKE_KARMA_COST} karma, got ` +
              `${marker.value}`,
          };
        }
        // ⛔ **Resolved from `block_topology`, never `dag_posts.author`** — a
        // placeholder row carries a zeroed author, so a marker built from the
        // wrong source earmarks the liker's karma to the zero key.
        const author = deps.getTopologyAuthor(likeTarget);
        if (author === null) {
          return {
            valid: false,
            error: `Like target ${likeTarget} is not confirmed, so it names no author`,
          };
        }
        if (Buffer.from(marker.author).toString('hex') !==
            Buffer.from(author).toString('hex')) {
          return {
            valid: false,
            error:
              `Like marker names ${Buffer.from(marker.author).toString('hex')}, ` +
              `but ${likeTarget}'s author is ${Buffer.from(author).toString('hex')}`,
          };
        }
      } else if (postLockOutputs.length > 0) {
        // karma → karma + post_lock (post creation lock)
        if (postLockOutputs.length !== 1 || bondOutputs.length > 0 || vouchOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid post-lock transition: exactly 1 karma + 1 post_lock output expected`,
          };
        }
        // ⛔ **The post biconditional** (NODE_INTERFACE → Post transactions), in
        // the shape the like carve already set: `post` present ⟺ exactly one
        // PostLockBox whose value is the cost for that post's shape. Both
        // directions are checked, because only the pair makes it a
        // biconditional — a lock with no payload is a lock nothing will ever
        // unlock, and a payload with no lock is a post that cost nothing.
        if (post === undefined) {
          return {
            valid: false,
            error: 'A post_lock output requires the transaction to carry its post payload',
          };
        }
        const expectedLock =
          post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
        const lockValue = (postLockOutputs[0] as PostLockBox).value;
        if (lockValue !== expectedLock) {
          return {
            valid: false,
            error: `Post lock must be exactly ${expectedLock} karma, got ${lockValue}`,
          };
        }
        // The author is the owner of the karma being spent — asserted here
        // because the payload is otherwise opaque to the engine, and authorship
        // is what prune and the feed key on.
        if (!Buffer.from(post.author).equals(Buffer.from(inputKarma.owner))) {
          return {
            valid: false,
            error: 'Post author must own the karma the transaction spends',
          };
        }
      } else if (post !== undefined) {
        // The biconditional's other direction: a payload with no lock.
        return {
          valid: false,
          error: 'A post payload requires exactly one post_lock output',
        };
      } else if (vouchOutputs.length > 0) {
        // karma → karma + vouch
        if (vouchOutputs.length !== 1 ||
            bondOutputs.length > 0 ||
            postLockOutputs.length > 0) {
          return {
            valid: false,
            error: `Invalid vouch transition: exactly 1 karma + 1 vouch output expected`,
          };
        }
        const vouchOut = vouchOutputs[0] as VouchBox;
        // The stake is pinned at cast: a vouch is one vote and always stakes
        // exactly VOUCH_KARMA_AMOUNT (audit F-consensus-3). Without this pin
        // the only bound on the stake is conservation, which permits 0n, while
        // unvouch escrows the constant regardless: a 0-value vouch matures into
        // 1 karma minted from nothing, and a 100-value vouch destroys 99.
        if (vouchOut.value !== VOUCH_KARMA_AMOUNT) {
          return {
            valid: false,
            error:
              `Vouch cast must stake exactly ${VOUCH_KARMA_AMOUNT} karma, ` +
              `got ${vouchOut.value}`,
          };
        }
        // voucherId is pinned to the karma input's owner. The unvouch
        // transition requires the signature of the key at `voucherId`, so a box
        // carrying a foreign voucherId is spendable by that foreign key: A
        // stakes their karma, B unvouches it, and the escrow matures to B — a
        // karma transfer with no invite, the property the whole invite/bond
        // mechanism protects.
        if (Buffer.from(vouchOut.voucherId).toString('hex') !==
            Buffer.from(inputKarma.owner).toString('hex')) {
          return {
            valid: false,
            error: `Vouch voucherId must be the karma input's owner`,
          };
        }
        // No re-vouch while the voucher's escrow is cooling down
        // (NODE_INTERFACE → Vouch transition rules).
        //
        // ⛔ **KEYED ON THE VOUCHER ALONE, BECAUSE THE ESCROW CARRIES NO
        // TARGET.** `VouchEscrowBox` holds `owner` and `releaseAtBlock` and
        // nothing else (TYPES_INTERFACE → VouchEscrowBox), so a pair-scoped
        // question is one this state cannot answer. **A cooling voucher may not
        // recast at all**, which is the stronger of the two readings and the
        // only one the box supports.
        //
        // ⚠ **The rule it carries is economic, not structural.** A second
        // escrow is a second box, so nothing here is protecting an overwrite —
        // and the escrow's own value already leans the same way by withholding
        // the stake from `VOUCH_MIN_BALANCE`.
        if (deps.hasActiveVouchEscrow(vouchOut.voucherId)) {
          return {
            valid: false,
            error: `Vouch cast is locked: this voucher holds an unreleased escrow`,
          };
        }
        // The voucher's balance clears VOUCH_MIN_BALANCE (ARCHITECTURE →
        // "Vouch boxes"). Summed over every unspent karma box the voucher
        // holds, not over this transaction's inputs: a voucher may stake from
        // one box while the threshold is covered across several, and reading
        // the inputs alone would make the verdict depend on how their karma
        // happens to be partitioned. Read here rather than at submission
        // alone, because a vouch reaching a node inside a block never passes a
        // service gate — `getKarmaValue` is the confirmed-set reader every
        // validation path shares, so the predicate decides the same way on
        // every node.
        const voucherBalance = deps.getKarmaValue(vouchOut.voucherId);
        if (voucherBalance < VOUCH_MIN_BALANCE) {
          return {
            valid: false,
            error:
              `Vouch cast requires a karma balance of at least ` +
              `${VOUCH_MIN_BALANCE}, voucher holds ${voucherBalance}`,
          };
        }
      } else if (bondOutputs.length > 0) {
        // karma → karma + bond — the whole invite (NODE_INTERFACE → the
        // transition table). ⛔ **The bond IS the request**: the block's
        // settlement transaction emits the bond's OWN VALUE to the
        // `inviteePublicKey` of every bond the block creates, so the pairing is
        // structural — one bond, one grant — and no second box carries it.
        if (bondOutputs.length !== 1 || vouchOutputs.length > 0) {
          return {
            valid: false,
            error: `An invite requires exactly 1 bond output`,
          };
        }
        const bondOut = bondOutputs[0] as BondBox;
        // ⛔ **THE GRANT EQUALS THE BOND, so the bound cannot drift**
        // (ARCHITECTURE → Invite System). An inviter may name 32 bytes nobody
        // holds, stranding the grant in an unspendable box; equality is what
        // makes that cost exactly what it strands. There is no second number
        // free to fall below the first.
        //
        // The floor is the network's sybil price, and conservation alone would
        // permit `0n` — which would make that price free.
        if (bondOut.value < deps.inviteBondMin || bondOut.value > deps.inviteBondMax) {
          return {
            valid: false,
            error:
              `An invite bond must hold between ${deps.inviteBondMin} and ` +
              `${deps.inviteBondMax} karma, got ${bondOut.value}`,
          };
        }
        // The bond carries the karma input's owner as `inviterId`. Without this
        // the creator could emit a bond naming someone else as inviter, and the
        // probation-deadline settlement pays that stranger.
        if (Buffer.from(bondOut.inviterId).toString('hex') !== inputOwnerHex) {
          return {
            valid: false,
            error: `Bond inviterId must be the karma input's owner`,
          };
        }
        // **An invite may only name a key that is not already an account**, and
        // "is an account" is *holds an identity record* — not "was invited
        // before".
        //
        // ⚠ The weaker "never invited" reading PRINTS KARMA. An established
        // account that simply had not been invited — every genesis committee
        // member — could be named: the settlement grants it the bond's value out
        // of the pool, and the bond then vests in full against likes that key had
        // *already* earned, so the whole stake returns to the inviter at the
        // deadline. The inviter's cost is a
        // probation-length lock and nothing else.
        //
        // Record existence is the right test because every karma receipt writes
        // one through `insertBox`'s choke point. A key with no record has never
        // held karma, so it has never posted and never been liked — which is
        // also what makes the grant the record-CREATING event for every legal
        // invitee.
        const inviteeHex = Buffer.from(bondOut.inviteePublicKey).toString('hex');
        const inviteeRecord = deps.getIdentityRecord(bondOut.inviteePublicKey);
        if (inviteeRecord !== null) {
          return {
            valid: false,
            error:
              `An invite may not name an existing account: ${inviteeHex} already ` +
              `holds an identity record`,
          };
        }
      }
      // else: karma → karma only, which is always valid

      return { valid: true };
    }

    // ------------------------------------------------------------------
    // BondBox — consumed by block application only, refused at step 6
    // ------------------------------------------------------------------
    case 'bond': {
      // Unreachable through `validateTx`: no transition admits a bond input, so
      // step 6 refuses it ahead of this. Kept as the second layer, because a
      // transition table that *accepts* any bond shape is a consensus rule
      // waiting to be re-exposed by a reordering.
      return {
        valid: false,
        error: `BondBox can only be consumed by block application (not user transactions)`,
      };
    }

    // ------------------------------------------------------------------
    // CreditBox → CreditBox(es) and/or FeeBox (any owner)
    // ------------------------------------------------------------------
    case 'credit': {
      const allowed = outputs.every(
        (o) => o.boxType === 'credit' || o.boxType === 'fee',
      );
      if (outputs.length === 0 || !allowed) {
        return {
          valid: false,
          error: `CreditBox can only be spent to create CreditBox or FeeBox outputs`,
        };
      }
      // Zero or one, never two. A second fee output carries no information and
      // gives one economic fact two encodings with different `utxoTxRoot`,
      // which is the same "one block, one encoding" the zero-value coinbase
      // output is refused for (NODE_INTERFACE → the credit transition row).
      const feeOutputs = outputs.filter((o) => o.boxType === 'fee');
      if (feeOutputs.length > 1) {
        return {
          valid: false,
          error: `A transaction carries at most one FeeBox output`,
        };
      }
      // Zero fee means no box. A zero-value fee box conserves, so nothing
      // downstream refuses it and this is the only gate that can. Same rule
      // the emission successor carries — one block, one encoding
      // (TYPES_INTERFACE → EmissionBox).
      if (feeOutputs.some((o) => o.value === 0n)) {
        return {
          valid: false,
          error: `A zero-value FeeBox is not created; zero fee means no box`,
        };
      }
      return { valid: true };
    }

    // ------------------------------------------------------------------
    // PostLockBox — consumed by block application only, refused at step 6
    // ------------------------------------------------------------------
    case 'post_lock': {
      return {
        valid: false,
        error: `PostLockBox can only be consumed by block application (not user transactions)`,
      };
    }

    // ------------------------------------------------------------------
    // VouchBox → VouchEscrowBox — unvouch, the stake held in a box
    // ------------------------------------------------------------------
    case 'vouch': {
      // An unvouch consumes exactly one VouchBox (NODE_INTERFACE → "Vouch
      // transition rules"). Burning several stakes in one transaction has no
      // meaning in the design, so the shape is inexpressible rather than
      // handled — the same reasoning as the bond settlement's single-input
      // bound.
      if (inputs.length !== 1) {
        return {
          valid: false,
          error: `Unvouch must consume exactly one VouchBox`,
        };
      }
      const escrowOutputs = outputs.filter((o) => o.boxType === 'vouch_escrow');
      if (outputs.length !== 1 || escrowOutputs.length !== 1) {
        return {
          valid: false,
          error: `VouchBox can only be spent to produce exactly one vouch_escrow output`,
        };
      }
      const staked = inputs[0] as VouchBox;
      const escrow = escrowOutputs[0] as VouchEscrowBox;
      // ⛔ **The escrow's value is the CONSUMED BOX'S, never
      // `VOUCH_KARMA_AMOUNT`** (TYPES_INTERFACE → VouchEscrowBox). Step 5's
      // unconditional conservation already pins the total; this names which
      // box it came out of, so the round trip is conservation-structural rather
      // than true by coincidence of the cast pin.
      if (escrow.value !== staked.value) {
        return {
          valid: false,
          error:
            `Unvouch escrow holds ${escrow.value}, the consumed VouchBox held ` +
            `${staked.value}`,
        };
      }
      // Where the karma returns. A foreign `owner` is the `voucherId` defect in
      // a new box: A stakes, A unvouches, and the escrow matures to B.
      if (Buffer.from(escrow.owner).toString('hex') !==
          Buffer.from(staked.voucherId).toString('hex')) {
        return {
          valid: false,
          error: `Unvouch escrow owner must be the consumed VouchBox's voucherId`,
        };
      }
      // ⛔ **A LOWER BOUND, DELIBERATELY, AND IT IS THE ONE DIRECTION THAT
      // MATTERS.** A transaction's output cannot commit to the height of the
      // block that will carry it — the pool does not know which block that is —
      // so an exact pin would make every unvouch valid in exactly one block and
      // stale everywhere else. Releasing LATE costs only the voucher; releasing
      // early is what the cooldown exists to prevent, so only the floor is a
      // rule. The settlement releases at `releaseAtBlock`, so a voucher who
      // overshoots waits longer and gains nothing.
      const floor = currentBlockHeight + deps.vouchCooldownBlocks;
      if (escrow.releaseAtBlock < floor) {
        return {
          valid: false,
          error:
            `Unvouch escrow releases at ${escrow.releaseAtBlock}, before the ` +
            `earliest legal height ${floor}`,
        };
      }
      return { valid: true };
    }

    default:
      return { valid: false, error: `Unknown box type: ${inputType}` };
  }
}

// ---------------------------------------------------------------------------
// Internal validation helpers (extracted from validateAndApplyTx)
// ---------------------------------------------------------------------------

// The consensus bound on every `value` (and `originalValue`) is the schema's
// `u64` spec below — one table, not a separate value check alongside a type
// table. `json-to-tx.ts`'s `assertValidBoxValue` is the HTTP-edge ergonomics
// twin, not the consensus gate.

/**
 * Runtime type vocabulary for output fields (field-type pin). Every `ok`
 * predicate is total on any JS value — `validateTx`'s totality claim rides on
 * that. The schema owns every field-content rule that is a TYPE; which VALUES
 * are legal per transition (probation windows, the vouch stake,
 * committed-vs-uncommitted key length) stays in the arms.
 */
type FieldType =
  | 'u64'
  | 'bytes32'
  | 'hex32'
  | 'uint'
  | 'u32'
  | 'string'
  | 'boolean';

const FIELD_TYPE_CHECK: Record<FieldType, { ok: (v: unknown) => boolean; expected: string }> = {
  // The value bound is `BOX_VALUE_BOUND`, imported rather than restated
  // (TYPES_INTERFACE → Box value domain). A negative value balances
  // conservation sums while minting into a sibling box; a value at or above the
  // bound encodes cleanly and cannot be stored, so admitting one would put a
  // validly-encoded box into block application to crash there instead of being
  // rejected here.
  u64: {
    ok: (v) => typeof v === 'bigint' && v >= 0n && v < BOX_VALUE_BOUND,
    expected: 'a non-negative bigint < 2^63',
  },
  bytes32: {
    ok: (v) => v instanceof Uint8Array && v.length === 32,
    expected: 'a 32-byte Uint8Array',
  },
  /**
   * A 32-byte id carried as **hex text** in memory — `post_lock.targetPostId`,
   * and it is the only one. Distinct from `bytes32`, which is the same 32 bytes
   * held as a `Uint8Array`; the pair is the whole reason this needs its own
   * entry rather than reusing one.
   *
   * ⚠ **This entry holds a no-panic violation shut, it is not a style gap.**
   * `canonicalBoxBytes` writes the field with `writeHexNOrThrow(…, 32)`, which
   * throws on anything that is not exactly 64 lowercase hex. Type it `'string'`
   * here and a `post_lock` output carrying `targetPostId: 'hello'` clears step 4
   * and then makes `computeTxId` **throw** at `validateTx`'s last line — turning
   * an invalid transaction into an exception on an adversary-supplied value.
   * `VALIDATION_INTERFACE`'s no-panic rule forbids exactly that.
   *
   * The width belongs here and not in the encoder: a throwing writer's domain is
   * established upstream (TYPES_INTERFACE → "Totality"), and adding a guard
   * inside `canonicalBoxBytes` is what the format forbids. The schema is the
   * upstream.
   */
  hex32: {
    ok: (v) => typeof v === 'string' && HEX64.test(v),
    expected: '64 lowercase hex characters',
  },
  // Never -0: it is JSON- and CBOR-reachable and breaks byte round-trips —
  // cbor-x encodes -0 as a float where the store's JSON round-trip returns
  // integer 0. (`Number.isSafeInteger(-0)` and `-0 >= 0` both hold, so the
  // `Object.is` guard is load-bearing.)
  uint: {
    ok: (v) =>
      typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0),
    expected: 'a non-negative safe integer',
  },
  u32: {
    ok: (v) =>
      typeof v === 'number' &&
      Number.isSafeInteger(v) &&
      v >= 0 &&
      !Object.is(v, -0) &&
      v <= 0xffffffff,
    expected: 'a non-negative safe integer <= 0xFFFFFFFF',
  },
  string: { ok: (v) => typeof v === 'string', expected: 'a string' },
  boolean: { ok: (v) => typeof v === 'boolean', expected: 'a boolean' },
};

/**
 * Total description of a rejected value for error messages. Never throws,
 * unlike `String(v)`, which invokes a caller-controlled `toString`. Decoded
 * CBOR/JSON only produces plain data, but the totality of `validateTx` should
 * not depend on that.
 */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof Uint8Array) return `bytes(${v.length})`;
  switch (typeof v) {
    case 'bigint':
      return `${v}n`;
    case 'number':
      return Object.is(v, -0) ? '-0' : String(v);
    case 'string':
      return JSON.stringify(v.length > 64 ? `${v.slice(0, 64)}…` : v);
    case 'boolean':
      return String(v);
    default:
      return typeof v; // 'object' | 'function' | 'symbol' | 'undefined'
  }
}

// ---------------------------------------------------------------------------
// Transaction envelope shape — the step-0 gate
// ---------------------------------------------------------------------------

/**
 * 64 lowercase hex characters — the closed live set of ids. `computeBoxId`,
 * `computeTxId` and `computePostId` all emit `digest().subarray(0,32)` as
 * lowercase hex and nothing else, so an uppercase or short id names no box
 * that can ever exist.
 */
const HEX64 = /^[0-9a-f]{64}$/;

const ENVELOPE_REQUIRED = ['inputs', 'outputs', 'signatures', 'protocolVersion'] as const;

/**
 * Closed: `computeTxId` hashes only these, so any other key is free
 * malleability.
 *
 * ⛔ **`preimages` IS NOT ONE OF THEM, AND THE NAME IS RESERVED** (TYPES_INTERFACE
 * → Layout — UtxoTransaction). No transition requires knowledge of a secret, so
 * the field carries no meaning — and it is outside the `TxId` preimage, which
 * makes admitting it exactly the malleability this set exists to refuse: two
 * distinct byte strings carrying one id.
 */
const ENVELOPE_ALLOWED: ReadonlySet<string> = new Set<string>([
  ...ENVELOPE_REQUIRED,
  'likeTarget',
  'post',
]);

/**
 * A plain object: not null, not an array, and its prototype is
 * `Object.prototype` or null.
 *
 * The prototype clause is load-bearing, not decoration. Every downstream read
 * is `tx.likeTarget` / `tx.signatures[hexKey]` — plain
 * property reads that walk the prototype chain — while this gate decides
 * presence with `Object.hasOwn`. Pinning the prototype is what makes those two
 * agree: without it an object carrying the four required keys but inheriting a
 * `likeTarget` would pass a hasOwn-based gate and still drive `computeTxId`
 * and the conservation carve-out off the inherited value.
 *
 * Measured (2026-08-08), correcting the contracted rationale: cbor-x does NOT
 * set the prototype from a `__proto__` map key — it renames the key to
 * `__proto_` on decode, leaving `Object.prototype` intact. So the CBOR path
 * lands in the closed-key-set reject below, and `JSON.parse` (Express's body
 * parser) likewise defines `__proto__` as an own key rather than assigning it.
 * Both clauses stay anyway: they close the class structurally instead of
 * resting on a decoder's internal sanitizing staying the way it is today.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * The shape of a hex-keyed byte map. `signatures` is the only one — its values
 * are exactly 64 bytes, a raw Ed25519 signature.
 *
 * `byteLength` stays a parameter rather than a constant: the length is a
 * property of what the map carries, and a second map would state its own.
 */
function checkHexKeyedByteMap(
  map: Record<string, unknown>,
  field: 'signatures',
  byteLength: number | null,
): UtxoResult {
  for (const key of Object.keys(map)) {
    if (!HEX64.test(key)) {
      return {
        valid: false,
        error: `Invalid tx envelope: ${field} key must be 64 lowercase hex characters, got ${describeValue(key)}`,
      };
    }
    const value = map[key];
    if (!(value instanceof Uint8Array)) {
      return {
        valid: false,
        error: `Invalid tx envelope: ${field}['${key}'] must be a Uint8Array, got ${describeValue(value)}`,
      };
    }
    if (byteLength !== null && value.length !== byteLength) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: ${field}['${key}'] must be ${byteLength} bytes, ` +
          `got ${describeValue(value)}`,
      };
    }
  }
  return { valid: true };
}

/**
 * Transaction envelope shape (NODE_INTERFACE → "Transaction envelope shape").
 *
 * The outer twin of `checkOutputShape`: that check pins what is INSIDE
 * `tx.outputs`, this one pins that `tx` has the four fields at all and that
 * every one of them is the type its readers assume. Both exist for the same
 * reason — the transaction is attacker-controlled structure arriving over HTTP
 * JSON, gossip CBOR, and block-embedded CBOR — and the envelope is the half
 * nothing else checks. Measured without this gate: `inputs: null` throws at
 * step 1's `.length`, `inputs: 5` at `new Set(5)`, `inputs: [{}]` at the SQLite
 * bind inside `getBox`, `outputs: null` inside `checkOutputShape` itself, a
 * non-array `outputs` OBJECT slips that loop (`length` undefined) and throws at
 * conservation's `.reduce`, a missing or `null` `signatures` throws at
 * `tx.signatures[hexKey]`, and `likeTarget: null` throws inside `computeTxId` —
 * which `checkAuthorization` calls on its first line, so the whole envelope
 * reaches the hasher. Each one is an HTTP
 * 500 or, through the block funnel, a whole-block rejection logged as an
 * unexpected failure.
 *
 * **Total**: returns `{valid: false}` and never throws for any decoded-CBOR
 * value. Error strings quote input through `describeValue`, never bare
 * `String(v)` — which would invoke a caller-controlled `toString`.
 *
 * The key set is **closed**. `computeTxId` hashes only the known fields, so an
 * extra envelope key is free malleability: two distinct byte strings carrying
 * one txId. Measured without this gate: `{…, bogusKey: 'free'}` and the clean tx
 * hash identically, and the junk rides through validation into the store. A
 * REQUIRED key present with the value `undefined` rejects too — that is not a
 * transaction. ⛔ **The two optional fields do not**, and clause 2 states why:
 * `opt()` gives absence one encoding, so present-`undefined` and absent are the
 * same byte string rather than an ambiguity between two.
 *
 * Presence is decided with `Object.hasOwn`, never truthiness or `in` — see
 * `isPlainObject` for what that buys and what it does not.
 *
 * Exported for direct testing. Call sites are `validateTx` step 0 and the
 * block funnel in `block-apply.ts`; gossip and the HTTP routes inherit it
 * through `validateTx`.
 */
export function checkTxEnvelope(tx: unknown): UtxoResult {
  // ---- 1. A plain, non-null, non-array object ----
  if (!isPlainObject(tx)) {
    return {
      valid: false,
      error: `Invalid tx envelope: expected a plain object, got ${
        Array.isArray(tx) ? 'array' : describeValue(tx)
      }`,
    };
  }

  // ---- 2. Closed key set; a present-undefined key rejects ----
  //
  // ⛔ **The two OPTIONAL fields are exempt, and the reason is the codec.**
  // `likeTarget` and `post` each take `opt()`'s presence tag, which writes a
  // single `0` for absence — so an absent field and a present-`undefined` one
  // are ONE byte string, not two, and `computeTxId`'s `!== undefined` test reads
  // that byte string the way the encoder wrote it (TYPES_INTERFACE → Layout —
  // UtxoTransaction). There is no ambiguity here for a rule to refuse.
  //
  // ⚠ **And the decoder produces exactly that shape**: `decodeTx` writes both
  // keys unconditionally, holding `undefined` where the tag said absent. A gate
  // refusing it refuses every non-like, non-post transaction arriving inside a
  // block — which is the whole of the embedded path.
  //
  // Every other key keeps the refusal: a required field holding `undefined` is
  // not a transaction, and an unknown one is refused by the closed set above it.
  for (const key of Object.keys(tx)) {
    if (!ENVELOPE_ALLOWED.has(key)) {
      return { valid: false, error: `Invalid tx envelope: unexpected key '${key}'` };
    }
    if (tx[key] === undefined && key !== 'likeTarget' && key !== 'post') {
      return {
        valid: false,
        error: `Invalid tx envelope: key '${key}' is present with value undefined`,
      };
    }
  }
  for (const key of ENVELOPE_REQUIRED) {
    if (!Object.hasOwn(tx, key)) {
      return { valid: false, error: `Invalid tx envelope: missing required key '${key}'` };
    }
  }

  // ---- 3. inputs: an array of box ids ----
  // Emptiness is step 1's rule ("at least one input"), not the gate's — the
  // gate owns shape, `validateTx` owns the semantic minimum.
  const inputs = tx.inputs;
  if (!Array.isArray(inputs)) {
    return {
      valid: false,
      error: `Invalid tx envelope: inputs must be an array, got ${describeValue(inputs)}`,
    };
  }
  for (let i = 0; i < inputs.length; i++) {
    const id: unknown = inputs[i];
    if (typeof id !== 'string' || !HEX64.test(id)) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: inputs[${i}] must be 64 lowercase hex characters, ` +
          `got ${describeValue(id)}`,
      };
    }
  }

  // ---- 4. outputs: an array ----
  // Entries are NOT typed here — that is step 4's closed per-boxType schema.
  // This clause only guarantees the iteration and `.reduce` sites are total.
  if (!Array.isArray(tx.outputs)) {
    return {
      valid: false,
      error: `Invalid tx envelope: outputs must be an array, got ${describeValue(tx.outputs)}`,
    };
  }

  // ---- 5. signatures: a hex-keyed map of 64-byte signatures ----
  // An EMPTY map is shape-legal: `checkAuthorization` decides which key must
  // have signed, and a transaction whose transition requires one is refused
  // there rather than here. Extra well-formed keys are shape-legal too —
  // `checkAuthorization` only looks keys up, nothing iterates, and the like
  // path's exactly-one-signature rule is `castLike` policy, not envelope shape.
  const signatures = tx.signatures;
  if (!isPlainObject(signatures)) {
    return {
      valid: false,
      error: `Invalid tx envelope: signatures must be a plain object, got ${describeValue(signatures)}`,
    };
  }
  const sigCheck = checkHexKeyedByteMap(signatures, 'signatures', 64);
  if (!sigCheck.valid) return sigCheck;

  // ---- 6. `preimages` is refused by clause 2's closed key set ----
  // It has no clause of its own because it is not a field: the name is reserved
  // and never to be reused (TYPES_INTERFACE → Layout — UtxoTransaction).

  // ---- 7. protocolVersion: strictly PROTOCOL_VERSION ----
  // The same strict-equality posture as posts and block headers. No
  // version-keyed dispatch exists (repo-root CLAUDE.md warning) and this gate
  // does not pretend otherwise. Measured pre-gate: a tx SIGNED with
  // `protocolVersion: "x"` validated, pooled and applied end-to-end, with the
  // string `String()`-coerced into its own id preimage.
  if (tx.protocolVersion !== PROTOCOL_VERSION) {
    return {
      valid: false,
      error:
        `Invalid tx envelope: protocolVersion must be ${PROTOCOL_VERSION}, ` +
        `got ${describeValue(tx.protocolVersion)}`,
    };
  }

  // ---- 8. likeTarget: absent, or a post id ----
  //
  // Presence is `!== undefined`, the same test `computeTxId` applies — see
  // clause 2 for why an own key holding `undefined` IS absence here.
  if (tx.likeTarget !== undefined) {
    const likeTarget = tx.likeTarget;
    if (typeof likeTarget !== 'string' || !HEX64.test(likeTarget)) {
      return {
        valid: false,
        error:
          `Invalid tx envelope: likeTarget must be 64 lowercase hex characters, ` +
          `got ${describeValue(likeTarget)}`,
      };
    }
  }

  // ---- 9. post: absent, or a payload inside the encodable domain ----
  //
  // ⛔ **This clause is what keeps `computeTxId` from throwing on a post-bearing
  // transaction.** `txIdBytes` writes the payload through `postFieldBytes`,
  // which encodes `author` and every `parentRefs` entry fixed-width — writers
  // with no unreachable sentinel, so they THROW outside their domain
  // (TYPES_INTERFACE → Totality). `checkAuthorization` hashes on its first
  // line, so an
  // attacker-supplied payload reaches those writers before any transition arm
  // runs. Same obligation as `likeTarget` above, one field deeper.
  //
  // `verifyPostFieldDomains` is the single statement of that domain, shared with
  // the gossip gate and the verifier — a narrower re-check written here would be
  // a second spelling of one rule, which is the fork surface this engine rejects
  // everywhere else. Whether the payload is *permitted* (the post biconditional,
  // author owns the karma) is the transition arms' business, not the envelope's.
  if (tx.post !== undefined) {
    const domains = verifyPostFieldDomains(tx.post as Post);
    if (!domains.valid) {
      return { valid: false, error: `Invalid tx envelope: ${domains.error}` };
    }
  }

  return { valid: true };
}

/**
 * The box types that can appear as an output at all.
 *
 * `genesis_proof` is excluded **in the type**, not by an omitted entry: it is
 * written by genesis seeding alone and appears in no transaction, user or
 * settlement (NODE_INTERFACE → "Genesis proof boxes are never in a
 * transaction"). This is the node-side twin of the rule `validation` enforces at
 * the gossip gate (`VALIDATION_INTERFACE` → "A transaction may not create a
 * genesis_proof box"); node owns the input half of the same rule, in
 * `AUTHORIZATION`.
 *
 * Written as an `Exclude` so the exclusion is deliberate and a *new* box type
 * still fails to compile until it is given a shape — an omitted key would be
 * indistinguishable from a forgotten one.
 */
type OutputBoxType = Exclude<AnyBox['boxType'], 'genesis_proof'>;

/**
 * The three a **user** transaction may not create, refused under their own
 * names by `checkOutputShape`.
 *
 * They are the settlement transaction's alone at both ends — it is the only
 * spender of the pool and the emission box, and the only producer of all three
 * successors (NODE_INTERFACE → the settlement transaction). ⚠ The `Exclude`
 * above is compile-time; this set is what an attacker-supplied string reaches,
 * so a type in one and not the other is diagnosed as unknown rather than as
 * barred.
 */
const PROTOCOL_OUTPUT_TYPES: ReadonlySet<string> = new Set<string>([
  'emission',
  'treasury',
  'karma_pool',
]);

/**
 * Closed key set and per-field runtime types per boxType, in candidate form —
 * the `@dagsocial/types` box interfaces with `id`/`txId`/`index` removed
 * (`TYPES_INTERFACE` box definitions are authoritative). `required` keys must
 * be present; `optional` keys may be present or absent; nothing else may
 * appear; every present field must satisfy its `FieldType`.
 *
 * `boxType` carries a `null` spec: the discriminant is pinned by the
 * own-property table lookup itself, which is stricter than any type check.
 */
const OUTPUT_SHAPE: Record<
  OutputBoxType,
  {
    required: readonly string[];
    optional: readonly string[];
    allowed: ReadonlySet<string>;
    types: Readonly<Record<string, FieldType>>;
  }
> = (() => {
  const shape = (
    required: Readonly<Record<string, FieldType | null>>,
    optional: Readonly<Record<string, FieldType>> = {},
  ) => ({
    required: Object.keys(required),
    optional: Object.keys(optional),
    allowed: new Set([...Object.keys(required), ...Object.keys(optional)]),
    types: Object.fromEntries(
      [...Object.entries(required), ...Object.entries(optional)].filter(
        (e): e is [string, FieldType] => e[1] !== null,
      ),
    ),
  });
  return {
    karma: shape(
      { boxType: null, value: 'u64', owner: 'bytes32' },
      { decayBurn: 'boolean' },
    ),
    credit: shape(
      { boxType: null, value: 'u64', owner: 'bytes32' },
      { lockedUntilBlock: 'uint' },
    ),
    bond: shape({
      boxType: null,
      value: 'u64',
      inviterId: 'bytes32',
      inviteePublicKey: 'bytes32',
    }),
    post_lock: shape({
      boxType: null,
      value: 'u64',
      originalValue: 'u64',
      owner: 'bytes32',
      // Reserved, never to be reused: `targetPostId`. A lock carries no such
      // field — a post's id comes from the transaction that creates the lock, so
      // the field would have to be known before the `TxId` that produces it
      // (TYPES_INTERFACE → PostLockBox). The lock→post mapping is derived state
      // held by the store.
    }),
    vouch: shape({
      boxType: null,
      value: 'u64',
      voucherId: 'bytes32',
      targetId: 'bytes32',
    }),
    // The shared prefix and nothing else: a fee box names no owner, because
    // block application is its only spender and the coinbase already decides
    // which key the value reaches (TYPES_INTERFACE → FeeBox). No optional
    // fields, because there is no tail for one to sit in. That a user-created
    // box is consumed only by block application is the shape `bond` and
    // `post_lock` already have (NODE_INTERFACE → Output shape).
    fee: shape({ boxType: null, value: 'u64' }),
    // ⚠ **A row here says the field types are pinned, never that a transition
    // creates one.** No transition arm admits either type as an output today:
    // `KARMA_TRANSITION_TYPES` is an allowlist that excludes both and the credit
    // arm admits only `credit` and `fee`, so a transaction naming one is refused
    // at step 7 with the shape already checked. The settlement transaction
    // creates both and it does not pass through this table
    // (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
    like_accrual: shape({ boxType: null, value: 'u64', author: 'bytes32' }),
    vouch_escrow: shape({
      boxType: null,
      value: 'u64',
      owner: 'bytes32',
      releaseAtBlock: 'uint',
    }),
    // The three protocol boxes. Each names no owner and carries no per-type
    // trailing field — block application is their only spender and their only
    // producer, so there is no key for a field to name (TYPES_INTERFACE →
    // EmissionBox / TreasuryBox / KarmaPoolBox). They are reachable only through
    // `checkSettlementOutputShape`; `checkOutputShape` refuses all three by name.
    emission: shape({ boxType: null, value: 'u64' }),
    treasury: shape({ boxType: null, value: 'u64' }),
    karma_pool: shape({ boxType: null, value: 'u64' }),
  };
})();

/**
 * Output shape — the closed per-boxType schema (field-type pin,
 * NODE_INTERFACE → "Output shape").
 *
 * Outputs are attacker-controlled structure (HTTP JSON via `jsonToTx`, gossip
 * and block-embedded CBOR). The committed encoders are positional —
 * `canonicalBoxBytes` (the id preimage) and `serializeBox` (the AVL leaf, so
 * the `stateRoot`) each write the fields their layout declares and nothing
 * else — so a stray key is unrepresentable in the bytes. It still reaches
 * everything else: the object `insertBox` writes, the stored row, and every
 * later read. A mistyped field poisons the row itself — a string
 * `originalValue` in a stored row makes every later `rowToBox` of that box
 * throw.
 *
 * Three rules per output:
 * - a key outside the closed set is a REJECT, never a silent strip;
 * - every present field's runtime type matches its `FieldType` spec in
 *   OUTPUT_SHAPE (`TYPES_INTERFACE` box definitions are the authority);
 * - an unknown `boxType` — or a `null`/non-object entry — is a reject here,
 *   not a late throw downstream, and the table lookup is an OWN-PROPERTY
 *   lookup (`Object.hasOwn`): `boxType: 'constructor'` lands in this reject
 *   instead of retrieving `Object.prototype.constructor` and throwing;
 * - `genesis_proof`, `emission`, `treasury` and `karma_pool` are rejects under
 *   their own names, ahead of that lookup. ⛔ **The four are refused for two
 *   different reasons and only one of them is absolute**: `genesis_proof` is in
 *   no transaction of any kind, where the other three are the settlement
 *   transaction's own outputs and are admitted by
 *   `checkSettlementOutputShape`. The named arm is what keeps the *diagnosis*
 *   true, since an assigned tag refused by protocol rule is not an unknown one.
 *   ⚠ `OutputBoxType`'s `Exclude` is compile-time and covers `genesis_proof`
 *   alone; `PROTOCOL_OUTPUT_TYPES` is what an attacker-supplied string reaches,
 *   so a type in one and not the other is diagnosed as unknown.
 *
 * Client-supplied `id`/`txId`/`index` keys are skipped rather than rejected:
 * they are structurally outside every committed byte (no layout declares them;
 * `materializeOutput` strips them before appending the real provenance), so the
 * schema is compared in candidate form.
 *
 * ⛔ **A key present with the value `undefined` IS absence, and every reader
 * agrees.** `canonicalBoxBytes` writes one byte string for an absent optional
 * field — measured: a karma candidate with `decayBurn: undefined` and one
 * without encode identically — so the two are not two shapes for a rule to tell
 * apart. ⚠ **And the decoder produces exactly that shape**: `decodeTx` writes
 * every optional box field as an own key, holding `undefined` where the tag said
 * absent, so a gate refusing it refuses every ordinary karma output arriving
 * inside a block. A REQUIRED key holding `undefined` still rejects, in the
 * required-key loop below — that is a missing field, not an absent optional.
 *
 * Exported for direct testing. Through `validateTx` this check runs at step 4
 * — the first consumer of `tx.outputs` — so it is the PRIMARY gate for every
 * malformed output, unknown boxTypes included. The transition arms' own
 * unknown-type rejections (the karma/credit totality counts, the
 * `outputs.length` pins), which made the unknown-boxType arm here unreachable
 * while the check ran at step 7, are now the defense-in-depth layer behind
 * it: they fire only if this gate regresses.
 */
export function checkOutputShape(outputs: AnyBoxCandidate[]): UtxoResult {
  return checkShapeAgainst(outputs, false);
}

/**
 * The same closed schema for the block's **settlement** transaction, which
 * creates the three protocol boxes a user transaction may not
 * (NODE_INTERFACE → the settlement transaction).
 *
 * ⛔ **`genesis_proof` stays refused here too**, and that is the difference
 * between the two absences: no transaction of any kind creates one, where the
 * other three are refused of user transactions specifically.
 *
 * The settlement does not pass through `validateTx` — no signer authorizes it
 * and no transition row admits its inputs — so this is called from the block
 * funnel directly, ahead of `computeTxId`, for the same reason
 * `checkOutputShape` is: an out-of-domain output field would otherwise become an
 * exception absorbed by the funnel's totality handler instead of a stated
 * rejection.
 */
export function checkSettlementOutputShape(outputs: AnyBoxCandidate[]): UtxoResult {
  return checkShapeAgainst(outputs, true);
}

function checkShapeAgainst(outputs: AnyBoxCandidate[], settlement: boolean): UtxoResult {
  for (let i = 0; i < outputs.length; i++) {
    const raw: unknown = outputs[i];
    // A null/non-object entry rejects through the unknown-boxType arm below
    // (its boxType read is undefined), never a throw.
    const box = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const boxTypeValue = box.boxType;
    if (
      boxTypeValue === 'genesis_proof' ||
      (!settlement && typeof boxTypeValue === 'string' &&
        PROTOCOL_OUTPUT_TYPES.has(boxTypeValue))
    ) {
      return {
        valid: false,
        error:
          `Invalid output shape at index ${i}: a ${String(boxTypeValue)} box may not be a ` +
          `transaction output`,
      };
    }
    if (typeof boxTypeValue !== 'string' || !Object.hasOwn(OUTPUT_SHAPE, boxTypeValue)) {
      return {
        valid: false,
        error: `Invalid output shape at index ${i}: unknown boxType ${
          typeof boxTypeValue === 'string' ? boxTypeValue : describeValue(boxTypeValue)
        }`,
      };
    }
    const boxType = boxTypeValue as OutputBoxType;
    const shape = OUTPUT_SHAPE[boxType];
    for (const key of Object.keys(box)) {
      if (key === 'id' || key === 'txId' || key === 'index') continue;
      if (!shape.allowed.has(key)) {
        return {
          valid: false,
          error: `Invalid output shape at index ${i} (${boxType}): unexpected key '${key}'`,
        };
      }
    }
    for (const key of shape.required) {
      if (box[key] === undefined) {
        return {
          valid: false,
          error: `Invalid output shape at index ${i} (${boxType}): missing required key '${key}'`,
        };
      }
    }
    for (const [key, fieldType] of Object.entries(shape.types)) {
      const value = box[key];
      // Required presence is enforced above; an undefined read here is an
      // absent optional.
      if (value === undefined) continue;
      const check = FIELD_TYPE_CHECK[fieldType];
      if (!check.ok(value)) {
        return {
          valid: false,
          error:
            `Invalid output shape at index ${i} (${boxType}): field '${key}' ` +
            `must be ${check.expected}, got ${describeValue(value)}`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * Enforce strict face-value conservation — `sum(inputs) == sum(outputs)` across
 * the transaction as a whole, **one total per side and not per box type**.
 *
 * ⛔ **Per-type equality would reject most karma transactions.** Value changes
 * form inside the karma family: invite creation is `karma → karma + bond`,
 * where the bond's value comes out of the karma output, so the transaction
 * conserves as one total while the `karma` type alone does not.
 * Posting and vouch casting have the same shape. Step 3 constrains the
 * **inputs** to a single box type; the outputs deliberately span several, and
 * the two `.reduce`s below carry no type predicate (NODE_INTERFACE →
 * `validateTx` step 5).
 *
 * Karma and credits are minted or burned only in block-application paths (like
 * settlement, decay, bond settlement), never inside a user transaction, so no
 * box type gets a blanket exemption. **Two stated exceptions and no others**
 * (NODE_INTERFACE → `validateTx` step 5):
 *
 * - **The like burn** — `likeTarget` present ⟺ the transaction burns
 *   exactly `LIKE_KARMA_COST` from karma inputs. This is the biconditional's
 *   value half: `likeTarget` absent ⇒ zero deficit as always (strict equality
 *   below), present ⇒ exactly that deficit — never more, never less, never a
 *   surplus. The only karma-burning user transaction. Checked before the vouch
 *   exemption so a zero-output unvouch with a bolted-on `likeTarget` cannot
 *   shelter under it.
 *
 * - **The zero-output spend** of a `VouchBox` (unvouch — the staked karma is
 *   escrowed in `vouch_cooldowns` and re-minted to the voucher at maturity by
 *   `processVouchCooldowns`, an escrow round-trip rather than a burn). The
 *   escrow living outside the UTXO set, and therefore outside the AVL+ state
 *   root, is a known wart — modelling it as a maturing box is tracked
 *   separately.
 *
 * ⛔ **The invite carries NO surplus.** An invite is `karma → karma + bond` and
 * conserves like any other karma transaction; the invitee's grant — the bond's
 * own value — is spent from the pool by the block's settlement transaction,
 * which this gate does not govern (NODE_INTERFACE → the settlement
 * transaction). **No user transaction creates karma.**
 *
 * Both remaining exceptions move karma. **A credit transaction conserves
 * strictly**: its fee is a `FeeBox` output it names (TYPES_INTERFACE → FeeBox),
 * so what the miner takes is inside the output sum rather than a gap between two
 * sums, and a credit-side deficit is refused by the strict equality below like
 * any other. That leaves the like burn as the only deficit in the system, which
 * is what lets `likeTarget` ⟺ a deficit stay exact with no ledger argument
 * behind it.
 *
 * The BondBox has **no** exemption and needs none: a bond is destroyed by the
 * probation-deadline settlement, which is block application, and this gate
 * governs transactions (NODE_INTERFACE → "Bond transition rules").
 */
function checkValueConservation(
  inputBoxes: AnyBox[],
  outputs: AnyBoxCandidate[],
  likeTarget: string | undefined,
): UtxoResult {
  // Output `value` types are pinned by the step-4 schema before this runs
  // (field-type pin), so the bigint sums below are total — this function must
  // never run on outputs that have not passed `checkOutputShape`.

  // ⛔ **NO CARVE-OUTS. `sum(inputs) == sum(outputs)`, unconditionally**
  // (ARCHITECTURE → The conservation axiom). It holds for a like because the
  // cost lands in a `LikeAccrualBox` the transaction outputs, and for an unvouch
  // because the stake lands in a `VouchEscrowBox` — **every karma-side spend has
  // somewhere for its value to go, so none needs an exception.**
  //
  // ⚠ **`likeTarget` is still a parameter and still load-bearing**, one rule
  // further out: an all-karma input set is what makes the marker exemption in
  // `checkTransitions` reachable only from a like, and a `likeTarget` bolted
  // onto a credit or vouch spend is refused here before any arm reads it.
  if (likeTarget !== undefined && !inputBoxes.every((b) => b.boxType === 'karma')) {
    return {
      valid: false,
      error: `likeTarget is only legal on an all-karma burn transaction`,
    };
  }

  const totalInputValue = inputBoxes.reduce((sum, b) => sum + b.value, 0n);
  const totalOutputValue = outputs.reduce((sum, b) => sum + b.value, 0n);

  if (totalInputValue !== totalOutputValue) {
    return {
      valid: false,
      error: `Value non-conservation: inputs=${totalInputValue}, outputs=${totalOutputValue}`,
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Authorization — a property of the transition
// ---------------------------------------------------------------------------

/**
 * What a transition requires of the transaction performing it
 * (NODE_INTERFACE → "Legal box transitions").
 *
 * Two variants, and the closed set is the point: a transition either requires a
 * signature by a key **the box itself names**, or no transition admits the input
 * at all. There is no variant that names a key from anywhere else, so no rule
 * expressible here can name a privileged key. ⚠ The contract states that
 * property tree-wide, marks it AHEAD OF CODE, and names its one counter-example
 * — which is a shape rule in `checkTransitions`, not a requirement in this
 * table.
 *
 * This decides only who must have signed, which is what lets it run ahead of
 * `checkTransitions`: ⛔ **the verdict is a function of the input's TYPE alone**
 * — `checkAuthorization` reads `inputBoxes` and the signature map and nothing
 * else. The rest of each shape is pinned a step later.
 */
type Authorization =
  | {
      /**
       * The key that must have signed, read out of the box and the transition.
       * Absent when the box carries no such field, which refuses rather than
       * throwing — every input reaching here is store-shaped, and a row that is
       * not is a refusal like any other.
       */
      signer: (box: AnyBox, tx: UtxoTransaction) => Uint8Array | undefined;
      /** The refusal when that key did not sign. */
      unsigned: (box: AnyBox, tx: UtxoTransaction) => string;
    }
  | {
      /** The refusal, and which absence it is: no transition names this type as an input. */
      noUserTransition: (box: AnyBox) => string;
    };

const missingOwnerSignature = (box: AnyBox): string =>
  `Missing or invalid owner signature for box ${box.id}`;

/**
 * The transition rows that name no signer require the owner's signature — every
 * karma and credit row (NODE_INTERFACE → "Legal box transitions").
 *
 * The karma post row's *"the signing key is the post's author"* is this
 * requirement together with `checkTransitions`' pin of `post.author` to the
 * input owner. Neither half states it alone.
 */
const OWNER_SIGNATURE: Authorization = {
  signer: (box) => (box as KarmaBox | CreditBox).owner,
  unsigned: missingOwnerSignature,
};

/**
 * `bond`, `post_lock` and `fee` are created by user transactions and consumed
 * only by block application; `emission`, `treasury` and `karma_pool` are block
 * application's at both ends (NODE_INTERFACE → "Genesis proof boxes are never
 * in a transaction"). No transition admits any of them as an input, and this
 * entry carries that absence's reason.
 */
const BLOCK_APPLICATION_ONLY: Authorization = {
  noUserTransition: (box) =>
    `No user transition consumes box ${box.id}: ` +
    `a ${box.boxType} box is consumed only by block application`,
};

/**
 * Authorization per input box type — one entry per box type, and each is the
 * requirement of that type's transitions.
 *
 * Keyed on the input's **type**: the requirement belongs to the transition, not
 * to the box (NODE_INTERFACE → "Legal box transitions"). Typed over every
 * `boxType`, so a new box type fails to compile until its authorization is
 * stated — the obligation `OUTPUT_SHAPE` carries for output shape.
 *
 * A type the transition table names as a legal input gets a signer rule; a type
 * no row names gets the absence. Admitting a type is the deliberate act.
 */
const AUTHORIZATION: Readonly<Record<AnyBox['boxType'], Authorization>> = {
  karma: OWNER_SIGNATURE,
  credit: OWNER_SIGNATURE,

  // *voucher-signed*. A `VouchBox` names the staking key as `voucherId` and
  // carries no `owner`, so the key the row means is the one field it has.
  vouch: {
    signer: (box) => (box as VouchBox).voucherId,
    unsigned: missingOwnerSignature,
  },

  bond: BLOCK_APPLICATION_ONLY,
  post_lock: BLOCK_APPLICATION_ONLY,
  fee: BLOCK_APPLICATION_ONLY,
  emission: BLOCK_APPLICATION_ONLY,
  treasury: BLOCK_APPLICATION_ONLY,

  // Both are the settlement transaction's alone — a marker it consumes, an
  // escrow it releases (TYPES_INTERFACE → LikeAccrualBox / VouchEscrowBox).
  // `LikeAccrualBox.author` is attribution, not authorization: no signature by
  // that key unlocks the box.
  like_accrual: BLOCK_APPLICATION_ONLY,
  vouch_escrow: BLOCK_APPLICATION_ONLY,

  // The karma supply pool: grants draw it down and burns return to it, both the
  // settlement's, so no user transaction may name it in either position
  // (TYPES_INTERFACE → KarmaPoolBox).
  karma_pool: BLOCK_APPLICATION_ONLY,

  // Nothing spends a genesis proof box — the empty set of transitions, which is
  // a stronger statement than block application's and is why it reads
  // differently (NODE_INTERFACE → "Genesis proof boxes are never in a
  // transaction"). `validation` owns the output half and cannot own this one:
  // `tx.inputs` are box **id** strings, so typing one requires the UTXO set.
  genesis_proof: {
    noUserTransition: (box) =>
      `No transition consumes box ${box.id}: ` +
      `a ${box.boxType} box can never be consumed`,
  },
};

/**
 * Check every input's authorization: the signer its transition requires signed
 * this transaction, or no transition admits the input at all.
 *
 * Runs ahead of `checkTransitions`, which is why the transition is identified
 * here from the input's type and the output count rather than from a shape that
 * has already been validated.
 */
function checkAuthorization(tx: UtxoTransaction, inputBoxes: AnyBox[]): UtxoResult {
  const txHash = Buffer.from(computeTxId(tx), 'hex');

  for (const box of inputBoxes) {
    // Own-property lookup, never a bare index: `boxType` is a store column, so
    // `boxType: 'constructor'` must land in the arm below rather than retrieve
    // `Object.prototype.constructor` and throw downstream (NODE_INTERFACE →
    // "Output shape" states the same rule for the output schema).
    if (!Object.hasOwn(AUTHORIZATION, box.boxType)) {
      return {
        valid: false,
        error: `No transition admits a ${box.boxType} box as an input: box ${box.id}`,
      };
    }
    const rule = AUTHORIZATION[box.boxType];

    if ('noUserTransition' in rule) {
      return { valid: false, error: rule.noUserTransition(box) };
    }

    const signer = rule.signer(box, tx);
    if (!signer || !verifyGuardSignature(tx, txHash, signer)) {
      return { valid: false, error: rule.unsigned(box, tx) };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Public API: validateTx, revalidateTxInContext, applyTx, validateAndApplyTx
// ---------------------------------------------------------------------------

/**
 * Validate a transaction without applying it (read-only).
 *
 * Performs 8 validation steps:
 * 0. Transaction envelope shape — `tx` is a plain object with the closed key
 *    set, hex input ids, array outputs, a hex-keyed 64-byte signature map, and
 *    `protocolVersion` strictly equal
 *    to `PROTOCOL_VERSION` (NODE_INTERFACE → "Transaction envelope shape").
 *    Ahead of every other read of `tx`, so steps 1–7 dereference envelope
 *    fields under a shape guarantee.
 * 1. No duplicate input IDs
 * 2. All inputs exist and are unspent
 * 3. All inputs have the same boxType
 * 4. Output shape — every output is a non-null object matching the closed
 *    per-boxType schema: exact key set, and every field's runtime type
 *    (field-type pin, NODE_INTERFACE → "Output shape"). This is the first
 *    step that reads
 *    `tx.outputs`, so steps 5–7 dereference output fields under a schema
 *    guarantee.
 * 5. Face-value conservation — sum(in) == sum(out) across the transaction as a
 *    whole, one total per side and not per box type. The like burn lands in a
 *    `LikeAccrualBox` and the unvouch's stake in a `VouchEscrowBox`, so every
 *    karma-side spend has somewhere for its value to go and the equality is
 *    unconditional. The `value` TYPE bound lives in step 4's schema.
 * 6. Authorization — the signer the transition requires signed this
 *    transaction, or no transition admits the input (NODE_INTERFACE → "Legal
 *    box transitions"). Ahead of step 7, so the transition is identified from
 *    the input type and the output count rather than from a validated shape.
 * 7. Legal box transitions (`likeTarget`-aware — the like burn shape)
 *
 * Karma decay is handled by the periodic decay engine, not at transaction
 * validation time.
 *
 * Does NOT call runInTransaction, consumeBox, or insertBox.
 * Returns computedOutputs and txId on success for use by applyTx.
 */
export function validateTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // ---- 0. Transaction envelope shape ----
  // Ahead of every other read of `tx`: steps 1–7 index `tx.inputs`, iterate
  // `tx.outputs`, and hash the whole envelope inside `computeTxId`, all of
  // which are throw sites for a malformed envelope without this gate.
  const envelopeCheck = checkTxEnvelope(tx);
  if (!envelopeCheck.valid) return envelopeCheck;

  // ---- 1. No duplicate input box IDs ----
  const inputSet = new Set(tx.inputs);
  if (inputSet.size !== tx.inputs.length) {
    return { valid: false, error: 'Duplicate input box IDs' };
  }

  if (tx.inputs.length === 0) {
    return { valid: false, error: 'Transaction must have at least one input' };
  }

  // ---- 2. Every input box exists and is unspent ----
  const inputBoxes: AnyBox[] = [];
  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (!box) {
      return { valid: false, error: `Input box not found or already spent: ${inputId}` };
    }
    inputBoxes.push(box);
  }

  // ---- 3. All inputs must be the same box_type ----
  // No exceptions: every legal shape is single-type. The claim needs no bond
  // alongside its invite, because the karma it produces is minted rather than
  // moved, and the cancel names no bond at all (NODE_INTERFACE → the transition
  // table). `checkTransitions` relies on this — it reads `inputs[0]`'s type as
  // the type of all of them.
  const inputType = inputBoxes[0]!.boxType;
  for (const box of inputBoxes) {
    if (box.boxType !== inputType) {
      return {
        valid: false,
        error: `Mixed input types not allowed: ${inputType} vs ${box.boxType}`,
      };
    }
  }

  // ---- 4. Output shape: the closed per-boxType schema (field-type pin) ----
  // First consumer of `tx.outputs`, ahead of every semantic rule: steps 5–7
  // dereference output fields under the schema's key-set and type guarantees
  // instead of defending per-site. Placing it here rather than at step 7
  // changes only which error a MALFORMED output surfaces (a shape error, not
  // an arm-specific one); the accepted set for well-typed outputs is identical
  // either way.
  const shapeCheck = checkOutputShape(tx.outputs);
  if (!shapeCheck.valid) return shapeCheck;

  // ---- 5. Value conservation ----
  const valueCheck = checkValueConservation(inputBoxes, tx.outputs, tx.likeTarget);
  if (!valueCheck.valid) return valueCheck;

  // ---- 6. Authorization ----
  // Ahead of the transition arms, so a transaction that is both unsigned and
  // malformed is refused for being unsigned. The transition is identified here
  // from the input type and the output count; step 7 pins the rest of the shape.
  const authCheck = checkAuthorization(tx, inputBoxes);
  if (!authCheck.valid) return authCheck;

  // ---- 7. Legal box transitions ----
  const transitionCheck = checkTransitions(
    inputBoxes,
    tx.outputs,
    deps,
    tx.likeTarget,
    tx.post,
    currentBlockHeight,
  );
  if (!transitionCheck.valid) return transitionCheck;

  // Compute output IDs for the caller (so applyTx doesn't re-compute)
  const txId = computeTxId(tx);
  const computedOutputs = tx.outputs.map((box, index) =>
    materializeOutput(box, txId, index),
  );

  return {
    valid: true,
    computedOutputs,
    txId,
  };
}

/**
 * Turn a transaction output candidate into the box that goes into the ledger:
 * the creating transaction's real id, the output's position within
 * `tx.outputs`, and the derived box id (NODE_INTERFACE → "Box Identity and
 * Mint Provenance").
 *
 * The `txId` is passed in rather than recomputed. `computeTxId` hashes outputs
 * through `canonicalBoxBytes`, so it does not *observe* provenance — which
 * means re-deriving it from a box that already carries some would be silently
 * wrong rather than an error.
 *
 * Any client-supplied `id`/`txId`/`index` is **stripped before** the canonical
 * pair is appended, not overwritten in place.
 *
 * Stripping rather than overwriting is not about bytes — the AVL value is
 * positional, so key order is not observable and either shape serializes the
 * same. It is about representability: stripping makes "this box's provenance
 * came from the client" unrepresentable, where overwriting merely corrects it
 * after the fact. Outputs are attacker-controlled, so the difference is between
 * a shape that cannot exist and one that depends on every later reader
 * overwriting in the same order.
 *
 * Exported because `block-apply.ts` materializes the outputs of block-embedded
 * transactions on its own path. One rule for both, so the pool path and the
 * block path cannot derive different ids for the same transaction.
 */
export function materializeOutput(box: AnyBoxCandidate, txId: string, index: number): AnyBox {
  // The destructure still names all three keys even though `AnyBoxCandidate`
  // declares none of them: outputs are decoded from attacker-supplied CBOR, so
  // the runtime shape is not bound by the type.
  const { id: _id, txId: _txId, index: _index, ...candidate } = box as AnyBox;
  const withProvenance = { ...candidate, txId, index } as AnyBox;
  return { ...withProvenance, id: computeBoxId(withProvenance) } as AnyBox;
}

/**
 * Revalidate a previously-validated transaction at a later height.
 *
 * Skips expensive checks (signatures, transitions) and only verifies:
 * - Inputs are still unspent (liveness)
 *
 * Karma decay is handled by the periodic decay engine.
 *
 * Used by the mempool to detect stale transactions.
 */
export function revalidateTxInContext(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): UtxoResult {
  // Only check liveness — are inputs still unspent?
  for (const id of tx.inputs) {
    const box = deps.getBox(id);
    if (!box) {
      return { valid: false, error: `Input box not found or already spent: ${id}` };
    }
  }

  return { valid: true };
}

/**
 * Apply a previously-validated transaction (write).
 *
 * Consumes all input boxes and inserts all output boxes inside a transaction.
 * Call validateTx first — applyTx performs no validation.
 */
export function applyTx(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  outputsWithIds: AnyBox[],
  currentBlockHeight: number,
): void {
  deps.runInTransaction(() => {
    for (const id of tx.inputs) {
      deps.consumeBox(id, currentBlockHeight);
    }
    for (const box of outputsWithIds) {
      // The box goes in exactly as `materializeOutput` built it. Spreading it
      // is wrong: any key added or reordered here changes the id, since
      // `computeBoxId` hashes the box itself. The settled height reaches the
      // `created_at_block` store column through `insertBox`, which takes it
      // from the open journal — the only place it can come from.
      deps.insertBox(box);
    }
  });
}

