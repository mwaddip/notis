import { BOX_VALUE_BOUND, computeBoxId } from '@dagsocial/types';
import type {
  KarmaBox,
  CreditBox,
  GenesisProofBox,
  EmissionBox,
  KarmaPoolBox,
} from '@dagsocial/types';
import {
  insertBox,
  getKarmaBox,
  getCreditBoxes,
  getGenesisProofBox,
  getEmissionBox,
  getKarmaPoolBox,
} from './utxo.js';
import { putIdentityRecord } from './identity-records.js';
import {
  GENESIS_EMISSION,
  GENESIS_FAUCET_CREDITS,
  GENESIS_KARMA_POOL,
  GENESIS_PROOF,
  GENESIS_SYSTEM_KARMA,
  MINT_OUTPUT_INDEX,
  genesisCommitteeContext,
  genesisContext,
  mintTxIdFor,
} from '../mint-provenance.js';

// ---------------------------------------------------------------------------
// The faucet identity's genesis boxes
//
// ⛔ **THE NODE HOLDS NO SECRET KEY.** The faucet identity is named by
// `profile.faucetPublicKey` and its key lives in an off-chain service that
// invites like any member. Nothing here signs, and no consensus rule resolves
// against a configured key (ARCHITECTURE → "What varies per network, and what
// must not").
// ---------------------------------------------------------------------------

/**
 * The faucet identity's stake. **Capacity is this divided by the bond it
 * chooses** — at testnet's 1000 ceiling that is 1,000 invites, at the 25 floor
 * 40,000. It does not replenish: the bond returns only as an invitee earns
 * likes, and what does not vest goes to the pool.
 */
const SYSTEM_KARMA_INITIAL = 1_000_000n;

/**
 * The height a genesis mint commits to.
 *
 * A synthetic mint txId commits to a height and 0 is not one a block ever
 * settles at (`genesis-state.ts` → `GENESIS_HEIGHT`), so the genesis seeder's
 * own height — always 0, since seeding requires an empty store — is raised to
 * the first real one. Every seeder below takes its height through here: the
 * value reaches `mintTxIdFor`, so it is inside the box id, and three sites
 * spelling out the same clamp is three chances for one of them to stop
 * agreeing.
 */
function genesisMintHeight(currentHeight: number): number {
  return currentHeight > 0 ? currentHeight : 1;
}

/**
 * Ensure the system karma box exists with the initial balance.
 * Idempotent — if a system karma box already exists, returns it without creating.
 */
export function ensureSystemKarmaBox(systemPubKey: Uint8Array, currentHeight: number): KarmaBox {
  const existing = getKarmaBox(systemPubKey);
  if (existing) return existing;

  // One height for both the recorded block and the mint txId. Derived once
  // rather than clamped twice, so the id cannot encode a height the box does
  // not carry.
  const genesisHeight = genesisMintHeight(currentHeight);

  const box: KarmaBox = {
    boxType: 'karma',
    value: SYSTEM_KARMA_INITIAL,
    createdAtBlock: genesisHeight,
    owner: systemPubKey,
    txId: mintTxIdFor(genesisContext(GENESIS_SYSTEM_KARMA), genesisHeight),
    index: MINT_OUTPUT_INDEX,
  };
  box.id = computeBoxId(box);
  insertBox(box);

  // Genesis is the one non-decay karma producer that runs **outside** block
  // application, so `insertBox`'s choke point cannot bump the activity clock:
  // there is no open journal, and therefore no settled height for it to read
  // (Spec G phase D).
  //
  // Left unwritten, the system identity would hold karma with no record, and
  // decay would fall back to "never active" — staleness one block early and one
  // extra interval charged on the first firing, because the box says
  // `genesisHeight` and the fallback says 0. Writing it here is the root fix:
  // the clock and the box get the same height from the same local, so they
  // cannot disagree.
  //
  // With no journal open this records nothing to roll back, which is correct —
  // genesis is not a block. The row still reaches the `stateRoot` on any node
  // that bootstraps its prover from the store.
  putIdentityRecord(box.owner, {
    lastActivityBlock: genesisHeight,
    lastDecayBlock: 0,
    // The system identity was never invited, and genesis is the one event that
    // could not have been a claim — a claim is a user transaction and the first
    // block is height 1. It has received no likes either: genesis mints boxes,
    // and only per-block like settlement moves the counter.
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
  });
  return box;
}

