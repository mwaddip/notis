import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';
import { LazySyncStore, NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
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
  orderingBlockPowTargetFloorBits: 2304,
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
});

describe('setChainHeightProvider wiring', () => {
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
