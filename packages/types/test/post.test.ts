import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  computePostId,
  signingHash,
  postPowPreimage,
  getPostDiscriminator,
  buildProfileContent,
} from '../src/post.js';
import {
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  MAX_PARENT_REFS,
  POST_POW_TARGET_BITS,
  CHALLENGE_WINDOW_BLOCKS,
  KARMA_POSTING_MINIMUM,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  MAX_PENDING_INVITES,
  INVITE_BOND_KARMA,
  INVITE_PROBATION_BLOCKS,
  INVITE_KARMA_THRESHOLD,
  GENESIS_COMMITTEE_KEYS,
  GENESIS_KARMA_PER_MEMBER,
  GENESIS_CREDITS_PER_MEMBER,
  BOOTSTRAP_PERIOD_BLOCKS,
  CREDIT_FIXED_RATE_BLOCKS,
  CREDIT_INITIAL_REWARD,
  CREDIT_EPOCH_BLOCKS,
  CREDIT_REWARD_REDUCTION,
  CREDIT_TAIL_REWARD,
  CREDIT_MINER_REWARD_DELAY,
  CREDIT_TREASURY_PCT,
  ORDERING_BLOCK_POW_TARGET_BITS,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '../src/constants.js';
import type { Post } from '../src/post.js';

const challenge = new Uint8Array(32).fill(0xab);
const signature = new Uint8Array(64).fill(0xcd);

const post: Post = {
  content: 'hello world',
  author: new Uint8Array(32).fill(0x11),
  parentRefs: [],
  challenge,
  powNonce: 42,
  protocolVersion: 2,
  timestamp: 1700000000000,
  signature,
};

describe('post', () => {
  it('computePostId is deterministic', () => {
    expect(computePostId(post)).toBe(computePostId(post));
  });

  it('computePostId changes with content', () => {
    expect(computePostId(post))
      .not.toBe(computePostId({ ...post, content: 'different' }));
  });

  it('signingHash excludes powNonce', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, powNonce: 99 });
    expect(Buffer.compare(h1, h2)).toBe(0);
  });

  it('signingHash changes with content', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, content: 'other' });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('signingHash changes with protocolVersion', () => {
    const h1 = signingHash(post);
    const h2 = signingHash({ ...post, protocolVersion: 3 });
    expect(Buffer.compare(h1, h2)).not.toBe(0);
  });

  it('computePostId changes with powNonce (unlike signingHash)', () => {
    const id1 = computePostId(post);
    const id2 = computePostId({ ...post, powNonce: 43 });
    expect(id1).not.toBe(id2);
  });

  it('computePostId returns a hex string', () => {
    const id = computePostId(post);
    expect(typeof id).toBe('string');
    expect(id).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(/^[0-9a-f]+$/.test(id)).toBe(true);
  });

  it('signingHash returns 32 bytes', () => {
    expect(signingHash(post)).toHaveLength(32);
  });

  it('post with parentRefs hashes differently', () => {
    // A ref is `b32` now, so it must be 64 lowercase hex characters to have an
    // encoding at all — see the domain tests below.
    const withRefs = { ...post, parentRefs: ['a1'.repeat(32)] };
    expect(computePostId(post)).not.toBe(computePostId(withRefs));
  });

  it('post with different challenge hashes differently', () => {
    const otherChallenge = new Uint8Array(32).fill(0xff);
    const other = { ...post, challenge: otherChallenge };
    expect(computePostId(post)).not.toBe(computePostId(other));
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
  h.update(p.challenge);
  h.update(String(p.protocolVersion));
  h.update(String(p.powNonce));
  h.update(String(p.timestamp));
  return h.digest().subarray(0, 32).toString('hex');
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
 * `challenge` is `20..3f`, the ref is `11…`, `protocolVersion` is 1 and the
 * timestamp is wide — because an all-zeros vector cannot detect a field-order
 * swap, and field order *is* the specification here.
 */
const GOLDEN_AUTHOR = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_AUTHOR[i] = i;
const GOLDEN_CHALLENGE = new Uint8Array(32);
for (let i = 0; i < 32; i++) GOLDEN_CHALLENGE[i] = 0x20 + i;

/** A well-formed `b32` parent ref: 64 lowercase hex characters. */
const GOLDEN_REF = '11'.repeat(32);

const GOLDEN_POST: Post = {
  content: 'dagsocial golden vector ✓',
  author: GOLDEN_AUTHOR,
  parentRefs: [GOLDEN_REF],
  challenge: GOLDEN_CHALLENGE,
  powNonce: 4294967296,     // 2^32 — five VLQ bytes, so the wide path is covered
  protocolVersion: 1,
  timestamp: 1767225600000, // > 2^32 — six VLQ bytes
  signature: new Uint8Array(64).fill(0xcd),
};

const GOLDEN_SIGNING_HASH =
  '3143d7a351cf2bb4cdbca49ba7aa994ce2e4fd1638a9322058d03fe87debc6b0';
const GOLDEN_POST_ID =
  'fefac701207339ba5953fdfe98ed6212f7ead3025dc6e718878dc465ca06e8b0';

/**
 * The exact preimage bytes, frozen. Stronger than the two hashes above: a hash
 * says "something moved", these say *which byte*.
 */
const GOLDEN_PREIMAGE =
  '1b' +                                                     // vlqU(27) content length
  '646167736f6369616c20676f6c64656e20766563746f7220e29c93' + // utf8 content
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' + // b32 author
  '01' +                                                     // arr count = 1
  '1111111111111111111111111111111111111111111111111111111111111111' + // b32 ref, RAW
  '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f' + // b32 challenge
  '01' +                                                     // vlqU protocolVersion
  '80d0eab6b733';                                            // vlqU timestamp

describe('canonical field encoding (M-1)', () => {
  it('golden vector: signingHash is frozen', () => {
    expect(signingHash(GOLDEN_POST).toString('hex')).toBe(GOLDEN_SIGNING_HASH);
  });

  it('golden vector: postId is frozen', () => {
    expect(computePostId(GOLDEN_POST)).toBe(GOLDEN_POST_ID);
  });

  it('golden vector: preimage is the exact positional layout', () => {
    const pre = postPowPreimage(GOLDEN_POST);
    expect(Buffer.from(pre).toString('hex')).toBe(GOLDEN_PREIMAGE);
    //  1 + 27 content, 32 author, 1 + 32 refs, 32 challenge, 1 version, 6 ts
    expect(pre.length).toBe(28 + 32 + 33 + 32 + 1 + 6);
  });

  it('an id crosses the preimage as 32 RAW bytes, not as 64 hex characters', () => {
    // The largest byte difference in the layout, and the one a mirror
    // implementation is most likely to get wrong: a parent ref costs 32 bytes,
    // not the 68 that a length-prefixed hex text would (`u32LE(64) ‖
    // utf8(hex)`). Asserted as a length delta rather than against a constant so
    // it stays true if the fixture's other fields change.
    const withRef = postPowPreimage(GOLDEN_POST);
    const without = postPowPreimage({ ...GOLDEN_POST, parentRefs: [] });
    expect(withRef.length - without.length).toBe(32);
    // And the raw bytes really are in there — not their hex text.
    expect(Buffer.from(withRef).toString('hex')).toContain('11'.repeat(32));
    expect(Buffer.from(withRef).toString('hex')).not.toContain(
      Buffer.from(GOLDEN_REF, 'utf8').toString('hex'),
    );
  });

  it('the M-1 collision pair still yields distinct ids — preserved, not introduced', () => {
    // The defect audit M-1 closed. `postFieldBytes` is injective by
    // construction — every variable-length field is length-prefixed and the ref
    // array is counted (TYPES_INTERFACE → Canonical field encoding) — so this
    // assertion guards the property against a dialect change rather than
    // recording its arrival.
    const a: Post = { ...GOLDEN_POST, powNonce: 5, timestamp: 23 };
    const b: Post = { ...GOLDEN_POST, powNonce: 52, timestamp: 3 };
    expect(computePostId(a)).not.toBe(computePostId(b));
    // Vacuity check: this pair DOES collide under the undelimited
    // concatenation `legacyPostId` above models.
    expect(legacyPostId(a)).toBe(legacyPostId(b));
  });

  it('a parentRef outside the b32 domain has NO encoding — the ambiguity is unconstructible', () => {
    // Restates "parentRef boundaries are unambiguous". That test compared
    // `['ab','cd']` against `['abcd']` and proved the *length prefix* kept them
    // apart. Under `arr(refs, b32)` neither input exists: a ref that is not
    // exactly 64 lowercase hex characters has no encoding, so the collision is
    // prevented one layer earlier, by the domain rather than by a delimiter.
    // A fixed-width writer cannot pad or truncate to close the gap — that would
    // map a malformed ref onto a well-formed post's encoding.
    const split: Post = { ...GOLDEN_POST, parentRefs: ['ab', 'cd'] };
    const joined: Post = { ...GOLDEN_POST, parentRefs: ['abcd'] };
    expect(() => computePostId(split)).toThrow(/64 lowercase hex chars/);
    expect(() => computePostId(joined)).toThrow(/64 lowercase hex chars/);
    // Vacuity check: the pair really did collide under the old concatenation,
    // which is what makes "unconstructible" an improvement and not a dodge.
    expect(legacyPostId(split)).toBe(legacyPostId(joined));
    // Uppercase hex is out of domain too: 'AB…' and 'ab…' decode to identical
    // bytes, so admitting both would make the boundary non-injective.
    expect(() => computePostId({ ...GOLDEN_POST, parentRefs: ['AB'.repeat(32)] }))
      .toThrow(/64 lowercase hex chars/);
  });

  it('the content/parentRefs boundary is unambiguous — the one leg still earned by a prefix', () => {
    // Restates "the content/author boundary is unambiguous". `author`,
    // `challenge` and every ref are fixed-width now, so their boundaries are
    // structural and nothing can test them. `content` is the sole remaining
    // variable-length field, so it is the only place where the M-1 argument is
    // still load-bearing: without its length prefix, moving a ref's text into
    // the content would produce the same byte stream.
    const a: Post = { ...GOLDEN_POST, content: 'ab', parentRefs: [GOLDEN_REF] };
    const b: Post = { ...GOLDEN_POST, content: `ab${GOLDEN_REF}`, parentRefs: [] };
    expect(computePostId(a)).not.toBe(computePostId(b));
    // …and the count prefix seals the other direction: same content, ref
    // present versus absent.
    const c: Post = { ...GOLDEN_POST, content: 'ab', parentRefs: [] };
    expect(computePostId(a)).not.toBe(computePostId(c));
  });

  it('an empty parentRef is unrepresentable, and absence is still distinguishable', () => {
    // Under a length-prefixed text encoding `''` is a legal ref — `LP(utf8(''))`
    // is four zero bytes — and only the explicit count separates `[]` from
    // `['']`. `b32` removes the input instead of distinguishing it: an empty
    // ref has no encoding at all.
    const none: Post = { ...GOLDEN_POST, parentRefs: [] };
    const empty: Post = { ...GOLDEN_POST, parentRefs: [''] };
    expect(() => computePostId(empty)).toThrow(/64 lowercase hex chars/);
    // Vacuity check: both append nothing under the undelimited concatenation
    // `legacyPostId` models.
    expect(legacyPostId(none)).toBe(legacyPostId(empty));
    // The count prefix still does its job for the in-domain pair.
    expect(computePostId(none)).not.toBe(computePostId({ ...GOLDEN_POST, parentRefs: [GOLDEN_REF] }));
  });

  it('the post id is domain-tagged — it is not the PoW hash', () => {
    // The PoW hash appends `vlqU(powNonce)` to the same preimage and carries no
    // domain tag; 2^32 encodes as five VLQ bytes.
    const nonce = Buffer.from([0x80, 0x80, 0x80, 0x80, 0x10]);
    const powHash = createHash('blake2b512')
      .update(postPowPreimage(GOLDEN_POST))
      .update(nonce)
      .digest()
      .subarray(0, 32)
      .toString('hex');
    expect(computePostId(GOLDEN_POST)).not.toBe(powHash);
  });

  it('postPowPreimage excludes powNonce, computePostId includes it', () => {
    const other: Post = { ...GOLDEN_POST, powNonce: GOLDEN_POST.powNonce + 1 };
    expect(Buffer.compare(
      Buffer.from(postPowPreimage(GOLDEN_POST)),
      Buffer.from(postPowPreimage(other)),
    )).toBe(0);
    expect(computePostId(GOLDEN_POST)).not.toBe(computePostId(other));
  });

  it('never throws on out-of-domain numerics (validation no-panic contract)', () => {
    // `@dagsocial/validation`'s isSignablePost admits any `typeof === 'number'`,
    // so these reach the encoder. BigInt/writeBigUInt64LE would throw here.
    for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 64, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => signingHash({ ...GOLDEN_POST, timestamp: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, timestamp: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, powNonce: bad })).not.toThrow();
      expect(() => computePostId({ ...GOLDEN_POST, protocolVersion: bad })).not.toThrow();
    }
  });

  it('an out-of-domain numeric cannot impersonate a valid one', () => {
    // The all-ones sentinel is unreachable from a non-negative safe integer.
    const valid = computePostId({ ...GOLDEN_POST, timestamp: 0 });
    for (const bad of [NaN, Infinity, -1, 1.5]) {
      expect(computePostId({ ...GOLDEN_POST, timestamp: bad })).not.toBe(valid);
    }
  });
});

