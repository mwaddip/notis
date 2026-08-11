import { ByteKeyedMap, uid } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  signingHash,
  postPowPreimage,
  PROTOCOL_VERSION,
  MAX_CONTENT_BYTES,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import { verifyPoW } from '../../src/services/pow.js';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Brute-force a valid PoW nonce for the given input and target bits. Returns
 * the first nonce >= startNonce the verifier accepts — the acceptance rule is
 * `verifyPoW`'s, never a second copy of it here.
 */
function solvePoW(input: Uint8Array, targetBits: number, startNonce = 0): number {
  for (let nonce = startNonce; nonce < 100_000_000; nonce++) {
    if (verifyPoW(input, nonce, targetBits)) return nonce;
  }
  throw new Error('Failed to solve PoW within iteration limit');
}

/**
 * Build the powInput buffer exactly as the verifier does — both now read the
 * one canonical encoder in @dagsocial/types (audit M-1).
 */
function buildPowInput(post: Post): Buffer {
  return Buffer.from(postPowPreimage(post));
}

// ---------------------------------------------------------------------------
// Mock store helpers
// ---------------------------------------------------------------------------

interface MockStore {
  // Byte-keyed, because the store they stand in for compares BLOBs by
  // value. `karmaBoxes` below already hex-keys; these two did not.
  identities: ByteKeyedMap<{ userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  challenges: ByteKeyedMap<{ challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array }>;
  karmaBoxes: Map<string, { value: bigint }[]>; // keyed by hex(owner publicKey), now an array
  // Typed as what the dep must return, not `unknown`. Nothing is ever put
  // in it — `getPost` returns null throughout these suites — but a mock
  // whose value type cannot satisfy the interface is a mock that would
  // not compile the day a test starts using it.
  posts: Map<string, Post | Stump>;
}

function createMockDeps(store: MockStore): VerifierDeps {
  return {
    getActiveChallenge: (userId: Uint8Array) => store.challenges.get(userId) ?? null,
    getKarmaBoxes: (owner: Uint8Array) => {
      const hex = Buffer.from(owner).toString('hex');
      return store.karmaBoxes.get(hex) ?? [];
    },
    getPost: (id: string) => store.posts.get(id) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyPost', () => {
  // Shared test fixtures
  let pubKeyRaw: Uint8Array;
  let privKey: KeyObject;
  let userId: Uint8Array;
  let challengeBytes: Uint8Array;

  // Build a fresh mock store for each test
  function makeStore(): MockStore {
    return {
      identities: new ByteKeyedMap(),
      challenges: new ByteKeyedMap(),
      karmaBoxes: new Map(),
      posts: new Map(),
    };
  }

  /**
   * Create a fully valid Post object (unsigned) with the given overrides.
   * The caller is responsible for signing and setting powNonce.
   */
  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello world',
      author: userId,
      parentRefs: [],
      challenge: challengeBytes,
      powNonce: 0,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: 1700000000000,
      signature: new Uint8Array(64),
      ...overrides,
    };
  }

  /**
   * Sign a post with the test private key and set its signature.
   */
  function signPost(post: Post): Post {
    const sig = cryptoSign(null, signingHash(post), privKey);
    return { ...post, signature: new Uint8Array(sig) };
  }

