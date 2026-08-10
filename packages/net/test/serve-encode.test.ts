import { describe, it, expect, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  CREDIT_MINER_REWARD_DELAY,
  decodeOrderingBlock,
  decodeSubBlock,
  encodeOrderingBlock,
  encodeSubBlock,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, Post, SubBlock } from '@dagsocial/types';
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
import { encodeServableOrderingBlock, encodeServableSubBlock } from '../src/serve-encode.js';
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
//     out-of-domain value encodes *successfully* into bytes `decodeSubBlock`
//     then refuses. Nothing downstream of the encoder can see this one.
// ---------------------------------------------------------------------------

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

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    content: 'a stored post',
    author: new Uint8Array(32).fill(7),
    parentRefs: [],
    challenge: new Uint8Array(32),
    protocolVersion: PROTOCOL_VERSION,
    timestamp: 1_000_000,
    powNonce: 42,
    signature: new Uint8Array(64),
    ...overrides,
  };
}

function makeSubBlock(overrides: Partial<SubBlock> = {}): SubBlock {
  return {
    subBlockId: 'ab'.repeat(32),
    post: makePost(),
    producerId: new Uint8Array(32).fill(7),
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

function makeHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    subBlockRoot: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 100,
    powTargetBits: 4,
    createdAt: 1_000_000,
    ...overrides,
  };
}

function makeOrderingBlock(header: BlockHeader = makeHeader()): OrderingBlock {
  return {
    header,
    subBlockTree: { subBlockEntries: [], pruneEntries: [] },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      coinbaseOutputs: [
        {
          value: 100n,
          owner: new Uint8Array(32),
          lockedUntilBlock: header.height + CREDIT_MINER_REWARD_DELAY,
          isTreasury: false,
        },
      ],
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

describe('encodeServableSubBlock — out-of-domain rows', () => {
  it('refuses a colliding `protocolVersion` that the encoder would accept', () => {
    // The load-bearing case. `writeVlqU(-1)` does not throw: it emits a
    // sentinel, and the bytes come back as a *successful* encode that our own
    // reader then refuses. Only the structural verdict sees this.
    const stored = makeSubBlock({ protocolVersion: -1 });

    expect(() => encodeSubBlock(stored)).not.toThrow();
    expect(() => decodeSubBlock(encodeSubBlock(stored))).toThrow();

    const { result, logged } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, stored.subBlockId),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('protocolVersion');
  });

  it('refuses a non-hex `subBlockId` instead of throwing out of the encoder', () => {
    const stored = makeSubBlock({ subBlockId: 'not hex' });

    expect(() => encodeSubBlock(stored)).toThrow();

    const { result, logged } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, 'not hex'),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('subBlockId');
  });

  it('refuses a `producerId` that is 32 characters rather than 32 bytes', () => {
    const stored = makeSubBlock({ producerId: '0'.repeat(32) as unknown as Uint8Array });

    const { result, logged } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, stored.subBlockId),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('producerId');
  });

  it('refuses an out-of-domain post field', () => {
    const stored = makeSubBlock({ post: makePost({ timestamp: -1 }) });

    const { result } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, stored.subBlockId),
    );
    expect(result).toBeNull();
  });

  it('refuses a row that is not a sub-block at all, without throwing', () => {
    for (const junk of [null, undefined, 42, 'a string', {}, { post: {} }]) {
      const { result } = capturingErrors(() =>
        encodeServableSubBlock(junk, validators, 'junk'),
      );
      expect(result).toBeNull();
    }
  });

  it('refuses a bad `post.signature`, which the structural verdict does not reach', () => {
    // ⚠ This is the residual gap, pinned so it is visible rather than assumed
    // closed: `verifyPostFieldDomains` stops at `timestamp`, so `signature`
    // passes the verdict and is caught only by the encode arm. The root fix is
    // in `@dagsocial/validation` — until then, this asserts the serve path
    // stays total, not that the check is complete.
    const stored = makeSubBlock({ post: makePost({ signature: new Uint8Array(63) }) });

    expect(verifySubBlockStructure(stored).valid).toBe(true);
    expect(() => encodeSubBlock(stored)).toThrow();

    const { result, logged } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, stored.subBlockId),
    );
    expect(result).toBeNull();
    expect(logged.join('\n')).toContain('encode failed');
  });
});

// ---------------------------------------------------------------------------
// …and does not fire on an honest row (the "guard that never fires" inverse)
// ---------------------------------------------------------------------------

describe('encodeServableSubBlock — in-domain rows still serve', () => {
  it('returns bytes that round-trip back to the same sub-block', () => {
    const stored = makeSubBlock();
    const { result, logged } = capturingErrors(() =>
      encodeServableSubBlock(stored, validators, stored.subBlockId),
    );

    expect(result).not.toBeNull();
    expect(logged).toEqual([]);

    const back = decodeSubBlock(result!);
    expect(back.subBlockId).toBe(stored.subBlockId);
    expect(back.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(back.post.content).toBe('a stored post');
  });
});

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
      [2, makeOrderingBlock(makeHeader({ height: 2, subBlockRoot: 'nope' }))],
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
