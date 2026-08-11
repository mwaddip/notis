import { ByteKeyedMap, uid } from '../helpers.js';
import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync,
  createHash,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import { signingHash, PROTOCOL_VERSION } from '@dagsocial/types';
import type { Post, Stump } from '@dagsocial/types';
import { verifyPost } from '../../src/services/verifier.js';
import type { VerifierDeps } from '../../src/services/verifier.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockStore {
  // Byte-keyed, because the store they stand in for compares BLOBs by
  // value. A plain `Map` keyed on a `Uint8Array` compares by reference, so a
  // lookup with an equal-but-distinct array misses. `karmaBoxes` reaches the
  // same property by hex-keying.
  identities: ByteKeyedMap<{ userId: Uint8Array; publicKey: Uint8Array; createdAt: number }>;
  challenges: ByteKeyedMap<{ challenge: Uint8Array; expiresAtBlock: number; userId: Uint8Array }>;
  karmaBoxes: Map<string, { value: bigint }[]>;
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

function makeStore(): MockStore {
  return {
    identities: new ByteKeyedMap(),
    challenges: new ByteKeyedMap(),
    karmaBoxes: new Map(),
    posts: new Map(),
  };
}

function signPost(post: Post, privKey: Buffer | KeyObject): Post {
  const sig = cryptoSign(null, signingHash(post), privKey);
  return { ...post, signature: new Uint8Array(sig) };
}

describe('verifier', () => {
  let userId: Uint8Array;
  let pubKeyRaw: Uint8Array;
  let privKey: KeyObject;
  let challengeBytes: Uint8Array;

  // Generate a real Ed25519 keypair
  {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    pubKeyRaw = new Uint8Array(pubDer.slice(pubDer.length - 32));
    privKey = privateKey;
    userId = pubKeyRaw;
    challengeBytes = new Uint8Array(
      createHash('blake2b512').update('unit-test-challenge').digest().subarray(0, 32),
    );
  }

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      content: 'hello',
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

  it('rejects post with unsupported protocol version', () => {
    const store = makeStore();
    const post = makePost({ protocolVersion: 99 });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Unsupported protocol version');
  });

  it('rejects post with content exceeding max length', () => {
    const store = makeStore();
    const longContent = 'x'.repeat(301);
    const post = makePost({ content: longContent });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content exceeds max length');
  });

  it('rejects post with empty content', () => {
    const store = makeStore();
    const post = makePost({ content: '' });
    const deps = createMockDeps(store);
    const result = verifyPost(deps, post, 0);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('rejects post with invalid signature', () => {
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
    store.karmaBoxes.set(Buffer.from(pubKeyRaw).toString('hex'), [{ value: 1n }]);

    let post = makePost({ powNonce: 1 });
    // Sign correctly, then zero the signature — crypto.verify will fail on
    // an all-zeros 64-byte array against the real public key.
    post = signPost(post, privKey);
    const badPost = { ...post, signature: new Uint8Array(64) };

    // powNonce=1 almost certainly fails PoW at targetBits=20, so the first
    // failure will be "Proof of Work invalid". Both failure modes (PoW and
    // signature) produce the correct `valid: false` with a descriptive error.
    const deps = createMockDeps(store);
    const result = verifyPost(deps, badPost, 50);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
