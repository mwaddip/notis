import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyHeaderFieldDomains,
  verifyOrderingBlockStructure,
  verifyValidatorSignature,
  verifyUtxoTxRoot,
  verifyPostBody,
  blockHash,
} from '@dagsocial/validation';
import {
  generateKeyPair,
  encodeTxPacket,
  decodeTxPacket,
  computeContentHash,
  computeUtxoTxRoot,
  ReaderError,
  encodeHeader,
  encodeOrderingBlock,
  encodeUtxoTxTree,
  decodeOrderingBlock,
  hexToBytes,
  ByteWriter,
  writeLp,
  writeBytesNOrThrow,
  EMPTY_STATE_ROOT,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  MAX_HEADER_BYTES,
  MAX_ORDERING_BLOCK_BYTES,
  MAX_TX_PACKET_BYTES,
} from '@dagsocial/types';
import type {
  PostCommit, UtxoTransaction, OrderingBlock, BlockHeader, UtxoTxTree, ProtocolEra,
} from '@dagsocial/types';
import { TopicValidatorResult } from '@libp2p/interface';
import {
  subscribeTopics,
  gossipTopics,
  gossipMessageId,
  GOSSIP_SEEN_WINDOW_MS,
} from '../src/gossip.js';
import type { Libp2pGossip } from '../src/gossip.js';
import { PeerManager } from '../src/peer-mgr.js';
import { PenaltyKind } from '../src/types.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// The topics the harness runs under — the testnet pair `makeConfig()` carries
// (NET_INTERFACE → Gossip Topics → "A topic is named for its network").
const topics = gossipTopics(MAGIC_TESTNET);

// These tests drive the REAL topic validators registered by subscribeTopics —
// not an inline copy of their bodies. A copied harness would contain the fix
// under test and pass by construction; here every assertion runs the same
// closures production gossipsub invokes, over wire-encoded messages, against
// the real @dagsocial/validation functions and a real PeerManager.

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

function makeConfig(): NetConfig {
  return makeBaseConfig({ penaltyScoreThreshold: 1000, penaltySafeIntervalMs: 0 });
}

type CapturedValidator = (
  peer: { toString(): string },
  msg: { data: Uint8Array },
) => TopicValidatorResult;

