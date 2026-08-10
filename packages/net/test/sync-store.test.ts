import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  PROTOCOL_VERSION,
  CREDIT_MINER_REWARD_DELAY,
  encodeOrderingBlock,
} from '@dagsocial/types';
import {
  blockHash,
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
import { LazySyncStore, NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

// ---------------------------------------------------------------------------
// Why this file exists
//
// Phase 1f-3 migrated exactly one `src` line — `LazySyncStore.getOrderingBlockId`
// moved from `blockHash` inside a `try`/`catch` to the guarded
// `blockHash`. Main then mutated that method to unconditionally return
// `null` and all 410 tests still passed: the method had **no coverage at all**.
// A total lobotomy that the suite cannot see is the strongest possible evidence
// that the suite was not testing the thing.
//
// So these tests drive the real method on the real class. Every case below
// fails against `return null`, and the class-B cases fail against the pre-1f
// `blockHash` + `catch` as well — which is what makes them a pin on the change
// rather than a restatement of whatever the code currently does.
// ---------------------------------------------------------------------------

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

function makeBlock(header: BlockHeader): OrderingBlock {
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

/** A store wired to serve exactly these blocks by height. */
function storeServing(blocks: Map<number, unknown>): LazySyncStore {
  const store = new LazySyncStore();
  store.setOrderingBlockFn((h) => blocks.get(h) ?? null);
  return store;
}

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Class A — an in-domain header still hashes, and hashes canonically
// ---------------------------------------------------------------------------

describe('LazySyncStore.getOrderingBlockId — in-domain headers (class A)', () => {
  it('returns the canonical block hash, not merely something non-null', () => {
    const header = makeHeader();
    const store = storeServing(new Map([[1, makeBlock(header)]]));

    const id = store.getOrderingBlockId(1);

    // Two assertions, deliberately. The shape check alone would survive a
    // method that hashed the wrong thing; the equality check is what pins this
    // to `blockHash` over the header.
    expect(id).toMatch(HEX64);
    expect(id).toBe(blockHash(header));
  });

  it('distinguishes headers that differ in one field', () => {
    // A migration that dropped the header on the floor and hashed a constant
    // would pass every single-header test above. This is the cheapest way to
    // refuse that.
    const a = storeServing(new Map([[1, makeBlock(makeHeader({ height: 1 }))]]));
    const b = storeServing(new Map([[1, makeBlock(makeHeader({ height: 2 }))]]));

    expect(a.getOrderingBlockId(1)).not.toBe(b.getOrderingBlockId(1));
  });
});

// ---------------------------------------------------------------------------
// Class B — out of domain but still CBOR-encodable: the behaviour 1f changed
// ---------------------------------------------------------------------------

describe('LazySyncStore.getOrderingBlockId — out-of-domain headers (class B)', () => {
  it('createdAt NaN yields null, where it used to yield a plausible id', () => {
    // The single-field delta is the whole test. `createdAt` is the field that
    // had no domain check anywhere in the repo before 1f, and cbor-x encodes
    // NaN happily — so pre-1f this returned a real-looking 64-hex id. Under a
    // positional encoder `vlqU` is total *by sentinel*, so NaN, -1, 1.5 and
    // 2^60 would all collide on one hash: serving an id here would advertise a
    // sync anchor that several distinct headers share.
    //
    // Deliberately NOT written as "differs from the unguarded blockHash" — that
    // function is `@deprecated` and 1f-4 deletes it, which would break this
    // test. The delta against the same header with a valid createdAt proves the
    // same thing and survives 1f-4.
    const good = makeHeader({ createdAt: 1_000_000 });
    const bad = makeHeader({ createdAt: Number.NaN });

    const goodStore = storeServing(new Map([[1, makeBlock(good)]]));
    const badStore = storeServing(new Map([[1, makeBlock(bad)]]));

    expect(goodStore.getOrderingBlockId(1)).toMatch(HEX64);
    expect(badStore.getOrderingBlockId(1)).toBeNull();
  });

  it.each([
    ['negative height', { height: -1 }],
    ['fractional height', { height: 1.5 }],
    ['non-hex prevBlockHash', { prevBlockHash: 'zz'.repeat(32) }],
    ['short prevBlockHash', { prevBlockHash: 'ab' }],
    ['uppercase prevBlockHash', { prevBlockHash: 'AB'.repeat(32) }],
    ['stateRoot at 64 chars, not 66', { stateRoot: '00'.repeat(32) }],
    ['validatorId of the wrong length', { validatorId: new Uint8Array(31) }],
    ['powNonce Infinity', { powNonce: Number.POSITIVE_INFINITY }],
  ])('%s yields null', (_label, override) => {
    const store = storeServing(
      new Map([[1, makeBlock(makeHeader(override as Partial<BlockHeader>))]]),
    );
    expect(store.getOrderingBlockId(1)).toBeNull();
  });

  it('a validatorId that is a 32-character string, not 32 bytes, yields null', () => {
    // Phase 1e's finding, reached through this method: a length check would
    // accept this and the encoder would not. `isBytesOfLength` checks type
    // before width, so it lands as `null` rather than as a throw.
    const store = storeServing(
      new Map([[1, makeBlock(makeHeader({ validatorId: 'x'.repeat(32) as unknown as Uint8Array }))]]),
    );
    expect(store.getOrderingBlockId(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The absence branches around the call — each one is a place a lobotomy hides
// ---------------------------------------------------------------------------

describe('LazySyncStore.getOrderingBlockId — absence', () => {
  it('returns null when no headers handler has been registered', () => {
    expect(new LazySyncStore().getOrderingBlockId(1)).toBeNull();
  });

  it('returns null when the handler has no block at that height', () => {
    const store = storeServing(new Map([[1, makeBlock(makeHeader())]]));
    expect(store.getOrderingBlockId(2)).toBeNull();
  });

  it.each([
    ['a block with no header', {}],
    ['a header that is not an object', { header: 42 }],
    ['a null header', { header: null }],
    ['a non-object block', 'not-a-block'],
  ])('returns null for %s', (_label, served) => {
    const store = storeServing(new Map([[1, served]]));
    expect(store.getOrderingBlockId(1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The caller — what the `null` actually costs, one level up
// ---------------------------------------------------------------------------

describe('LazySyncStore.getAnchors', () => {
  it('advertises an anchor for an in-domain tip', () => {
    const header = makeHeader();
    const store = storeServing(new Map([[1, makeBlock(header)]]));

    expect(store.getAnchors()).toEqual([
      { height: 1, blockId: blockHash(header) },
    ]);
  });

  it('advertises no anchor for an out-of-domain tip, rather than a colliding one', () => {
    // This is class B's consequence at the call site: the absence is absorbed
    // (`if (id)`), so a malformed stored header costs us one anchor instead of
    // publishing an id that several distinct headers would share.
    const store = storeServing(
      new Map([[1, makeBlock(makeHeader({ createdAt: Number.NaN }))]]),
    );

    expect(store.getAnchors()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The wiring — that this is the store NetNode actually uses
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

const config: NetConfig = {
  magic: 0x54444147,
  postPowTargetBits: 20,
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

describe('NetNode.setHeadersHandler wiring', () => {
  it('routes the public handler into the store the sync machine reads', () => {
    // Without this, every test above proves only that a class works — not that
    // it is the class production drives. `setHeadersHandler` wires the store
    // unconditionally (the libp2p guard covers only the legacy protocol
    // registration), so no `start()` and no I/O is needed here.
    //
    // The cast reaches a private field, deliberately and in one place: there is
    // no public reader for `getOrderingBlockId` on NetNode. It pins the field
    // name `syncStore`; if that rename ever happens, this line is the one to
    // follow, and widening the class's public surface is the alternative.
    const header = makeHeader();
    const net = new NetNode(config, validators);
    net.setHeadersHandler((h) => (h === 7 ? makeBlock(header) : null));

    const store = (net as unknown as { syncStore: LazySyncStore }).syncStore;

    expect(store.getOrderingBlockId(7)).toBe(blockHash(header));
    expect(store.getOrderingBlockId(8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendBlocks — Phase 1f-3b, the swallow that spanned decode AND dispatch
//
// The old body wrapped both in one `try` and logged every escape as "failed to
// decode block". Two consequences: a throw out of node's `applyOrderingBlock`
// was reported as a decode failure, and the loop carried on to the next block —
// applying blocks past the one that failed, though they are chain-linked.
//
// Like `getOrderingBlockId` before it, the real method had no coverage at all:
// every existing test stubs `appendBlocks` on a fake `SyncStore`.
// ---------------------------------------------------------------------------

/** A store whose block handler records what it is given, and can be made to throw. */
function storeApplying(onBlock: (b: OrderingBlock) => void): LazySyncStore {
  const store = new LazySyncStore();
  store.setBlocksHandler(onBlock);
  return store;
}

const GOOD_1 = encodeOrderingBlock(makeBlock(makeHeader({ height: 1 })));
const GOOD_2 = encodeOrderingBlock(makeBlock(makeHeader({ height: 2 })));
const UNDECODABLE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

describe('LazySyncStore.appendBlocks', () => {
  it('applies every block in a good batch, in order', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => seen.push(b.header.height));

    store.appendBlocks([GOOD_1, GOOD_2]);

    expect(seen).toEqual([1, 2]);
  });

  it('skips an undecodable entry and still applies the rest', () => {
    // A decode failure is genuinely the sender's fault and genuinely
    // per-modifier — the other entries decode independently — so this one keeps
    // the `continue` the old code had.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: number[] = [];
    const store = storeApplying((b) => seen.push(b.header.height));

    store.appendBlocks([GOOD_1, UNDECODABLE, GOOD_2]);

    expect(seen).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('appendBlocks: failed to decode block'),
    );
    warn.mockRestore();
  });

  it('propagates a handler throw instead of reporting it as a decode failure', () => {
    // The misattribution defect. Pre-fix this threw inside the `try` and was
    // logged as "failed to decode block" — a consensus-apply failure wearing a
    // wire-format label, sending whoever read the log to the wrong package.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeApplying(() => {
      throw new Error('apply exploded');
    });

    expect(() => store.appendBlocks([GOOD_1])).toThrow('apply exploded');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops the batch at a handler throw rather than applying later blocks', () => {
    // The sequencing defect, and the reason this is not merely a labelling fix.
    // Blocks are chain-linked; continuing past a failure applies the successor
    // of a block that did not land.
    const seen: number[] = [];
    const store = storeApplying((b) => {
      if (b.header.height === 1) throw new Error('apply exploded');
      seen.push(b.header.height);
    });

    expect(() => store.appendBlocks([GOOD_1, GOOD_2])).toThrow('apply exploded');
    expect(seen).toEqual([]); // block 2 was never attempted
  });

  it('ignores entries that are not byte arrays', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => seen.push(b.header.height));

    store.appendBlocks(['nope', 42, null, undefined, {}, GOOD_1]);

    expect(seen).toEqual([1]);
  });

  it('does nothing when no blocks handler is registered', () => {
    expect(() => new LazySyncStore().appendBlocks([GOOD_1])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The export is for tests, not for consumers
// ---------------------------------------------------------------------------

describe('LazySyncStore is not part of net’s published surface', () => {
  it('is absent from the index allowlist', () => {
    // `src/index.ts` is an explicit named allowlist, not `export *`, and
    // `package.json` publishes only `"."` → `dist/index.js`. So exporting this
    // class from `node.ts` makes it importable source-relatively (as this file
    // does) without adding anything a consumer of `@dagsocial/net` can reach.
    // Asserted against the allowlist rather than against `dist/`, because
    // `pnpm test` does not require a build to have run.
    const indexSrc = readFileSync(
      fileURLToPath(new URL('../src/index.ts', import.meta.url)),
      'utf8',
    );
    expect(indexSrc).not.toContain('LazySyncStore');
  });
});
