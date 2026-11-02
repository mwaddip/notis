import { describe, it, expect } from 'vitest';
import {
  ByteWriter,
  computeUtxoTxRoot,
  encodeHeader,
  encodeOrderingBlock,
  encodeUtxoTxTree,
  MAGIC_DEVNET,
  MAX_ORDERING_BLOCK_BYTES,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POW_TARGET_BITS_MAX,
  profileFor,
  PROTOCOL_VERSION,
  writeLp,
} from '@dagsocial/types';
import type {
  BlockHeader,
  NetworkProfile,
  OrderingBlock,
  UtxoTxTree,
} from '@dagsocial/types';
import { blockHash, verifyOrderingBlockPoW } from '@dagsocial/validation';
import { BlockCheck } from '../src/block-check.js';
import type { BlockCheckContext } from '../src/block-check.js';
import { GOSSIP_SEEN_WINDOW_MS } from '../src/gossip-rules.js';
import { makeBlockAt } from './helpers/devnet-block.js';

// MESH_INTERFACE → Block gossip → "A block is checked before it is forwarded,
// and never applied" — the ordering-block topic's checks of
// `NET_INTERFACE → Stage 1`, in their order, through the same
// `@dagsocial/types` and `@dagsocial/validation` functions. Each case here is
// one valid mined devnet block altered at one field so the refusal is for
// its own reason and no earlier one, as `net` records it
// (`NET_INTERFACE → Peer Penalty System`).

const devnetProfile: NetworkProfile = profileFor('devnet');

interface CtxOverrides {
  profile?: NetworkProfile;
  scheduledTargetBits?: BlockCheckContext['scheduledTargetBits'];
  standing?: BlockCheckContext['standing'];
  nowMs?: () => number;
}

function makeCtx(overrides?: CtxOverrides): BlockCheckContext {
  return {
    profile: overrides?.profile ?? devnetProfile,
    scheduledTargetBits: overrides?.scheduledTargetBits ?? (() => null),
    standing: overrides?.standing ?? (() => null),
    nowMs: overrides?.nowMs ?? (() => 1_000_000),
  };
}

/**
 * Build raw ordering-block bytes from parts, mirroring
 * `encodeOrderingBlock`'s layout
 * (`TYPES_INTERFACE → Layout — Block`): `lp(header) ‖ lp(body) ‖ sig64`.
 * The signature bytes are written as-is, so a case may hand bytes of any
 * value in that span; a signature longer or shorter than 64 bytes writes
 * what it holds and the frame is sized by the caller.
 */
function assembleRaw(
  header: BlockHeader,
  bodyBytes: Uint8Array,
  signatureBytes: Uint8Array,
): Uint8Array {
  const w = new ByteWriter();
  writeLp(w, encodeHeader(header));
  writeLp(w, bodyBytes);
  w.writeBytes(signatureBytes);
  return w.toBytes();
}