function makeHarness(
  karmaMembers: Set<string> = new Set(),
  opts: {
    schedule?: readonly ProtocolEra[];
    chainHeight?: () => number;
    penaltyScoreThreshold?: number;
    floorBits?: number;
    scheduledTargetBits?: (header: BlockHeader) => number | null;
    // The header-standing seam (NET_INTERFACE → Sync Handler Registration).
    headerStanding?: (hash: string, height: number) => 'held' | 'refused' | null;
    // The clock behind the memory of accepted headers
    // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored").
    nowMs?: () => number;
  } = {},
) {
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

  const config = opts.penaltyScoreThreshold !== undefined
    ? { ...makeConfig(), penaltyScoreThreshold: opts.penaltyScoreThreshold }
    : makeConfig();
  const peerMgr = new PeerManager(config);
  subscribeTopics(stub, validators, peerMgr, {
    onOrderingBlock: () => {},
    onTx: () => {},
  }, topics, karmaMembers,
    opts.schedule ?? [{ version: 1, fromHeight: 0 }],
    opts.chainHeight ?? (() => 0),
    opts.floorBits ?? ORDERING_BLOCK_POW_TARGET_FLOOR,
    opts.scheduledTargetBits ?? (() => null),
    opts.headerStanding ?? (() => null),
    opts.nowMs ?? Date.now);

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
// plausible size and nothing more. The id and the bytes are what `utxoTxRoot`
// commits (TYPES_INTERFACE → Ordering block).
function settlementBody(): UtxoTxTree {
  return {
    utxoTxIds: ['5e'.repeat(32)],
    utxoTxs: [new Uint8Array(96).fill(0x5e)],
  };
}

// The settlement body's root — the one a header carrying this body commits
// (TYPES_INTERFACE → Ordering block). Computed once because the body is a
// constant across the fixtures of this file.
const SETTLEMENT_ROOT = computeUtxoTxRoot(settlementBody());

// The module-level validator key the fixtures carry (NET_INTERFACE → Stage 1 →
// "A header is read before its body"). Each fixture mines a header under
// `MODULE_VALIDATOR_KP.publicKey` and signs it with `MODULE_VALIDATOR_SEED`,
// so the signature verifies by `verifyValidatorSignature`.
const MODULE_VALIDATOR_KP = generateKeyPair();
const MODULE_VALIDATOR_SEED = MODULE_VALIDATOR_KP.secretKey.subarray(16);

function signHeader(header: BlockHeader): Uint8Array {
  const hash = blockHash(header);
  // A header outside the encodable domain has no block hash to sign — the
  // fixtures that pin that case (powNonce NaN, height 1.5) run before the
  // signature check, so a 64-zero stand-in is what reaches the frame.
  if (hash === null) return new Uint8Array(64);
  return ed25519.sign(hexToBytes(hash), MODULE_VALIDATOR_SEED);
}

// ---------------------------------------------------------------------------
// Ordering-block topic validator — relay PoW gate (audit M-9, M-6)
// ---------------------------------------------------------------------------

describe('ordering-block topic validator (relay PoW gate)', () => {
  const baseHeader: BlockHeader = {
    protocolVersion: 1,
    height: 7,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: SETTLEMENT_ROOT,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: MODULE_VALIDATOR_KP.publicKey,
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR, // the structure floor
    createdAt: 1_722_470_400_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };

  function makeBlock(header: BlockHeader): OrderingBlock {
    return {
      header,
      utxoTxTree: settlementBody(),
      validatorSignature: signHeader(header),
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
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(peerMgr.getPeerMetadata(peer.id)!.penaltyCount).toBe(0);
  });

  it('rejects the same block with a wrong nonce and records one misbehavior penalty', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(topics.orderingBlock)!;
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
    const validate = topicValidators.get(topics.orderingBlock)!;
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
    const validate = topicValidators.get(topics.orderingBlock)!;
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
    const validate = topicValidators.get(topics.tx)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const result = validate(peer, { data: encodeTxPacket(tx, content) });
    return { result, peer, peerMgr, penaltySpy, kindSpy };
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
    const validate = topicValidators.get(topics.tx)!;
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
    const validate = topicValidators.get(topics.tx)!;
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
    // era at chainHeight()+1 = 0+1 = 1; the tx declares 99. A version mismatch is
    // a compatibility signal — Transient (50), not misbehavior (100).
    const tx = { ...txWith(baseCommit(keyPair.publicKey)), protocolVersion: 99 };
    const { result, peer, penaltySpy, kindSpy } = validatePacket(tx, postContent, new Set([authorHex]));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).toHaveBeenCalledWith(
      PenaltyKind.Transient, peer.id, expect.stringContaining('era 1'),
    );
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('there is no sub-block topic to subscribe to', () => {
    // NET_INTERFACE → Gossip Topics — the reservation guard: a topic named
    // `subblock` under this node's magic has no validator registered.
    const { topicValidators } = makeHarness(new Set([authorHex]));
    expect([...topicValidators.keys()].sort()).toEqual([topics.orderingBlock, topics.tx].sort());
    const subblock = `/dagsocial/${MAGIC_TESTNET.toString(16).padStart(8, '0')}/subblock/1`;
    expect(topicValidators.has(subblock)).toBe(false);
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
    const { topicValidators, peerMgr } = makeHarness(new Set());
    const validate = topicValidators.get(topics.tx)!;
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
    topics,
    new Set<string>(),
    [{ version: 1, fromHeight: 0 }],
    () => 0,
    ORDERING_BLOCK_POW_TARGET_FLOOR,
    () => null,
  );

  // `propagationSource` is the peer that relayed the message to us — the one
  // value handed on as the handler's `fromPeerId` (NET_INTERFACE → Inbound
  // Processing). The gossip event names the carrier and no publisher.
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

  return { deliver, peerMgr };
}

describe('gossip dispatch listener', () => {
  const dispatchHeader: BlockHeader = {
    protocolVersion: 1,
    height: 3,
    prevBlockHash: '44'.repeat(32),
    utxoTxRoot: SETTLEMENT_ROOT,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(1),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_722_470_400_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
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

    deliver(topics.orderingBlock, encodeOrderingBlock(dispatchBlock));

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

    deliver(topics.orderingBlock, encodeOrderingBlock(dispatchBlock));

    expect(seen).toEqual([RELAY_PEER]);
  });

  it('degrades rather than throwing when the event carries no source', () => {
    // gossipsub's own type makes the field required, so an event without it is a
    // broken event — and net's invariant is that one bad message degrades one
    // message, never the listener.
    const seen: string[] = [];
    const { deliver } = makeDispatchHarness({ onOrderingBlock: (_b, from) => seen.push(from) });

    expect(() =>
      deliver(topics.orderingBlock, encodeOrderingBlock(dispatchBlock), null),
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
    expect(() => deliver(topics.orderingBlock, encodeOrderingBlock(dispatchBlock))).not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('handler exploded'),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(`handler for '${topics.orderingBlock}' threw`),
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

    expect(() => deliver(topics.orderingBlock, new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow();

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

    deliver(topics.tx, encodeTxPacket(plainTx));

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

    deliver(topics.tx, encodeTxPacket(plainTx), null);

    expect(seen).toEqual(['']);
  });

  it('ignores a topic it does not route', () => {
    const { deliver } = makeDispatchHarness({
      onOrderingBlock: () => { throw new Error('must not run'); },
    });
    expect(() => deliver('/dagsocial/not-a-topic/1', new Uint8Array([1, 2, 3]))).not.toThrow();
  });

  it('delivers although the carrier is not an Active peer', () => {
    // NET_INTERFACE → Inbound Processing →
    // "A gossip message that passes Stage 1 is delivered, whichever peer carried it"
    // The handler fires with the carrier's id, and the membership of the
    // Active set has no bearing on delivery.
    const seen: string[] = [];
    const { deliver, peerMgr } = makeDispatchHarness({
      onOrderingBlock: (_b, from) => seen.push(from),
    });
    // A Connecting peer whose handshake has not completed — present in the
    // manager's row, not Active.
    peerMgr.addPeer({
      id: RELAY_PEER,
      multiaddrs: [],
      protocols: [],
      connectedAt: Date.now(),
    });
    expect(peerMgr.isPeerActive(RELAY_PEER)).toBe(false);

    deliver(topics.orderingBlock, encodeOrderingBlock(dispatchBlock));

    expect(seen).toEqual([RELAY_PEER]);
  });
});

// ---------------------------------------------------------------------------
// Version gate — NET_INTERFACE → Stage 1; → Peer Penalty System
//
// A declared version that is not its era is a compatibility signal, Rejected
// with PenaltyKind.Transient (50), never the misbehavior tier (100). The block
// header is keyed on its own height; the tx on the next block's, chainHeight()+1.
// A synthetic two-era schedule [1@0, 2@H] exercises the boundary without a
// placeholder version.
// ---------------------------------------------------------------------------

describe('version gate — a mismatch is Transient (50), not misbehavior (100)', () => {
  const H = 5;
  const twoEra: readonly ProtocolEra[] = [
    { version: 1, fromHeight: 0 },
    { version: 2, fromHeight: H },
  ];

  const vHeader = (height: number, protocolVersion: number): BlockHeader => ({
    protocolVersion,
    height,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: SETTLEMENT_ROOT,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: new Uint8Array(32).fill(9),
    powNonce: 0,
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_722_470_400_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  });
  const vBlock = (height: number, protocolVersion: number): OrderingBlock => ({
    header: vHeader(height, protocolVersion),
    utxoTxTree: settlementBody(),
    validatorSignature: new Uint8Array(64),
  });

  let keyPair: ReturnType<typeof generateKeyPair>;
  const CONTENT = 'version-gate fixture';
  beforeAll(() => { keyPair = generateKeyPair(); });

  const vCommit = (protocolVersion: number): PostCommit => ({
    contentHash: computeContentHash(CONTENT),
    author: keyPair.publicKey,
    parentRefs: [],
    protocolVersion,
    type: 'regular' as const,
  });
  const plainTxV = (protocolVersion: number): UtxoTransaction => ({
    inputs: ['aa'.repeat(32)],
    outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: new Uint8Array(32).fill(1) } as never],
    signatures: {},
    protocolVersion,
  });
  const postTxV = (txVersion: number, commitVersion: number): UtxoTransaction => ({
    ...plainTxV(txVersion),
    post: vCommit(commitVersion),
  });

  const runBlock = (block: OrderingBlock) => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), { schedule: twoEra });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const result = validate(peer, { data: encodeOrderingBlock(block) });
    return { result, peer, peerMgr, penaltySpy, kindSpy };
  };
  const runTx = (tx: UtxoTransaction, content: string | undefined, chainHeightVal: number) => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set([Buffer.from(keyPair.publicKey).toString('hex')]), {
      schedule: twoEra,
      chainHeight: () => chainHeightVal,
    });
    const validate = topicValidators.get(topics.tx)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const result = validate(peer, { data: encodeTxPacket(tx, content) });
    return { result, peer, peerMgr, penaltySpy, kindSpy };
  };

  it('rejects block H declaring era 1 (era at H is 2)', () => {
    const { result, peer, penaltySpy, kindSpy } = runBlock(vBlock(H, 1));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).toHaveBeenCalledWith(PenaltyKind.Transient, peer.id, expect.stringContaining('era 2'));
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('rejects block H-1 declaring era 2 (era at H-1 is 1)', () => {
    const { result, peer, penaltySpy, kindSpy } = runBlock(vBlock(H - 1, 2));
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).toHaveBeenCalledWith(PenaltyKind.Transient, peer.id, expect.stringContaining('era 1'));
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('rejects a tx declaring era 1 when chainHeight()+1 = H (era 2)', () => {
    const { result, peer, penaltySpy, kindSpy } = runTx(plainTxV(1), undefined, H - 1);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).toHaveBeenCalledWith(PenaltyKind.Transient, peer.id, expect.stringContaining('era 2'));
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('rejects a tx whose commit declares a different era than its envelope', () => {
    // The envelope declares era 2 (matches), the commit declares 1 — both must
    // equal the era, so the commit alone fails it.
    const { result, peer, penaltySpy, kindSpy } = runTx(postTxV(2, 1), CONTENT, H - 1);
    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).toHaveBeenCalledWith(PenaltyKind.Transient, peer.id, expect.stringContaining('commit 1'));
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('a mismatch accrues 50, not 100: one hit under threshold 75 does not ban, two do', () => {
    // The score that separates Transient from misbehavior. The harness config
    // sets penaltySafeIntervalMs 0, so no decay: 50 + 50 = 100 crosses 75, while
    // a single misbehavior (100) would have banned at the first hit.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      schedule: twoEra,
      penaltyScoreThreshold: 75,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const data = encodeOrderingBlock(vBlock(H, 1));

    validate(peer, { data });
    expect(peerMgr.isBanned(peer.id)).toBe(false); // 50 < 75

    validate(peer, { data });
    expect(peerMgr.isBanned(peer.id)).toBe(true);  // 50 + 50 = 100 >= 75

    expect(penaltySpy).not.toHaveBeenCalled();      // never the misbehavior path
  });

  it('a structurally invalid block is still misbehavior (100), not Transient', () => {
    // The tier split holds only for the version check: a bad body keeps its
    // tier. The input reaches the structure check only once version, floor,
    // PoW and the validator signature stand (NET_INTERFACE → Stage 1); the
    // header below carries a matching version, is mined and signed, and the
    // empty body is what the structure check refuses.
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), { schedule: twoEra });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const emptyTree: UtxoTxTree = { utxoTxIds: [], utxoTxs: [] };
    const baseInvalid: BlockHeader = {
      ...vHeader(1, 1),
      utxoTxRoot: computeUtxoTxRoot(emptyTree),
      validatorId: MODULE_VALIDATOR_KP.publicKey,
    };
    let minedHeader = baseInvalid;
    for (let n = 0; n < 2_000_000; n++) {
      const candidate = { ...baseInvalid, powNonce: n };
      if (verifyOrderingBlockPoW(candidate)) { minedHeader = candidate; break; }
    }
    const bad: OrderingBlock = {
      header: minedHeader,
      utxoTxTree: emptyTree,
      validatorSignature: signHeader(minedHeader),
    };

    const result = validate(peer, { data: encodeOrderingBlock(bad) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith('misbehavior', peer.id, 100, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Network floor and scheduled-target checks — NET_INTERFACE → Stage 1,
// → Consensus parameters net enforces
// ---------------------------------------------------------------------------

describe('ordering-block topic validator — network floor and schedule', () => {
  const NETWORK_FLOOR = 3000;

  const baseHeader: BlockHeader = {
    protocolVersion: 1,
    height: 7,
    prevBlockHash: '11'.repeat(32),
    utxoTxRoot: SETTLEMENT_ROOT,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: MODULE_VALIDATOR_KP.publicKey,
    powNonce: 0,
    powTargetBits: NETWORK_FLOOR,
    createdAt: 1_722_470_400_000,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };

  function makeBlock(header: BlockHeader): OrderingBlock {
    return {
      header,
      utxoTxTree: settlementBody(),
      validatorSignature: signHeader(header),
    };
  }

  let minedNonce = -1;

  beforeAll(() => {
    for (let n = 0; n < 2_000_000; n++) {
      if (verifyOrderingBlockPoW({ ...baseHeader, powNonce: n })) {
        minedNonce = n;
        break;
      }
    }
    if (minedNonce < 0) throw new Error('PoW search at network floor exhausted');
  });

  it('rejects a header below the network floor with misbehavior 100', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    // bits above the constant floor (2304) so structure passes
    const block = makeBlock({ ...baseHeader, powNonce: minedNonce, powTargetBits: NETWORK_FLOOR - 1 });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block below the network floor',
    );
  });

  it('accepts at or above the floor, valid PoW, no provider', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('rejects when provider answers a number ≠ bits, no penalty', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
      scheduledTargetBits: () => NETWORK_FLOOR + 100,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
  });

  it('accepts when provider answers the header\'s own bits', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
      scheduledTargetBits: () => NETWORK_FLOOR,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('accepts when provider answers null', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
      scheduledTargetBits: () => null,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: minedNonce });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Accept);
    expect(penaltySpy).not.toHaveBeenCalled();
  });

  it('a header below the floor with invalid PoW records the floor reason, not PoW', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
    });
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const block = makeBlock({ ...baseHeader, powNonce: 0, powTargetBits: NETWORK_FLOOR - 1 });
    const result = validate(peer, { data: encodeOrderingBlock(block) });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledTimes(1);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block below the network floor',
    );
  });

  it('a provider set after subscribeTopics is consulted (late-bound closure)', () => {
    let provider: ((h: BlockHeader) => number | null) = () => null;
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      floorBits: NETWORK_FLOOR,
      scheduledTargetBits: (h) => provider(h),
    });
    const validate = topicValidators.get(topics.orderingBlock)!;

    // Three distinct headers — one block per call so the seen-window memory
    // (NET_INTERFACE → Stage 1 → "A header this node knows is Ignored") sees
    // each hash afresh and the provider's reading is what the result reads.
    const mineAt = (createdAt: number): OrderingBlock => {
      for (let n = 0; n < 2_000_000; n++) {
        const candidate = { ...baseHeader, createdAt, powNonce: n };
        if (verifyOrderingBlockPoW(candidate)) return makeBlock(candidate);
      }
      throw new Error('late-bound closure fixture: PoW search exhausted');
    };
    const dataA = encodeOrderingBlock(mineAt(1_722_470_401_000));
    const dataB = encodeOrderingBlock(mineAt(1_722_470_402_000));
    const dataC = encodeOrderingBlock(mineAt(1_722_470_403_000));

    // No provider → Accept
    expect(validate(newPeer(peerMgr), { data: dataA })).toBe(TopicValidatorResult.Accept);

    // Set a provider that disagrees → Reject, no penalty
    provider = () => NETWORK_FLOOR + 100;
    expect(validate(newPeer(peerMgr), { data: dataB })).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();

    // Set a provider that agrees → Accept
    provider = () => NETWORK_FLOOR;
    expect(validate(newPeer(peerMgr), { data: dataC })).toBe(TopicValidatorResult.Accept);
  });
});

