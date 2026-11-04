import { describe, it, expect } from 'vitest';
import {
  ByteWriter,
  computeUtxoTxRoot,
  encodeHeader,
  encodeOrderingBlock,
  encodeUtxoTxTree,
  MAX_ORDERING_BLOCK_BYTES,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  POW_TARGET_BITS_MAX,
  PROTOCOL_VERSION,
  writeLp,
} from '@dagsocial/types';
import type {
  BlockHeader,
  OrderingBlock,
  ProtocolEra,
  UtxoTxTree,
} from '@dagsocial/types';
import {
  blockHash,
  verifyHeaderFieldDomains,
  verifyOrderingBlockPoW,
  verifyOrderingBlockStructure,
  verifyProtocolVersion,
  verifyUtxoTxRoot,
  verifyValidatorSignature,
} from '@dagsocial/validation';
import { BlockCheck } from '../src/block-check.js';
import type { BlockCheckContext, BlockValidators } from '../src/block-check.js';
import { GOSSIP_SEEN_WINDOW_MS } from '../src/gossip.js';
import { makeBlockAt } from './helpers/devnet-block.js';

// NET_INTERFACE → The browser entry — BlockCheck is the one copy of the
// ordering-block topic's checks of NET_INTERFACE → Stage 1, its checks in
// their order. Each case here is one valid mined devnet block altered at
// one field so the refusal is for its own reason and no earlier one.

const schedule: readonly ProtocolEra[] = [{ version: 1, fromHeight: 0 }];

const validators: BlockValidators = {
  verifyHeaderFieldDomains,
  verifyProtocolVersion,
  verifyOrderingBlockPoW,
  verifyValidatorSignature,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
};

interface CtxOverrides {
  scheduledTargetBits?: BlockCheckContext['scheduledTargetBits'];
  standing?: BlockCheckContext['standing'];
  nowMs?: () => number;
}

function makeCtx(overrides?: CtxOverrides): BlockCheckContext {
  return {
    schedule,
    floorBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    scheduledTargetBits: overrides?.scheduledTargetBits ?? (() => null),
    standing: overrides?.standing ?? (() => null),
    nowMs: overrides?.nowMs ?? (() => 1_000_000),
  };
}

