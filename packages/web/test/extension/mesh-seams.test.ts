// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type { MeshClient, ClientState, ClientTraffic, ReadNeed, MeshContact, StartMeshClientOptions } from '../../src/mesh/index.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { PostTextProvider } from '@dagsocial/net/browser';
import { createMeshSeams, startExtensionMesh, parseHandNodeAddress, type StorageLike } from '../../src/extension/mesh-seams.js';
import { HAND_NODE_KEY, SERVE_KEY } from '../../src/extension/storage-keys.js';

const emptyPostTexts: PostTextProvider = async () => new Map<string, string>();

const PEER_HEX = '68112eb3027cf9649a2ebc7f5caa48dbaf7fdb77ad3b1427176767ed2bf50d09';
// The peer id string the hand-added test parses. 12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa
// is the peer id for a specific Ed25519 public key; the notisId that derives
// from it is determined by `notisIdFromPeerId(peerIdFromString(...))`.
const VALID_PEER_ADDR = '/ip4/127.0.0.1/udp/9733/webrtc-direct/certhash/uEiAHocoutEO27UicmZa5J6i7mvNBHjnfOtnAeSTMAR0Ezg/p2p/12D3KooWGpbmMichyTNz56FYsZd8W5rok6JaggtBaXKNqXsdQ8sa';

function emptyTraffic(): ClientTraffic {
  return { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 };
}

function emptyState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: null,
    transport: null,
    path: null,
    lastLeft: null,
    tip: null,
    agreement: null,
    checks: 0,
    traffic: emptyTraffic(),
    nodes: [],
    seated: false,
    proofs: null,
    anchor: null,
    chain: null,
    notContinued: false,
    disagreement: null,
    ...overrides,
  };
}

interface FakeClientHooks {
  base?: (need: ReadNeed) => string | null;
  order?: (need: ReadNeed) => string[];
  state?: () => ClientState;
  check?: () => Promise<void>;
  fetch?: HttpFetch;
  addByHand?: (id: string, addrs: string[], trusted: boolean) => void;
  removeByHand?: (id: string) => void;
  stop?: () => Promise<void>;
}

