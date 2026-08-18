import { fixturePostId } from '../helpers.js';
/**
 * TS ↔ JS mirror: the demo UI must encode posts, boxes and transactions
 * byte-identically to `@dagsocial/types` — TYPES_INTERFACE → Canonical field
 * encoding, Layout — Post, Layout — Boxes, Layout — UtxoTransaction.
 *
 * The demo UI (`public/index.html`) mines PoW, signs, and computes post, box and
 * transaction ids in the browser; the node verifies all three. If the two
 * encodings drift, every post and every transaction minted from the UI is
 * rejected — and no unit test in either package would notice, because neither
 * exercises the other's code.
 *
 * This test closes that gap without a browser: it reads `index.html`, extracts
 * the actual crypto declarations from it, evaluates them, and asserts they
 * reproduce the golden vectors frozen in the types tests.
 *
 * **Why the UI is not simply importing the library.** It would remove this drift
 * class outright, but it means giving `index.html` a build step, and the demo UI
 * is scaffolding until `@dagsocial/web` lands (user decision, 2026-08-09). So the
 * mirror stays hand-written and this test stays the thing that polices it; both
 * die with the UI.
 *
 * The UI's `blake2b` comes from the `blakejs` CDN module, which is not
 * installed here, so it is injected as a Node `blake2b512` shim. Both are plain
 * BLAKE2b-512 — the equivalence the project already relies on (see CLAUDE.md,
 * "Platform constraint"). What this test pins is the *encoding*, which is where
 * the two implementations can actually diverge.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  computePostId, postFieldBytes, computeBoxId, computeTxId,
  computeCandidateBoxId, canonicalBoxBytes, BOX_VALUE_BOUND, MAX_PARENT_REFS,
  PROTOCOL_VERSION, VOUCH_KARMA_AMOUNT, VOUCH_MIN_BALANCE, u32BE,
  INVITE_KARMA_AMOUNT, INVITE_BOND_KARMA,
} from '@dagsocial/types';
import { jsonToTx } from '../../src/routes/json-to-tx.js';
import { extractDeclaration as extractDeclarationFrom } from './extract-declaration.js';
import type {
  CandidateOf,
  Post, KarmaBox, CreditBox, GenesisProofBox, BondBox, PostLockBox, VouchBox,
  EmissionBox, TreasuryBox, FeeBox, KarmaPoolBox, LikeAccrualBox, VouchEscrowBox,
  AnyBox, UtxoTransaction,
} from '@dagsocial/types';

const INDEX_HTML = fileURLToPath(new URL('../../public/index.html', import.meta.url));

// ---------------------------------------------------------------------------
// Golden vector — must stay identical to packages/types/test/post.test.ts
// ---------------------------------------------------------------------------

const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;

/** A well-formed `b32` parent ref: 64 lowercase hex characters. */
const GOLDEN_REF = '11'.repeat(32);

const GOLDEN_POST: Post = {
  content: 'dagsocial golden vector ✓',
  author: GOLDEN_AUTHOR,
  parentRefs: [GOLDEN_REF],
  protocolVersion: 1,
  timestamp: 1767225600000, // > 2^32 — six VLQ bytes
};

/** The txId a post id is derived from. Any 64-hex value; this one is distinctive. */
const GOLDEN_POST_TX_ID = '7f'.repeat(32);

/**
 * The same payload as the page builds it: `author` is the identity's HEX, not
 * bytes. Both forms encode to the same 32 bytes (`b32Either`), and this is the
 * one that survives the page's own `JSON.stringify` → `jsonToTx` round trip.
 */
const GOLDEN_POST_HEX_AUTHOR = {
  ...GOLDEN_POST,
  author: Buffer.from(GOLDEN_AUTHOR).toString('hex'),
} as unknown as Post;

// ---------------------------------------------------------------------------
// Golden box vectors — must stay identical to packages/types/test/utxo.test.ts
// (positional: enum8(boxType) ‖ vlqU(value) ‖ per-type)
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE: CandidateOf<KarmaBox> = {
  boxType: 'karma',
  value: 100n,
  owner: GOLDEN_AUTHOR,
};

const GOLDEN_CREDIT_CANDIDATE: CandidateOf<CreditBox> = {
  boxType: 'credit',
  value: 123456789n * 10n ** 8n,  // 12_345_678_900_000_000 > 2^53 — why box values are bigint
  owner: GOLDEN_AUTHOR,
};

const GOLDEN_UTXO_TX: UtxoTransaction = {
  inputs: ['1111111111111111111111111111111111111111111111111111111111111111'],
  outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_CREDIT_CANDIDATE],
  signatures: {},
  protocolVersion: 1,
};

// ⛔ **EVERY ID BELOW MOVED WITH C1'S TRANSACTION PREIMAGE, AND THE BOX BYTES
// DID NOT.** `txIdBytes` lost its `preimages` field (TYPES_INTERFACE → Layout —
// UtxoTransaction: the name is reserved), so every `TxId` moved and, through
// `computeCandidateBoxId(candidate, txId, index)`, every box id derived from
// one. The two frozen byte vectors further down are **unchanged** — measured,
// not assumed — which is what localises the move to the transaction preimage
// rather than to the box layout.
//
// ⚠ **These were re-pinned to `@dagsocial/types`, which is the normative
// encoder; the page mirrors it and not the reverse.** While the page still
// writes the retired field it will disagree with them, and that disagreement is
// the point: a constant left matching a stale page would be a fixture and a
// subject drifted together, which is the one shape a mirror cannot see past.
const GOLDEN_KARMA_BOX_ID =
  '4f46bf062ba4efccb85d1db363aee824f4d175f0002ffd168697234ce362d193';
const GOLDEN_CREDIT_BOX_ID =
  'f8ff432e8b0e4389482f667b9c05f0c301eb34b6514314ec5cd2b776ae4f8b1c';
const GOLDEN_UTXO_TX_ID =
  '14cea3748d7b4a232b9a774b71dc1d5e4dbf112949c11d14e61147b642557565';

/**
 * The exact canonical bytes for the two golden candidates, frozen. Stronger
 * than the ids: a hash says "something moved", these say *which byte*. Read
 * them against TYPES_INTERFACE → Layout — Boxes, field by field.
 */
const GOLDEN_KARMA_BOX_BYTES =
  '00' +                                                               // enum8 karma
  '64' +                                                               // vlqU value 100
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '00';                                                                // opt decayBurn absent

const GOLDEN_CREDIT_BOX_BYTES =
  '01' +                                                               // enum8 credit
  '80eae1eac58af715' +                                                 // vlqU value
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 owner
  '00';                                                                // opt lockedUntilBlock absent

/** The candidates as block application materializes them out of GOLDEN_UTXO_TX. */
const GOLDEN_KARMA_BOX: KarmaBox =
  { ...GOLDEN_KARMA_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 0 };
const GOLDEN_CREDIT_BOX: CreditBox =
  { ...GOLDEN_CREDIT_CANDIDATE, txId: GOLDEN_UTXO_TX_ID, index: 1 };

// ---------------------------------------------------------------------------
// Provenance vectors (NODE_INTERFACE → Box Identity and Mint Provenance).
//
// The provenance is the real one for these boxes: GOLDEN_UTXO_TX creates the
// karma box at index 0 and the credit box at index 1. Values measured from
// `computeCandidateBoxId` in @dagsocial/types, so both implementations are
// pinned to a constant rather than only to each other.
//
// `GOLDEN_KARMA_CANDIDATE_ID` equals `GOLDEN_KARMA_BOX_ID` above, and that is
// the derivation rather than a copy-paste slip: `computeBoxId` IS
// `computeCandidateBoxId` applied to the box's own provenance, one derivation
// on both sides.
// ---------------------------------------------------------------------------

const GOLDEN_KARMA_CANDIDATE_ID =            // (GOLDEN_UTXO_TX_ID, index 0)
  '4f46bf062ba4efccb85d1db363aee824f4d175f0002ffd168697234ce362d193';
const GOLDEN_CREDIT_CANDIDATE_ID =           // (GOLDEN_UTXO_TX_ID, index 1)
  'f8ff432e8b0e4389482f667b9c05f0c301eb34b6514314ec5cd2b776ae4f8b1c';
const GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX = // index 0x12345678 — five VLQ bytes
  'c837393c51d82567145c3cbed9f9c9cd837b9085bad1594ce9567d315375d8a4';
// ⚠ Derived from a genuinely malformed index (`NaN`), NOT from `2**32` — that
// one is inside `vlqU`'s domain and encodes faithfully, so it is a valid index
// and pinning it here would make the case below assert nothing. The test's own
// comment states the distinction; regenerating this constant from the wrong
// input is the exact trap a regenerated pin carries.
const GOLDEN_KARMA_CANDIDATE_ID_SENTINEL =   // any index outside the vlqU domain
  '1563d15fe2d81bce59c59c294f7e21e1f5d62c3476315bf2ea0406427875fa74';

// ---------------------------------------------------------------------------
// One fixture per box type
//
// A box type encoded through only ONE implementation is a type whose binary
// fields nobody compares: a UI that wrote `VouchBox.voucherId` in the wrong form
// would be observed by nothing. Every type in `ALL_BOX_TYPES` is encoded through
// both implementations in both forms, so an omission fails here instead of
// needing review to catch. Distinct fill bytes per field so a transposition is
// visible too.
//
// ⚠ **`genesis_proof` is covered separately, in the byte form only.**
// `toUiForm` renders every `Uint8Array` as hex because that is how the UI's tx
// builders carry keys — and no builder carries a `payload`, because the box is
// written by genesis seeding and a transaction may never create one. `lp` is
// byte-only on both sides, so a hex-form assertion would be asserting agreement
// on a shape neither implementation has a producer for.
// ---------------------------------------------------------------------------

