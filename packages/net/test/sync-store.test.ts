import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { BlockHeader, OrderingBlock } from '@dagsocial/types';
import {
  PROTOCOL_VERSION,
  encodeOrderingBlock,
} from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
} from '@dagsocial/validation';
import { LazySyncStore, NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

function makeHeader(overrides: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: PROTOCOL_VERSION,
    height: 1,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 100,
    powTargetBits: 4 * 256,
    createdAt: 1_000_000,
    interlinkRoot: '00'.repeat(32),
    ...overrides,
  };
}

function makeBlock(header: BlockHeader): OrderingBlock {
  return {
    header,
    utxoTxTree: {
      utxoTxIds: [header.height.toString(16).padStart(64, '0')],
      utxoTxs: [new Uint8Array(96).fill(header.height & 0xff)],
    },
    validatorSignature: new Uint8Array(64),
  };
}

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyPostBody,
};

// ---------------------------------------------------------------------------
// Provider-read tests — NET_INTERFACE → Sync Handler Registration
// ---------------------------------------------------------------------------

describe('LazySyncStore.getOrderingBlockId — provider read', () => {
  it('returns the provider value for a known height', () => {
    const store = new LazySyncStore(validators);
    store.setBlockIdProvider((h) => h === 1 ? 'id_1' : null);
    expect(store.getOrderingBlockId(1)).toBe('id_1');
  });

  it('returns null when the provider returns null', () => {
    const store = new LazySyncStore(validators);
    store.setBlockIdProvider(() => null);
    expect(store.getOrderingBlockId(1)).toBeNull();
  });

  it('returns null when no provider is set', () => {
    expect(new LazySyncStore(validators).getOrderingBlockId(1)).toBeNull();
  });

  it('a later setBlockIdProvider replaces the delegate', () => {
    const store = new LazySyncStore(validators);
    store.setBlockIdProvider(() => 'old');
    expect(store.getOrderingBlockId(1)).toBe('old');
    store.setBlockIdProvider(() => 'new');
    expect(store.getOrderingBlockId(1)).toBe('new');
  });
});