describe('profile discriminators', () => {
  it('getPostDiscriminator returns null for plain text', () => {
    expect(getPostDiscriminator('hello world')).toBeNull();
  });

  it('getPostDiscriminator returns null for JSON without type', () => {
    expect(getPostDiscriminator('{"foo":"bar"}')).toBeNull();
  });

  it('getPostDiscriminator returns null for invalid JSON', () => {
    expect(getPostDiscriminator('{broken')).toBeNull();
  });

  it('getPostDiscriminator returns type for profile JSON', () => {
    expect(getPostDiscriminator('{"type":"bio","text":"hello"}')).toBe('bio');
  });

  it('getPostDiscriminator returns type for username_claim', () => {
    expect(getPostDiscriminator('{"type":"username_claim","claim":"@alice"}')).toBe('username_claim');
  });

  it('buildProfileContent embeds type in JSON', () => {
    const content = buildProfileContent('bio', { text: 'hello' });
    expect(JSON.parse(content)).toEqual({ type: 'bio', text: 'hello' });
  });

  it('buildProfileContent with no extra fields', () => {
    const content = buildProfileContent('profile');
    expect(JSON.parse(content)).toEqual({ type: 'profile' });
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

  it('PoW constants are defined', () => {
    expect(POST_POW_TARGET_BITS).toBe(20);
    expect(CHALLENGE_WINDOW_BLOCKS).toBe(10);
  });

  it('karma constants are defined', () => {
    expect(KARMA_POSTING_MINIMUM).toBe(1n);
    expect(KARMA_STALE_THRESHOLD_BLOCKS).toBe(40320); // 28 days at 60s blocks
    expect(KARMA_DECAY_INTERVAL_BLOCKS).toBe(1440); // 24 hours at 60s blocks
    expect(KARMA_DECAY_AMOUNT).toBe(5n);
    expect(KARMA_MINIMUM).toBe(10n);
  });

  it('invite constants are defined', () => {
    expect(MAX_PENDING_INVITES).toBe(5);
    expect(INVITE_BOND_KARMA).toBe(25n);
    expect(INVITE_PROBATION_BLOCKS).toBe(1000);
    expect(INVITE_KARMA_THRESHOLD).toBe(20n);
  });

  it('genesis constants are defined', () => {
    expect(GENESIS_COMMITTEE_KEYS).toEqual([]);
    expect(GENESIS_KARMA_PER_MEMBER).toBe(1000n);
    expect(GENESIS_CREDITS_PER_MEMBER).toBe(10000n * 10n ** 8n);  // credits ×10^8 base units
    expect(BOOTSTRAP_PERIOD_BLOCKS).toBe(10000);
  });

  it('validator constants are defined', () => {
    expect(ORDERING_BLOCK_POW_TARGET_BITS).toBe(5984);
    expect(CREDIT_INITIAL_REWARD).toBe(100n * 10n ** 8n);   // credits ×10^8 base units
    expect(CREDIT_FIXED_RATE_BLOCKS).toBe(1_051_200);
    expect(CREDIT_EPOCH_BLOCKS).toBe(129_600);
    expect(CREDIT_REWARD_REDUCTION).toBe(2n * 10n ** 8n);
    expect(CREDIT_TAIL_REWARD).toBe(2n * 10n ** 8n);
    expect(CREDIT_MINER_REWARD_DELAY).toBe(720);
    expect(CREDIT_TREASURY_PCT).toBe(10);
    expect(ORDERING_BLOCK_POW_TARGET_FLOOR).toBe(2304);
  });
});