/**
 * Provenance for the four per-type coverage fixtures below.
 *
 * They are NOT outputs of `GOLDEN_UTXO_TX` — that transaction creates the karma
 * box at index 0 and the credit box at index 1 and nothing else — so they carry
 * their own synthetic creating transaction rather than claiming an index of one
 * that has no output there.
 */
const COVERAGE_TX_ID = 'de'.repeat(32);

const BYTES_INVITEE = new Uint8Array(32).fill(0xb2);
const BYTES_TARGET = new Uint8Array(32).fill(0xc3);

const GOLDEN_BOND_BOX: BondBox = {
  boxType: 'bond', value: 5n,
  inviterId: GOLDEN_AUTHOR, inviteePublicKey: BYTES_INVITEE,
  txId: COVERAGE_TX_ID, index: 1,
};

const GOLDEN_POST_LOCK_BOX: PostLockBox = {
  boxType: 'post_lock', value: 8n,
  originalValue: 10n, owner: GOLDEN_AUTHOR,
  txId: COVERAGE_TX_ID, index: 2,
};

const GOLDEN_VOUCH_BOX: VouchBox = {
  boxType: 'vouch', value: 1n,
  voucherId: GOLDEN_AUTHOR, targetId: BYTES_TARGET,
  txId: COVERAGE_TX_ID, index: 3,
};

const GOLDEN_EMISSION_BOX: EmissionBox = {
  boxType: 'emission', value: 4226400000000n,
  txId: COVERAGE_TX_ID, index: 4,
};

const GOLDEN_TREASURY_BOX: TreasuryBox = {
  boxType: 'treasury', value: 77n,
  txId: COVERAGE_TX_ID, index: 5,
};

const GOLDEN_FEE_BOX: FeeBox = {
  boxType: 'fee', value: 1000n,
  txId: COVERAGE_TX_ID, index: 6,
};

// The pool's ordinary state is the top of the ACCEPTED domain, not the two-byte
// floor its empty-tail siblings sit at (TYPES_INTERFACE → KarmaPoolBox: genesis
// holds the whole supply). `BOX_VALUE_BOUND - 1n` rather than the top of
// `vlqU64`'s range: the encoder is wider than the gate, and this fixture is the
// value a real pool box carries — the encoder's own ceiling is pinned
// separately, by the `vlqU64` vector below.
const GOLDEN_KARMA_POOL_BOX: KarmaPoolBox = {
  boxType: 'karma_pool', value: BOX_VALUE_BOUND - 1n,
  txId: COVERAGE_TX_ID, index: 7,
};

// ⚠ **Neither type has a producer yet** — the like transition does not emit a
// marker and the unvouch does not emit an escrow (TYPES_INTERFACE →
// LikeAccrualBox / VouchEscrowBox). They are covered here because coverage is
// keyed on the box-type UNION rather than on what a transition happens to build:
// a type the demo UI cannot encode is exactly what this file exists to catch.
const GOLDEN_LIKE_ACCRUAL_BOX: LikeAccrualBox = {
  boxType: 'like_accrual', value: 1n,
  author: BYTES_TARGET,
  txId: COVERAGE_TX_ID, index: 8,
};

const GOLDEN_VOUCH_ESCROW_BOX: VouchEscrowBox = {
  boxType: 'vouch_escrow', value: 1n,
  owner: GOLDEN_AUTHOR, releaseAtBlock: 40,
  txId: COVERAGE_TX_ID, index: 9,
};

/**
 * The box types the mirror covers, **keyed so coverage is a compile error.**
 *
 * ⛔ **`satisfies Record<MirroredBoxType, AnyBox>` is what makes the coverage
 * structural: a box type added to the union without a fixture here is a compile
 * error.** NODE_INTERFACE (→ the mirror's coverage rule) states the enforceable
 * rule is coverage rather than documentation: *"with every box type in the
 * mirror, a missing `binaryFields` entry fails mechanically instead of waiting
 * for someone to notice the list is a manual copy of a type definition."* An
 * array is that manual copy — an array of the union is satisfied by any subset
 * of it, so it tracks the set only by hand. Same shape as `MINT_REASON_GOLDENS`
 * in `@dagsocial/types`.
 *
 * `genesis_proof` is the one deliberate exclusion, in the type rather than by
 * omission, and it is covered separately in the byte form only — `toUiForm`
 * renders every `Uint8Array` as hex because that is how the UI's tx builders
 * carry keys, and no builder carries a `payload`.
 */
type MirroredBoxType = Exclude<AnyBox['boxType'], 'genesis_proof'>;

const BOX_TYPE_FIXTURES = {
  karma: GOLDEN_KARMA_BOX,
  credit: GOLDEN_CREDIT_BOX,
  bond: GOLDEN_BOND_BOX,
  post_lock: GOLDEN_POST_LOCK_BOX,
  vouch: GOLDEN_VOUCH_BOX,
  emission: GOLDEN_EMISSION_BOX,
  treasury: GOLDEN_TREASURY_BOX,
  fee: GOLDEN_FEE_BOX,
  karma_pool: GOLDEN_KARMA_POOL_BOX,
  like_accrual: GOLDEN_LIKE_ACCRUAL_BOX,
  vouch_escrow: GOLDEN_VOUCH_ESCROW_BOX,
} satisfies Record<MirroredBoxType, AnyBox>;

const ALL_BOX_TYPES: ReadonlyArray<{ name: string; box: AnyBox }> =
  Object.entries(BOX_TYPE_FIXTURES).map(([name, box]) => ({ name, box }));

/**
 * The tx-builder form of a box: every `Uint8Array` field as a hex string, which
 * is how the UI's builders carry keys (`pubKeyHex`, `secretHashHex`).
 *
 * Derived mechanically rather than hand-written, so a `Uint8Array` field added
 * to any box type is covered here without anyone remembering to update a
 * fixture — which is the failure this whole block exists to prevent.
 */
function toUiForm(box: AnyBox): Record<string, unknown> {
  return Object.fromEntries(Object.entries(box).map(
    ([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v],
  ));
}

// ---------------------------------------------------------------------------
// Extract the UI's crypto declarations from index.html
// ---------------------------------------------------------------------------

/**
 * Return the source of a top-level declaration, brace-matched from its header.
 *
 * Skips braces inside string literals and comments so a future comment or
 * string containing `{`/`}` cannot truncate the slice.
 *
 * Shared with `miner-mirror.test.ts`, the other consumer that cannot import
 * `@dagsocial/validation` and is held by a mirror instead.
 */
const extractDeclaration = (src: string, header: string): string =>
  extractDeclarationFrom(src, header, 'index.html');

/** Return a single-line `const NAME = …;` declaration. */
function extractConst(src: string, name: string): string {
  const header = `const ${name} =`;
  const start = src.indexOf(header);
  if (start === -1) throw new Error(`index.html no longer declares: ${header}`);
  const end = src.indexOf('\n', start);
  return src.slice(start, end === -1 ? undefined : end);
}

/**
 * The byte primitives: every declaration whose job is to emit wire bytes. The
 * completeness audit at the bottom of this file derives its vocabulary from this
 * array, so a primitive added here extends the audit with it.
 */
const BYTE_PRIMITIVES = [
  'vlqU', 'vlqS', 'vlqU64', 'vlqBigInt', 'lp', 'lpUtf8', 'arr', 'opt',
  'boolByte', 'enum8Tag', 'b32Bytes', 'b32Hex', 'b32Either',
] as const;

/** The rest of what the mirror evaluates: helpers and the id preimages. */
const MIRRORED_OTHER = [
  'buf2hex', 'hex2buf', 'concatUint8Arrays',
  'isEncodableVlqU', 'isEncodableVlqS',
  'postFieldBytes', 'u32BE',
  'computePostId', 'canonicalBoxBytes', 'boxTypeFields',
  'computeBoxId', 'computeCandidateBoxId', 'computeTxId',
  'jsonBigint',
] as const;

/**
 * Transaction builders lifted from the page, so what the mirror hashes is the
 * object a user's click actually signs rather than a copy of it kept here.
 *
 * A hand-copied builder in a test asserts agreement between the test and
 * itself: `devnet-bond-commit-agreement.test.ts` re-states `buildCommitTx`'s
 * arithmetic, and nothing ties that restatement to the page.
 */
const MIRRORED_BUILDERS = [
  'selectBoxes', 'buildVouchTx', 'buildUnvouchTx',
  'buildPostTx', 'buildLikeTx', 'predictOutputBoxId',
  'buildCreateInviteTx',
  'recordPendingKarmaChange', 'applyPendingKarmaChange',
] as const;

/** Every function declaration the mirror lifts out of `index.html`. */
const MIRRORED_FUNCTIONS: readonly string[] =
  [...BYTE_PRIMITIVES, ...MIRRORED_OTHER, ...MIRRORED_BUILDERS];

/** Consts the mirror lifts. A top-level one may itself construct bytes. */
const MIRRORED_CONSTS = [
  'POST_ID_DOMAIN', 'BOX_ID_DOMAIN', 'TX_ID_DOMAIN', 'VLQ_SENTINEL', 'U32_SENTINEL', 'BOX_TYPE_TAGS',
  'PROTOCOL_VERSION', 'VOUCH_KARMA_AMOUNT', 'VOUCH_MIN_BALANCE',
  'LIKE_KARMA_COST', 'POST_LOCK_THREAD_COST',
  'INVITE_KARMA_AMOUNT', 'INVITE_BOND_KARMA',
  'pendingKarmaChange',
] as const;

/** What `loadUiCrypto` hands back; must stay in step with `UiCrypto`. */
const RETURNED = [
  'postFieldBytes', 'computePostId', 'u32BE',
  'vlqU', 'vlqS', 'vlqU64', 'lp', 'lpUtf8', 'arr', 'opt', 'boolByte', 'enum8Tag',
  'b32Bytes', 'b32Hex',
  'canonicalBoxBytes', 'computeBoxId', 'computeTxId', 'computeCandidateBoxId',
  'jsonBigint', 'buildVouchTx', 'buildUnvouchTx',
  'buildPostTx', 'buildLikeTx', 'predictOutputBoxId',
  'buildCreateInviteTx',
  'recordPendingKarmaChange', 'applyPendingKarmaChange', 'pendingKarmaChange',
  'VOUCH_KARMA_AMOUNT', 'VOUCH_MIN_BALANCE',
  'INVITE_KARMA_AMOUNT', 'INVITE_BOND_KARMA',
] as const;

/** The shape `GET /karma` returns, and what the page's builders select from. */
interface KarmaView { total: bigint; boxes: Array<{ boxId: string; value: bigint }> }

interface UiCrypto {
  postFieldBytes: (
    content: string, author: Uint8Array | string, parentRefs: string[],
    protocolVersion: number, timestamp: number,
  ) => Uint8Array;
  computePostId: (txId: string, index: number) => string;
  u32BE: (n: number) => Uint8Array;
  vlqU: (n: number) => Uint8Array;
  vlqS: (n: number) => Uint8Array;
  vlqU64: (v: bigint) => Uint8Array;
  lp: (b: Uint8Array) => Uint8Array;
  lpUtf8: (s: string) => Uint8Array;
  arr: <T>(items: T[], f: (x: T) => Uint8Array) => Uint8Array;
  opt: <T>(v: T | null | undefined, f: (x: T) => Uint8Array) => Uint8Array;
  boolByte: (v: boolean) => Uint8Array;
  enum8Tag: (table: Record<string, number>, v: string) => Uint8Array;
  b32Bytes: (v: Uint8Array, n: number) => Uint8Array;
  b32Hex: (v: string, n: number) => Uint8Array;
  canonicalBoxBytes: (box: Record<string, unknown>) => Uint8Array;
  computeBoxId: (box: Record<string, unknown>) => string;
  computeTxId: (tx: Record<string, unknown>) => string;
  computeCandidateBoxId: (
    candidate: Record<string, unknown>, txId: string, index: number,
  ) => string;
  jsonBigint: (key: string, value: unknown) => unknown;
  buildVouchTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    targetIdHex: string,
    pubKeyHex: string,
  ) => Record<string, unknown>;
  buildUnvouchTx: (vouchBoxId: string) => Record<string, unknown>;
  buildCreateInviteTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    pubKeyHex: string,
    inviteePubKeyHex: string,
  ) => Record<string, unknown>;
  buildPostTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    lockAmount: bigint,
    post: Post,
    pubKeyHex: string,
  ) => UtxoTransaction;
  buildLikeTx: (
    karmaBox: { total: bigint; boxes: Array<{ boxId: string; value: bigint }> },
    targetPostId: string,
    pubKeyHex: string,
  ) => UtxoTransaction;
  predictOutputBoxId: (tx: Record<string, unknown>, index: number) => string;
  recordPendingKarmaChange: (tx: Record<string, unknown>) => void;
  applyPendingKarmaChange: (data: KarmaView) => KarmaView;
  pendingKarmaChange: Map<string, { boxId: string; value: bigint }>;
  VOUCH_KARMA_AMOUNT: bigint;
  VOUCH_MIN_BALANCE: bigint;
  INVITE_KARMA_AMOUNT: bigint;
  INVITE_BOND_KARMA: bigint;
}

