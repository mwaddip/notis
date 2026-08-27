import { describe, it, expect, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  decodeOrderingBlock,
  encodeOrderingBlock,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import { encodeServableOrderingBlock } from '../src/serve-encode.js';
import { LazySyncStore } from '../src/node.js';
import type { NetValidators } from '../src/types.js';

// ---------------------------------------------------------------------------
// The serve-side encode boundary
//
// Every case below is a value a *store* could hand us, not one a peer could
// send: this is the seam between `@dagsocial/node`'s rows and net's encoders,
// and the property under test is that an out-of-domain row leaves the serve
// path as a verdict rather than as a throw or as bytes our own reader refuses.
//
// The two failure classes are different and both are covered, because only one
// of them is visible to a `try`/`catch`:
//
//   - **throwing** — `writeHexNOrThrow` / `writeBytesNOrThrow` on a field
//     outside their fixed width;
//   - **colliding** — `writeVlqU`, which is total by sentinel, so an
//     out-of-domain value encodes *successfully* into bytes `decodeOrderingBlock`
//     then refuses. Nothing downstream of the encoder can see this one.
//
// ---------------------------------------------------------------------------

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
};

function makeHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 100,
    // 1/256-bit units — VALIDATION_INTERFACE → orderingPowTarget. This one is
    // verdict-bearing: `encodeServableOrderingBlock` gates on structure, and
    // the floor is a clause of that verdict (VALIDATION_INTERFACE →
    // verifyOrderingBlockStructure), so a header this factory builds serves
    // only at or above it. Dereferenced rather than spelled, so the fixture
    // moves with the constant instead of having to be re-chosen beside it.
    powTargetBits: ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: 1_000_000,
    interlinkRoot: '00'.repeat(32),
    ...overrides,
  };
}

function makeOrderingBlock(header: BlockHeader = makeHeader()): OrderingBlock {
  return {
    header,
    // Verdict-bearing like `powTargetBits` above, and for the same reason:
    // `encodeServableOrderingBlock` gates on structure, and a body carrying no
    // transaction is a clause of that verdict (VALIDATION_INTERFACE →
    // verifyOrderingBlockStructure). Every block carries at least one, because
    // the settlement is one (NODE_INTERFACE → It is the LAST entry in
    // `utxoTxIds`).
    utxoTxTree: {
      utxoTxIds: [header.height.toString(16).padStart(64, '0')],
      utxoTxs: [new Uint8Array(96).fill(header.height & 0xff)],
    },
    validatorSignature: new Uint8Array(64),
  };
}

/** Run `fn` with `console.error` silenced, returning both the result and what was logged. */
function capturingErrors<T>(fn: () => T): { result: T; logged: string[] } {
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
  try {
    return { result: fn(), logged };
  } finally {
    spy.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// The guard fires — and fires for the right reason
// ---------------------------------------------------------------------------

describe('encodeServableOrderingBlock', () => {
  it('returns bytes that round-trip back to the same block', () => {
    const stored = makeOrderingBlock();
    const { result, logged } = capturingErrors(() =>
      encodeServableOrderingBlock(stored, validators, 'height 1'),
    );

    expect(result).not.toBeNull();
    expect(logged).toEqual([]);
    expect(decodeOrderingBlock(result!).header.height).toBe(1);
  });

  it('refuses a header outside the encodable domain', () => {
    const stored = makeOrderingBlock(makeHeader({ prevBlockHash: 'nope' }));

    const { result, logged } = capturingErrors(() =>
      encodeServableOrderingBlock(stored, validators, 'height 1'),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('height 1');
  });

  it('refuses a colliding `height` that the encoder would accept', () => {
    // The ordering-block half of the collision class: `writeVlqU(-1)` encodes,
    // and the bytes are refused by our own reader rather than by the writer.
    const stored = makeOrderingBlock(makeHeader({ height: -1 }));

    expect(() => decodeOrderingBlock(encodeOrderingBlock(stored))).toThrow();

    const { result, logged } = capturingErrors(() =>
      encodeServableOrderingBlock(stored, validators, 'height -1'),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('height');
  });

  it('refuses a row that is not an ordering block at all, without throwing', () => {
    for (const junk of [null, undefined, 7, 'block', {}, { header: {} }]) {
      const { result } = capturingErrors(() =>
        encodeServableOrderingBlock(junk, validators, 'height 9'),
      );
      expect(result).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The serve path — `LazySyncStore.serializeOrderingBlock` answers a peer's
// ModifierRequest from these rows (`sync-machine.handleModifierRequestMsg`)
// ---------------------------------------------------------------------------

describe('LazySyncStore.serializeOrderingBlock', () => {
  it('returns null for a malformed stored block rather than throwing', () => {
    const store = new LazySyncStore(validators);
    store.setOrderingBlockFn(() => makeOrderingBlock(makeHeader({ validatorId: 'short' as unknown as Uint8Array })));

    const { result } = capturingErrors(() => store.serializeOrderingBlock(1));
    expect(result).toBeNull();
  });

  it('still serves the neighbouring good blocks — one bad row is not a dead batch', () => {
    const rows = new Map<number, unknown>([
      [1, makeOrderingBlock(makeHeader({ height: 1 }))],
      [2, makeOrderingBlock(makeHeader({ height: 2, prevBlockHash: 'nope' }))],
      [3, makeOrderingBlock(makeHeader({ height: 3 }))],
    ]);
    const store = new LazySyncStore(validators);
    store.setOrderingBlockFn((h) => rows.get(h) ?? null);

    const { result } = capturingErrors(() => [1, 2, 3].map((h) => store.serializeOrderingBlock(h)));
    expect(result[0]).not.toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).not.toBeNull();
    expect(decodeOrderingBlock(result[2]!).header.height).toBe(3);
  });

  it('keeps absence and unservability apart in the log, not in the return', () => {
    const store = new LazySyncStore(validators);
    store.setOrderingBlockFn(() => null);

    const { result, logged } = capturingErrors(() => store.serializeOrderingBlock(1));
    expect(result).toBeNull();
    expect(logged).toEqual([]);
  });
});