// ---------------------------------------------------------------------------
// The faucet identity's credit box
// ---------------------------------------------------------------------------

const FAUCET_CREDITS_INITIAL = 100_000n * 10n ** 8n;  // 100k credits in base units

/**
 * Ensure the faucet identity has a credit box holding `FAUCET_CREDITS_INITIAL`.
 * Idempotent — if it already has unspent credit boxes, returns the first
 * without creating.
 *
 * ⚠ **Credits are TRADEABLE, so the service dispenses them by an ordinary
 * owner-signed transfer** — no rule names this box, and the node holds no key
 * to spend it with. Karma takes the other path because a karma transfer does
 * not exist to be performed.
 *
 * Returns the box for the same reason `ensureSystemKarmaBox` does: the cold-start
 * caller has to hand what it seeded to the AVL feed, and re-reading it from the
 * store afterwards would be a second derivation of the same fact.
 */
export function ensureFaucetCreditBox(
  systemPubKey: Uint8Array,
  currentHeight: number,
): CreditBox {
  const existing = getCreditBoxes(systemPubKey);
  if (existing.length > 0) return existing[0]!;

  const genesisHeight = genesisMintHeight(currentHeight);

  // A `u32BE` selector separates the two genesis boxes, not the ASCII tags Spec
  // G §3.2 sketched: those are variable-length and merely prefix-free, which
  // the fixed-length-or-self-delimiting rule cannot check per encoding.
  const box: CreditBox = {
    boxType: 'credit',
    value: FAUCET_CREDITS_INITIAL,
    createdAtBlock: genesisHeight,
    owner: systemPubKey,
    txId: mintTxIdFor(genesisContext(GENESIS_FAUCET_CREDITS), genesisHeight),
    index: MINT_OUTPUT_INDEX,
  };
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

// ---------------------------------------------------------------------------
// Genesis proof box
// ---------------------------------------------------------------------------

/**
 * Ensure the genesis proof box exists, carrying this network's payload.
 * Idempotent — if one is already seeded, returns it without creating.
 *
 * The payload is a parameter rather than a config read, following the two
 * seeders above: the caller supplies what distinguishes the box, so this
 * function is testable under a payload without a module reset, and `store/`
 * gains no edge into config.
 *
 * ⚠ **No identity record.** `ensureSystemKarmaBox` writes one because the
 * system identity holds karma and decay would otherwise read "never active".
 * A proof box has no owner and no karma, so there is no activity clock for a
 * record to hold — the block above is not a template.
 */
export function ensureGenesisProofBox(
  payload: Uint8Array,
  currentHeight: number,
): GenesisProofBox {
  const existing = getGenesisProofBox();
  if (existing) return existing;

  const genesisHeight = genesisMintHeight(currentHeight);

  // `GENESIS_PROOF` is the third `u32BE` selector, which is the whole cost of a
  // third genesis box — `genesisContext` was built fixed-width for exactly this
  // (NODE_INTERFACE → "Box Identity and Mint Provenance").
  const box: GenesisProofBox = {
    boxType: 'genesis_proof',
    value: 0n,
    createdAtBlock: genesisHeight,
    payload,
    txId: mintTxIdFor(genesisContext(GENESIS_PROOF), genesisHeight),
    index: MINT_OUTPUT_INDEX,
  };
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

// ---------------------------------------------------------------------------
// Emission box
// ---------------------------------------------------------------------------

/**
 * Ensure the emission box exists, holding this network's whole emission total.
 * Idempotent — if one is already seeded, returns it without creating.
 *
 * **Seeded on every network, mainnet included** (TYPES_INTERFACE → EmissionBox).
 * Unlike the karma and credit boxes above there is no faucet gate: emission is
 * what every network pays its miners out of, so a network without this box
 * produces no block at all.
 *
 * `total` is a parameter rather than a config read, following
 * `ensureGenesisProofBox`: the caller supplies what distinguishes the box, so
 * this function is testable under a total without a module reset and `store/`
 * gains no edge into the emission schedule. ⚠ **It must be `emissionTotal()`'s
 * result and never a literal** — a total that disagrees with
 * `computeBlockReward` starves the box before the terminus, making every block
 * from that height unproducible, or strands a residue no rule can release.
 *
 * ⚠ **No identity record**, for `ensureGenesisProofBox`'s reason: the box has no
 * owner and holds no karma, so there is no activity clock for a record to hold.
 */
export function ensureEmissionBox(total: bigint, currentHeight: number): EmissionBox {
  const existing = getEmissionBox();
  if (existing) return existing;

  const genesisHeight = genesisMintHeight(currentHeight);

  // `GENESIS_EMISSION` is the fourth `u32BE` selector — the whole cost of a
  // fourth genesis box, which is what `genesisContext` was built fixed-width
  // for (NODE_INTERFACE → "Box Identity and Mint Provenance").
  const box: EmissionBox = {
    boxType: 'emission',
    value: total,
    createdAtBlock: genesisHeight,
    txId: mintTxIdFor(genesisContext(GENESIS_EMISSION), genesisHeight),
    index: MINT_OUTPUT_INDEX,
  };
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

// ---------------------------------------------------------------------------
// Genesis committee
// ---------------------------------------------------------------------------

/**
 * Seed one karma box per genesis committee member and return the total granted.
 *
 * The return value is what `ensureKarmaPoolBox` draws out of the supply, and it
 * is summed from the boxes actually created rather than recomputed from the
 * profile: two derivations of one number are two chances to disagree, and the
 * one that matters is what the store holds.
 *
 * ⛔ **`genesisCommitteeContext(member)`, never a `genesisContext` selector.**
 * A selector names one box; this mints one per member, and N boxes under one
 * `k` derive one synthetic txId, one `computeBoxId` preimage, and the second
 * insert violates `UNIQUE(tx_id, output_index)` (NODE_INTERFACE → Reason and
 * subject table).
 *
 * Each member gets an identity record for the reason `ensureSystemKarmaBox`
 * writes one: genesis runs outside block application, so `insertBox`'s choke
 * point has no open journal and no settled height to bump an activity clock
 * from. Left unwritten, a member holds karma with no record and decay reads
 * "never active".
 *
 * `invitedAtBlock: 0` — a committee member was never invited, and genesis is the
 * one event that could not have been a claim, since a claim is a user
 * transaction and the first block is height 1.
 *
 * Idempotent through `getKarmaBox`: a member who already holds karma is not
 * granted a second box.
 */
export function seedGenesisCommittee(
  committeeKeys: readonly string[],
  karmaPerMember: bigint,
  currentHeight: number,
): bigint {
  const genesisHeight = genesisMintHeight(currentHeight);
  let granted = 0n;

  for (const keyHex of committeeKeys) {
    const member = new Uint8Array(Buffer.from(keyHex, 'hex'));
    if (member.length !== 32) {
      throw new Error(
        `Genesis committee key ${keyHex} is ${member.length} bytes, not 32. Refusing ` +
        'to seed — a committee member is named by an Ed25519 public key.',
      );
    }
    if (getKarmaBox(member)) continue;

    const box: KarmaBox = {
      boxType: 'karma',
      value: karmaPerMember,
      createdAtBlock: genesisHeight,
      owner: member,
      txId: mintTxIdFor(genesisCommitteeContext(member), genesisHeight),
      index: MINT_OUTPUT_INDEX,
    };
    box.id = computeBoxId(box);
    insertBox(box);
    granted += box.value;

    putIdentityRecord(member, {
      lastActivityBlock: genesisHeight,
      lastDecayBlock: 0,
        invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
    });
  }

  return granted;
}

// ---------------------------------------------------------------------------
// Karma supply pool
// ---------------------------------------------------------------------------

/**
 * The whole of a network's karma supply: the largest value a box may hold, the
 * top of the accepted domain (TYPES_INTERFACE → Box value domain). Genesis puts
 * all of it into the pool but what it grants the committee, every later mint
 * draws the pool down and every burn returns to it, so `pool.value +
 * circulating karma` equals this at every height, forever. Karma is not scarce
 * by policy — it is non-inflatable by construction, and this is the number that
 * makes it so.
 *
 * Derived from `BOX_VALUE_BOUND` rather than written out: the pool is the one
 * box that sits at the ceiling, so a restated literal here is the copy that
 * would be left behind if the domain ever moved again.
 */
export const KARMA_SUPPLY_TOTAL = BOX_VALUE_BOUND - 1n;

/**
 * Ensure the karma supply pool box exists, holding the karma not in
 * circulation. Idempotent — if one is already seeded, returns it without
 * creating.
 *
 * **Seeded on every network, mainnet included**, for the reason
 * `ensureEmissionBox` carries: every karma mint draws from this box, so a
 * network seeded without it can mint no karma at all.
 *
 * `granted` is what genesis hands out — the committee grants — subtracted here
 * rather than minted beside a full pool. Minting beside one would put total
 * supply above `KARMA_SUPPLY_TOTAL` **at genesis**, which `writeVlqU64OrThrow`
 * refuses outright: the invariant is not merely violated, the state is
 * unencodable (TYPES_INTERFACE → KarmaPoolBox).
 *
 * ⛔ **A zero-value pool box IS created, and this is the one place the
 * `ensureEmissionBox` rule inverts.** Emission terminates, so above its terminus
 * no box exists and its zero successor is never written. The pool never
 * terminates: burns must always have somewhere to return, so the box exists at
 * every height whatever its value. **A reader who pattern-matches to the
 * emission rule here gets it exactly backwards.**
 *
 * ⚠ **No identity record**, for `ensureGenesisProofBox`'s reason: the box has no
 * owner and no holder, so there is no activity clock for a record to hold.
 */
export function ensureKarmaPoolBox(granted: bigint, currentHeight: number): KarmaPoolBox {
  const existing = getKarmaPoolBox();
  if (existing) return existing;

  // A grant total above the supply is a profile that cannot be seeded, and it
  // is refused by name here rather than left to surface as an encoder throw on
  // a negative `value` — the box the message would name is this one, and the
  // configuration at fault is not.
  if (granted > KARMA_SUPPLY_TOTAL) {
    throw new Error(
      `Genesis grants ${granted} karma, which is more than the ${KARMA_SUPPLY_TOTAL} ` +
      'a network can hold. Refusing to seed — the karma supply pool would have to ' +
      'hold a negative balance for the total to be conserved.',
    );
  }

  const genesisHeight = genesisMintHeight(currentHeight);

  // `GENESIS_KARMA_POOL` is the fifth `u32BE` selector — the whole cost of a
  // fifth genesis box, which is what `genesisContext` was built fixed-width for
  // (NODE_INTERFACE → "Box Identity and Mint Provenance").
  const box: KarmaPoolBox = {
    boxType: 'karma_pool',
    value: KARMA_SUPPLY_TOTAL - granted,
    createdAtBlock: genesisHeight,
    txId: mintTxIdFor(genesisContext(GENESIS_KARMA_POOL), genesisHeight),
    index: MINT_OUTPUT_INDEX,
  };
  box.id = computeBoxId(box);
  insertBox(box);
  return box;
}