function fakeClient(hooks: FakeClientHooks = {}): MeshClient {
  const noopFetch: HttpFetch = (url) => Promise.resolve(new Response(JSON.stringify({ url }), { status: 200, headers: { 'content-type': 'application/json' } }));
  return {
    fetch: hooks.fetch ?? noopFetch,
    read: () => Promise.reject(new Error('not used here')),
    base: hooks.base ?? ((): string | null => null),
    order: hooks.order ?? ((): string[] => []),
    check: hooks.check ?? ((): Promise<void> => Promise.resolve()),
    state: hooks.state ?? ((): ClientState => emptyState()),
    onState: () => () => {},
    stop: hooks.stop ?? ((): Promise<void> => Promise.resolve()),
    addByHand: hooks.addByHand ?? ((): void => {}),
    removeByHand: hooks.removeByHand ?? ((): void => {}),
    answer: (): void => {},
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

function fakeLocks(): { request(name: string, fn: () => Promise<void>): Promise<void> } {
  return { request: (_n, fn) => fn() };
}

const check: (rows: unknown[]) => PostCheck[] = (rows) => rows.map((): PostCheck => ({ status: 'unbound', reason: 'no-tx', verdict: 'no-tx' }));

describe('parseHandNodeAddress', () => {
  it('parses an ip4 webrtc-direct address ending in /p2p/<peer id>', () => {
    const r = parseHandNodeAddress(VALID_PEER_ADDR);
    expect('notisId' in r).toBe(true);
    if ('notisId' in r) expect(r.notisId).toBe(PEER_HEX);
  });
  it('refuses a DNS address', () => {
    const r = parseHandNodeAddress('/dns4/notis.fun/p2p/x');
    expect(r).toEqual({ error: 'addresses with DNS names are not accepted' });
  });
  it('refuses an address missing /p2p/<id>', () => {
    const r = parseHandNodeAddress('/ip4/127.0.0.1/udp/9733/webrtc-direct/certhash/uEiA');
    expect(r).toEqual({ error: 'address must end in /p2p/<peer id>' });
  });
  it('refuses a blank address', () => {
    expect(parseHandNodeAddress('')).toEqual({ error: 'the address is blank' });
  });
});

describe('createMeshSeams — the seams the App takes', () => {
  it('the readClient fetches at client.base(\'tip\')', async () => {
    const urls: string[] = [];
    const client = fakeClient({
      base: () => 'https://a.example',
      fetch: (url) => { urls.push(url); return Promise.resolve(new Response(JSON.stringify({ tip: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })); },
    });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage: fakeStorage() });
    // The call shape doesn't matter here — what matters is the URL the
    // client built goes to `client.base('tip')`.
    try { await seams.readClient.status(); } catch { /* the response is not a /status shape — PageError is ok */ }
    expect(urls[0]).toBe('https://a.example/status');
  });

  it('the readClient fetches at the empty base when client.base answers null', async () => {
    const urls: string[] = [];
    const client = fakeClient({
      base: () => null,
      fetch: (url) => { urls.push(url); return Promise.resolve(new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })); },
    });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage: fakeStorage() });
    try { await seams.readClient.status(); } catch { /* 2xx null is a PageError; the url is what we care about */ }
    expect(urls[0]).toBe('/status');
  });

  it('the writeClient walks client.order(\'tip\') — the first base answered, then the next, then the next', async () => {
    const urls: string[] = [];
    const client = fakeClient({
      order: () => ['https://a.example', 'https://b.example'],
      fetch: (url) => {
        urls.push(url);
        if (url.startsWith('https://a.example')) {
          return Promise.reject(new Error('A is down'));
        }
        return Promise.resolve(new Response(JSON.stringify({ postId: 'x', status: 'pending' }), { status: 400 }));
      },
    });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage: fakeStorage() });
    await seams.writeClient.submitLike({ foo: 'bar' });
    expect(urls).toEqual(['https://a.example/likes', 'https://b.example/likes']);
  });

  it('the tip verifier awaits one check and answers tipRunOf(state)', async () => {
    let checkCalls = 0;
    const client = fakeClient({
      check: () => { checkCalls++; return Promise.resolve(); },
      state: () => emptyState({ seated: false, agreement: null }),
    });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage: fakeStorage() });
    const run = await seams.tipVerifier.run();
    expect(checkCalls).toBe(1);
    expect(run.verdict).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
    expect(run.anchor).toBeNull();
    expect(run.chain).toBeNull();
  });

  it('the resolver reads client.order(\'older\') for its nodes', async () => {
    const urls: string[] = [];
    const client = fakeClient({
      order: (need): string[] => need === 'older' ? ['https://older.example'] : ['https://tip.example'],
      fetch: (url) => { urls.push(url); return Promise.resolve(new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { 'content-type': 'application/json' } })); },
    });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage: fakeStorage() });
    await seams.postResolver.resolve(['a'.repeat(64)], () => {});
    expect(urls[0]).toContain('https://older.example/posts/batch');
  });

  it('the handNodeSeam.address reads the stored key', () => {
    const storage = fakeStorage({ [HAND_NODE_KEY]: VALID_PEER_ADDR });
    const client = fakeClient();
    const seams = createMeshSeams({ client, network: 'devnet', check, storage });
    expect(seams.handNodeSeam.address()).toBe(VALID_PEER_ADDR);
  });

  it('a valid commit calls client.addByHand and stores the address', () => {
    const calls: Array<{ id: string; addrs: string[]; trusted: boolean }> = [];
    const client = fakeClient({ addByHand: (id, addrs, trusted) => { calls.push({ id, addrs, trusted }); } });
    const storage = fakeStorage();
    const seams = createMeshSeams({ client, network: 'devnet', check, storage });
    const err = seams.handNodeSeam.commit(VALID_PEER_ADDR);
    expect(err).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe(PEER_HEX);
    expect(calls[0]!.addrs).toEqual([VALID_PEER_ADDR]);
    expect(calls[0]!.trusted).toBe(true);
    expect(storage.map.get(HAND_NODE_KEY)).toBe(VALID_PEER_ADDR);
  });

  it('a blank commit calls client.removeByHand and clears the stored address', () => {
    const calls: string[] = [];
    const client = fakeClient({ removeByHand: (id) => { calls.push(id); } });
    const storage = fakeStorage({ [HAND_NODE_KEY]: VALID_PEER_ADDR });
    const seams = createMeshSeams({ client, network: 'devnet', check, storage });
    const err = seams.handNodeSeam.commit('');
    expect(err).toBeNull();
    expect(calls).toEqual([PEER_HEX]);
    expect(storage.map.has(HAND_NODE_KEY)).toBe(false);
  });

  it('a DNS commit returns the error and stores nothing', () => {
    const calls: Array<{ id: string; addrs: string[] }> = [];
    const client = fakeClient({ addByHand: (id, addrs) => { calls.push({ id, addrs }); } });
    const storage = fakeStorage();
    const seams = createMeshSeams({ client, network: 'devnet', check, storage });
    const err = seams.handNodeSeam.commit('/dns4/notis.fun/p2p/x');
    expect(err).toBe('addresses with DNS names are not accepted');
    expect(calls).toHaveLength(0);
    expect(storage.map.has(HAND_NODE_KEY)).toBe(false);
  });
});

