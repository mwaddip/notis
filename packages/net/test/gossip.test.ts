import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createPrivateKey, sign } from 'crypto';
import {
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
} from '@dagsocial/validation';
import {
  generateKeyPair,
  computePostId,
  postPowPreimage,
  signingHash,
  subBlockFromPost,
  encodeSubBlock,
  encodeOrderingBlock,
  decodeOrderingBlock,
  EMPTY_STATE_ROOT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POST_POW_TARGET_BITS,
} from '@dagsocial/types';
import type { Post, SubBlock, OrderingBlock, BlockHeader } from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import { subscribeTopics, TOPICS } from '../src/gossip.js';
import type { Libp2pGossip } from '../src/gossip.js';
import { PeerManager } from '../src/peer-mgr.js';
import type { NetConfig, NetValidators } from '../src/types.js';

// These tests drive the REAL topic validators registered by subscribeTopics —
// not an inline copy of their bodies. A copied harness would contain the fix
// under test and pass by construction; here every assertion runs the same
// closures production gossipsub invokes, over wire-encoded messages, against
// the real @dagsocial/validation functions and a real PeerManager.

const validators: NetValidators = {
  verifyPoW,
  verifyOrderingBlockPoW,
  verifyPostSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifySubBlockStructure,
  verifyTxStructure,
  verifyOrderingBlockStructure,
};

function makeConfig(): NetConfig {
  return {
    magic: 0x54444147,
    postPowTargetBits: POST_POW_TARGET_BITS,
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 1000,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 0,
    syncRequestTimeoutMs: 10_000,
  };
}

type CapturedValidator = (
  peer: { toString(): string },
  msg: { data: Uint8Array },
) => TopicValidatorResult;

function makeHarness(postPowTargetBits: number = POST_POW_TARGET_BITS) {
  const topicValidators = new Map<string, CapturedValidator>();
  const stub = {
    services: {
      pubsub: {
        topicValidators,
        subscribe: () => {},
        addEventListener: () => {},
      },
    },
  } as unknown as Libp2pGossip;

  const peerMgr = new PeerManager(makeConfig());
  subscribeTopics(stub, validators, peerMgr, {
    onSubBlock: () => {},
    onOrderingBlock: () => {},
    onTx: () => {},
  }, postPowTargetBits);

  const penaltySpy = vi.spyOn(peerMgr, 'recordPenalty');
  return { topicValidators, peerMgr, penaltySpy };
}

let peerSeq = 0;
function newPeer(peerMgr: PeerManager): { id: string; toString(): string } {
  const id = `test-peer-${peerSeq++}`;
  peerMgr.addPeer({ id, multiaddrs: [], protocols: [], connectedAt: Date.now() });
  return { id, toString: () => id };
}

// ---------------------------------------------------------------------------
// Ordering-block topic validator — relay PoW gate (audit M-9, M-6)
// ---------------------------------------------------------------------------

