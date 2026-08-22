import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createPrivateKey, sign } from 'crypto';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import {
  generateKeyPair,
  encodeTxPacket,
  decodeTxPacket,
  computeContentHash,
  ReaderError,
  encodeOrderingBlock,
  decodeOrderingBlock,
  EMPTY_STATE_ROOT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';
import type {
  PostCommit, UtxoTransaction, OrderingBlock, BlockHeader, UtxoTxTree,
} from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import { subscribeTopics, TOPICS } from '../src/gossip.js';
import type { Libp2pGossip } from '../src/gossip.js';
import { PeerManager } from '../src/peer-mgr.js';
import { PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';

// These tests drive the REAL topic validators registered by subscribeTopics —
// not an inline copy of their bodies. A copied harness would contain the fix
// under test and pass by construction; here every assertion runs the same
// closures production gossipsub invokes, over wire-encoded messages, against
// the real @dagsocial/validation functions and a real PeerManager.

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
};

function makeConfig(): NetConfig {
  return {
    magic: 0x54444147,
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

function makeHarness(karmaMembers: Set<string> = new Set()) {
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
    onOrderingBlock: () => {},
    onTx: () => {},
  }, karmaMembers);

  const penaltySpy = vi.spyOn(peerMgr, 'recordPenalty');
  return { topicValidators, peerMgr, penaltySpy, karmaMembers };
}

let peerSeq = 0;
function newPeer(peerMgr: PeerManager): { id: string; toString(): string } {
  const id = `test-peer-${peerSeq++}`;
  peerMgr.addPeer({ id, multiaddrs: [], protocols: [], connectedAt: Date.now() });
  return { id, toString: () => id };
}

// Every block carries at least one transaction, because the settlement is one
// (VALIDATION_INTERFACE → verifyOrderingBlockStructure;
// NODE_INTERFACE → It is the LAST entry in `utxoTxIds`). A body with none is
// refused at Stage 1, so an empty-body fixture cannot stand in for a block a
// peer relayed.
//
// Stage 1 never decodes an element: `utxoTxs` is `arr(utxoTxs, lp)`, opaque
// length-prefixed bytes weighed as they arrived, so the payload here is a
// plausible size and nothing more. The id is what `utxoTxRoot` would commit.
function settlementBody(): UtxoTxTree {
  return {
    utxoTxIds: ['5e'.repeat(32)],
    utxoTxs: [new Uint8Array(96).fill(0x5e)],
    pruneEntries: [],
  };
}

// ---------------------------------------------------------------------------
// Ordering-block topic validator — relay PoW gate (audit M-9, M-6)
// ---------------------------------------------------------------------------

describe('ordering-block topic validator (relay PoW gate)', () => {
  const baseHeader: BlockHeader = {
    protocolVersion: 1,
    height: 7,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: '33'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(9),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR, // the structure floor
    createdAt: 1_722_470_400_000,
  };

  function makeBlock(header: BlockHeader): OrderingBlock {
    return {
      header,
      utxoTxTree: settlementBody(),
      // 64-byte dummy — Stage 1 does not verify the validator signature.
      validatorSignature: new Uint8Array(64),
    };
  }

  let minedNonce = -1;
  let failingNonce = -1;

  beforeAll(() => {
    // Mine the real nonce at the structure floor and record a genuinely
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
    // The single-field-delta control that Accepts is the mined-nonce case
    // above.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(TOPICS.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // `powNonce` is a `vlqU` field and `NaN` is outside its encodable domain,
    // so it writes `VLQ_SENTINEL` — ten bytes past `MAX_SAFE_INTEGER` — which
    // `readVlqU` refuses to decode. The message dies at the decode boundary and
    // never reaches `verifyOrderingBlockStructure` at all.
    //
    // The verdict is therefore a permanent ban rather than a 100-point
    // misbehavior penalty, and that is the decided semantics
    // (NET_INTERFACE → Stage 1): where the serializer is the validator
    // (ARCHITECTURE → Wire Format), bytes that do not decode are malformed
    // rather than merely bogus. The one-way sentinel is what makes it safe — a
    // malformed value encodes, but its encoding decodes to nothing, so it can
    // never impersonate a well-formed header.
    const block = makeBlock({ ...baseHeader, powNonce: Number.NaN });
    const encoded = encodeOrderingBlock(block);

    expect(() => decodeOrderingBlock(encoded)).toThrow(ReaderError);

    const banSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const result = validate(peer, { data: encoded });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(banSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation, peer.id, expect.stringContaining('malformed ordering block'),
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
    //
    // `height` is a `vlqU` row, so NaN and 1.5 are outside its encodable domain
    // and sentinel on encode with no decoding — no peer can put either on the
    // wire, and the verdict is a permanent ban rather than a misbehavior
    // penalty, for the reason given above the powNonce case.
    //
    // The struct is therefore also checked directly below, driving the real
    // `verifyOrderingBlockStructure` (the harness injects the package, not a
    // stub): the structure gate independently rejects both values by name, and
    // its distinct reason string is what proves the rejection is attributable
    // to height rather than to PoW, which the height change also breaks. That
    // attribution is the property this test exists for, and it holds as a
    // subset argument rather than as a claim about two values — `isU64Safe`
    // rejects everything `Number.isSafeInteger` rejects, and more.
    const block = makeBlock({ ...baseHeader, powNonce: minedNonce, height: badHeight });

    expect(verifyOrderingBlockStructure(block)).toEqual({
      valid: false, error: 'Ordering block invalid height',
    });

    const banSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(banSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation, peer.id, expect.stringContaining('malformed ordering block'),
    );
  });
});

// ---------------------------------------------------------------------------
// Transaction topic validator — the post relay gate (membership, not PoW)
//
// ⛔ **The gate that replaces post PoW, and it is the easiest thing in this unit
// to test vacuously.** A set that is always empty rejects everything and a set
// that is always full accepts everything, and a fixture that only ever exercises
// one side passes either way. All four cells are asserted below — known author
// admitted, unknown author dropped, an author ADDED at runtime then admitted, an
// author REMOVED then dropped — because the add/remove pair is the only thing
// that proves the gate reads the live set rather than a constant, and the only
// thing that proves `NetNode`'s mutators are connected to the path that drops.
// ---------------------------------------------------------------------------

describe('tx topic validator — the post membership gate', () => {
  let keyPair: ReturnType<typeof generateKeyPair>;
  let authorHex: string;
  let postTx: UtxoTransaction;
  let postContent: string;
  let plainTx: UtxoTransaction;

  const DEFAULT_CONTENT = 'gossip relay-gate fixture';

  const baseCommit = (author: Uint8Array, content: string = DEFAULT_CONTENT): PostCommit => ({
    contentHash: computeContentHash(content),
    author,
    parentRefs: [],
    protocolVersion: 1,
    type: 'regular' as const,
  });

  const txWith = (post?: PostCommit): UtxoTransaction => ({
    inputs: ['aa'.repeat(32)],
    outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: new Uint8Array(32).fill(1) } as never],
    signatures: {},
    protocolVersion: 1,
    ...(post ? { post } : {}),
  });

  beforeAll(() => {
    keyPair = generateKeyPair();
    authorHex = Buffer.from(keyPair.publicKey).toString('hex');
    postTx = txWith(baseCommit(keyPair.publicKey));
    postContent = DEFAULT_CONTENT;
    plainTx = txWith();
  });

  const validatePacket = (tx: UtxoTransaction, content: string | undefined, members: Set<string>) => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(members);
    const validate = topicValidators.get(TOPICS.tx)!;
    const peer = newPeer(peerMgr);
    const result = validate(peer, { data: encodeTxPacket(tx, content) });
    return { result, peer, peerMgr, penaltySpy };
  };

  // --- cell 1: a known author is admitted -----------------------------------

  it('accepts a post from an author IN the karma set, with zero penalties', () => {
    const { result, peer, peerMgr, penaltySpy } = validatePacket(postTx, postContent, new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  // --- cell 2: an unknown author is dropped ---------------------------------

  it('rejects the SAME post when its author is not in the set', () => {
    const { result, peer, penaltySpy } = validatePacket(postTx, postContent, new Set());
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'post author holds no karma',
    );
  });

  it('rejects a post whose author is in the set under a DIFFERENT spelling', () => {
    const { result } = validatePacket(postTx, postContent, new Set([authorHex.toUpperCase()]));
    expect(result).toBe(TopicValidatorResult.Reject);
  });

  // --- cell 3 and 4: the set is LIVE, not captured ---------------------------

  it('admits an author ADDED after the validator was registered', () => {
    const members = new Set<string>();
    const { topicValidators, peerMgr } = makeHarness(members);
    const validate = topicValidators.get(TOPICS.tx)!;
    const packetData = encodeTxPacket(postTx, postContent);

    expect(validate(newPeer(peerMgr), { data: packetData }))
      .toBe(TopicValidatorResult.Reject);

    members.add(authorHex);

    expect(validate(newPeer(peerMgr), { data: packetData }))
      .toBe(TopicValidatorResult.Accept);
  });

  it('drops an author REMOVED after the validator was registered', () => {
    const members = new Set<string>([authorHex]);
    const { topicValidators, peerMgr } = makeHarness(members);
    const validate = topicValidators.get(TOPICS.tx)!;
    const packetData = encodeTxPacket(postTx, postContent);

    expect(validate(newPeer(peerMgr), { data: packetData }))
      .toBe(TopicValidatorResult.Accept);

    members.delete(authorHex);

    expect(validate(newPeer(peerMgr), { data: packetData }))
      .toBe(TopicValidatorResult.Reject);
  });

  // --- the biconditional's other half ---------------------------------------

  it('a transaction with NO post is not gated by membership at all', () => {
    const empty = new Set<string>();
    expect(validatePacket(postTx, postContent, empty).result).toBe(TopicValidatorResult.Reject);
    expect(validatePacket(plainTx, undefined, empty).result).toBe(TopicValidatorResult.Accept);
  });

  // --- structure still gates, ahead of membership ---------------------------

  it('rejects an over-long body before consulting the set', () => {
    const longContent = 'x'.repeat(301);
    const tx = txWith(baseCommit(keyPair.publicKey, longContent));
    const { result, peer, penaltySpy } = validatePacket(tx, longContent, new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, expect.stringContaining('Content'),
    );
  });

  it('a 31-byte author has no encoding, so the gate is never handed one', () => {
    const tx = txWith(baseCommit(new Uint8Array(31).fill(4)));
    expect(() => encodeTxPacket(tx, 'test')).toThrow(/32 bytes/);

    expect(decodeTxPacket(encodeTxPacket(postTx, postContent)).tx.post!.author.length).toBe(32);
  });

  it('rejects an unsupported protocol version', () => {
    const tx = { ...txWith(baseCommit(keyPair.publicKey)), protocolVersion: 99 };
    const { result, peer, penaltySpy } = validatePacket(tx, postContent, new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'unsupported protocol version',
    );
  });

  it('there is no sub-block topic to subscribe to', () => {
    const { topicValidators } = makeHarness(new Set([authorHex]));
    expect([...topicValidators.keys()].sort()).toEqual([TOPICS.orderingBlock, TOPICS.tx].sort());
    expect(topicValidators.has('/dagsocial/subblock/1')).toBe(false);
  });

  // --- packet biconditional and body verification ---

  it('rejects a post without a body (biconditional)', () => {
    // tx.post present, content absent → misbehaviour
    const { result, peer, penaltySpy } = validatePacket(postTx, undefined, new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'post without body',
    );
  });

  it('rejects a body without a post (biconditional)', () => {
    // tx.post absent, content present → misbehaviour
    const { result, peer, penaltySpy } = validatePacket(plainTx, 'orphan body', new Set());
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'body without post',
    );
  });

  it('rejects a body that fails verifyPostBody (hash mismatch)', () => {
    const { result, peer, penaltySpy } = validatePacket(postTx, 'wrong content', new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, expect.stringContaining('hash'),
    );
  });

  it('a non-post packet delivers content === undefined', () => {
    const seen: Array<{ content: string | undefined }> = [];
    const { topicValidators, peerMgr } = makeHarness(new Set());
    const validate = topicValidators.get(TOPICS.tx)!;
    const peer = newPeer(peerMgr);
    const result = validate(peer, { data: encodeTxPacket(plainTx) });
    expect(result).toBe(TopicValidatorResult.Accept);
  });

  it('structure failure fires before body failure', () => {
    // A tx that fails both structure (bad parentRefs count) and would also fail
    // body — only the structure error is reported.
    const badCommit: PostCommit = {
      contentHash: computeContentHash('test'),
      author: keyPair.publicKey,
      parentRefs: ['aa'.repeat(32), 'bb'.repeat(32)],
      protocolVersion: 1,
      type: 'regular' as const,
    };
    const tx = txWith(badCommit);
    const { result, peer, penaltySpy } = validatePacket(tx, 'wrong content', new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, expect.stringContaining('parent ref'),
    );
  });
});