/**
 * `blakejs`-compatible shim over Node's blake2b512. Asserts the UI still calls
 * it the documented way — an unkeyed 64-byte digest.
 */
function blake2bShim(data: Uint8Array, key: null, outlen: number): Uint8Array {
  if (key !== null) throw new Error('UI passed a key to blake2b; mirror assumes unkeyed');
  if (outlen !== 64) throw new Error(`UI requested a ${outlen}-byte digest; mirror assumes 64`);
  return new Uint8Array(createHash('blake2b512').update(data).digest());
}

function loadUiCrypto(): UiCrypto {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const source = [
    'const encoder = new TextEncoder();',
    ...MIRRORED_CONSTS.map((name) => extractConst(html, name)),
    ...MIRRORED_FUNCTIONS.map((name) => extractDeclaration(html, `function ${name}(`)),
    `return { ${RETURNED.join(', ')} };`,
  ].join('\n\n');

  return new Function('blake2b', source)(blake2bShim) as UiCrypto;
}

const ui = loadUiCrypto();

/** The UI's payload encoder, called the way the page calls it. */
function uiPayload(post: Post): Uint8Array {
  return ui.postFieldBytes(
    post.content, post.author, post.parentRefs, post.protocolVersion, post.timestamp,
  );
}

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------

describe('demo UI ↔ @dagsocial/types encoding mirror (M-1)', () => {
  it('the UI payload encoder is byte-identical to postFieldBytes', () => {
    expect(hexOf(uiPayload(GOLDEN_POST))).toBe(hexOf(postFieldBytes(GOLDEN_POST)));
  });

  it('the UI derives a post id from (txId, index) exactly as types does', () => {
    // ⛔ Both sides take the TRANSACTION, not the post. A mirror that still took
    // a post would be reproducing an id the node can no longer produce.
    expect(ui.computePostId(GOLDEN_POST_TX_ID, 0)).toBe(computePostId(GOLDEN_POST_TX_ID, 0));
    expect(ui.computePostId(GOLDEN_POST_TX_ID, 1)).toBe(computePostId(GOLDEN_POST_TX_ID, 1));
    expect(ui.computePostId(GOLDEN_POST_TX_ID, 0))
      .not.toBe(ui.computePostId(GOLDEN_POST_TX_ID, 1));
  });

  it('the UI derives a malformed index to the sentinel id rather than throwing', () => {
    // The M-5 totality split, mirrored: `u32BE` sentinels on both sides, so a
    // page handed a bad index shows a wrong id rather than breaking.
    for (const bad of [NaN, -1, 1.5, 2 ** 40]) {
      expect(ui.computePostId(GOLDEN_POST_TX_ID, bad))
        .toBe(computePostId(GOLDEN_POST_TX_ID, bad));
    }
  });

  it('the UI accepts a hex-string author identically', () => {
    // The posting flow passes the identity's hex straight through.
    const asHex = ui.postFieldBytes(
      GOLDEN_POST.content, Buffer.from(GOLDEN_POST.author).toString('hex'),
      GOLDEN_POST.parentRefs, GOLDEN_POST.protocolVersion, GOLDEN_POST.timestamp,
    );
    expect(hexOf(asHex)).toBe(hexOf(postFieldBytes(GOLDEN_POST)));
  });

  it('both implementations agree across a spread of posts', () => {
    // Every variant is in-domain on both sides. A `parentRefs` entry is `b32`,
    // so a short or empty ref has no encoding at all and belongs in the domain
    // test below, where the throw is the assertion.
    const variants: Post[] = [
      { ...GOLDEN_POST, content: 'a', parentRefs: [] },
      { ...GOLDEN_POST, content: '', parentRefs: [] },
      { ...GOLDEN_POST, content: '🙂 multi-byte ✓ ünïcode', parentRefs: ['ab'.repeat(32)] },
      { ...GOLDEN_POST, protocolVersion: 0, timestamp: 0 },
      { ...GOLDEN_POST, protocolVersion: 52, timestamp: Number.MAX_SAFE_INTEGER },
      // At the cap. The encoder itself has no opinion on the count — the cap is
      // validation's — so this pins the count prefix, not the rule.
      {
        ...GOLDEN_POST,
        parentRefs: Array.from({ length: MAX_PARENT_REFS }, (_, i) => String(i).repeat(64)),
      },
    ];
    for (const v of variants) {
      expect(hexOf(uiPayload(v))).toBe(hexOf(postFieldBytes(v)));
    }
  });

  it('a parentRef outside the b32 domain has no encoding on EITHER side', () => {
    // The mirror has to agree on which inputs are unencodable, not only on the
    // bytes for the ones that are. A UI that padded `'ab'` to 32 bytes where the
    // node throws would mint posts the node cannot verify — and the padding
    // would map a malformed ref onto a well-formed ref's encoding, which is the
    // reason a fixed-width field throws instead of carrying a sentinel
    // (TYPES_INTERFACE → Totality).
    // `GOLDEN_REF` is all digits, so uppercasing it is a no-op — the case leg
    // needs a ref that actually contains letters to be non-vacuous.
    const MIXED_CASE_REF = 'ab'.repeat(32).toUpperCase();
    for (const bad of ['', 'ab', 'abcd', 'z'.repeat(64), MIXED_CASE_REF]) {
      const post = { ...GOLDEN_POST, parentRefs: [bad] };
      expect(() => postFieldBytes(post), `types accepted ${bad}`).toThrow();
      expect(() => uiPayload(post), `ui accepted ${bad}`).toThrow();
    }
  });

  it('the M-1 collision pair is distinct in the UI too', () => {
    // The pair moved from (powNonce, timestamp) to (protocolVersion, timestamp)
    // — the field died, the collision shape did not. Compared as PAYLOAD bytes,
    // because that is where injectivity now matters: these bytes go inside the
    // `TxId`, so a collision here collides two transactions.
    const a = { ...GOLDEN_POST, protocolVersion: 5, timestamp: 23 };
    const b = { ...GOLDEN_POST, protocolVersion: 52, timestamp: 3 };
    expect(hexOf(uiPayload(a))).not.toBe(hexOf(uiPayload(b)));
    expect(hexOf(uiPayload(a))).toBe(hexOf(postFieldBytes(a)));
    expect(hexOf(uiPayload(b))).toBe(hexOf(postFieldBytes(b)));
  });

  it('the UI positional writers match the frozen byte forms', () => {
    // Hand-derived from TYPES_INTERFACE → Primitives rather than measured off
    // the UI, so this catches an encoder that is merely self-consistent.
    expect(hexOf(ui.vlqU(0))).toBe('00');
    expect(hexOf(ui.vlqU(1))).toBe('01');
    expect(hexOf(ui.vlqU(127))).toBe('7f');
    expect(hexOf(ui.vlqU(128))).toBe('8001');
    expect(hexOf(ui.vlqU(300))).toBe('ac02');
    // Past 2^32, where a bitwise implementation silently truncates.
    expect(hexOf(ui.vlqU(2 ** 32))).toBe('8080808010');
    expect(hexOf(ui.vlqU(1767225600000))).toBe('80d0eab6b733');
    // ZigZag: the sign rides in bit 0.
    expect(hexOf(ui.vlqS(0))).toBe('00');
    expect(hexOf(ui.vlqS(-1))).toBe('01');
    expect(hexOf(ui.vlqS(1))).toBe('02');
    expect(hexOf(ui.vlqS(70000))).toBe('e0c508');
    // The bigint path spans the whole u64, where the number path stops at 2^53.
    expect(hexOf(ui.vlqU64(0n))).toBe('00');
    expect(hexOf(ui.vlqU64(2n ** 64n - 1n))).toBe('ffffffffffffffffff01');
    // Length prefixes, options and tags.
    expect(hexOf(ui.lp(new Uint8Array([0xaa, 0xbb])))).toBe('02aabb');
    expect(hexOf(ui.lpUtf8('✓'))).toBe('03e29c93');
    expect(hexOf(ui.arr([1, 2], (n: number) => ui.vlqU(n)))).toBe('020102');
    expect(hexOf(ui.opt(undefined, () => new Uint8Array([9])))).toBe('00');
    expect(hexOf(ui.opt(null, () => new Uint8Array([9])))).toBe('00');
    expect(hexOf(ui.opt(7, () => new Uint8Array([9])))).toBe('0109');
    expect(hexOf(ui.boolByte(false))).toBe('00');
    expect(hexOf(ui.boolByte(true))).toBe('01');
    expect(hexOf(ui.enum8Tag({ a: 0, b: 4 }, 'b'))).toBe('04');
  });

  it('the totality split is mirrored: sentinel where types sentinels, throw where it throws', () => {
    // A mirror that threw where the node sentinels (or the reverse) would
    // diverge on exactly the malformed input a light client is handed
    // (TYPES_INTERFACE → Totality). Total writers absorb it into the
    // unreachable all-ones u64.
    const SENTINEL = 'ffffffffffffffffff01';
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(hexOf(ui.vlqU(bad)), `vlqU(${bad})`).toBe(SENTINEL);
    }
    // `vlqS`'s domain is wider on the negative side and narrower at the top:
    // ZigZag doubles the magnitude before the VLQ sees it, so −1 is faithful
    // while ±2^52 is not. Sharing `vlqU`'s list would assert the wrong domain.
    for (const bad of [NaN, Infinity, -Infinity, 1.5, 2 ** 52, -(2 ** 52) - 1]) {
      expect(hexOf(ui.vlqS(bad)), `vlqS(${bad})`).toBe(SENTINEL);
    }
    expect(hexOf(ui.lp(undefined as unknown as Uint8Array))).toBe(SENTINEL);
    expect(hexOf(ui.lpUtf8(undefined as unknown as string))).toBe(SENTINEL);
    expect(hexOf(ui.arr(undefined as unknown as number[], () => new Uint8Array()))).toBe(SENTINEL);
    expect(hexOf(ui.boolByte(undefined as unknown as boolean))).toBe('ff');
    expect(hexOf(ui.enum8Tag({ a: 0 }, 'nope'))).toBe('ff');
    // No unreachable sentinel exists for these, so they throw on both sides.
    expect(() => ui.vlqU64(1 as unknown as bigint)).toThrow();
    expect(() => ui.b32Bytes(new Uint8Array(31), 32)).toThrow();
    expect(() => ui.b32Bytes('ab'.repeat(32) as unknown as Uint8Array, 32)).toThrow();
    expect(() => ui.b32Hex('ab'.repeat(31), 32)).toThrow();
    expect(() => ui.b32Hex('AB'.repeat(32), 32)).toThrow();
  });
});

