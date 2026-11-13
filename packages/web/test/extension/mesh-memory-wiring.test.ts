// @vitest-environment happy-dom
// WEB_INTERFACE → The extension → "What the extension remembers".
// MESH_INTERFACE → What the client remembers.
import { describe, it, expect, vi } from 'vitest';
import type { MeshClient, ClientState, ClientTraffic, StartMeshClientOptions } from '../../src/mesh/index.js';
import type { MemorySnapshot } from '../../src/mesh/memory-store.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import {
  startExtensionMesh,
  type StorageLike,
} from '../../src/extension/mesh-seams.js';
import { profileFor } from '@dagsocial/types';
import type { PostCheck } from '@dagsocial/nipopow-client';

const TESTNET_GENESIS = profileFor('testnet').genesisId;
const OTHER_GENESIS = '0'.repeat(64);
const NODE_HEX = 'a'.repeat(64);
// Three NUL bytes, a valid base64 payload the memory store accepts; the
// mesh client's constructor decodes it and refuses to seat — the seam
// hands the bytes through unchanged, which is all these cases observe.
const PROOF_B64 = 'AAAA';
const PROOF_BYTES = new Uint8Array([0, 0, 0]);
const KEY = (network: string): string => `notis.mesh.memory.${network}`;

function emptyTraffic(): ClientTraffic {
  return { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 };
}

function emptyState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: null, transport: null, path: null, lastLeft: null, tip: null,
    agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
    seated: false, proofs: null, anchor: null, chain: null,
    notContinued: false, disagreement: null, ...overrides,
  };
}

interface FakeClientHooks {
  state?: () => ClientState;
}

function fakeClient(hooks: FakeClientHooks = {}): MeshClient {
  const noopFetch: HttpFetch = (url) =>
    Promise.resolve(new Response(JSON.stringify({ url }), { status: 200, headers: { 'content-type': 'application/json' } }));
  return {
    fetch: noopFetch,
    read: () => Promise.reject(new Error('not used here')),
    base: () => null,
    order: () => [],
    check: () => Promise.resolve(),
    state: hooks.state ?? ((): ClientState => emptyState()),
    onState: () => () => {},
    stop: () => Promise.resolve(),
    addByHand: () => {},
    removeByHand: () => {},
    answer: () => {},
    configuredAddrs: () => [],
    iceConfiguration: () => ({ iceServers: [] }),
    toRemember: () => ({ proof: null, nodes: [], dropped: [], answered: [], replace: false }),
    setServing: () => Promise.resolve(),
    libp2p: {} as unknown as MeshClient['libp2p'],
  };
}

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

function immediateLocks(): { request(name: string, fn: () => Promise<void>): Promise<void> } {
  return { request: (_n, fn) => fn() };
}

const check: (rows: unknown[]) => PostCheck[] = (rows) =>
  rows.map((): PostCheck => ({ status: 'unbound', reason: 'no-tx', verdict: 'no-tx' }));

/** Pump the microtask queue so an unawaited write under the lock lands. */
async function pump(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  await new Promise<void>(r => setTimeout(r, 0));
}

// The seam's option shape is tightened by the implementation in a later
// commit. These cases pass a literal that already carries `locks`; the cast
// keeps the test file compiling against today's type where the field is
// still missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Opts = any;