// ---------------------------------------------------------------------------
// Dispatch listener — decode failure and handler throw, contained separately
//
// The `gossipsub:message` listener gives each its own span and logs both: a
// decode failure past the topic validator is our bug, a handler throw is the
// app layer's, and one span over both would report neither.
//
// These tests drive the REAL listener registered by `subscribeTopics`. The
// harness above stubs `addEventListener` and so never captures the listener,
// which leaves this path uncovered; this one captures it.
// ---------------------------------------------------------------------------

type GossipListener = (evt: {
  detail: {
    propagationSource?: { toString(): string };
    msg: { topic: string; data: Uint8Array; from?: { toString(): string } };
  };
}) => void;

const RELAY_PEER = 'peer-that-relayed-it';

function makeDispatchHarness(handlers: {
  onOrderingBlock?: (block: OrderingBlock, fromPeerId: string) => void;
  onTx?: (tx: unknown, content: string | undefined, fromPeerId: string) => void;
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
      onOrderingBlock: handlers.onOrderingBlock ?? (() => {}),
      onTx: handlers.onTx ?? (() => {}),
    },
    new Set<string>(),
  );

  // `from` is left undefined so the Active-peer filter is skipped — this suite
  // is about what happens after a message is accepted for dispatch, and peer
  // state has its own tests. `propagationSource` is the peer that relayed the
  // message to us, which is the value the ordering-block handler receives; it is
  // a separate field precisely because it is a different peer.
  // `null` is how a caller asks for an event with no source at all — an explicit
  // `undefined` would take the default, which is the opposite of the request.
  const deliver = (
    topic: string,
    data: Uint8Array,
    propagationSource: { toString(): string } | null = { toString: () => RELAY_PEER },
  ): void => {
    if (!listener) throw new Error('subscribeTopics registered no message listener');
    listener({
      detail: { propagationSource: propagationSource ?? undefined, msg: { topic, data } },
    });
  };

  return { deliver };
}