describe('ordering-block topic validator (relay PoW gate)', () => {
  const baseHeader: BlockHeader = {
    protocolVersion: 1,
    height: 7,
    prevBlockHash: '11'.repeat(32),
    subBlockRoot: '22'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(9),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR, // 4 — the structure floor
    createdAt: 1_722_470_400_000,
  };

  function makeBlock(header: BlockHeader): OrderingBlock {
    return {
      header,
      subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
      utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
      // 64-byte dummy — Stage 1 does not verify the validator signature.
      validatorSignature: new Uint8Array(64),
    };
  }

  let minedNonce = -1;
  let failingNonce = -1;

  beforeAll(() => {
    // Mine the real nonce (~16 tries at 4 bits) and record a genuinely
    // failing one, both via the same verifyOrderingBlockPoW that gates relay.
    for (let n = 0; minedNonce < 0 || failingNonce < 0; n++) {
      if (n > 1_000_000) throw new Error('ordering-block PoW search exhausted');
      const ok = verifyOrderingBlockPoW({ ...baseHeader, powNonce: n });
      if (ok && minedNonce < 0) minedNonce = n;
      if (!ok && failingNonce < 0) failingNonce = n;
    }
  });

  it('accepts a mined block with zero penalties (control anchor)', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  it('rejects the same block with a wrong nonce and records one misbehavior penalty', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // Self-check: this nonce genuinely fails PoW (no 1-in-16 flake).
    expect(verifyOrderingBlockPoW({ ...baseHeader, powNonce: failingNonce })).toBe(false);

    const block = makeBlock({ ...baseHeader, powNonce: failingNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block PoW invalid',
    );
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(1);
  });

  it('rejects the same block with powNonce NaN (M-6 — pre-fix code Accepted this)', () => {
    // Vacuity evidence: against pre-fix gossip.ts this exact message was
    // ACCEPTED and forwarded mesh-wide. verifyOrderingBlockStructure guarded
    // powNonce with `typeof !== 'number' || < 0`, and `typeof NaN ===
    // 'number'` while `NaN < 0` is false — so structure passed, the version
    // check passed, and nothing else ran before Accept. The single-field-delta
    // control that Accepts is the mined-nonce case above.
    //
    // Phase 1f moved the rejection one gate earlier. `verifyOrderingBlockStructure`
    // now states the header's whole encodable domain, and `powNonce` is a
    // `vlqU` field, so `isU64Safe` refuses NaN at `gossip.ts:98` — before
    // net's own PoW check at `:114` ever runs. Same `Reject`, same kind, peer
    // and weight; the attribution improved, because the gate now names the
    // field instead of blaming PoW for a header that never reached it.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: Number.NaN });
    const encoded = encodeOrderingBlock(block);

    // NaN survives the CBOR wire round-trip — this is a reachable network
    // input, not an in-process artifact.
    expect(Number.isNaN(decodeOrderingBlock(encoded).header.powNonce)).toBe(true);

    const result = validate(peer, { data: encoded });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'Ordering block missing or invalid powNonce',
    );
  });

  it.each([
    ['NaN', Number.NaN],
    ['1.5', 1.5],
  ])('rejects height %s at the structure gate, attributably', (_label, badHeight) => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // Single-field delta from the accepted anchor: only height changes.
    // Pre-fix, height NaN/floats passed structure (`< 1` is false for NaN;
    // 1.5 >= 1) and were forwarded. The distinct reason string still proves the
    // rejection is attributable to height rather than to PoW (which the height
    // change also breaks) — that property is what this test is for.
    //
    // What moved in Phase 1f is *which* gate supplies it.
    // `verifyOrderingBlockStructure` now states the header's encodable domain,
    // so `isU64Safe` refuses NaN and 1.5 at `gossip.ts:98`, before net's own
    // `Number.isSafeInteger` add-on at `:109` ever ran. 1f-3 deleted that
    // add-on and renamed this test off "via the height guard" — a test named
    // for a gate that no longer exists is the vacuity pattern, and the name is
    // the last thing to go stale because nothing type-checks it.
    //
    // This test is also the deletion's standing evidence. It drives the real
    // `verifyOrderingBlockStructure` (the harness injects the package, not a
    // stub) and asserts the *structure gate's* message. It passed before the
    // deletion, which is what proved the guard never fired for these inputs;
    // it must keep passing after, which is what proves nothing was lost. The
    // general case is a subset argument rather than these two values:
    // `isU64Safe` rejects everything `Number.isSafeInteger` rejects, and more.
    const block = makeBlock({ ...baseHeader, powNonce: minedNonce, height: badHeight });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'Ordering block invalid height',
    );
  });
});

// ---------------------------------------------------------------------------
// Sub-block topic validator — Stage 1 (structure, limits, PoW, signature)
// ---------------------------------------------------------------------------