  // Generate a real Ed25519 keypair once for all tests
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    // Keep KeyObject — crypto.sign needs it for Ed25519
    privKey = privateKey;
    userId = pubKeyRaw;
    challengeBytes = new Uint8Array(
      createHash('blake2b512').update('test-challenge').digest().subarray(0, 32),
    );
  }

  // -----------------------------------------------------------------------
  // 1. Valid post passes all checks
  // -----------------------------------------------------------------------
  it(
    'valid post passes all checks',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      // Populate store
      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Build post and solve PoW
      let post = makePost();
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };

      // Sign
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );

  // -----------------------------------------------------------------------
  // 2. Empty content
  // -----------------------------------------------------------------------
  it('rejects empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  // -----------------------------------------------------------------------
  // 3. Content > 300 bytes
  // -----------------------------------------------------------------------
  it('rejects content exceeding max length', () => {
    const store = makeStore();
    const post = makePost({ content: 'x'.repeat(MAX_CONTENT_BYTES + 1) });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  // -----------------------------------------------------------------------
  // 4. > 8 parent refs
  // -----------------------------------------------------------------------
  it('rejects too many parent refs', () => {
    const store = makeStore();
    // Nine distinct well-formed PostIds. The subject here is the count rule, so
    // the refs must clear the step-0 domain pin to reach it — the old fixture
    // ('post0'…'post8') was never emittable by any producer, since a real PostId
    // is always `computePostId`'s 64-lowercase-hex digest.
    const post = makePost({
      parentRefs: Array.from({ length: 9 }, (_, i) =>
        i.toString(16).padStart(2, '0').repeat(32),
      ),
    });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Too many parent refs');
  });

  // -----------------------------------------------------------------------
  // 5. Wrong protocol version
  // -----------------------------------------------------------------------
  it('rejects unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  // -----------------------------------------------------------------------
  // 6. No active challenge
  // -----------------------------------------------------------------------
  it('rejects missing challenge', () => {
    const store = makeStore();
    // No challenge inserted
    const post = makePost({ content: 'test' }); // 4 bytes, passes content check
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('No active challenge');
  });

  // -----------------------------------------------------------------------
  // 7. Challenge mismatch
  // -----------------------------------------------------------------------
  it('rejects challenge mismatch', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: new Uint8Array(32), // all zeros — not what the post carries
      expiresAtBlock: 100,
    });
    const post = makePost({ content: 'test' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Challenge mismatch');
  });

  // -----------------------------------------------------------------------
  // 8. Expired challenge
  // -----------------------------------------------------------------------
  it('rejects expired challenge', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: challengeBytes,
      expiresAtBlock: 10,
    });
    const post = makePost({ content: 'test' });
    const deps = createMockDeps(store);
    // currentBlockHeight (20) > expiresAtBlock (10)
    const result = verifyPost(deps, post, 20);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Challenge expired');
  });

  // -----------------------------------------------------------------------
  // 9. Invalid PoW
  // -----------------------------------------------------------------------
  it('rejects invalid PoW', () => {
    const store = makeStore();
    store.challenges.set(userId, {
      userId,
      challenge: challengeBytes,
      expiresAtBlock: 100,
    });
    // powNonce=0 with targetBits=20 is almost certainly invalid
    const post = makePost({ content: 'test', powNonce: 0 });
    const deps = createMockDeps(store);

    // Verify that powNonce=0 is actually invalid for this input
    const powInput = buildPowInput(post);
    const isValid = verifyPoW(powInput, 0, 20);
    if (isValid) {
      // Extremely unlikely — skip the test if 0 happens to be valid
      return;
    }

    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Proof of Work invalid');
  });

  // -----------------------------------------------------------------------
  // 10. Invalid signature (tampered content)
  // -----------------------------------------------------------------------
  it(
    'rejects invalid signature',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Build a valid post, solve PoW, and sign the original content
      let post = makePost({ content: 'original content' });
      let powInput = buildPowInput(post);
      const goodNonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: goodNonce };
      post = signPost(post);

      // Tamper with content after signing — signature no longer matches.
      // Re-solve PoW for the tampered content so PoW check passes and we reach
      // the signature verification step.
      const tamperedPost = { ...post, content: 'tampered content' };
      powInput = buildPowInput(tamperedPost);
      const tamperedNonce = solvePoW(powInput, 20);
      const finalTampered = { ...tamperedPost, powNonce: tamperedNonce };

      const deps = createMockDeps(store);
      const result = verifyPost(deps, finalTampered, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Signature invalid');
    },
  );

  // -----------------------------------------------------------------------
  // 11. Missing parent ref
  // -----------------------------------------------------------------------
  it(
    'rejects missing parent ref',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Reference a post that does not exist — reply needs POST_LOCK_REPLY_COST karma
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_REPLY_COST },
      ]);
      // A well-formed PostId that no post claims. It must be 64 lowercase hex:
      // a real PostId is always `computePostId`'s hex digest, and
      // `verifyPostFieldDomains` rejects anything else at step 0 — before this
      // test's actual subject, the step-8 parent-existence check, is reached.
      // A short non-hex id would therefore never reach that check, and no
      // producer could emit one.
      const ABSENT_PARENT = 'de'.repeat(32);
      let post = makePost({ parentRefs: [ABSENT_PARENT] });
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`Parent post not found: ${ABSENT_PARENT}`);
    },
  );

  // -----------------------------------------------------------------------
  // 12. Insufficient karma
  // -----------------------------------------------------------------------
  it(
    'rejects insufficient karma',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      // Karma box value = 0, below POST_LOCK_THREAD_COST (5)
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [{ value: 0n }]);

      let post = makePost();
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Insufficient karma');
    },
  );

  // -----------------------------------------------------------------------
  // 13. Valid post with 0 parent refs passes
  // -----------------------------------------------------------------------
  it(
    'valid post with 0 parent refs passes',
    { timeout: 60_000 },
    () => {
      const store = makeStore();

      store.identities.set(userId, {
        userId,
        publicKey: pubKeyRaw,
        createdAt: Date.now(),
      });
      store.challenges.set(userId, {
        userId,
        challenge: challengeBytes,
        expiresAtBlock: 100,
      });
      store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
        { value: POST_LOCK_THREAD_COST },
      ]);

      // Explicitly empty parentRefs
      let post = makePost({ parentRefs: [] });
      const powInput = buildPowInput(post);
      const nonce = solvePoW(powInput, 20);
      post = { ...post, powNonce: nonce };
      post = signPost(post);

      const deps = createMockDeps(store);
      const result = verifyPost(deps, post, 50);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    },
  );

  // -----------------------------------------------------------------------
  // 14. Multi-box karma sufficiency (split across boxes)
  // -----------------------------------------------------------------------
  it('accepts post when karma is split across multiple boxes', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.challenges.set(userId, { userId, challenge: challengeBytes, expiresAtBlock: 100 });
    // Two karma boxes: 3 + 2 = 5, enough for thread post
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 3n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    let post = makePost();
    const powInput = buildPowInput(post);
    const nonce = solvePoW(powInput, 20);
    post = { ...post, powNonce: nonce };
    post = signPost(post);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 15. Multi-box karma insufficiency (combined too low)
  // -----------------------------------------------------------------------
  it('rejects post when combined karma across boxes is insufficient', { timeout: 60_000 }, () => {
    const store = makeStore();
    store.identities.set(userId, { userId, publicKey: pubKeyRaw, createdAt: Date.now() });
    store.challenges.set(userId, { userId, challenge: challengeBytes, expiresAtBlock: 100 });
    // Two boxes with 2 + 2 = 4, but thread post costs 5
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [
      { value: 2n },
      { value: 2n },
    ]);
    const deps = createMockDeps(store);
    let post = makePost();
    const powInput = buildPowInput(post);
    const nonce = solvePoW(powInput, 20);
    post = { ...post, powNonce: nonce };
    post = signPost(post);
    const result = verifyPost(deps, post, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Insufficient karma');
  });
});
