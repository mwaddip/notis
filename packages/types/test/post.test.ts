import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computePostId,
  computeContentHash,
  postFieldBytes,
  POST_TYPE,
} from '../src/post.js';
import type { PostCommit } from '../src/post.js';
import { computeTxId } from '../src/utxo.js';
import type { UtxoTransaction } from '../src/utxo.js';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  INVITE_BOND_MIN,
  INVITE_BOND_MAX,
  INVITE_PROBATION_BLOCKS,
  INVITE_BOND_VEST_PER_LIKES,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_MINER_REWARD_DELAY,
  COINBASE_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '../src/constants.js';
import type { Post } from '../src/post.js';

const commit: PostCommit = {
  contentHash: computeContentHash('hello world'),
  author: new Uint8Array(32).fill(0x11),
  parentRefs: [],
  protocolVersion: 2,
  type: 'regular',
};

const TX_A = 'aa'.repeat(32);
const TX_B = 'bb'.repeat(32);

describe('post identity', () => {
  it('computePostId is deterministic', () => {
    expect(computePostId(TX_A, 0)).toBe(computePostId(TX_A, 0));
  });

  it('⛔ takes no Post at all — the id is a function of the transaction only', () => {
    const other: PostCommit = { ...commit, contentHash: computeContentHash('completely different') };
    expect(postFieldBytes(commit)).not.toEqual(postFieldBytes(other));
    expect(computePostId(TX_A, 0)).toBe(computePostId(TX_A, 0));
    expect(computePostId(TX_A, 0)).not.toBe(computePostId(TX_B, 0));
  });

  it('changes with index', () => {
    // `index` is 0 for every post today (one post per transaction), but it is a
    // real parameter and must be in the preimage — otherwise the rule "one post
    // per transaction" would be load-bearing rather than stated.
    expect(computePostId(TX_A, 0)).not.toBe(computePostId(TX_A, 1));
  });

  it('returns a hex string', () => {
    const id = computePostId(TX_A, 0);
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('takes txId as UTF-8 hex TEXT, not decoded bytes', () => {
    // TYPES_INTERFACE → Pinned byte forms. A standalone derivation hashes the
    // hex text; the decoded-bytes form belongs to the positional encoders. The
    // two are distinguishable, so this is a real pin and not a restatement.
    const indexBytes = Buffer.alloc(4);
    const asText = createHash('blake2b512')
      .update(new TextEncoder().encode('dagsocial/post-id/1'))
      .update(new TextEncoder().encode(TX_A))
      .update(indexBytes)
      .digest().subarray(0, 32).toString('hex');
    const asBytes = createHash('blake2b512')
      .update(new TextEncoder().encode('dagsocial/post-id/1'))
      .update(Buffer.from(TX_A, 'hex'))
      .update(indexBytes)
      .digest().subarray(0, 32).toString('hex');
    expect(computePostId(TX_A, 0)).toBe(asText);
    expect(computePostId(TX_A, 0)).not.toBe(asBytes);
  });

  it('is TOTAL on a malformed txId — a light client derives from untrusted fields', () => {
    // The reason the text form is chosen. `Buffer.from(x, 'hex')` on a
    // malformed id would throw or silently truncate; UTF-8 encoding cannot.
    for (const bad of ['', 'zz', 'AB'.repeat(32), 'a'.repeat(63)]) {
      expect(() => computePostId(bad, 0)).not.toThrow();
    }
    // …and `index` is total by sentinel, like every other numeric writer here.
    for (const bad of [NaN, -1, 1.5, 2 ** 40]) {
      expect(() => computePostId(TX_A, bad)).not.toThrow();
    }
  });

  it('the payload reaches the id THROUGH the transaction — the chain, end to end', () => {
    const base: UtxoTransaction = {
      inputs: ['01'.repeat(32)],
      outputs: [],
      signatures: {},
      protocolVersion: 1,
    };
    const txWithPost: UtxoTransaction = { ...base, post: commit };
    const txWithOther: UtxoTransaction = { ...base, post: { ...commit, contentHash: computeContentHash('other') } };

    expect(computeTxId(txWithPost)).not.toBe(computeTxId(txWithOther));
    expect(computePostId(computeTxId(txWithPost), 0))
      .not.toBe(computePostId(computeTxId(txWithOther), 0));

    expect(computeTxId(txWithPost)).not.toBe(computeTxId(base));
  });

  it('two byte-identical payloads in one block get DIFFERENT ids (spec §7)', () => {
    const identical: PostCommit = { ...commit };
    const tx1: UtxoTransaction = {
      inputs: ['01'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1, post: identical,
    };
    const tx2: UtxoTransaction = {
      inputs: ['02'.repeat(32)], outputs: [], signatures: {}, protocolVersion: 1, post: identical,
    };
    expect(postFieldBytes(tx1.post!)).toEqual(postFieldBytes(tx2.post!));
    expect(computePostId(computeTxId(tx1), 0))
      .not.toBe(computePostId(computeTxId(tx2), 0));
  });

  it('commit with parentRefs encodes differently', () => {
    const withRefs = { ...commit, parentRefs: ['a1'.repeat(32)] };
    expect(postFieldBytes(commit)).not.toEqual(postFieldBytes(withRefs));
  });
});

// ---------------------------------------------------------------------------
// Canonical field encoding (audit M-1)
// ---------------------------------------------------------------------------

/**
 * The pre-M-1 encoding, kept verbatim so every test below can be shown to be
 * non-vacuous: each case that passes under the canonical encoding is asserted
 * to have *failed* under this one.
 */
function legacyPostId(p: Post): string {
  const h = createHash('blake2b512');
  h.update(p.content);
  h.update(p.author);
  for (const ref of p.parentRefs) h.update(ref);
  h.update(String(p.protocolVersion));
  h.update(p.type);
  return h.digest().subarray(0, 32).toString('hex');
}

/**
 * The payload's encoding as a hex string — the subject of every test below.
 *
 * ⛔ **These assertions moved from the post ID to the PAYLOAD BYTES, and the
 * property they test did not change.** Injectivity used to keep two posts'
 * *ids* apart; it now keeps two *transactions* apart, because `postFieldBytes`
 * sits inside the `computeTxId` preimage (TYPES_INTERFACE → Canonical field
 * encoding). Weakening the encoding because the id no longer reads it would
 * collide two transactions, which is strictly worse than colliding two ids —
 * so these tests are more load-bearing than before, not less.
 */
function payload(c: PostCommit): string {
  return Buffer.from(postFieldBytes(c)).toString('hex');
}

/**
 * Frozen golden vector — the cross-implementation anchor.
 *
 * These hex strings are reproduced by the demo-UI JS mirror
 * (packages/node/public/index.html, asserted in the node package's
 * ui-crypto-mirror test). A change to either implementation that is not
 * mirrored in the other breaks this vector. Do not "fix" a failure by editing
 * the constants — the encoding is protocol-breaking and unversioned.
 *
 * The fixture carries exactly **one** parent ref, because `MAX_PARENT_REFS` is
 * 1, and the ref is raw bytes rather than hex text, because `parentRefs` is
 * `arr(refs, b32)` (TYPES_INTERFACE → Layout — Post).
 *
 * Adjacent fields carry **distinct non-zero values** — `author` is `00..1f`,
 * the ref is `11…`, `protocolVersion` is 1 and `type` is `'regular'` (tag 0)
 * — because an all-zeros vector cannot detect a field-order swap, and field
 * order *is* the specification here.
 */
const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;

/** A well-formed `b32` parent ref: 64 lowercase hex characters. */
const GOLDEN_REF = '11'.repeat(32);

const GOLDEN_COMMIT: PostCommit = {
  contentHash: computeContentHash('dagsocial golden vector ✓'),
  author: GOLDEN_AUTHOR,
  parentRefs: [GOLDEN_REF],
  protocolVersion: 1,
  type: 'regular',
};

/**
 * The exact preimage bytes, frozen — and the same bytes `test/golden/post.json`
 * carries as `postCommit/golden`. Stronger than a hash: a hash says "something
 * moved", these say *which byte*.
 */
const GOLDEN_PREIMAGE =
  '9745d058b1dbd844c81b91384cad9bbcff0896560987f64c50e4e924477c5569' + // b32 contentHash
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 author
  '01' +                                                     // arr count = 1
  '1111111111111111111111111111111111111111111111111111111111111111' + // b32 ref, RAW
  '01' +                                                     // vlqU protocolVersion
  '00';                                                      // enum8 type = regular

describe('canonical field encoding (M-1)', () => {
  it('golden vector: preimage is the exact positional layout', () => {
    const pre = postFieldBytes(GOLDEN_COMMIT);
    expect(Buffer.from(pre).toString('hex')).toBe(GOLDEN_PREIMAGE);
    //  32 contentHash, 32 author, 1 + 32 refs, 1 version, 1 type
    expect(pre.length).toBe(32 + 32 + 33 + 1 + 1);
  });

  it('an id crosses the preimage as 32 RAW bytes, not as 64 hex characters', () => {
    // The largest byte difference in the layout, and the one a mirror
    // implementation is most likely to get wrong: a parent ref costs 32 bytes,
    // not the 68 that a length-prefixed hex text would (`u32LE(64) ‖
    // utf8(hex)`). Asserted as a length delta rather than against a constant so
    // it stays true if the fixture's other fields change.
    const withRef = postFieldBytes(GOLDEN_COMMIT);
    const without = postFieldBytes({ ...GOLDEN_COMMIT, parentRefs: [] });
    expect(withRef.length - without.length).toBe(32);
    // And the raw bytes really are in there — not their hex text.
    expect(Buffer.from(withRef).toString('hex')).toContain('11'.repeat(32));
    expect(Buffer.from(withRef).toString('hex')).not.toContain(
      Buffer.from(GOLDEN_REF, 'utf8').toString('hex'),
    );
  });

  it('injectivity holds across distinct protocolVersions', () => {
    // `postFieldBytes` is injective by construction — every variable-length
    // field is length-prefixed, the ref array is counted, and the trailing
    // `type` is a fixed-width enum8 (TYPES_INTERFACE → Canonical field
    // encoding). `protocolVersion` is the sole VLQ field, so a two-VLQ
    // concatenation collision (the M-1 defect class) is structurally absent.
    // Distinct versions encode distinctly.
    const a = { ...GOLDEN_COMMIT, protocolVersion: 5 };
    const b = { ...GOLDEN_COMMIT, protocolVersion: 52 };
    expect(payload(a)).not.toBe(payload(b));
  });

  it('a parentRef outside the b32 domain has NO encoding — the ambiguity is unconstructible', () => {
    const split = { ...GOLDEN_COMMIT, parentRefs: ['ab', 'cd'] };
    const joined = { ...GOLDEN_COMMIT, parentRefs: ['abcd'] };
    expect(() => payload(split)).toThrow(/64 lowercase hex chars/);
    expect(() => payload(joined)).toThrow(/64 lowercase hex chars/);
    // Vacuity check: the pair collides under the old undelimited concatenation.
    const legacySplit: Post = { content: '', author: GOLDEN_COMMIT.author, parentRefs: ['ab', 'cd'], protocolVersion: 1, type: 'regular' };
    const legacyJoined: Post = { content: '', author: GOLDEN_COMMIT.author, parentRefs: ['abcd'], protocolVersion: 1, type: 'regular' };
    expect(legacyPostId(legacySplit)).toBe(legacyPostId(legacyJoined));
    expect(() => payload({ ...GOLDEN_COMMIT, parentRefs: ['AB'.repeat(32)] }))
      .toThrow(/64 lowercase hex chars/);
  });

  it('contentHash and parentRefs boundaries are structural — both fixed-width', () => {
    // All three of the first three fields are `b32` or `arr(b32)`, so
    // boundaries are structural and nothing can collide them. The only
    // variable-width field is `protocolVersion` (vlqU), and the ref array's
    // count prefix separates presence from absence.
    const a = { ...GOLDEN_COMMIT, parentRefs: [GOLDEN_REF] };
    const b = { ...GOLDEN_COMMIT, parentRefs: [] };
    expect(payload(a)).not.toBe(payload(b));
  });

  it('an empty parentRef is unrepresentable, and absence is still distinguishable', () => {
    const none = { ...GOLDEN_COMMIT, parentRefs: [] as string[] };
    const empty = { ...GOLDEN_COMMIT, parentRefs: [''] };
    expect(() => payload(empty)).toThrow(/64 lowercase hex chars/);
    // Vacuity check: both append nothing under the old undelimited concatenation.
    const legacyNone: Post = { content: '', author: GOLDEN_COMMIT.author, parentRefs: [], protocolVersion: 1, type: 'regular' };
    const legacyEmpty: Post = { content: '', author: GOLDEN_COMMIT.author, parentRefs: [''], protocolVersion: 1, type: 'regular' };
    expect(legacyPostId(legacyNone)).toBe(legacyPostId(legacyEmpty));
    expect(payload(none)).not.toBe(payload({ ...GOLDEN_COMMIT, parentRefs: [GOLDEN_REF] }));
  });

  it('the post id is domain-tagged — it cannot collide with a box or tx id', () => {
    // All three are derived from the same `(txId, index)` provenance, so the tag
    // is the whole of the separation between them (TYPES_INTERFACE → Domain
    // tags). Without it, a post id and a box id at the same outpoint would be
    // the same 32 bytes in one keyspace.
    const indexBytes = Buffer.alloc(4);
    const untagged = createHash('blake2b512')
      .update(new TextEncoder().encode(TX_A))
      .update(indexBytes)
      .digest().subarray(0, 32).toString('hex');
    expect(computePostId(TX_A, 0)).not.toBe(untagged);
  });

  it('never throws on out-of-domain protocolVersion (validation no-panic contract)', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 64, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => payload({ ...GOLDEN_COMMIT, protocolVersion: bad })).not.toThrow();
    }
  });

  it('an out-of-domain protocolVersion cannot impersonate a valid one', () => {
    const valid = payload({ ...GOLDEN_COMMIT, protocolVersion: 0 });
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(payload({ ...GOLDEN_COMMIT, protocolVersion: bad })).not.toBe(valid);
    }
  });

  it('type distinguishes regular from profile', () => {
    const reg = payload({ ...GOLDEN_COMMIT, type: 'regular' });
    const prof = payload({ ...GOLDEN_COMMIT, type: 'profile' });
    expect(reg).not.toBe(prof);
  });

  it('POST_TYPE enum8 exposes the expected tag table', () => {
    expect(POST_TYPE.name).toBe('postType');
  });
});