describe('LazySyncStore.heightByBlockId — provider read', () => {
  it('returns the provider value for a known id', () => {
    const store = new LazySyncStore(validators);
    store.setHeightByBlockIdProvider((id) => id === 'abc' ? 5 : null);
    expect(store.heightByBlockId('abc')).toBe(5);
  });

  it('returns null for an unknown id', () => {
    const store = new LazySyncStore(validators);
    store.setHeightByBlockIdProvider(() => null);
    expect(store.heightByBlockId('xyz')).toBeNull();
  });

  it('returns null when no provider is set', () => {
    expect(new LazySyncStore(validators).heightByBlockId('abc')).toBeNull();
  });

  it('a later setHeightByBlockIdProvider replaces the delegate', () => {
    const store = new LazySyncStore(validators);
    store.setHeightByBlockIdProvider(() => 10);
    expect(store.heightByBlockId('x')).toBe(10);
    store.setHeightByBlockIdProvider(() => 99);
    expect(store.heightByBlockId('x')).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// NetNode forwarding — provider setters reach the sync store
// ---------------------------------------------------------------------------

const config: NetConfig = {
  magic: 0x54444147,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3600000,
  penaltySafeIntervalMs: 120000,
  syncRequestTimeoutMs: 10000,
};

describe('NetNode provider forwarding', () => {
  function getStore(net: NetNode): LazySyncStore {
    return (net as unknown as { syncStore: LazySyncStore }).syncStore;
  }

  it('setBlockIdProvider forwards to the sync store', () => {
    const net = new NetNode(config, validators);
    net.setBlockIdProvider((h) => h === 7 ? 'id7' : null);

    const store = getStore(net);
    expect(store.getOrderingBlockId(7)).toBe('id7');
    expect(store.getOrderingBlockId(8)).toBeNull();
  });

  it('setHeightByBlockIdProvider forwards to the sync store', () => {
    const net = new NetNode(config, validators);
    net.setHeightByBlockIdProvider((id) => id === 'abc' ? 3 : null);

    const store = getStore(net);
    expect(store.heightByBlockId('abc')).toBe(3);
    expect(store.heightByBlockId('xyz')).toBeNull();
  });

  it('setChainHeightProvider forwards to the sync store', () => {
    const net = new NetNode(config, validators);
    net.setChainHeightProvider(() => 77);
    expect(getStore(net).chainHeight()).toBe(77);
  });

  it('peerTipHeight returns null before start', () => {
    const net = new NetNode(config, validators);
    expect(net.peerTipHeight('any-peer')).toBeNull();
  });
});

describe('setChainHeightProvider wiring', () => {
  it('chainHeight reads the height provider, not the headers provider', () => {
    const store = new LazySyncStore(validators);
    let headersProviderCalls = 0;
    let heightProviderCalls = 0;
    store.setOrderingBlockFn(() => { headersProviderCalls++; return null; });
    store.setChainHeightProvider(() => { heightProviderCalls++; return 42; });

    const result = store.chainHeight();

    expect(result).toBe(42);
    expect(heightProviderCalls).toBe(1);
    expect(headersProviderCalls).toBe(0);
  });

  it('returns 0 when no height provider is set', () => {
    const store = new LazySyncStore(validators);
    expect(store.chainHeight()).toBe(0);
  });

  it('a later setChainHeightProvider replaces the delegate', () => {
    const store = new LazySyncStore(validators);
    store.setChainHeightProvider(() => 10);
    expect(store.chainHeight()).toBe(10);
    store.setChainHeightProvider(() => 99);
    expect(store.chainHeight()).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// appendBlocks — decode and dispatch fail for different reasons
//
// One `try` over both would log every escape as "failed to decode block": a
// throw out of node's `applyOrderingBlock` reported as a decode failure, and
// the loop carrying on to apply blocks past the one that failed, though they
// are chain-linked. So the `try` covers the decode alone.
//
// Like `getOrderingBlockId`, the real method is otherwise uncovered — every
// test outside this file stubs `appendBlocks` on a fake `SyncStore`.
// ---------------------------------------------------------------------------

/** A store whose block handler records what it is given, and can be made to throw. */
function storeApplying(onBlock: (b: OrderingBlock, fromPeerId: string) => boolean): LazySyncStore {
  const store = new LazySyncStore(validators);
  store.setBlocksHandler(onBlock);
  return store;
}

const TEST_PEER = 'test-peer';

const GOOD_1 = encodeOrderingBlock(makeBlock(makeHeader({ height: 1 })));
const GOOD_2 = encodeOrderingBlock(makeBlock(makeHeader({ height: 2 })));
const UNDECODABLE = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

describe('LazySyncStore.appendBlocks', () => {
  it('applies every block in a good batch, in order', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => { seen.push(b.header.height); return true; });

    store.appendBlocks([GOOD_1, GOOD_2], TEST_PEER);

    expect(seen).toEqual([1, 2]);
  });

  it('skips an undecodable entry and still applies the rest', () => {
    // A decode failure is genuinely the sender's fault and genuinely
    // per-modifier — the other entries decode independently — so this one
    // `continue`s rather than stopping the batch.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: number[] = [];
    const store = storeApplying((b) => { seen.push(b.header.height); return true; });

    store.appendBlocks([GOOD_1, UNDECODABLE, GOOD_2], TEST_PEER);

    expect(seen).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('appendBlocks: failed to decode block'),
    );
    warn.mockRestore();
  });

  it('propagates a handler throw instead of reporting it as a decode failure', () => {
    // The misattribution this guards against: inside the decode `try` this
    // throw logs as "failed to decode block" — a consensus-apply failure
    // wearing a wire-format label, sending whoever reads the log to the wrong
    // package.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeApplying((): boolean => {
      throw new Error('apply exploded');
    });

    expect(() => store.appendBlocks([GOOD_1], TEST_PEER)).toThrow('apply exploded');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops the batch at a handler throw rather than applying later blocks', () => {
    // The sequencing defect, and the reason this is not merely a labelling fix.
    // Blocks are chain-linked; continuing past a failure applies the successor
    // of a block that did not land.
    const seen: number[] = [];
    const store = storeApplying((b): boolean => {
      if (b.header.height === 1) throw new Error('apply exploded');
      seen.push(b.header.height);
      return true;
    });

    expect(() => store.appendBlocks([GOOD_1, GOOD_2], TEST_PEER)).toThrow('apply exploded');
    expect(seen).toEqual([]); // block 2 was never attempted
  });

  it('ignores entries that are not byte arrays', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => { seen.push(b.header.height); return true; });

    store.appendBlocks(['nope', 42, null, undefined, {}, GOOD_1], TEST_PEER);

    expect(seen).toEqual([1]);
  });

  it('does nothing when no blocks handler is registered', () => {
    expect(() => new LazySyncStore(validators).appendBlocks([GOOD_1], TEST_PEER)).not.toThrow();
  });

  it('passes the peer id to the handler', () => {
    const received: string[] = [];
    const store = storeApplying((_b, peerId) => { received.push(peerId); return true; });

    store.appendBlocks([GOOD_1, GOOD_2], 'counterparty-x');

    expect(received).toEqual(['counterparty-x', 'counterparty-x']);
  });

  it('stops the batch at the first false return', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => {
      seen.push(b.header.height);
      return b.header.height !== 1;
    });

    store.appendBlocks([GOOD_1, GOOD_2], TEST_PEER);

    expect(seen).toEqual([1]);
  });

  it('calls the handler for all blocks when every return is true', () => {
    const seen: number[] = [];
    const store = storeApplying((b) => { seen.push(b.header.height); return true; });

    store.appendBlocks([GOOD_1, GOOD_2], TEST_PEER);

    expect(seen).toEqual([1, 2]);
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