describe('startExtensionMesh — memory wiring', () => {
  it('a stored record seeds the client and hands it the kept proof and the answered branches', async () => {
    const storage = fakeStorage({
      [KEY('testnet')]: JSON.stringify({
        genesis: TESTNET_GENESIS,
        proof: PROOF_B64,
        nodes: [{ notisId: NODE_HEX, addrs: ['/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg'] }],
      }),
      [`${KEY('testnet')}.answered.0`]: PROOF_B64,
    });
    let captured: StartMeshClientOptions | null = null;
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      captured = o;
      return fakeClient();
    });
    const opts: Opts = {
      firstContact: [], network: 'testnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks: immediateLocks(),
      window: { addEventListener: () => {} }, startMeshClient,
    };
    await startExtensionMesh(opts);
    expect(captured).not.toBeNull();
    expect(captured!.seeds).toEqual([{ notisId: NODE_HEX, addrs: ['/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg'] }]);
    expect(captured!.memory).toBeDefined();
    expect(captured!.memory!.answered.length).toBe(1);
    expect(Array.from(captured!.memory!.answered[0]!)).toEqual(Array.from(PROOF_BYTES));
    expect(Array.from(captured!.memory!.proof)).toEqual(Array.from(PROOF_BYTES));
  });

  it('a record kept under another pinned genesis is cleared and the client starts with none', async () => {
    const storage = fakeStorage({
      [KEY('testnet')]: JSON.stringify({
        genesis: OTHER_GENESIS,
        proof: PROOF_B64,
        nodes: [{ notisId: NODE_HEX, addrs: [] }],
      }),
    });
    let captured: StartMeshClientOptions | null = null;
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      captured = o;
      return fakeClient();
    });
    const opts: Opts = {
      firstContact: [], network: 'testnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks: immediateLocks(),
      window: { addEventListener: () => {} }, startMeshClient,
    };
    await startExtensionMesh(opts);
    expect(captured!.seeds).toBeUndefined();
    expect(captured!.memory).toBeUndefined();
    expect(storage.map.has(KEY('testnet'))).toBe(false);
  });

  it('a damaged record is cleared and the client starts with none', async () => {
    const storage = fakeStorage({ [KEY('testnet')]: 'not { json' });
    let captured: StartMeshClientOptions | null = null;
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      captured = o;
      return fakeClient();
    });
    const opts: Opts = {
      firstContact: [], network: 'testnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks: immediateLocks(),
      window: { addEventListener: () => {} }, startMeshClient,
    };
    await startExtensionMesh(opts);
    expect(captured!.seeds).toBeUndefined();
    expect(captured!.memory).toBeUndefined();
    expect(storage.map.has(KEY('testnet'))).toBe(false);
  });

  it("each check's snapshot is written through the store under the lock, keyed by the pinned genesis", async () => {
    const storage = fakeStorage();
    const lockNames: string[] = [];
    const locks = {
      request: async (name: string, fn: () => Promise<void>): Promise<void> => {
        lockNames.push(name);
        await fn();
      },
    };
    let onChecked: ((s: MemorySnapshot) => void) | undefined;
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      onChecked = o.onChecked;
      return fakeClient();
    });
    const opts: Opts = {
      firstContact: [], network: 'testnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks,
      window: { addEventListener: () => {} }, startMeshClient,
    };
    await startExtensionMesh(opts);
    expect(onChecked).toBeDefined();
    const answeredBytes = new Uint8Array([9, 9, 9]);
    const snapshot: MemorySnapshot = {
      proof: PROOF_BYTES,
      nodes: [{ notisId: NODE_HEX, addrs: ['/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg'] }],
      dropped: [],
      answered: [answeredBytes],
      replace: false,
    };
    onChecked!(snapshot);
    await pump();
    expect(lockNames).toContain('notis.mesh.memory');
    const stored = storage.map.get(KEY('testnet'));
    expect(stored).toBeDefined();
    const parsed: { genesis: string; proof: string } = JSON.parse(stored!);
    expect(parsed.genesis).toBe(TESTNET_GENESIS);
    expect(parsed.proof).toBe(PROOF_B64);
    // The answered branch is kept under its own side key.
    expect(storage.map.get(`${KEY('testnet')}.answered.0`))
      .toBe(btoa(String.fromCharCode(9, 9, 9)));
  });

  it("on a network pinning no genesis the snapshot is keyed by the client's chain name, and none is written before a chain", async () => {
    const storage = fakeStorage();
    let onChecked: ((s: MemorySnapshot) => void) | undefined;
    // The fake client lets the case move state().chain between fires.
    const stateRef: { v: ClientState } = { v: emptyState({ chain: null }) };
    const client = fakeClient({ state: () => stateRef.v });
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      onChecked = o.onChecked;
      return client;
    });
    const opts: Opts = {
      firstContact: [], network: 'devnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks: immediateLocks(),
      window: { addEventListener: () => {} }, startMeshClient,
    };
    await startExtensionMesh(opts);
    expect(onChecked).toBeDefined();
    const snapshot: MemorySnapshot = {
      proof: PROOF_BYTES, nodes: [], dropped: [], answered: [], replace: false,
    };
    // Chain is null — the write is skipped.
    onChecked!(snapshot);
    await pump();
    expect(storage.map.has(KEY('devnet'))).toBe(false);
    // Seat a chain, then fire again — the write lands keyed by the chain name.
    const CHAIN = 'bb'.repeat(32);
    stateRef.v = emptyState({ chain: CHAIN, seated: true });
    onChecked!(snapshot);
    await pump();
    const stored = storage.map.get(KEY('devnet'));
    expect(stored).toBeDefined();
    const parsed: { genesis: string } = JSON.parse(stored!);
    expect(parsed.genesis).toBe(CHAIN);
  });

  it('a rejected write is logged and the check carries on', async () => {
    // A storage that throws on setItem makes the write under the lock reject.
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => {},
    };
    let onChecked: ((s: MemorySnapshot) => void) | undefined;
    const startMeshClient = vi.fn(async (o: StartMeshClientOptions): Promise<MeshClient> => {
      onChecked = o.onChecked;
      return fakeClient();
    });
    const opts: Opts = {
      firstContact: [], network: 'testnet', agentName: 'notis-extension',
      httpFetch: fetch.bind(globalThis), check, storage, locks: immediateLocks(),
      window: { addEventListener: () => {} }, startMeshClient,
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startExtensionMesh(opts);
      expect(onChecked).toBeDefined();
      const snapshot: MemorySnapshot = {
        proof: PROOF_BYTES, nodes: [], dropped: [], answered: [], replace: false,
      };
      // The call must not throw — a rejected write stays inside the seam.
      expect(() => onChecked!(snapshot)).not.toThrow();
      await pump();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