describe('sub-block topic validator (Stage 1)', () => {
  let keyPair: ReturnType<typeof generateKeyPair>;
  let validPost: Post;
  let validSubBlock: SubBlock;
  let failingPostNonce = -1;

  beforeAll(() => {
    keyPair = generateKeyPair();
    const basePost: Post = {
      content: 'gossip stage-1 fixture',
      author: keyPair.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(7),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_722_470_400_000,
      signature: new Uint8Array(64),
    };

    // Mine the real 20-bit post PoW (~1M tries expected; the preimage
    // excludes powNonce and signature, so mining and signing commute).
    const powInput = postPowPreimage(basePost);
    let nonce = -1;
    for (let n = 0; n < 100_000_000; n++) {
      const ok = verifyPoW(powInput, n, POST_POW_TARGET_BITS);
      if (ok && nonce < 0) { nonce = n; break; }
      if (!ok && failingPostNonce < 0) failingPostNonce = n;
    }
    if (nonce < 0) throw new Error('post PoW search exhausted');

    validPost = { ...basePost, powNonce: nonce };
    validPost.signature = new Uint8Array(
      sign(null, signingHash(validPost), createPrivateKey({
        key: Buffer.from(keyPair.secretKey), format: 'der', type: 'pkcs8',
      })),
    );
    validSubBlock = subBlockFromPost(validPost, computePostId(validPost));
  }, 120_000);

  function validateSubBlock(sb: SubBlock) {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.subblock)!;
    const peer = newPeer(peerMgr);
    const result = validate(peer, { data: encodeSubBlock(sb) });
    return { result, peer, peerMgr, penaltySpy };
  }

  it('accepts a mined, signed sub-block with zero penalties (control anchor)', () => {
    const { result, peer, peerMgr, penaltySpy } = validateSubBlock(validSubBlock);
    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  it('rejects the same sub-block with a corrupted signature (pre-fix code Accepted this)', () => {
    // Vacuity evidence: against pre-fix gossip.ts this exact message was
    // ACCEPTED and forwarded — runStage1SubBlock never called
    // verifyPostSignature, and the PoW preimage excludes the signature, so
    // every check that did run still passes here. The single-field-delta
    // control that Accepts is the real-signature case above. This is the
    // NET_INTERFACE Stage-1 drift being closed.
    const badSig = new Uint8Array(validPost.signature);
    badSig[0] = badSig[0]! ^ 0xff;
    const sb: SubBlock = {
      ...validSubBlock,
      post: { ...validPost, signature: badSig },
    };

    const { result, peer, penaltySpy } = validateSubBlock(sb);

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Signature invalid');
  });

  it('rejects a wrong post PoW nonce before the signature check runs', () => {
    // Self-check the nonce genuinely fails, then confirm the reason is the
    // PoW gate — the anti-spam check stays in front of the ~50µs signature.
    expect(verifyPoW(postPowPreimage(validPost), failingPostNonce, POST_POW_TARGET_BITS)).toBe(false);
    const sb: SubBlock = {
      ...validSubBlock,
      post: { ...validPost, powNonce: failingPostNonce },
    };

    const { result, peer, penaltySpy } = validateSubBlock(sb);

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Proof of Work invalid');
  });

  // Regression coverage from the pre-rewrite suite, now driven through the
  // real registered validator instead of an inline copy. Each delta trips a
  // check that runs before PoW, so the unmined variants stay cheap; the
  // asserted reason string pins the rejection to the intended check.

  it('rejects empty content', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, content: '' } };
    const { result, peer, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Content is empty');
  });

  it('rejects content exceeding 300 bytes', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, content: 'x'.repeat(301) } };
    const { result, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects too many parent refs', () => {
    const refs = Array.from({ length: 9 }, () => 'ab'.repeat(32));
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, parentRefs: refs } };
    const { result, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported protocol version', () => {
    const sb: SubBlock = { ...validSubBlock, post: { ...validPost, protocolVersion: 999 } };
    const { result, peer, penaltySpy } = validateSubBlock(sb);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'Unsupported protocol version',
    );
  });

  it('rejects a sub-block with a missing post', () => {
    const { post: _post, ...rest } = validSubBlock;
    const { result, peer, penaltySpy } = validateSubBlock(rest as SubBlock);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Sub-block missing post');
  });
});

// ---------------------------------------------------------------------------
// Sub-block topic validator — per-network post difficulty (the A6 twin)
// ---------------------------------------------------------------------------