describe('BlockCheck — net\'s Stage 1 for the block topic', () => {
  it.fails('over MAX_ORDERING_BLOCK_BYTES → reject, lie', () => {
    const raw = new Uint8Array(MAX_ORDERING_BLOCK_BYTES + 1);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('MAX_ORDERING_BLOCK_BYTES'),
    });
  });

  it.fails('sections that do not read → reject, lie', () => {
    const raw = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('malformed ordering block header'),
    });
  });

  it.fails('invalid field domains → reject, lie', () => {
    // `powTargetBits` outside `[0, POW_TARGET_BITS_MAX]`
    // (`VALIDATION_INTERFACE → verifyHeaderFieldDomains`). The vlqU writer
    // accepts the integer so the frame reads; `verifyHeaderFieldDomains`
    // refuses it before any later check runs.
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const badHeader: BlockHeader = { ...good.header, powTargetBits: POW_TARGET_BITS_MAX + 1 };
    const raw = assembleRaw(
      badHeader,
      encodeUtxoTxTree(good.utxoTxTree),
      good.validatorSignature,
    );
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('powTargetBits'),
    });
  });

  it.fails('protocol version not the era → reject, not a lie', () => {
    // Devnet's `protocolVersionSchedule` is a single era at version 1 from
    // height 0; a block declaring version 2 at height 1 is a compatibility
    // signal (`NET_INTERFACE → Peer Penalty System`), Transient, so this
    // module records `lie: false`.
    const block = makeBlockAt(1, PROTOCOL_VERSION, { protocolVersion: PROTOCOL_VERSION + 1 });
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: false,
      detail: expect.stringContaining('protocol version'),
    });
  });

  it.fails('below orderingBlockPowTargetFloorBits → reject, lie', () => {
    // Devnet's floor is `ORDERING_BLOCK_POW_TARGET_FLOOR`; a header a bit
    // below is refused `misbehavior` before `verifyOrderingBlockPoW` runs
    // (`NET_INTERFACE → Stage 1`).
    const block = makeBlockAt(1, PROTOCOL_VERSION, {
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR - 1,
    });
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('floor'),
    });
  });

  it.fails('PoW not met → reject, lie', () => {
    // A mined header's nonce bumped to the first value that `verifyOrderingBlockPoW`
    // refuses; the floor is reached, so this is the one check that fires
    // (`NET_INTERFACE → Stage 1`).
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    let bad = (good.header.powNonce + 1) >>> 0;
    while (verifyOrderingBlockPoW({ ...good.header, powNonce: bad })) {
      bad = (bad + 1) >>> 0;
    }
    const badHeader: BlockHeader = { ...good.header, powNonce: bad };
    const raw = assembleRaw(
      badHeader,
      encodeUtxoTxTree(good.utxoTxTree),
      good.validatorSignature,
    );
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('PoW'),
    });
  });

  it.fails('scheduled target differs → reject, not a lie', () => {
    // The parent-held schedule the provider answers for this header disagrees
    // with its `powTargetBits`; the refusal rests on this node's state
    // (`NET_INTERFACE → Stage 1 → "A scheduled-target mismatch is refused,
    // never forwarded, and never penalised"`) — `lie: false`.
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      makeCtx({ scheduledTargetBits: (h) => h.powTargetBits + 1 }),
    ).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: false,
      detail: expect.stringContaining('scheduled'),
    });
  });

  it.fails('scheduledTargetBits null → the schedule is not checked', () => {
    // A `null` answer means the schedule provider cannot judge this header,
    // the check skipped; the otherwise-valid block is accepted.
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      makeCtx({ scheduledTargetBits: () => null }),
    ).check(raw);
    expect(verdict.result).toBe('accept');
  });

  it.fails('standing held or refused → ignore', () => {
    // A header this node holds or has refused is Ignored, no penalty
    // (`NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"`).
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const held = new BlockCheck(makeCtx({ standing: () => 'held' })).check(raw);
    expect(held).toEqual({ result: 'ignore' });
    const refused = new BlockCheck(makeCtx({ standing: () => 'refused' })).check(raw);
    expect(refused).toEqual({ result: 'ignore' });
  });

  it.fails('accepted inside the seen window → ignore; past it → accept again', () => {
    // The seen-accepted memory is the instance's; a second call for the same
    // header inside `GOSSIP_SEEN_WINDOW_MS` is Ignored, and a call once that
    // window has passed accepts again
    // (`NET_INTERFACE → Stage 1 → "A header this node knows is Ignored"`).
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    let now = 1_000_000;
    const check = new BlockCheck(makeCtx({ nowMs: () => now }));
    const first = check.check(raw);
    expect(first.result).toBe('accept');
    const second = check.check(raw);
    expect(second).toEqual({ result: 'ignore' });
    now = 1_000_000 + GOSSIP_SEEN_WINDOW_MS + 1;
    const third = check.check(raw);
    expect(third.result).toBe('accept');
  });

  it.fails('validator signature fails → reject, lie', () => {
    // `verifyValidatorSignature` runs after the header-only checks and
    // before the body decode (`NET_INTERFACE → Stage 1`); a 64-byte
    // signature that does not verify is `misbehavior`, a lie.
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const bad: OrderingBlock = {
      ...good,
      validatorSignature: new Uint8Array(64).fill(0xaa),
    };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('validator signature'),
    });
  });

  it.fails('body undecodable → reject, lie', () => {
    // The body section is read as length-prefixed bytes
    // (`TYPES_INTERFACE → Layout — Block`), then `decodeUtxoTxTree` parses
    // them; a short run of 0xff refuses the decode. The header is mined,
    // its signature verifies, so this is the one check that fires
    // (`NET_INTERFACE → Stage 1`, `ProtocolViolation`).
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = assembleRaw(
      good.header,
      new Uint8Array([0xff, 0xff, 0xff]),
      good.validatorSignature,
    );
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('malformed ordering block body'),
    });
  });

  it.fails('structure invalid → reject, lie', () => {
    // An empty body carries no settlement transaction, which
    // `verifyOrderingBlockStructure` refuses
    // (`VALIDATION_INTERFACE → verifyOrderingBlockStructure`). The header
    // keeps its own `utxoTxRoot` so the signature verifies; the structure
    // check fires before the root check.
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const emptyTree: UtxoTxTree = { utxoTxIds: [], utxoTxs: [] };
    const bad: OrderingBlock = { ...good, utxoTxTree: emptyTree };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('settlement'),
    });
  });

  it.fails('body not the root\'s → reject, lie', () => {
    // The structure passes but the body is not the one the header's
    // `utxoTxRoot` commits (`NET_INTERFACE → Stage 1 → "A worked header is
    // forwarded with the body its root commits"`): `misbehavior`.
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const otherTree: UtxoTxTree = {
      utxoTxIds: ['22'.repeat(32)],
      utxoTxs: [new Uint8Array(96).fill(0x22)],
    };
    expect(computeUtxoTxRoot(otherTree)).not.toBe(good.header.utxoTxRoot);
    const bad: OrderingBlock = { ...good, utxoTxTree: otherTree };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining("header's root"),
    });
  });

  it.fails('valid → accept, the block and its blockHash', () => {
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(makeCtx()).check(raw);
    const hash = blockHash(block.header);
    expect(hash).not.toBeNull();
    expect(verdict).toEqual({ result: 'accept', block, hash });
    expect(block.header.powTargetBits).toBe(ORDERING_BLOCK_POW_TARGET_FLOOR);
    // Guard against a wrong magic drifting from the devnet profile the
    // helper mines against: the profile the ctx carries is devnet's.
    expect(devnetProfile.magic).toBe(MAGIC_DEVNET);
  });

  it.fails('a throw from a context provider → ignore, not a lie', () => {
    // `scheduledTargetBits` throwing is this receiver's own fault; the
    // outer catch Ignores it with no penalty
    // (`NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's"`).
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      makeCtx({
        scheduledTargetBits: () => {
          throw new Error('context provider down');
        },
      }),
    ).check(raw);
    expect(verdict).toEqual({ result: 'ignore' });
  });
});