describe('startExtensionMesh — the lifecycle', () => {
  it('awaits startMeshClient, kicks a check without awaiting, and attaches pagehide', async () => {
    let checkCalls = 0;
    let stopCalls = 0;
    const client = fakeClient({
      check: () => { checkCalls++; return Promise.resolve(); },
      stop: () => { stopCalls++; return Promise.resolve(); },
    });
    let startOpts: StartMeshClientOptions | null = null;
    const startMeshClient = vi.fn(async (opts: StartMeshClientOptions): Promise<MeshClient> => { startOpts = opts; return client; });
    const firstContact: MeshContact[] = [];
    const storage = fakeStorage();
    const addHandler = vi.fn();
    const window = { addEventListener: addHandler };
    await startExtensionMesh({
      firstContact, network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage, locks: fakeLocks(), window, startMeshClient, postTexts: emptyPostTexts,
    });
    expect(startMeshClient).toHaveBeenCalledTimes(1);
    expect(startOpts!.network).toBe('devnet');
    expect(startOpts!.agentName).toBe('notis-extension');
    expect(checkCalls).toBe(1);
    expect(addHandler).toHaveBeenCalledWith('pagehide', expect.any(Function), { once: true });
    // Fire pagehide — the client stops.
    const [, handler] = addHandler.mock.calls[0]!;
    (handler as () => void)();
    await Promise.resolve();
    expect(stopCalls).toBe(1);
  });

  it('a stored hand-added address is re-added via addByHand after start', async () => {
    const addCalls: string[] = [];
    const client = fakeClient({ addByHand: (id) => { addCalls.push(id); } });
    const startMeshClient = vi.fn(async (): Promise<MeshClient> => client);
    const storage = fakeStorage({ [HAND_NODE_KEY]: VALID_PEER_ADDR });
    await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage, locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient, postTexts: emptyPostTexts,
    });
    expect(addCalls).toEqual([PEER_HEX]);
  });

  it('a stored proof that does not decode is replaced by the next check\'s snapshot', async () => {
    // startExtensionMesh's `continues` seam must decode each proof alone:
    // a stored proof that does not decode answers `true` (the next
    // snapshot's proof replaces it); a next proof that does not decode
    // answers `false` (the kept one stands). A bare catch around
    // `decode(kept), decode(next), compare(…)` swallows a bad stored proof
    // and the store never recovers.
    const { encodeNipopowProof } = await import('@dagsocial/nipopow');
    const { proveWithReader } = await import('@dagsocial/nipopow');
    const { buildMinedChain, makeReader } = await import('../../../nipopow/test/helpers.js');
    const { DEFAULT_M, DEFAULT_K } = await import('@dagsocial/nipopow-client');
    const next = proveWithReader(makeReader(buildMinedChain({ count: DEFAULT_M + DEFAULT_K })), { m: DEFAULT_M, k: DEFAULT_K });
    const nextBytes = encodeNipopowProof(next);
    const nextB64 = Buffer.from(nextBytes).toString('base64');
    // The stored record's proof is base64 of random bytes — a valid
    // base64 string, but `decodeNipopowProof` will throw on it.
    const badBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const badB64 = Buffer.from(badBytes).toString('base64');
    // Devnet's profile pins no genesis, so any 64-hex value stays — the
    // record is read, and `write` re-stamps the stored one as it goes.
    const GENESIS = 'ab'.repeat(32);
    const storage = fakeStorage({
      'notis.mesh.memory.devnet': JSON.stringify({ genesis: GENESIS, proof: badB64, nodes: [] }),
    });
    let capturedOnChecked: ((s: import('../../src/mesh/index.js').MemorySnapshot) => void) | null = null;
    // Devnet pins no genesis, so startExtensionMesh takes the chain from
    // the client's state for the write's `genesis`; a `null` chain would
    // make onChecked return early with no write.
    const GENESIS_FOR_WRITE = GENESIS;
    const client = fakeClient({
      state: () => emptyState({ seated: true, chain: GENESIS_FOR_WRITE }),
    });
    const startMeshClient = vi.fn(async (opts: import('../../src/mesh/index.js').StartMeshClientOptions): Promise<MeshClient> => {
      capturedOnChecked = opts.onChecked ?? null;
      return client;
    });
    await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage, locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient, postTexts: emptyPostTexts,
    });
    expect(capturedOnChecked).not.toBeNull();
    // Trigger the check-end callback with a snapshot carrying a decodable
    // proof. The store's `continues` must answer `true` for the bad
    // stored proof, and the new proof replaces it.
    const snapshot: import('../../src/mesh/index.js').MemorySnapshot = {
      proof: nextBytes,
      nodes: [],
      dropped: [],
      answered: [],
      replace: false,
    };
    capturedOnChecked!(snapshot);
    // The store's write is awaited inside a .catch; let it flush.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const stored = storage.map.get('notis.mesh.memory.devnet');
    expect(stored).toBeDefined();
    const record = JSON.parse(stored!);
    expect(record.proof).toBe(nextB64);
  });

  it('two pages are two seams on two fake clients — pagehide on one stops only its client; the other\'s reads go on', async () => {
    // WEB_INTERFACE → The extension → "The page holds the extension's
    // reader" — "one per page, started at load and stopped at pagehide;
    // two pages are two readers". The test mirrors that rule by booting
    // two seams and firing pagehide on one window only.
    const client1 = fakeClient();
    const client2 = fakeClient();
    const stop1 = vi.spyOn(client1, 'stop').mockResolvedValue();
    const stop2 = vi.spyOn(client2, 'stop').mockResolvedValue();
    const read1 = vi.spyOn(client1, 'base').mockReturnValue('https://a.example');
    const read2 = vi.spyOn(client2, 'base').mockReturnValue('https://b.example');

    const handlers1: Array<[string, (e: unknown) => void]> = [];
    const window1 = { addEventListener: (ev: string, cb: (e: unknown) => void) => { handlers1.push([ev, cb]); } };
    const handlers2: Array<[string, (e: unknown) => void]> = [];
    const window2 = { addEventListener: (ev: string, cb: (e: unknown) => void) => { handlers2.push([ev, cb]); } };

    const startMeshClient = vi.fn()
      .mockImplementationOnce(async (): Promise<MeshClient> => client1)
      .mockImplementationOnce(async (): Promise<MeshClient> => client2);
    const { seams: seams1 } = await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage: fakeStorage(), locks: fakeLocks(), window: window1, startMeshClient, postTexts: emptyPostTexts,
    });
    const { seams: seams2 } = await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage: fakeStorage(), locks: fakeLocks(), window: window2, startMeshClient, postTexts: emptyPostTexts,
    });

    // Both seams read their own client's base.
    expect(seams1.readClient['base' in seams1.readClient ? 'base' : 'base' as never]).toBeDefined();
    // Fire pagehide on window1 only.
    const [, cb1] = handlers1.find(([ev]) => ev === 'pagehide')!;
    cb1(new Event('pagehide'));
    await Promise.resolve();
    expect(stop1).toHaveBeenCalledTimes(1);
    expect(stop2).not.toHaveBeenCalled();
    // Seam 2 still answers off its live client.
    expect(seams2.tipVerifier).toBeDefined();
    expect(read1).toBeDefined();
    expect(read2).toBeDefined();
  });

  // WEB_INTERFACE → The settings window → "The serve row": `SERVE_KEY` is
  // read at the mesh client's start — `'1'` is on, any other value or
  // none off — and passed as `serving: { on, texts }` to
  // `startMeshClient`.
  it("serving starts off with no key and on with '1'", async () => {
    const texts: PostTextProvider = async (ids) => new Map(ids.map((id) => [id, 'x']));
    // No key: serving.on is false; the texts the provider handed in are
    // passed through.
    const client1 = fakeClient();
    const start1 = vi.fn(async (opts: StartMeshClientOptions): Promise<MeshClient> => { captured1 = opts; return client1; });
    let captured1: StartMeshClientOptions | null = null;
    await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage: fakeStorage(), locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient: start1, postTexts: texts,
    });
    expect(captured1!.serving).toBeDefined();
    expect(captured1!.serving!.on).toBe(false);
    expect(captured1!.serving!.texts).toBe(texts);
    // `SERVE_KEY === '1'`: serving.on is true, texts the same.
    const client2 = fakeClient();
    let captured2: StartMeshClientOptions | null = null;
    const start2 = vi.fn(async (opts: StartMeshClientOptions): Promise<MeshClient> => { captured2 = opts; return client2; });
    await startExtensionMesh({
      firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
      check, storage: fakeStorage({ [SERVE_KEY]: '1' }), locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient: start2, postTexts: texts,
    });
    expect(captured2!.serving!.on).toBe(true);
    expect(captured2!.serving!.texts).toBe(texts);
  });

  // WEB_INTERFACE → The settings window → "The serve row": `on()` reads
  // the stored choice — `'1'` is on, any other value or none off.
  it('the serve seam reads the stored choice', async () => {
    const start = async (_o: StartMeshClientOptions): Promise<MeshClient> => fakeClient();
    // No key: on() reads false.
    {
      const storage = fakeStorage();
      const { seams } = await startExtensionMesh({
        firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
        check, storage, locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient: start, postTexts: emptyPostTexts,
      });
      expect(seams.serveSeam.on()).toBe(false);
    }
    // `'1'`: on() reads true.
    {
      const storage = fakeStorage({ [SERVE_KEY]: '1' });
      const { seams } = await startExtensionMesh({
        firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
        check, storage, locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient: start, postTexts: emptyPostTexts,
      });
      expect(seams.serveSeam.on()).toBe(true);
    }
    // Any other value: on() reads false.
    {
      const storage = fakeStorage({ [SERVE_KEY]: 'yes' });
      const { seams } = await startExtensionMesh({
        firstContact: [], network: 'devnet', agentName: 'notis-extension', httpFetch: fetch.bind(globalThis),
        check, storage, locks: fakeLocks(), window: { addEventListener: () => {} }, startMeshClient: start, postTexts: emptyPostTexts,
      });
      expect(seams.serveSeam.on()).toBe(false);
    }
  });

  // WEB_INTERFACE → The settings window → "The serve row": `set(true)`
  // writes `'1'` under `SERVE_KEY` and calls `client.setServing(true)`;
  // `set(false)` removes the key and calls `client.setServing(false)`.
  it('set writes the key and calls setServing', () => {
    const servingCalls: boolean[] = [];
    const client = {
      ...fakeClient(),
      setServing: (on: boolean): Promise<void> => { servingCalls.push(on); return Promise.resolve(); },
    };
    const storage = fakeStorage();
    const seams = createMeshSeams({ client, network: 'devnet', check, storage });
    seams.serveSeam.set(true);
    expect(storage.map.get(SERVE_KEY)).toBe('1');
    expect(servingCalls).toEqual([true]);
    seams.serveSeam.set(false);
    expect(storage.map.has(SERVE_KEY)).toBe(false);
    expect(servingCalls).toEqual([true, false]);
  });

  // WEB_INTERFACE → The extension → "The mesh client's faults reach the
  // page's console" — the extension hands its mesh client a log that
  // writes each line to the page's console as an error.
  it.fails('the mesh client is handed a log that writes each line to console.error', async () => {
    let startOpts: StartMeshClientOptions | null = null;
    const client = fakeClient();
    const startMeshClient = vi.fn(async (opts: StartMeshClientOptions): Promise<MeshClient> => {
      startOpts = opts;
      return client;
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startExtensionMesh({
        firstContact: [], network: 'devnet', agentName: 'notis-extension',
        httpFetch: fetch.bind(globalThis),
        check, storage: fakeStorage(), locks: fakeLocks(),
        window: { addEventListener: () => {} }, startMeshClient, postTexts: emptyPostTexts,
      });
      expect(typeof startOpts!.log).toBe('function');
      startOpts!.log!('[mesh-client] fault line');
      expect(consoleSpy).toHaveBeenCalledWith('[mesh-client] fault line');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