// ---------------------------------------------------------------------------

/**
 * Box and transaction encoding mirror. The UI's hand-written positional writers
 * must produce the same bytes as `@dagsocial/types` for every box type and every
 * transaction shape — otherwise every client-built box id (and every signed
 * txId) diverges from the node and the UI's transactions are simply rejected.
 */
describe('demo UI ↔ @dagsocial/types box encoding mirror (positional)', () => {
  it('the UI reproduces the frozen golden karma boxId', () => {
    expect(ui.computeBoxId(GOLDEN_KARMA_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('the UI reproduces the frozen golden credit boxId (value > 2^53)', () => {
    expect(ui.computeBoxId(GOLDEN_CREDIT_BOX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('types reproduces the same frozen golden box vectors', () => {
    // Pins both live implementations to the constants, not just to each other.
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('golden vector: the canonical box bytes are frozen on both sides', () => {
    // Field-by-field, which an id comparison cannot be: this says *which byte*.
    expect(hexOf(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE))).toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(canonicalBoxBytes(GOLDEN_CREDIT_CANDIDATE))).toBe(GOLDEN_CREDIT_BOX_BYTES);
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_CREDIT_CANDIDATE as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_CREDIT_BOX_BYTES);
  });

  it('the UI accepts hex-string binary fields identically (the tx-builder form)', () => {
    // The UI's tx builders pass `owner` as a hex string straight from state.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeBoxId(hexBox as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the tx-builder hex form encodes identically to the byte form (E3)',
    ({ box }) => {
      // The form that catches a byte field the UI converts differently: it would
      // write 64 bytes of ASCII where the node writes 32 raw, and every id
      // derived from that box diverges — while both sides' own tests still pass.
      expect(hexOf(ui.canonicalBoxBytes(toUiForm(box)))).toBe(hexOf(canonicalBoxBytes(box)));
      expect(ui.computeBoxId(toUiForm(box))).toBe(computeBoxId(box));
      // And the byte form, which is what a server-returned box carries.
      expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)))
        .toBe(hexOf(canonicalBoxBytes(box)));
    },
  );

  it('no guard string reaches the consensus bytes on either side', () => {
    // No box carries a guard field, and the layout is positional
    // (TYPES_INTERFACE → Layout — Boxes).
    // Both halves are pinned: no such string is in the bytes, *and* a stray
    // `guard` key attached to a box object moves no id — on either side.
    const bytes = hexOf(canonicalBoxBytes(GOLDEN_KARMA_CANDIDATE));
    expect(bytes).not.toContain(Buffer.from('owner_signature').toString('hex'));
    const withStrayKey = { ...GOLDEN_KARMA_BOX, guard: 'block_apply' as never };
    expect(ui.computeBoxId(withStrayKey as unknown as Record<string, unknown>))
      .toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(withStrayKey)).toBe(GOLDEN_KARMA_BOX_ID);
  });

  it('a stray key is unrepresentable — the encoder reads only what it declares', () => {
    // The positional encoder writes the fields its arm names and has no branch
    // that could write another, so a decoration a display path attaches cannot
    // enter the hash — no strip step stands between the box and its bytes.
    const decorated = {
      ...GOLDEN_KARMA_BOX, id: GOLDEN_KARMA_BOX_ID, createdAtBlock: 99, junk: 'x',
    };
    expect(hexOf(ui.canonicalBoxBytes(decorated as unknown as Record<string, unknown>)))
      .toBe(GOLDEN_KARMA_BOX_BYTES);
    expect(hexOf(canonicalBoxBytes(decorated as never))).toBe(GOLDEN_KARMA_BOX_BYTES);
  });

  it('the lp length ladder agrees across implementations at every VLQ width', () => {
    // `genesis_proof`'s `payload` is the one variable-length field any box arm
    // carries, so it is the only place inside a box where a length prefix can
    // change width. `lp` is VLQ-prefixed, so the rungs sit at 2^7 and 2^14
    // (TYPES_INTERFACE → Primitives). A width the two implementations disagreed
    // on shifts every following byte and moves the id.
    //
    // The arm is `enum8(3) ‖ vlqU64(0) ‖ lp(payload)`, so the prefix starts at
    // offset 2 and the three bytes read below are it plus the payload's first.
    const prefixAt = (b: Uint8Array): string => hexOf(b.subarray(2, 5));
    for (const [len, prefix] of [
      [127, '7f7878'], [128, '800178'], [16383, 'ff7f78'], [16384, '808001'],
    ] as Array<[number, string]>) {
      const box: CandidateOf<GenesisProofBox> = {
        boxType: 'genesis_proof',
        value: 0n,
        payload: new Uint8Array(len).fill(0x78),
      };
      const fromUi = ui.canonicalBoxBytes(box as unknown as Record<string, unknown>);
      const fromTypes = canonicalBoxBytes(box);
      expect(hexOf(fromUi), `len=${len}`).toBe(hexOf(fromTypes));
      expect(prefixAt(fromTypes), `len=${len}`).toBe(prefix);
    }
  });

  it('an out-of-domain box field has no encoding on EITHER side', () => {
    const short = { ...GOLDEN_KARMA_BOX, owner: new Uint8Array(31) };
    expect(() => canonicalBoxBytes(short as never)).toThrow();
    expect(() => ui.canonicalBoxBytes(short as unknown as Record<string, unknown>)).toThrow();
    for (const value of [-1n, 2n ** 64n]) {
      const bad = { ...GOLDEN_KARMA_BOX, value };
      expect(() => canonicalBoxBytes(bad as never), `value=${value}`).toThrow();
      expect(
        () => ui.canonicalBoxBytes(bad as unknown as Record<string, unknown>),
        `value=${value}`,
      ).toThrow();
    }
  });

  it('the tag is what separates a bond from any other box, on both sides', () => {
    // ⛔ **Tag 2 is unassigned and reserved** — `invite` held it and the type is
    // gone (TYPES_INTERFACE → InviteBox), so the pair this case used to compare
    // no longer exists. `enum8Tag` is still the whole of what keeps two leaves
    // apart, and asserting it on the UI side is what stops an encoder that
    // dropped the tag from giving two boxes with the same parties one id.
    const b = hexOf(canonicalBoxBytes(GOLDEN_BOND_BOX));
    const tagless = b.slice(2);
    for (const other of [GOLDEN_KARMA_BOX, GOLDEN_VOUCH_BOX, GOLDEN_POST_LOCK_BOX]) {
      expect(hexOf(canonicalBoxBytes(other))).not.toBe(b);
    }
    expect(b.slice(0, 2)).not.toBe('02');
    expect(tagless.length).toBeGreaterThan(0);
    expect(hexOf(ui.canonicalBoxBytes(GOLDEN_BOND_BOX as unknown as Record<string, unknown>))).toBe(b);
    // The tx-builder form carries keys as hex and must reach the same bytes —
    // otherwise a client-built invite derives ids the node never agrees with.
    expect(hexOf(ui.canonicalBoxBytes(toUiForm(GOLDEN_BOND_BOX)))).toBe(b);
    // A *missing* key is out of domain: a malformed box must not be handed a
    // well-formed box's id.
    const missing = { ...GOLDEN_BOND_BOX } as Partial<BondBox>;
    delete missing.inviteePublicKey;
    expect(() => canonicalBoxBytes(missing as never)).toThrow();
    expect(() => ui.canonicalBoxBytes(missing as unknown as Record<string, unknown>)).toThrow();
  });

  it('genesis_proof: the byte form encodes identically on both implementations', () => {
    // The page never builds one, and that is exactly why this is here: without
    // the tag and the arm, `enum8Tag` falls back to `0xff` and `boxTypeFields`
    // writes no tail, so the UI derives a **wrong id that looks well-formed**
    // rather than throwing. Two arms, because the length prefix is the whole of
    // `lp`'s injectivity and the empty payload is the smallest legal box.
    for (const payload of [new Uint8Array([0xde, 0xad, 0xbe, 0xef]), new Uint8Array(0)]) {
      const box: GenesisProofBox = {
        boxType: 'genesis_proof', value: 0n, payload,
        txId: COVERAGE_TX_ID, index: 5,
      };
      const label = `payload=${payload.length}`;
      expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)), label)
        .toBe(hexOf(canonicalBoxBytes(box)));
      expect(ui.computeBoxId(box as unknown as Record<string, unknown>), label)
        .toBe(computeBoxId(box));
    }
  });

  it('genesis_proof takes tag 3, on both implementations', () => {
    // The tag is the first byte of the id preimage, so a table that disagrees
    // with @dagsocial/types moves every id derived here.
    const box: GenesisProofBox = {
      boxType: 'genesis_proof', value: 0n, payload: new Uint8Array([0x01]),
      txId: COVERAGE_TX_ID, index: 5,
    };
    expect(hexOf(canonicalBoxBytes(box)).slice(0, 2)).toBe('03');
    expect(hexOf(ui.canonicalBoxBytes(box as unknown as Record<string, unknown>)).slice(0, 2))
      .toBe('03');
  });

  it('an unknown boxType takes the reserved 0xff tag rather than throwing', () => {
    // Total, and the reserved tag is what keeps a malformed box from colliding
    // with a well-formed one: no valid boxType is 0xff.
    const bogus = { ...GOLDEN_KARMA_BOX, boxType: 'like' };
    expect(hexOf(ui.canonicalBoxBytes(bogus as unknown as Record<string, unknown>))).toBe('ff64');
    expect(hexOf(canonicalBoxBytes(bogus as never))).toBe('ff64');
  });

  it('the UI reproduces the frozen golden txId (what signTxId signs)', () => {
    expect(ui.computeTxId(GOLDEN_UTXO_TX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(GOLDEN_UTXO_TX)).toBe(GOLDEN_UTXO_TX_ID);
  });

  it('the txId counts its entries — two output lists cannot concatenate alike (C1)', () => {
    // Box bytes are variable-length, so a concatenation with no count and no
    // length prefix lets two different output lists produce one byte string.
    // `arr()` writes the count, which is what makes the preimage injective
    // (TYPES_INTERFACE → Layout — UtxoTransaction).
    const one = { ...GOLDEN_UTXO_TX, outputs: [GOLDEN_KARMA_CANDIDATE] };
    const two = { ...GOLDEN_UTXO_TX, outputs: [GOLDEN_KARMA_CANDIDATE, GOLDEN_KARMA_CANDIDATE] };
    expect(ui.computeTxId(one as unknown as Record<string, unknown>))
      .not.toBe(ui.computeTxId(two as unknown as Record<string, unknown>));
    expect(ui.computeTxId(one as unknown as Record<string, unknown>)).toBe(computeTxId(one));
    expect(ui.computeTxId(two as unknown as Record<string, unknown>)).toBe(computeTxId(two));
  });

  it('a `preimages` key is not a field, and the page must not build one', () => {
    // ⛔ **THE NAME IS RESERVED AND NEVER TO BE REUSED** (TYPES_INTERFACE →
    // Layout — UtxoTransaction). It is outside the `TxId` preimage, so a builder
    // that emitted one would produce two byte strings carrying one id — the
    // malleability the closed envelope key set refuses.
    const withStray = { ...GOLDEN_UTXO_TX, preimages: { ab: 'cd' } } as Record<string, unknown>;
    // The node ignores it, because there is no such field to hash …
    expect(computeTxId(GOLDEN_UTXO_TX)).toBe(GOLDEN_UTXO_TX_ID);
    // … and the page must agree, on the transaction WITHOUT it.
    expect(ui.computeTxId(GOLDEN_UTXO_TX as unknown as Record<string, unknown>))
      .toBe(GOLDEN_UTXO_TX_ID);
    // A page hashing the stray key would disagree with the node here.
    expect(ui.computeTxId(withStray)).toBe(GOLDEN_UTXO_TX_ID);
  });
});

// ---------------------------------------------------------------------------

/**
 * Box-identity mirror. The derivation binds content *and* the position that
 * content was created at (NODE_INTERFACE → Box Identity and Mint Provenance):
 *
 *   blake2b512( BOX_ID_DOMAIN ‖ canonicalBoxBytes ‖ b32(txId) ‖ vlqU(index) )
 *
 * Provenance is structurally absent from `canonicalBoxBytes` and appended
 * afterwards rather than stripped before hashing, which is what keeps the
 * derivation non-circular without anyone having to remember a strip rule.
 */
describe('demo UI ↔ @dagsocial/types box identity mirror (Spec G phase E)', () => {
  const asUi = (box: object): Record<string, unknown> => box as unknown as Record<string, unknown>;

  it('the legacy boxId is unmoved by provenance on both sides', () => {
    expect(ui.computeBoxId(asUi(GOLDEN_KARMA_BOX))).toBe(GOLDEN_KARMA_BOX_ID);
    expect(computeBoxId(GOLDEN_KARMA_BOX)).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeBoxId(asUi(GOLDEN_CREDIT_BOX))).toBe(GOLDEN_CREDIT_BOX_ID);
    expect(computeBoxId(GOLDEN_CREDIT_BOX)).toBe(GOLDEN_CREDIT_BOX_ID);
  });

  it('the txId is unmoved by output provenance too — one encoder, two callers', () => {
    // types routes `computeTxId`'s outputs through `canonicalBoxBytes` for
    // exactly this reason; the UI does too, so a materialized output and the
    // candidate it came from hash the same.
    const tx: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      outputs: [GOLDEN_KARMA_BOX, GOLDEN_CREDIT_BOX],
    };
    expect(ui.computeTxId(asUi(tx))).toBe(GOLDEN_UTXO_TX_ID);
    expect(computeTxId(tx)).toBe(GOLDEN_UTXO_TX_ID);
  });

  it('the UI computeCandidateBoxId matches types on the golden vectors', () => {
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_CREDIT_BOX), GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
    expect(computeCandidateBoxId(GOLDEN_CREDIT_BOX, GOLDEN_UTXO_TX_ID, 1))
      .toBe(GOLDEN_CREDIT_CANDIDATE_ID);
  });

  it('a stored box re-derives its own id — the derivation is total over both forms', () => {
    // What a light client does: take a box off the wire, re-derive from its own
    // provenance.
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it('the derivation is not the legacy one — the tag and provenance both bind', () => {
    // There is no second derivation to differ from: `computeBoxId` IS
    // `computeCandidateBoxId` applied to the box's own provenance — on BOTH
    // sides — so these must be EQUAL, and the mirror is what proves the client
    // collapsed them the same way the node did.
    expect(GOLDEN_KARMA_CANDIDATE_ID).toBe(GOLDEN_KARMA_BOX_ID);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_CANDIDATE), GOLDEN_UTXO_TX_ID, 0))
      .toBe(ui.computeBoxId(asUi(GOLDEN_KARMA_BOX)));
  });

  it('both txId and index enter the derivation', () => {
    const otherTx = '9'.repeat(64);
    const ids = [
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 1),
      ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), otherTx, 0),
    ];
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, otherTx, 0));
  });

  it('the page predicts a change box id the way types computes it', () => {
    // The chaining the page does rests entirely on this equality: it spends the
    // change of its own pending transaction, so the id it predicts must be the
    // id block application materializes. A mirror that drifted here would have
    // the page spending a box that never exists.
    const karmaBox = {
      total: 100n,
      boxes: [{ boxId: 'a1'.repeat(32), value: 100n }],
    };
    const pubKeyHex = '02'.repeat(32);
    const targetPostId = '11'.repeat(32);

    for (const tx of [
      ui.buildLikeTx(karmaBox, targetPostId, pubKeyHex),
      ui.buildPostTx(karmaBox, 5n, GOLDEN_POST_HEX_AUTHOR, pubKeyHex),
    ]) {
      const asTx = tx as unknown as Record<string, unknown>;
      const txId = computeTxId(jsonToTx(JSON.parse(JSON.stringify(asTx, ui.jsonBigint))));
      for (let i = 0; i < (tx.outputs as unknown[]).length; i++) {
        expect(ui.predictOutputBoxId(asTx, i)).toBe(
          computeCandidateBoxId(
            jsonToTx(JSON.parse(JSON.stringify(asTx, ui.jsonBigint))).outputs[i]!,
            txId,
            i,
          ),
        );
      }
    }
  });

  it('the page spends its own pending change, not the box it just spent', () => {
    // The production incident in one assertion: a post's lock and a like on it,
    // both built from `GET /karma`, both naming the confirmed box — one block,
    // and the second cannot apply. The page carries its own change forward, so
    // the second transaction chains onto the first.
    ui.pendingKarmaChange.clear();
    const pubKeyHex = '02'.repeat(32);
    const confirmed = { boxId: 'a1'.repeat(32), value: 100n };

    const lock = ui.buildPostTx(
      { total: 100n, boxes: [{ ...confirmed }] }, 5n, GOLDEN_POST_HEX_AUTHOR, pubKeyHex,
    );
    ui.recordPendingKarmaChange(lock as unknown as Record<string, unknown>);

    // The lock has not landed, so the server still answers with the box it spends.
    const view = ui.applyPendingKarmaChange({ total: 100n, boxes: [{ ...confirmed }] });
    const changeId = ui.predictOutputBoxId(lock as unknown as Record<string, unknown>, 0);
    expect(view.boxes.map(b => b.boxId)).toEqual([changeId]);
    expect(view.total).toBe(95n);

    const like = ui.buildLikeTx(view, '22'.repeat(32), pubKeyHex);
    expect(like.inputs).toEqual([changeId]);
    expect(like.inputs).not.toContain(confirmed.boxId);
  });

  it('a chain of three carries the whole way forward', () => {
    ui.pendingKarmaChange.clear();
    const pubKeyHex = '02'.repeat(32);
    const confirmed = { boxId: 'b1'.repeat(32), value: 100n };
    let view: KarmaView = { total: 100n, boxes: [{ ...confirmed }] };

    for (let i = 0; i < 3; i++) {
      const tx = ui.buildLikeTx(view, '33'.repeat(32), pubKeyHex);
      ui.recordPendingKarmaChange(tx as unknown as Record<string, unknown>);
      view = ui.applyPendingKarmaChange({ total: 100n, boxes: [{ ...confirmed }] });
    }

    // Three likes at 1 karma each, all still pending against one confirmed box.
    expect(view.total).toBe(97n);
    expect(view.boxes).toHaveLength(1);
  });

  it('forgets a pending change once the server reports it confirmed', () => {
    ui.pendingKarmaChange.clear();
    const pubKeyHex = '02'.repeat(32);
    const confirmed = { boxId: 'c1'.repeat(32), value: 100n };

    const tx = ui.buildLikeTx({ total: 100n, boxes: [{ ...confirmed }] }, '44'.repeat(32), pubKeyHex);
    ui.recordPendingKarmaChange(tx as unknown as Record<string, unknown>);
    const changeId = ui.predictOutputBoxId(tx as unknown as Record<string, unknown>, 0);

    // The block landed: the server now reports the change box itself.
    const view = ui.applyPendingKarmaChange({ total: 99n, boxes: [{ boxId: changeId, value: 99n }] });

    expect(view.boxes.map(b => b.boxId)).toEqual([changeId]);
    expect(view.total).toBe(99n);
    expect(ui.pendingKarmaChange.size).toBe(0);
  });

  it('leaves a box no pending transaction spends untouched', () => {
    ui.pendingKarmaChange.clear();
    const untouched = { boxId: 'd1'.repeat(32), value: 42n };

    const view = ui.applyPendingKarmaChange({ total: 42n, boxes: [{ ...untouched }] });

    expect(view.boxes).toEqual([untouched]);
    expect(view.total).toBe(42n);
  });

  it('the predicted id moves with the transaction it is predicted from', () => {
    // One byte of difference in the spending transaction, and the change box is
    // a different box. This is what makes the prediction safe to chain on: it
    // cannot silently name some other transaction's output.
    const pubKeyHex = '02'.repeat(32);
    const a = ui.buildLikeTx(
      { total: 100n, boxes: [{ boxId: 'a1'.repeat(32), value: 100n }] },
      '11'.repeat(32), pubKeyHex,
    ) as unknown as Record<string, unknown>;
    const b = ui.buildLikeTx(
      { total: 100n, boxes: [{ boxId: 'a2'.repeat(32), value: 100n }] },
      '11'.repeat(32), pubKeyHex,
    ) as unknown as Record<string, unknown>;

    expect(ui.predictOutputBoxId(a, 0)).not.toBe(ui.predictOutputBoxId(b, 0));
  });

  it('a wide index agrees byte for byte across implementations', () => {
    // 0x12345678 needs five VLQ bytes, so a mirror that stopped at one
    // continuation byte fails here even though it agrees on index 0 — the index
    // every mint and most single-output transactions use.
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 0x12345678))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID_WIDE_INDEX);
  });

  it('a malformed index derives the sentinel id rather than throwing (M-5)', () => {
    // `index` is `vlqU`, which is total: the encodable domain is the
    // non-negative safe integers, so the all-ones u64 stays unreachable from a
    // valid index and a malformed one cannot impersonate a valid one.
    //
    // 0xffffffff and 2^32 are deliberately absent from this list. Both are
    // inside `vlqU`'s domain and encode faithfully, so they are valid indices
    // rather than sentinel cases — the assertion below pins that.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
      expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, bad), `index=${bad}`)
        .toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    }
    // …and 2^32 is a real index, distinct from the sentinel.
    expect(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32))
      .not.toBe(GOLDEN_KARMA_CANDIDATE_ID_SENTINEL);
    expect(ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), GOLDEN_UTXO_TX_ID, 2 ** 32))
      .toBe(computeCandidateBoxId(GOLDEN_KARMA_BOX, GOLDEN_UTXO_TX_ID, 2 ** 32));
  });

  it('txId enters as 32 RAW bytes — an out-of-domain txId has no encoding at all', () => {
    // `b32` decodes the hex text to 32 raw bytes, and its domain is 64
    // LOWERCASE hex characters. `AB…` and `ab…` name one transaction, so an
    // encoding that admitted both would give that transaction two ids; here the
    // uppercase spelling has no encoding at all, and the ambiguity is
    // unconstructible rather than merely distinguished.
    //
    // The cost is stated where it is paid: derivation is NOT total on an
    // attacker-supplied txId, so every call site must establish the domain. Every
    // txId reaching here is a blake2b digest rendered lowercase, by construction.
    for (const weird of [GOLDEN_UTXO_TX_ID.toUpperCase(), '', 'abc', 'zz', 'ab'.repeat(31)]) {
      expect(() => computeCandidateBoxId(GOLDEN_KARMA_BOX, weird, 0), `types txId=${weird}`)
        .toThrow();
      expect(() => ui.computeCandidateBoxId(asUi(GOLDEN_KARMA_BOX), weird, 0), `ui txId=${weird}`)
        .toThrow();
    }
  });

  it('the UI accepts hex-string binary fields identically here too', () => {
    // The tx-builder form: `owner` arrives as hex from state, not as bytes.
    const hexBox = { ...GOLDEN_KARMA_BOX, owner: Buffer.from(GOLDEN_AUTHOR).toString('hex') };
    expect(ui.computeCandidateBoxId(asUi(hexBox), GOLDEN_UTXO_TX_ID, 0))
      .toBe(GOLDEN_KARMA_CANDIDATE_ID);
  });

  it.each(ALL_BOX_TYPES)(
    '$name: the provenance derivation agrees in both forms (E3)',
    ({ box }) => {
      const expected = computeCandidateBoxId(box, GOLDEN_UTXO_TX_ID, 3);
      expect(ui.computeCandidateBoxId(toUiForm(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
      expect(ui.computeCandidateBoxId(asUi(box), GOLDEN_UTXO_TX_ID, 3)).toBe(expected);
    },
  );
});

// ---------------------------------------------------------------------------

/**
 * likeTarget tail mirror. The like transaction's target sits inside the
 * `computeTxId` preimage as `opt(likeTarget, b32)` (TYPES_INTERFACE → Layout —
 * UtxoTransaction), so the signature covers the target and a
 * relay cannot re-point a like. The UI signs what it builds, so a mirror that
 * dropped the tail (or gated it on truthiness) would sign ids the node never
 * computes, and every like from the demo UI would be rejected.
 */
describe('demo UI ↔ @dagsocial/types likeTarget tail mirror (P2-D)', () => {
  const asUi = (tx: object): Record<string, unknown> => tx as unknown as Record<string, unknown>;

  // Measured from @dagsocial/types computeTxId — both implementations pin to
  // constants, not just to each other.
  const GOLDEN_LIKE_TX_ID =
    '129c319acce167afb58cafa8fbe9314e575319b000897cf3173460c36f6121ea';

  const GOLDEN_LIKE_TX: UtxoTransaction = {
    ...GOLDEN_UTXO_TX,
    likeTarget: GOLDEN_POST_TX_ID,
  };

  it('the UI reproduces the frozen likeTarget-bearing txId', () => {
    expect(ui.computeTxId(asUi(GOLDEN_LIKE_TX))).toBe(GOLDEN_LIKE_TX_ID);
    expect(computeTxId(GOLDEN_LIKE_TX)).toBe(GOLDEN_LIKE_TX_ID);
  });

  it('absence appends nothing but the tag — the un-targeted tx keeps its id', () => {
    expect(ui.computeTxId(asUi(GOLDEN_UTXO_TX))).toBe(GOLDEN_UTXO_TX_ID);
    expect(GOLDEN_LIKE_TX_ID).not.toBe(GOLDEN_UTXO_TX_ID);
  });

  it('an empty-string target has no encoding — the truthiness trap is gone', () => {
    // `opt` distinguishes presence from absence by a tag byte, so presence is
    // `!== undefined` and never truthiness — but `''` does not reach that
    // question at all, because it is out of the `b32` domain and has no
    // encoding. A truthiness trap is unconstructible here rather than handled.
    const emptyTarget: UtxoTransaction = { ...GOLDEN_UTXO_TX, likeTarget: '' };
    expect(() => computeTxId(emptyTarget)).toThrow();
    expect(() => ui.computeTxId(asUi(emptyTarget))).toThrow();
  });

  it('the target binds — re-pointing the like moves the id identically on both sides', () => {
    const repointed: UtxoTransaction = {
      ...GOLDEN_UTXO_TX,
      likeTarget: '2222222222222222222222222222222222222222222222222222222222222222',
    };
    const uiId = ui.computeTxId(asUi(repointed));
    expect(uiId).not.toBe(GOLDEN_LIKE_TX_ID);
    expect(uiId).toBe(computeTxId(repointed));
  });
});

// ---------------------------------------------------------------------------
// The post-id index writer
//
// Reserved, never to be reused: the post-PoW nonce tail and the PoW predicate
// suites (`powNonceTail`, `postPowHash`, `powTarget`, `meetsPowTarget`). There
// is no post PoW. What the id derivation needs from the page instead is `u32BE`,
// and it is total on both sides for the same M-5 reason the nonce tail was.
// ---------------------------------------------------------------------------

describe('demo UI ↔ @dagsocial/types u32BE', () => {
  // Including the out-of-domain sentinel, because the writer is total on both
  // sides and several out-of-domain indices sharing one encoding is a property,
  // not an accident.
  const FROZEN = [0, 1, 127, 128, 65535, 65536, 0xfffffffe, -1, 1.5, NaN, 2 ** 40];

  it.each(FROZEN)('u32BE(%p) is byte-identical to the types writer', (n) => {
    expect(hexOf(ui.u32BE(n))).toBe(hexOf(u32BE(n)));
  });

  it('computePostId reaches that writer, not a second copy of it', () => {
    // The id's index row must move with `u32BE`. Both sides read their own
    // writer, so neither can drift from the other.
    expect(hexOf(ui.u32BE(0))).toBe(hexOf(u32BE(0)));
    expect(ui.computePostId(GOLDEN_POST_TX_ID, 0))
      .toBe(computePostId(GOLDEN_POST_TX_ID, 0));
  });

  it('the id is total on a malformed txId on both sides', () => {
    // `utf8(txId)` rather than a hex decode, so a light client deriving from
    // attacker-supplied fields gets a wrong id rather than an exception.
    for (const bad of ['', 'zz', 'AB'.repeat(32)]) {
      expect(ui.computePostId(bad, 0)).toBe(computePostId(bad, 0));
    }
  });
});

// ---------------------------------------------------------------------------
// Completeness audit — a mirror's coverage is a claim about a LIST
// ---------------------------------------------------------------------------

/**
 * Byte construction in `index.html` must sit inside something the mirror evaluates.
 *
 * Adding a name to `MIRRORED_OTHER` fixes one omission. This re-derives the list
 * instead, because the defect's shape is *a list nobody re-derives*: a
 * consensus-critical function the list does not name is unpinned, and its
 * absence signals nothing — the whole suite stays green (WEB_INTERFACE, the
 * mirror-coverage warning).
 *
 * ⚠ **This narrows the class; it does not close it.** The audit keys on a
 * VOCABULARY drawn from `BYTE_PRIMITIVES`. Byte assembly written without any of
 * those names — a bare `new Uint8Array([…])`, a hand-rolled push loop, a DataView
 * write — is invisible to it. Nor can it see a function that calls a *mirrored*
 * builder with the wrong arguments: it sees construction, not correctness. A reader
 * who takes the vocabulary for the whole class repeats the mistake one level down.
 */
const AUDIT_VOCABULARY: readonly string[] = [
  ...BYTE_PRIMITIVES,
  'blake2b', 'concatUint8Arrays', 'encoder.encode',
];

/**
 * Scopes that construct bytes and are deliberately not mirrored — one line of reason
 * each, and none of them the post-PoW tail. An entry is an admission, not a
 * clearance: `signPost`'s own reason names a digest line this suite does not pin,
 * so read each reason for what it concedes rather than treating the list as a
 * second column of coverage.
 */
const AUDIT_ALLOW: Record<string, string> = {
  attachFeedHandlers:
    'hashes a server-issued challenge before Ed25519 signing — it takes no layout decision',
};

interface Scope { name: string; start: number; end: number; }
interface Finding { scope: string; token: string; line: number; }

/** Blank comments and string/template bodies, preserving every offset. */
function maskSource(s: string): string {
  const out = s.split('');
  let i = 0;
  let state: 'line' | 'block' | 'str' | null = null;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (state === 'line') { if (ch === '\n') state = null; else out[i] = ' '; i++; continue; }
    if (state === 'block') {
      if (ch === '*' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = null; continue; }
      if (ch !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (state === 'str') {
      if (ch === '\\') { out[i] = ' '; if (s[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
      if (ch === quote) { state = null; quote = null; i++; continue; }
      if (ch !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (ch === '/' && next === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; continue; }
    if (ch === '/' && next === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { out[i] = ' '; quote = ch; state = 'str'; i++; continue; }
    i++;
  }
  return out.join('');
}

/** End offset (exclusive) of the block opened by the first `{` at or after `from`. */
function blockEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = masked.indexOf('{', from); i < masked.length && i !== -1; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  throw new Error(`unterminated block at offset ${from}`);
}

/**
 * Every scope a byte site can be attributed to, innermost-first at use.
 *
 * Three shapes, because two of them are the blind spots of the first: a declared
 * function, a function or arrow bound to a name, and an inline DOM handler — which
 * has no name of its own, so it takes the element id and event as its address.
 */
function namedScopes(src: string, masked: string): Scope[] {
  const scopes: Scope[] = [];
  for (const m of masked.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g)) {
    scopes.push({ name: m[1]!, start: m.index, end: blockEnd(masked, m.index) });
  }
  const bound = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/g;
  for (const m of masked.matchAll(bound)) {
    scopes.push({ name: m[1]!, start: m.index, end: blockEnd(masked, m.index) });
  }
  // Matched on the raw source: a handler's address is its element id and event, and
  // both are string literals, which `maskSource` blanks. Offsets are preserved, so
  // requiring the call itself to survive masking is what keeps a commented-out
  // registration from registering a scope.
  const handler = /getElementById\(\s*'([A-Za-z0-9_]+)'\s*\)\s*\.addEventListener\(\s*'([a-z]+)'\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const m of src.matchAll(handler)) {
    if (!masked.startsWith('getElementById', m.index)) continue;
    scopes.push({ name: `${m[1]!}#${m[2]!}`, start: m.index, end: blockEnd(masked, m.index) });
  }
  return scopes;
}

/** The single-statement scope of a top-level `const NAME = …` initialiser. */
function constInitScopes(masked: string): Scope[] {
  const scopes: Scope[] = [];
  for (const m of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)) {
    const nl = masked.indexOf('\n', m.index);
    scopes.push({ name: m[1]!, start: m.index, end: nl === -1 ? masked.length : nl });
  }
  return scopes;
}

function auditByteConstruction(): { findings: Finding[]; unattributed: Finding[] } {
  const src = readFileSync(INDEX_HTML, 'utf8');
  const masked = maskSource(src);
  const scopes = namedScopes(src, masked);
  const consts = constInitScopes(masked);
  const lineOf = (off: number): number => masked.slice(0, off).split('\n').length;

  const findings: Finding[] = [];
  const unattributed: Finding[] = [];
  for (const token of AUDIT_VOCABULARY) {
    const re = new RegExp(`(?<![A-Za-z0-9_$.])${token.replace('.', '\\.')}\\s*\\(`, 'g');
    for (const m of masked.matchAll(re)) {
      const off = m.index;
      const inner = scopes
        .filter((s) => off > s.start && off < s.end)
        .sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .pop();
      if (inner) {
        // A declaration's own header is not a call site of itself.
        if (inner.name === token && off === inner.start + 'function '.length) continue;
        findings.push({ scope: inner.name, token, line: lineOf(off) });
        continue;
      }
      const asConst = consts.find((c) => off > c.start && off < c.end);
      if (asConst) { findings.push({ scope: asConst.name, token, line: lineOf(off) }); continue; }
      unattributed.push({ scope: '<no named scope>', token, line: lineOf(off) });
    }
  }
  return { findings, unattributed };
}

describe('demo UI vouch builders ↔ the id the node derives', () => {
  // The page carries hex where the node carries bytes, so the two only agree if
  // the JSON edge converts before the preimage. `canonicalBoxBytes` is pinned
  // hex-vs-byte per box type above; this pins the same property one level up, at
  // `computeTxId` — the hash a vouch signature is actually over. Transitivity
  // through the box encoder would give the same answer today and is not the
  // thing that has to keep holding.

  const VOUCHER_HEX = Buffer.from(GOLDEN_AUTHOR).toString('hex');
  const TARGET_HEX = 'c3'.repeat(32);

  /** What `fetchKarmaBox()` hands a builder. */
  const karmaState = (values: bigint[]) => ({
    total: values.reduce((sum, v) => sum + v, 0n),
    boxes: values.map((value, i) => ({ boxId: String(i).padStart(2, '0').repeat(32), value })),
  });

  /** The tx as it arrives server-side: through the page's own bigint replacer. */
  const overTheWire = (tx: Record<string, unknown>) =>
    jsonToTx(JSON.parse(JSON.stringify(tx, ui.jsonBigint)) as Record<string, unknown>);

  it('the page mirrors the vouch amount constants it stakes against', () => {
    // Mirrored by hand from `@dagsocial/types`, so nothing but this compares
    // them. A drifted stake builds a tx `checkTransitions` rejects outright.
    expect(ui.VOUCH_KARMA_AMOUNT).toBe(VOUCH_KARMA_AMOUNT);
    expect(ui.VOUCH_MIN_BALANCE).toBe(VOUCH_MIN_BALANCE);
  });

  it('a cast the page builds hashes to the same txId the node derives', () => {
    const tx = ui.buildVouchTx(karmaState([VOUCH_MIN_BALANCE + 1n]), TARGET_HEX, VOUCHER_HEX);
    expect(ui.computeTxId(tx)).toBe(computeTxId(overTheWire(tx)));
  });

  it('an unvouch the page builds hashes to the same txId the node derives', () => {
    const tx = ui.buildUnvouchTx('ab'.repeat(32));
    expect(ui.computeTxId(tx)).toBe(computeTxId(overTheWire(tx)));
  });

  it('the cast carries the shape consensus pins', () => {
    // NODE_INTERFACE → "Vouch transition rules": one karma output plus one
    // vouch output, the stake exactly `VOUCH_KARMA_AMOUNT`, `voucherId` the
    // karma input's owner. A cast missing any of the three is rejected, and the
    // page is the only producer of this shape.
    const tx = ui.buildVouchTx(karmaState([7n, 5n]), TARGET_HEX, VOUCHER_HEX);
    const decoded = overTheWire(tx);
    const [change, vouch] = decoded.outputs as [KarmaBox, VouchBox];

    expect(decoded.outputs).toHaveLength(2);
    expect(change.boxType).toBe('karma');
    expect(vouch.boxType).toBe('vouch');
    expect(vouch.value).toBe(VOUCH_KARMA_AMOUNT);
    expect(Buffer.from(vouch.voucherId).toString('hex')).toBe(VOUCHER_HEX);
    expect(Buffer.from(vouch.targetId).toString('hex')).toBe(TARGET_HEX);
    expect(Buffer.from(change.owner).toString('hex')).toBe(VOUCHER_HEX);
    expect(decoded.protocolVersion).toBe(PROTOCOL_VERSION);

    // Conservation, over exactly the boxes named as inputs: one karma box
    // covers the 1-karma stake, so the second is not selected and its value is
    // not in the sum.
    expect(decoded.inputs).toEqual([karmaState([7n, 5n]).boxes[0]!.boxId]);
    expect(change.value + vouch.value).toBe(7n);
  });

  it('the unvouch spends one named box and produces nothing', () => {
    // Zero outputs is the shape: the stake is escrowed and re-minted at cooldown
    // maturity, so a change output here would be the same karma twice.
    const decoded = overTheWire(ui.buildUnvouchTx('ab'.repeat(32)));
    expect(decoded.inputs).toEqual(['ab'.repeat(32)]);
    expect(decoded.outputs).toEqual([]);
  });
});

describe('demo UI invite builder ↔ the id the node derives', () => {
  // ⛔ **ONE builder, because there is one transaction** — `buildClaimInviteTx`
  // and `buildCancelInviteTx` go with the transitions they built
  // (ARCHITECTURE → Invite System). The page is its only producer, and it is
  // rejected outright if it carries a field the box schema does not declare or
  // a value the transition arm does not admit. The txId assertion pins the same
  // hex-vs-byte boundary the vouch group pins, one level up from
  // `canonicalBoxBytes`; the shape assertions pin what `checkTransitions`
  // requires.

  const INVITER_HEX = Buffer.from(GOLDEN_AUTHOR).toString('hex');
  const INVITEE_HEX = 'd4'.repeat(32);

  /** What `fetchKarmaBox()` hands a builder. */
  const karmaState = (values: bigint[]) => ({
    total: values.reduce((sum, v) => sum + v, 0n),
    boxes: values.map((value, i) => ({ boxId: String(i).padStart(2, '0').repeat(32), value })),
  });

  /** The tx as it arrives server-side: through the page's own bigint replacer. */
  const overTheWire = (tx: Record<string, unknown>) =>
    jsonToTx(JSON.parse(JSON.stringify(tx, ui.jsonBigint)) as Record<string, unknown>);

  it('the page mirrors the two invite amounts by hand, so nothing but this compares them', () => {
    // A drifted bond builds an invite `checkTransitions` rejects. The grant
    // amount is the settlement's and the page never builds it — it is mirrored
    // so the page can show what an invitee will receive.
    expect(ui.INVITE_BOND_KARMA).toBe(INVITE_BOND_KARMA);
    expect(ui.INVITE_KARMA_AMOUNT).toBe(INVITE_KARMA_AMOUNT);
  });

  it('a create the page builds hashes to the same txId the node derives', () => {
    const tx = ui.buildCreateInviteTx(
      karmaState([INVITE_BOND_KARMA + 1n]), INVITER_HEX, INVITEE_HEX,
    );
    expect(ui.computeTxId(tx)).toBe(computeTxId(overTheWire(tx)));
  });

  it('the invite deducts the bond and only the bond', () => {
    // ⛔ **`INVITE_KARMA_AMOUNT` comes out of the POOL at settlement**, so it
    // never leaves the inviter's balance (ARCHITECTURE → Invite System).
    // Selecting exactly bond + grant is what makes the difference visible:
    // paying both would leave no change at all.
    const funded = INVITE_BOND_KARMA + INVITE_KARMA_AMOUNT;
    const decoded = overTheWire(
      ui.buildCreateInviteTx(karmaState([funded]), INVITER_HEX, INVITEE_HEX),
    );
    const [change, bond] = decoded.outputs as [KarmaBox, BondBox];

    expect(change.value).toBe(funded - INVITE_BOND_KARMA);
    expect(change.value).not.toBe(0n);
    // The invite conserves like any other transaction.
    expect(change.value + bond.value).toBe(funded);
  });

  it('the invite carries the shape consensus pins', () => {
    // NODE_INTERFACE → the transition table's invite row: one karma + one bond,
    // the bond holding exactly `INVITE_BOND_KARMA` and carrying the karma
    // input's owner as `inviterId`.
    const decoded = overTheWire(
      ui.buildCreateInviteTx(karmaState([40n, 30n]), INVITER_HEX, INVITEE_HEX),
    );
    const [change, bond] = decoded.outputs as [KarmaBox, BondBox];

    expect(decoded.outputs).toHaveLength(2);
    expect(bond.value).toBe(INVITE_BOND_KARMA);
    expect(Buffer.from(change.owner).toString('hex')).toBe(INVITER_HEX);
    expect(Buffer.from(bond.inviterId).toString('hex')).toBe(INVITER_HEX);
    expect(Buffer.from(bond.inviteePublicKey).toString('hex')).toBe(INVITEE_HEX);
    expect(decoded.protocolVersion).toBe(PROTOCOL_VERSION);

    // The first box covers the bond on its own, so the second is not selected
    // and its value is not in the sum.
    expect(decoded.inputs).toEqual([karmaState([40n, 30n]).boxes[0]!.boxId]);
    expect(change.value + bond.value).toBe(40n);

    // The per-boxType output shape is CLOSED — a key it does not declare is a
    // rejection, not a spare field. `bond` declares exactly `boxType`, `value`,
    // `inviterId` and `inviteePublicKey`.
    for (const dead of [
      'secretHash', 'inviteOutputIndex', 'probationStartBlock', 'probationEndBlock',
    ]) {
      expect((bond as unknown as Record<string, unknown>)[dead], dead).toBeUndefined();
    }
  });

});

describe('demo UI byte-construction completeness audit', () => {
  const { findings, unattributed } = auditByteConstruction();
  const covered = (scope: string): boolean =>
    MIRRORED_FUNCTIONS.includes(scope)
    || (MIRRORED_CONSTS as readonly string[]).includes(scope)
    || scope in AUDIT_ALLOW;

  it('finds byte construction at all — a vocabulary that matches nothing proves nothing', () => {
    expect(findings.length).toBeGreaterThan(20);
    expect(new Set(findings.map((f) => f.scope)).size).toBeGreaterThan(10);
  });

  it('every byte-constructing scope is mirrored or allow-listed', () => {
    const unexplained = findings
      .filter((f) => !covered(f.scope))
      .map((f) => `${f.scope} — ${f.token}( at index.html:${f.line}`);
    expect([...new Set(unexplained)]).toEqual([]);
  });

  it('no byte construction sits outside every named scope', () => {
    // An anonymous site has no stable address, so it cannot be allow-listed either.
    // The fix for one is to give it a name.
    expect(unattributed.map((f) => `${f.token}( at index.html:${f.line}`)).toEqual([]);
  });

  it('solvePoW constructs no bytes', () => {
    // Named on purpose. It is the site this audit exists to cover, so exempting it
    // would have been the audit's first act — the extraction is what keeps the
    // allow-list honest rather than self-serving.
    // `solvePoW` is gone with post PoW, so it can construct nothing.
    expect(MIRRORED_FUNCTIONS).not.toContain('solvePoW');
    expect(findings.filter((f) => f.scope === 'solvePoW')).toEqual([]);
  });

  it('the allow-list carries a reason per entry and no dead entries', () => {
    for (const [scope, reason] of Object.entries(AUDIT_ALLOW)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(findings.some((f) => f.scope === scope)).toBe(true);
    }
  });

  it('the mirror still names the payload encoder and the index writer', () => {
    // ⛔ The successors to the PoW tail/hash/predicate row. These four names are
    // what the post path now depends on, and a mirror that stopped extracting
    // one of them would silently stop comparing it.
    for (const name of ['postFieldBytes', 'computePostId', 'u32BE', 'buildPostTx']) {
      expect(MIRRORED_FUNCTIONS).toContain(name);
      expect(RETURNED as readonly string[]).toContain(name);
    }
    expect(typeof ui.postFieldBytes).toBe('function');
    expect(typeof ui.computePostId).toBe('function');
    expect(typeof ui.u32BE).toBe('function');
    expect(typeof ui.buildPostTx).toBe('function');
  });
});