describe('constants', () => {
  it('PROTOCOL_VERSION is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('MAX_CONTENT_BYTES is 300', () => {
    expect(MAX_CONTENT_BYTES).toBe(300);
  });

  it('MAX_PARENT_REFS is 1', () => {
    // Was 8 (never designed — inherited from a model's suggestion). Capping at
    // 1 makes reply subtrees disjoint, which is what stops one author's prune
    // signature from authorising the deletion of a reply that also hangs off
    // another author's thread.
    expect(MAX_PARENT_REFS).toBe(1);
  });

  it('karma constants are defined', () => {
    expect(KARMA_POSTING_MINIMUM).toBe(1n);
    expect(KARMA_STALE_THRESHOLD_BLOCKS).toBe(40320); // 28 days at 60s blocks
    expect(KARMA_DECAY_INTERVAL_BLOCKS).toBe(1440); // 24 hours at 60s blocks
    expect(KARMA_DECAY_AMOUNT).toBe(5n);
    expect(KARMA_MINIMUM).toBe(10n);
  });

  it('invite constants are defined', () => {
    // The bond an inviter picks from, and the grant equals whichever value they
    // pick. There is no separate grant constant to pin.
    expect(INVITE_BOND_MIN).toBe(25n);
    expect(INVITE_BOND_MAX).toBe(250n);
    expect(INVITE_PROBATION_BLOCKS).toBe(43200); // 30 days at 60s blocks
    expect(INVITE_BOND_VEST_PER_LIKES).toBe(3);
  });

  it('genesis constants are defined', () => {
    expect(GENESIS_COMMITTEE_KEYS).toEqual([]);
    expect(GENESIS_KARMA_PER_MEMBER).toBe(1000n);
  });

  it('validator constants are defined', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBe(5984);
    expect(CREDIT_INITIAL_REWARD).toBe(100n * 10n ** 8n);   // credits ×10^8 base units
    expect(CREDIT_FIXED_RATE_BLOCKS).toBe(1_051_200);
    expect(CREDIT_EPOCH_BLOCKS).toBe(129_600);
    expect(CREDIT_REWARD_REDUCTION).toBe(2n * 10n ** 8n);
    expect(CREDIT_MINER_REWARD_DELAY).toBe(1440); // 24 hours at 60s blocks
    expect(COINBASE_TREASURY_PCT).toBe(5);
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBe(2304);
  });
});