/**
 * Build raw ordering-block bytes from parts, mirroring encodeOrderingBlock's
 * layout (TYPES_INTERFACE → Layout — Block): lp(header) ‖ lp(body) ‖ sig64.
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

// AHEAD OF CODE: the BlockCheck stub answers { result: 'accept' } for
// every input. Each failing case flips to plain `it` as its check lands in
// the rule.
describe("BlockCheck — net's Stage 1 for the block topic", () => {
  it.fails('over MAX_ORDERING_BLOCK_BYTES → reject, lie', () => {
    const raw = new Uint8Array(MAX_ORDERING_BLOCK_BYTES + 1);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('MAX_ORDERING_BLOCK_BYTES'),
    });
  });

  it.fails('sections that do not read → reject, lie', () => {
    const raw = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('malformed ordering block header'),
    });
  });

  it.fails('invalid field domains → reject, lie', () => {
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const badHeader: BlockHeader = { ...good.header, powTargetBits: POW_TARGET_BITS_MAX + 1 };
    const raw = assembleRaw(
      badHeader,
      encodeUtxoTxTree(good.utxoTxTree),
      good.validatorSignature,
    );
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('powTargetBits'),
    });
  });

  it.fails('protocol version not the era → reject, not a lie', () => {
    // Devnet's schedule is a single era at version 1 from height 0; a
    // block declaring version 2 at height 1 is a compatibility signal
    // (NET_INTERFACE → Peer Penalty System), Transient, so `lie: false`.
    const block = makeBlockAt(1, PROTOCOL_VERSION, { protocolVersion: PROTOCOL_VERSION + 1 });
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: false,
      detail: expect.stringContaining('protocol version'),
    });
  });

  it.fails('below floorBits → reject, lie', () => {
    const block = makeBlockAt(1, PROTOCOL_VERSION, {
      powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR - 1,
    });
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('floor'),
    });
  });

  it.fails('PoW not met → reject, lie', () => {
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
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('PoW'),
    });
  });

  it.fails('scheduled target differs → reject, not a lie', () => {
    // NET_INTERFACE → Stage 1 → "A scheduled-target mismatch is refused,
    // never forwarded, and never penalised" — lie: false.
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      validators,
      makeCtx({ scheduledTargetBits: (h) => h.powTargetBits + 1 }),
    ).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: false,
      detail: expect.stringContaining('scheduled'),
    });
  });

  it('scheduledTargetBits null → the schedule is not checked', () => {
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      validators,
      makeCtx({ scheduledTargetBits: () => null }),
    ).check(raw);
    expect(verdict.result).toBe('accept');
  });

  it.fails('standing held or refused → ignore', () => {
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const held = new BlockCheck(validators, makeCtx({ standing: () => 'held' })).check(raw);
    expect(held).toEqual({ result: 'ignore' });
    const refused = new BlockCheck(validators, makeCtx({ standing: () => 'refused' })).check(raw);
    expect(refused).toEqual({ result: 'ignore' });
  });

  it.fails('accepted inside the seen window → ignore; past it → accept again', () => {
    // NET_INTERFACE → Stage 1 → "A header this node knows is Ignored".
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    let now = 1_000_000;
    const check = new BlockCheck(validators, makeCtx({ nowMs: () => now }));
    const first = check.check(raw);
    expect(first.result).toBe('accept');
    const second = check.check(raw);
    expect(second).toEqual({ result: 'ignore' });
    now = 1_000_000 + GOSSIP_SEEN_WINDOW_MS + 1;
    const third = check.check(raw);
    expect(third.result).toBe('accept');
  });

  it.fails('validator signature fails → reject, lie', () => {
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const bad: OrderingBlock = {
      ...good,
      validatorSignature: new Uint8Array(64).fill(0xaa),
    };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('validator signature'),
    });
  });

  it.fails('body undecodable → reject, lie', () => {
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = assembleRaw(
      good.header,
      new Uint8Array([0xff, 0xff, 0xff]),
      good.validatorSignature,
    );
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('malformed ordering block body'),
    });
  });

  it.fails('structure invalid → reject, lie', () => {
    // An empty body carries no settlement transaction, which
    // verifyOrderingBlockStructure refuses.
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const emptyTree: UtxoTxTree = { utxoTxIds: [], utxoTxs: [] };
    const bad: OrderingBlock = { ...good, utxoTxTree: emptyTree };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining('settlement'),
    });
  });

  it.fails("body not the root's → reject, lie", () => {
    // NET_INTERFACE → Stage 1 → "A worked header is forwarded with the
    // body its root commits".
    const good = makeBlockAt(1, PROTOCOL_VERSION);
    const otherTree: UtxoTxTree = {
      utxoTxIds: ['22'.repeat(32)],
      utxoTxs: [new Uint8Array(96).fill(0x22)],
    };
    expect(computeUtxoTxRoot(otherTree)).not.toBe(good.header.utxoTxRoot);
    const bad: OrderingBlock = { ...good, utxoTxTree: otherTree };
    const raw = encodeOrderingBlock(bad);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    expect(verdict).toEqual({
      result: 'reject',
      lie: true,
      detail: expect.stringContaining("header's root"),
    });
  });

  it.fails('valid → accept, the block and its blockHash', () => {
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(validators, makeCtx()).check(raw);
    const hash = blockHash(block.header);
    expect(hash).not.toBeNull();
    expect(verdict).toEqual({ result: 'accept', block, hash });
    expect(block.header.powTargetBits).toBe(ORDERING_BLOCK_POW_TARGET_FLOOR);
  });

  it.fails('a throw from a context provider → ignore, not a lie', () => {
    // NET_INTERFACE → Stage 1 → "A fault of this node's is no peer's".
    const block = makeBlockAt(1, PROTOCOL_VERSION);
    const raw = encodeOrderingBlock(block);
    const verdict = new BlockCheck(
      validators,
      makeCtx({
        scheduledTargetBits: () => {
          throw new Error('context provider down');
        },
      }),
    ).check(raw);
    expect(verdict).toEqual({ result: 'ignore' });
  });
});