// ---------------------------------------------------------------------------
// gossipTopics — NET_INTERFACE → Gossip Topics →
// "A topic is named for its network"
//
// The strings here are typed by hand from the contract: a case that built both
// sides through `gossipTopics` would pass by its own definition.
// ---------------------------------------------------------------------------

describe('gossipTopics — the topic pair per network', () => {
  it.each([
    ['mainnet', MAGIC_MAINNET, '/dagsocial/4d444147/ordering-block/1', '/dagsocial/4d444147/tx/1'],
    ['testnet', MAGIC_TESTNET, '/dagsocial/54444147/ordering-block/1', '/dagsocial/54444147/tx/1'],
    ['devnet',  MAGIC_DEVNET,  '/dagsocial/44444147/ordering-block/1', '/dagsocial/44444147/tx/1'],
  ])('%s pair carries the magic as eight lowercase hex digits', (_label, magic, expectedOrdering, expectedTx) => {
    expect(gossipTopics(magic)).toEqual({
      orderingBlock: expectedOrdering,
      tx: expectedTx,
    });
  });

  it.each([
    ['NaN', Number.NaN],
    ['-1', -1],
    ['1.5', 1.5],
    ['2 ** 32', 2 ** 32],
  ])('throws for %s (not an unsigned 32-bit integer)', (_label, magic) => {
    expect(() => gossipTopics(magic)).toThrow(/unsigned 32-bit integer/);
  });

  it('GOSSIP_SEEN_WINDOW_MS is two minutes', () => {
    // NET_INTERFACE → Gossip Topics →
    // "A message is heard once in a seen window"
    // CONSTANTS → net.
    expect(GOSSIP_SEEN_WINDOW_MS).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// gossipMessageId — NET_INTERFACE → Gossip Topics →
// "A message is named by its bytes"
//
// `hash32(lpUtf8(topic) ‖ data)`: the preimage is built by hand from the
// topic's bytes and a one-byte VLQ length, as the mesh file's id case does.
// ---------------------------------------------------------------------------

describe('gossipMessageId — hash32(lpUtf8(topic) ‖ data)', () => {
  it('matches a hand-built preimage over the testnet ordering-block topic', () => {
    const topic = topics.orderingBlock;
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const topicBytes = Buffer.from(topic, 'utf-8');
    expect(topicBytes.length).toBeLessThan(128);
    const preimage = Buffer.concat([
      Uint8Array.of(topicBytes.length),
      topicBytes,
      data,
    ]);
    const expected = createHash('blake2b512').update(preimage).digest().subarray(0, 32);
    expect(Array.from(gossipMessageId(topic, data))).toEqual(Array.from(expected));
  });

  it('the same bytes on the two topics are two ids', () => {
    const data = new Uint8Array([0xaa, 0xbb]);
    const idBlock = gossipMessageId(topics.orderingBlock, data);
    const idTx = gossipMessageId(topics.tx, data);
    expect(Array.from(idBlock)).not.toEqual(Array.from(idTx));
  });

  it('answers a fresh 32-byte Uint8Array', () => {
    const id = gossipMessageId(topics.orderingBlock, new Uint8Array([0]));
    expect(id).toBeInstanceOf(Uint8Array);
    expect(id.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Validation (and untrusted-input safety)
// → "A peer's bytes are weighed before they are decoded"
//
// A gossip message over the longest encoding Stage 1 accepts is refused
// undecoded, with ProtocolViolation whose reason names the bound; at the bound
// the validator does not refuse for length and lands on whatever its other
// checks answer.
// ---------------------------------------------------------------------------

describe('gossip topic validators weigh raw.length before decoding', () => {
  // One id, one over-bound payload: a tree the decoder returns and
  // verifyOrderingBlockStructure refuses as "body too large".
  // 1 id (33 bytes) + 1 element (1 + vlqU_len(payload) + payload) + lp framing
  // around header and body — see TYPES_INTERFACE → Size caps for the derivation.
  function overBoundBlockBytes(): Uint8Array {
    const utxoTxTree = {
      utxoTxIds: ['ab'.repeat(32)],
      utxoTxs: [new Uint8Array(1_999_993)],
    };
    const header: BlockHeader = {
      protocolVersion: 1,
      height: 7,
      prevBlockHash: '11'.repeat(32),
      utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: new Uint8Array(32).fill(9),
      powNonce: 0,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt: 1_722_470_400_000,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    };
    const block: OrderingBlock = { header, utxoTxTree, validatorSignature: new Uint8Array(64) };
    const encoded = encodeOrderingBlock(block);
    // The fixture is one byte past the bound by construction; the length check
    // is the whole subject of the test, and it costs nothing to pin.
    expect(encoded.length).toBe(MAX_ORDERING_BLOCK_BYTES + 1);
    expect(() => decodeOrderingBlock(encoded)).not.toThrow();
    return encoded;
  }

  it('an ordering-block message one byte past MAX_ORDERING_BLOCK_BYTES is a ProtocolViolation', () => {
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    const result = validate(peer, { data: overBoundBlockBytes() });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation,
      peer.id,
      expect.stringContaining(String(MAX_ORDERING_BLOCK_BYTES)),
    );
  });

  it('a tx packet one byte past MAX_TX_PACKET_BYTES is a ProtocolViolation', () => {
    // A plain non-post transaction (no karma gate), content chosen so the
    // encoded packet is exactly MAX_TX_PACKET_BYTES + 1. The content byte count
    // is far past MAX_CONTENT_BYTES, so pre-rule the structural chain reaches
    // verifyPostBody and the penalty is misbehavior; the length weigh is a
    // ProtocolViolation that must land before the decode.
    const keyPair = generateKeyPair();
    const commit = {
      contentHash: new Uint8Array(32), // the body check fires on size, not hash
      author: keyPair.publicKey,
      parentRefs: [],
      protocolVersion: 1,
      type: 'regular' as const,
    };
    const tx: UtxoTransaction = {
      inputs: ['aa'.repeat(32)],
      outputs: [{ boxType: 'karma', value: 10n, createdAtBlock: 0, owner: new Uint8Array(32).fill(1) } as never],
      signatures: {},
      protocolVersion: 1,
      post: commit,
    };
    // encodeTx(tx) is 142 bytes for this shape (one input, one karma output,
    // no signatures, a commit). Packet = 142 + 1 (opt tag) +
    // vlqU_len(contentLen) + contentLen. contentLen in [128, 16383] has
    // vlqU_len = 2, so a contentLen of 10159 leaves the packet at 10304 =
    // MAX_TX_PACKET_BYTES + 1.
    const content = 'a'.repeat(10_159);
    const encoded = encodeTxPacket(tx, content);
    expect(encoded.length).toBe(MAX_TX_PACKET_BYTES + 1);
    expect(() => decodeTxPacket(encoded)).not.toThrow();

    const authorHex = Buffer.from(keyPair.publicKey).toString('hex');
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set([authorHex]));
    const validate = topicValidators.get(topics.tx)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    const result = validate(peer, { data: encoded });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation,
      peer.id,
      expect.stringContaining(String(MAX_TX_PACKET_BYTES)),
    );
  });

  it('a message of exactly MAX_ORDERING_BLOCK_BYTES is not refused as over its bound', () => {
    // Whatever the validator then answers, the ProtocolViolation it may fire is
    // not the length-weigh one: the length check is `>` and equal passes.
    const { topicValidators, peerMgr } = makeHarness();
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    validate(peer, { data: new Uint8Array(MAX_ORDERING_BLOCK_BYTES) });

    for (const call of kindSpy.mock.calls) {
      if (call[0] === PenaltyKind.ProtocolViolation) {
        expect(String(call[2])).not.toContain(String(MAX_ORDERING_BLOCK_BYTES));
      }
    }
  });

  it('a message of exactly MAX_TX_PACKET_BYTES is not refused as over its bound', () => {
    const { topicValidators, peerMgr } = makeHarness();
    const validate = topicValidators.get(topics.tx)!;
    const peer = newPeer(peerMgr);
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');

    validate(peer, { data: new Uint8Array(MAX_TX_PACKET_BYTES) });

    for (const call of kindSpy.mock.calls) {
      if (call[0] === PenaltyKind.ProtocolViolation) {
        expect(String(call[2])).not.toContain(String(MAX_TX_PACKET_BYTES));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// NET_INTERFACE → Stage 1 — the header is read before the body, the standing
// check Ignores a header this node knows, the validator signature is Rejected
// with misbehavior when it does not verify, and a throw outside the decode is
// this node's fault alone.
// ---------------------------------------------------------------------------

// NET_INTERFACE → Stage 1 → "A header this node knows is Ignored" —
// `GOSSIP_SEEN_WINDOW_MS` from acceptance holds the memory of accepted
// headers. The clock below is the one `makeHarness` injects as `nowMs`.
const Point = ed25519.Point;
const Fn = Point.Fn;

// A second valid signing of the SAME message under a FRESH nonce — Ed25519
// is deterministic only through its own nonce derivation, so `ed25519.sign`
// cannot produce a second signing of one message by one key. Building it by
// hand (R = r·B, S = r + k·a mod L; k = SHA-512(R ‖ A ‖ M) mod L) yields a
// signature verifiable by `verifyValidatorSignature`.
function altSign(seed: Uint8Array, publicKey: Uint8Array, message: Uint8Array, nonceSeed: Uint8Array): Uint8Array {
  const h = sha512(seed);
  // RFC 8032 clamping — the secret scalar is derived from SHA-512(seed)[0..32].
  const scalarBytes = new Uint8Array(h.subarray(0, 32));
  scalarBytes[0]! &= 248;
  scalarBytes[31]! &= 127;
  scalarBytes[31]! |= 64;
  const a = Fn.create(bytesToNumberLE(scalarBytes));
  const r = Fn.create(bytesToNumberLE(sha512(nonceSeed)));
  const R = Point.BASE.multiply(r);
  const REncoded = R.toBytes();
  const chal = new Uint8Array(64 + message.length);
  chal.set(REncoded, 0);
  chal.set(publicKey, 32);
  chal.set(message, 64);
  const k = Fn.create(bytesToNumberLE(sha512(chal)));
  const S = Fn.create(r + k * a);
  const sig = new Uint8Array(64);
  sig.set(REncoded, 0);
  sig.set(numberToBytesLE(S, 32), 32);
  return sig;
}

// The three sections together, with no body decode run — the writer
// `encodeOrderingBlock` runs over an `OrderingBlock`, so bytes of a body that
// does not decode cannot ride that path. The frame is the one
// `readOrderingBlockSections` reads.
function assembleFrame(header: BlockHeader, bodyBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  const w = new ByteWriter();
  writeLp(w, encodeHeader(header));
  writeLp(w, bodyBytes);
  writeBytesNOrThrow(w, signature, 64);
  return w.toBytes();
}

describe('ordering-block topic validator — Stage 1 reads the header first', () => {
  let validatorSeed: Uint8Array;
  let validatorKp: ReturnType<typeof generateKeyPair>;
  let baseHeader: BlockHeader;
  let bodyTree: UtxoTxTree;

  // One mined block fixture per describe — the search is a one-off, so compute
  // once in `beforeAll` and derive each case's variant from it.
  let minedHeader: BlockHeader;
  let minedBodyBytes: Uint8Array;
  let minedSignature: Uint8Array;
  let minedHash: string;

  beforeAll(() => {
    validatorKp = generateKeyPair();
    validatorSeed = validatorKp.secretKey.subarray(16);  // PKCS8 prefix is 16 bytes
    bodyTree = {
      utxoTxIds: ['7a'.repeat(32)],
      utxoTxs: [new Uint8Array(96).fill(0x7a)],
    };
    baseHeader = {
      protocolVersion: 1,
      height: 11,
      prevBlockHash: '22'.repeat(32),
      utxoTxRoot: computeUtxoTxRoot(bodyTree),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: validatorKp.publicKey,
      powNonce: 0,
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
      createdAt: 1_722_470_400_000,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '00'.repeat(32),
    };
    for (let n = 0; n < 2_000_000; n++) {
      const candidate = { ...baseHeader, powNonce: n };
      if (verifyOrderingBlockPoW(candidate)) {
        minedHeader = candidate;
        break;
      }
    }
    if (minedHeader === undefined) throw new Error('PoW search exhausted');
    const message = hexToBytes(blockHash(minedHeader)!);
    minedSignature = ed25519.sign(message, validatorSeed);
    // Control — the deterministic signing verifies by the same function the
    // block validator reads.
    expect(verifyValidatorSignature(minedHeader, minedSignature)).toBe(true);
    minedBodyBytes = encodeOrderingBlock({
      header: minedHeader,
      utxoTxTree: bodyTree,
      validatorSignature: minedSignature,
    });  // round-trip control: the fixture does decode
    expect(() => decodeOrderingBlock(minedBodyBytes)).not.toThrow();
    minedHash = blockHash(minedHeader)!;
  });

  // Bytes that do not decode as a `UtxoTxTree`: an array count of 1 but zero
  // bytes to read for its first element. Reach the body section through the
  // frame assembly rather than `encodeOrderingBlock` — a struct writer refuses
  // its own invalid inputs.
  function undecodableBodyBytes(): Uint8Array {
    return new Uint8Array([0x01]);
  }

  function minedTree(): UtxoTxTree {
    return { utxoTxIds: bodyTree.utxoTxIds, utxoTxs: bodyTree.utxoTxs };
  }

  function mineUnderValidator(h: BlockHeader): BlockHeader {
    for (let n = 0; n < 2_000_000; n++) {
      const candidate = { ...h, powNonce: n };
      if (verifyOrderingBlockPoW(candidate)) return candidate;
    }
    throw new Error('PoW search exhausted');
  }

  it('a header the standing provider answers held is Ignored, no penalty', () => {
    const bodyBytes = undecodableBodyBytes();
    const bytes = assembleFrame(minedHeader, bodyBytes, minedSignature);
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      headerStanding: () => 'held',
    });
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
    expect(result).toBe(TopicValidatorResult.Ignore);
  });

  it('a header the standing provider answers refused is Ignored, no penalty', () => {
    const bodyBytes = undecodableBodyBytes();
    const bytes = assembleFrame(minedHeader, bodyBytes, minedSignature);
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      headerStanding: () => 'refused',
    });
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
    expect(result).toBe(TopicValidatorResult.Ignore);
  });

  it('a second valid signing of one header is Ignored inside the window and Accepted past it', () => {
    const message = hexToBytes(minedHash);
    const sigA = altSign(validatorSeed, validatorKp.publicKey, message, sha512(new Uint8Array([0x01])));
    const sigB = altSign(validatorSeed, validatorKp.publicKey, message, sha512(new Uint8Array([0x02])));
    // Controls — both signings verify by the same `verifyValidatorSignature`
    // the block validator reads, and they are distinct bytes.
    expect(verifyValidatorSignature(minedHeader, sigA)).toBe(true);
    expect(verifyValidatorSignature(minedHeader, sigB)).toBe(true);
    expect(Array.from(sigA)).not.toEqual(Array.from(sigB));

    let now = 1_000_000;
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      nowMs: () => now,
    });
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const first = validate(peer, { data: assembleFrame(minedHeader, encodeFrameBody(minedTree()), sigA) });
    expect(first).toBe(TopicValidatorResult.Accept);

    // Half a window later — well inside the seen window.
    now += Math.floor(GOSSIP_SEEN_WINDOW_MS / 2);
    const second = validate(peer, { data: assembleFrame(minedHeader, encodeFrameBody(minedTree()), sigB) });
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
    expect(second).toBe(TopicValidatorResult.Ignore);

    // Past the window from the first acceptance — the memory is empty, so the
    // second signing's bytes reach the Accept path.
    now += GOSSIP_SEEN_WINDOW_MS;
    const third = validate(peer, { data: assembleFrame(minedHeader, encodeFrameBody(minedTree()), sigB) });
    expect(third).toBe(TopicValidatorResult.Accept);
  });

  it('a worked header whose validator signature does not verify is Rejected with misbehavior 100', () => {
    const corrupted = new Uint8Array(minedSignature);
    corrupted[0]! ^= 0x01;
    expect(verifyValidatorSignature(minedHeader, corrupted)).toBe(false);

    const bytes = assembleFrame(minedHeader, encodeFrameBody(minedTree()), corrupted);
    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, expect.stringContaining('validator signature'),
    );
  });

  it('a PoW-failing header carrying an undecodable body records the PoW reason, not a body decode one', () => {
    const unmined: BlockHeader = { ...minedHeader, powNonce: minedHeader.powNonce + 1 };
    // Rule out a lucky second nonce — the whole point of this case is the PoW
    // failing before the body is read.
    expect(verifyOrderingBlockPoW(unmined)).toBe(false);
    const signature = ed25519.sign(hexToBytes(blockHash(unmined)!), validatorSeed);
    const bytes = assembleFrame(unmined, undecodableBodyBytes(), signature);

    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(kindSpy).not.toHaveBeenCalled();
    expect(penaltySpy).toHaveBeenCalledWith(
      'misbehavior', peer.id, 100, 'ordering block PoW invalid',
    );
  });

  it('a header section that does not read records a header decode reason', () => {
    // A header length prefix past MAX_HEADER_BYTES refuses before any header
    // byte is read (TYPES_INTERFACE → Layout — Block).
    const w = new ByteWriter();
    // vlqU of MAX_HEADER_BYTES + 1 — one byte if the number fits in 7 bits,
    // which 234 does not. 234 as vlqU is two bytes: 0xea 0x01.
    const over = MAX_HEADER_BYTES + 1;
    expect(over).toBeGreaterThan(127);
    // Write a vlqU of `over` by hand so the fixture does not sneak through
    // a struct writer.
    const vlqBytes: number[] = [];
    let value = over;
    while (value >= 128) {
      vlqBytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    vlqBytes.push(value);
    // Followed by no bytes — the reader throws before any header byte reads.
    for (const b of vlqBytes) w.writeU8(b);
    const bytes = w.toBytes();

    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation,
      peer.id,
      expect.stringContaining('ordering block header'),
    );
  });

  it('a valid worked signed header with a body that does not decode records a body decode reason', () => {
    const bytes = assembleFrame(minedHeader, undecodableBodyBytes(), minedSignature);

    const { topicValidators, peerMgr, penaltySpy } = makeHarness();
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Reject);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).toHaveBeenCalledWith(
      PenaltyKind.ProtocolViolation,
      peer.id,
      expect.stringContaining('ordering block body'),
    );
  });

  it('a scheduled-target provider that throws records no penalty and logs', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = assembleFrame(minedHeader, encodeFrameBody(minedTree()), minedSignature);
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      scheduledTargetBits: () => {
        throw new Error('provider explosion');
      },
    });
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Ignore);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('provider explosion'));
    errSpy.mockRestore();
  });

  it('a header-standing provider that throws records no penalty and logs', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bytes = assembleFrame(minedHeader, encodeFrameBody(minedTree()), minedSignature);
    const { topicValidators, peerMgr, penaltySpy } = makeHarness(new Set(), {
      headerStanding: () => {
        throw new Error('standing provider explosion');
      },
    });
    const kindSpy = vi.spyOn(peerMgr, 'recordPenaltyKind');
    const validate = topicValidators.get(topics.orderingBlock)!;
    const peer = newPeer(peerMgr);

    const result = validate(peer, { data: bytes });

    expect(result).toBe(TopicValidatorResult.Ignore);
    expect(penaltySpy).not.toHaveBeenCalled();
    expect(kindSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('standing provider explosion'));
    errSpy.mockRestore();
  });

  // The honest body bytes written to the frame — the fixture's tree so the
  // mined header's root agrees.
  function encodeFrameBody(tree: UtxoTxTree): Uint8Array {
    return encodeUtxoTxTree(tree);
  }
  // A non-dead reference so the surrounding helpers keep their intent visible
  // even where only the mined fixture is reached.
  void mineUnderValidator;
});