describe('gossip dispatch listener', () => {
  const dispatchHeader: BlockHeader = {
    protocolVersion: 1,
    height: 3,
    prevBlockHash: '44'.repeat(32),
    utxoTxRoot: '66'.repeat(32),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_722_470_400_000,
  };
  const dispatchBlock: OrderingBlock = {
    header: dispatchHeader,
    utxoTxTree: settlementBody(),
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

  it('hands the handler the peer that relayed the block, not its publisher', () => {
    // `propagationSource` is what fork resolution asks for the competing chain,
    // because that peer provably holds one. `msg.from` — the original publisher
    // — need not be connected to us at all, and this asserts which of the two
    // arrives.
    const seen: string[] = [];
    const { deliver } = makeDispatchHarness({ onOrderingBlock: (_b, from) => seen.push(from) });

    deliver(TOPICS.orderingBlock, encodeOrderingBlock(dispatchBlock));

    expect(seen).toEqual([RELAY_PEER]);
  });

  it('degrades rather than throwing when the event carries no source', () => {
    // gossipsub's own type makes the field required, so an event without it is a
    // broken event — and net's invariant is that one bad message degrades one
    // message, never the listener.
    const seen: string[] = [];
    const { deliver } = makeDispatchHarness({ onOrderingBlock: (_b, from) => seen.push(from) });

    expect(() =>
      deliver(TOPICS.orderingBlock, encodeOrderingBlock(dispatchBlock), null),
    ).not.toThrow();

    expect(seen).toEqual(['']);
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

  it('hands the tx handler the peer that relayed the transaction', () => {
    const plainTx: UtxoTransaction = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: new Uint8Array(32).fill(1) } as never],
      signatures: {},
      protocolVersion: 1,
    };
    const seen: string[] = [];
    const { deliver } = makeDispatchHarness({ onTx: (_tx, _content, from) => seen.push(from) });

    deliver(TOPICS.tx, encodeTxPacket(plainTx));

    expect(seen).toEqual([RELAY_PEER]);
  });

  it('delivers empty string when the tx event carries no source', () => {
    const plainTx: UtxoTransaction = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: new Uint8Array(32).fill(1) } as never],
      signatures: {},
      protocolVersion: 1,
    };
    const seen: string[] = [];
    const { deliver } = makeDispatchHarness({ onTx: (_tx, _content, from) => seen.push(from) });

    deliver(TOPICS.tx, encodeTxPacket(plainTx), null);

    expect(seen).toEqual(['']);
  });

  it('ignores a topic it does not route', () => {
    const { deliver } = makeDispatchHarness({
      onOrderingBlock: () => { throw new Error('must not run'); },
    });
    expect(() => deliver('/dagsocial/not-a-topic/1', new Uint8Array([1, 2, 3]))).not.toThrow();
  });
});