describe('sub-block topic validator (per-network post difficulty)', () => {
  const DEVNET_TARGET_BITS = 8;

  let devnetSubBlock: SubBlock;

  beforeAll(() => {
    const kp = generateKeyPair();
    const basePost: Post = {
      content: 'devnet-difficulty fixture',
      author: kp.publicKey,
      parentRefs: [],
      challenge: new Uint8Array(32).fill(3),
      powNonce: 0,
      protocolVersion: 1,
      timestamp: 1_722_470_400_000,
      signature: new Uint8Array(64),
    };

    // Find a nonce that meets the devnet target but provably NOT the mainnet
    // POST_POW_TARGET_BITS — the fixture a devnet user actually mines (~256
    // tries at 8 bits; skipping the rare nonce that also clears the mainnet
    // target keeps the fixture's property explicit, not probabilistic).
    const powInput = postPowPreimage(basePost);
    let nonce = -1;
    for (let n = 0; n < 10_000_000; n++) {
      if (verifyPoW(powInput, n, DEVNET_TARGET_BITS) && !verifyPoW(powInput, n, POST_POW_TARGET_BITS)) {
        nonce = n;
        break;
      }
    }
    if (nonce < 0) throw new Error('devnet PoW search exhausted');

    const post: Post = { ...basePost, powNonce: nonce };
    post.signature = new Uint8Array(
      sign(null, signingHash(post), createPrivateKey({
        key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8',
      })),
    );
    devnetSubBlock = subBlockFromPost(post, computePostId(post));
  });

  it('accepts a post mined at the configured non-mainnet target (devnet relays its own posts)', () => {
    // Pre-fix, runStage1SubBlock verified against the imported
    // POST_POW_TARGET_BITS, so a devnet relay rejected every post its own
    // network mined. The fixture meets 8 bits and provably not the mainnet
    // target — this Accept holds only if the gate reads the configured value.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(DEVNET_TARGET_BITS);
    const validate = topicValidators.get(TOPICS.subblock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: encodeSubBlock(devnetSubBlock) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('rejects the same post at the mainnet target (difficulty still gates relay)', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(POST_POW_TARGET_BITS);
    const validate = topicValidators.get(TOPICS.subblock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: encodeSubBlock(devnetSubBlock) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, 'Proof of Work invalid');
  });
});

// ---------------------------------------------------------------------------
// Dispatch listener — Phase 1f-3b, the catch whose comment promised a log
//
// The catch at the end of the `gossipsub:message` listener read:
//
//     } catch {
//       // Decode failure here would indicate a validator bug — the message
//       // already passed the topic validator.  Log and move on.
//     }
//
// There was no log. So the one condition the comment names produced complete
// silence, and — because the `try` spanned the handler call as well, which the
// comment never claimed — so did every throw out of an app-layer handler.
//
// These tests drive the REAL listener registered by subscribeTopics. The
// harness above stubs `addEventListener`, so the listener was never captured
// and none of this path had any coverage; this one captures it.
// ---------------------------------------------------------------------------

type GossipListener = (evt: {
  detail: { msg: { topic: string; data: Uint8Array; from?: { toString(): string } } };
}) => void;

function makeDispatchHarness(handlers: {
  onSubBlock?: (sb: SubBlock) => void;
  onOrderingBlock?: (block: OrderingBlock) => void;
  onTx?: (tx: unknown) => void;
} = {}) {
  let listener: GossipListener | null = null;
  const stub = {
    services: {
      pubsub: {
        topicValidators: new Map(),
        subscribe: () => {},
        addEventListener: (_name: string, fn: GossipListener) => {
          listener = fn;
        },
      },
    },
  } as unknown as Libp2pGossip;

  const peerMgr = new PeerManager(makeConfig());
  subscribeTopics(
    stub,
    validators,
    peerMgr,
    {
      onSubBlock: handlers.onSubBlock ?? (() => {}),
      onOrderingBlock: handlers.onOrderingBlock ?? (() => {}),
      onTx: handlers.onTx ?? (() => {}),
    },
    POST_POW_TARGET_BITS,
  );

  // `from` is left undefined so the Active-peer filter is skipped — this suite
  // is about what happens after a message is accepted for dispatch, and peer
  // state has its own tests.
  const deliver = (topic: string, data: Uint8Array): void => {
    if (!listener) throw new Error('subscribeTopics registered no message listener');
    listener({ detail: { msg: { topic, data } } });
  };

  return { deliver };
}

describe('gossip dispatch listener', () => {
  const dispatchHeader: BlockHeader = {
    protocolVersion: 1,
    height: 3,
    prevBlockHash: '44'.repeat(32),
    subBlockRoot: '55'.repeat(32),
    utxoTxRoot: '66'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_722_470_400_000,
  };
  const dispatchBlock: OrderingBlock = {
    header: dispatchHeader,
    subBlockTree: { subBlockRefs: [], subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: { utxoTxIds: [], utxoTxs: [], coinbaseOutputs: [] },
    validatorSignature: new Uint8Array(64),
  };

  it('delivers a decoded ordering block to the handler', () => {
    // Positive control: the routing still works after the restructure. Without
    // this, a `deliver` that silently did nothing would satisfy the two
    // error-path tests below.
    const seen: OrderingBlock[] = [];
    const { deliver } = makeDispatchHarness({ onOrderingBlock: (b) => seen.push(b) });

    deliver(TOPICS.orderingBlock, encodeOrderingBlock(dispatchBlock));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.header.height).toBe(3);
  });

  it('logs when a handler throws, instead of absorbing it silently', () => {
    // Pre-fix this produced no output of any kind: the handler call sat inside
    // a `try` whose `catch` had an empty body.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deliver } = makeDispatchHarness({
      onOrderingBlock: () => {
        throw new Error('handler exploded');
      },
    });

    // Contained, not propagated — this is a gossipsub event listener, and one
    // bad message must degrade one message rather than the subsystem.
    expect(() => deliver(TOPICS.orderingBlock, encodeOrderingBlock(dispatchBlock))).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('handler exploded'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`handler for '${TOPICS.orderingBlock}' threw`),
    );
    errSpy.mockRestore();
  });

  it('logs a post-validator decode failure as the validator bug it is', () => {
    // Reaching the decode catch means a topic validator accepted bytes it could
    // not itself decode. The comment always said so; now the code says it too,
    // and says it loudly, because silence is the worst possible response to
    // "one of our own gates is wrong".
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let handlerCalls = 0;
    const { deliver } = makeDispatchHarness({ onOrderingBlock: () => { handlerCalls++; } });

    expect(() => deliver(TOPICS.orderingBlock, new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow();

    expect(handlerCalls).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('BUG'));
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('passed its topic validator and then failed to decode'),
    );
    errSpy.mockRestore();
  });

  it('ignores a topic it does not route', () => {
    const { deliver } = makeDispatchHarness({
      onOrderingBlock: () => { throw new Error('must not run'); },
    });
    expect(() => deliver('/dagsocial/not-a-topic/1', new Uint8Array([1, 2, 3]))).not.toThrow();
  });
});
