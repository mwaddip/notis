// MESH_INTERFACE → Place in the workspace / Discovery / NAT / What the
// client remembers — the page's wiring: fetch `config.json` beside the
// page (the stage writes it), take the profile from
// `NETWORK_PROFILES[network]`, open the per-network memory store under
// `localStorage` through `createMeshMemoryStore`, read the record at
// start (seats the client's seeds and memory), start the client,
// apply `config.byHand` through `addByHand` in its given order, attach
// the hand-form, and call `render` on every `onState`. The one
// injectable is `fetch` (config read); `startMeshClient` is the real
// one — its first statement runs `assertClientConfig`, which throws
// `MeshConfigError` for a `/dns4/`, `/dns6/` or `/dnsaddr/`
// first-contact address before any libp2p node is created.
//
// MESH_INTERFACE → NAT → "A client's STUN list comes from the public
// nodes it holds" — the client derives its STUN servers from its node
// list. A config that still carries `stunServers` is refused in words,
// so a stale stage writer shows itself.
//
// MESH_INTERFACE → What the client remembers — the record's `genesis`
// is the one the profile pins, or absent where it pins none; the store's
// write merges nodes and forks under one lock. The `continues` seam
// decodes both encoded proofs and runs `@dagsocial/web/mesh`'s own
// `continues` against the client's profile and wall clock.
//
// A configuration that fails to load (network error, non-ok status,
// unparseable JSON, missing field), a `MeshConfigError` from
// `startMeshClient`, and a malformed `byHand` entry are shown on the
// page in words.

import { profileFor } from '@dagsocial/types';
import type { NetworkType } from '@dagsocial/types';
import { startMeshClient, continues, createMeshMemoryStore } from '@dagsocial/web/mesh';
import type {
  MeshContact,
  MeshClient,
  NetworkName,
  ReadNeed,
  StorageLike,
} from '@dagsocial/web/mesh';
import { MeshConfigError } from '@dagsocial/web/mesh';
import { decodeNipopowProof } from '@dagsocial/nipopow';
import { render } from './render.js';
import { runProbe } from './probe.js';
import { attachHandForm } from './form.js';
import { runReads } from './reads.js';

export interface ByHandEntry {
  notisId: string;
  addrs: string[];
  trusted: boolean;
}

export interface PageConfig {
  network: NetworkName;
  firstContact: MeshContact[];
  /**
   * MESH_INTERFACE → Discovery → "Known nodes" — contacts without
   * trust. Optional; default none. A seed's addresses meet the same
   * refusals as a first-contact node's, and a seed carries no trust
   * assertion of its own.
   */
  seeds?: MeshContact[];
  /**
   * MESH_INTERFACE → Discovery → "A node added by hand" — entries
   * applied through `client.addByHand` after start, in the given
   * order. Optional; default none.
   */
  byHand?: ByHandEntry[];
}

/**
 * MESH_INTERFACE → What the client remembers — the lock manager shape
 * the store takes. The page passes `navigator.locks` adapted to it;
 * tests pass a fake that runs callbacks in order.
 */
export interface LockManagerLike {
  request(name: string, fn: () => Promise<void>): Promise<void>;
}

export interface RunMainOptions {
  root: HTMLElement;
  fetch: typeof globalThis.fetch;
  /**
   * Test seam: swap the client factory. Defaults to the real
   * `startMeshClient`. Not meant for ordinary callers.
   */
  startMeshClient?: typeof startMeshClient;
  /**
   * MESH_INTERFACE → What the client remembers — the storage the
   * memory store holds the record in. Defaults to
   * `globalThis.localStorage`. Tests pass a fake.
   */
  storage?: StorageLike;
  /**
   * MESH_INTERFACE → What the client remembers — the lock manager the
   * memory store serialises its writes under. Defaults to an adapter
   * over `navigator.locks`. Tests pass a fake that runs callbacks in
   * order.
   */
  locks?: LockManagerLike;
  /**
   * MESH_INTERFACE → What the client remembers — the wall clock the
   * `continues` seam reads. Defaults to `Date.now`. Tests pass a fake.
   */
  wallClock?: () => number;
}

export async function runMain(opts: RunMainOptions): Promise<void> {
  const wallClock = opts.wallClock ?? (() => Date.now());
  const storage = opts.storage ?? (globalThis.localStorage as StorageLike);
  const locks = opts.locks ?? defaultLockManager();

  // MESH_INTERFACE → What the client remembers — the page honours one
  // query parameter here: `?clearMemory=1` removes every
  // `notis.mesh.memory.*` key from the origin's `localStorage` BEFORE
  // the client reads any memory, so a scenario that measures a client
  // with no memory opens a page target at `<url>?clearMemory=1` and
  // reads the fresh state. The page's other honoured query parameters
  // (`?probe=`, `?reads=`) ride alongside unchanged. The walk reads
  // the real `Storage`'s `length` + `key(i)` index, which the
  // `StorageLike` seam does not expose — so the clear fires only on
  // the default `globalThis.localStorage`; a test that passes
  // `opts.storage` holds the keys it means to.
  if (shouldClearMemory() && typeof opts.storage === 'undefined') {
    clearMeshMemoryKeys(globalThis.localStorage);
  }

  let config: PageConfig;
  try {
    config = await loadConfig(opts.fetch);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  let profile;
  try {
    profile = profileFor(config.network as NetworkType);
  } catch (e) {
    showError(opts.root, `config refused: ${messageOf(e)}`);
    return;
  }

  // MESH_INTERFACE → What the client remembers — "A client remembers,
  // per network, the nodes it found, the proof of the chain it
  // verified, and the forks the reader answered — keyed by the genesis
  // the network's profile pins, or by the network's name where it pins
  // none." The seam `continues` decodes both encoded proofs and runs
  // `@dagsocial/web/mesh`'s `continues` against the profile and the
  // page's wall clock; a proof that fails to decode is treated as not
  // continuing, so a corrupted record cannot pin the kept proof to
  // junk.
  const store = createMeshMemoryStore({
    storage,
    locks,
    network: config.network,
    continues: (kept, next) => {
      try {
        const keptProof = decodeNipopowProof(kept);
        const nextProof = decodeNipopowProof(next);
        return continues(keptProof, nextProof, profile, wallClock());
      } catch {
        return false;
      }
    },
  });

  // MESH_INTERFACE → What the client remembers — "A record under
  // another genesis reads as none to write": where the profile pins a
  // genesis, the stored record's `genesis` must match, else the record
  // is ignored; where the profile pins none (devnet), the stored record
  // is taken as it stands.
  const pinnedGenesis = pinnedGenesisHex(profile);
  const record = store.read();
  const useRecord = record !== null
    && (pinnedGenesis === null || record.genesis === pinnedGenesis);

  // MESH_INTERFACE → What the client remembers — "keyed by the genesis
  // the network's profile pins, or by the client's chain where it pins
  // none" — the chain is the lowercase hex blockHash of block 1
  // (`MeshClient.state().chain`), non-null once the client has seated.
  // `onChecked` reads this through `seatedClient`, which is assigned
  // once `startMeshClient` resolves. Before the chain is held, the
  // write is skipped — no key spelt from the network's name survives
  // the store's read (which refuses a `genesis` that is not 64 hex).
  let seatedClient: MeshClient | null = null;
  const seedsFromConfig = config.seeds ?? [];
  const seedsFromRecord: MeshContact[] = useRecord ? record!.nodes : [];
  // The record's nodes come in as the client's `seeds` — known nodes
  // (`MESH_INTERFACE → Discovery → "Known nodes"`), one entry per key.
  // A seed named by both the config and the record keeps the config's
  // entry; `startMeshClient` and `NodeList.add` de-duplicate by key.
  const seedsMerged = mergeSeeds(seedsFromConfig, seedsFromRecord);

  const startFn = opts.startMeshClient ?? startMeshClient;
  let client: MeshClient;
  try {
    client = await startFn({
      firstContact: config.firstContact,
      ...(seedsMerged.length > 0 ? { seeds: seedsMerged } : {}),
      network: config.network,
      profile,
      agentName: 'notis-mesh-poc',
      wallClock,
      ...(useRecord
        ? {
            memory: {
              proof: bytesFromBase64(record!.proof),
              answeredForks: [...record!.answeredForks],
            },
          }
        : {}),
      onChecked: (snapshot) => {
        // MESH_INTERFACE → What the client remembers — "A client
        // remembers, per network ... keyed by the genesis the network's
        // profile pins, or by the client's chain where it pins none."
        // The chain is `MeshClient.state().chain` — block 1's lowercase
        // hex blockHash, non-null once the client has seated. The
        // store's `read` refuses a `genesis` that is not 64 hex, so a
        // write before the chain is held would pin a record no later
        // read keeps; skip it until the chain is seated.
        const chainName = seatedClient !== null ? seatedClient.state().chain : null;
        const genesisForWrite = pinnedGenesis ?? chainName;
        if (genesisForWrite === null) return;
        void store.write(snapshot, genesisForWrite);
      },
    });
    seatedClient = client;
  } catch (e) {
    if (e instanceof MeshConfigError) {
      showError(opts.root, `config refused: ${messageOf(e)}`);
      return;
    }
    throw e;
  }

  // MESH_INTERFACE → Discovery → "A node added by hand" — the
  // config's `byHand` entries are applied in given order; a
  // malformed one refuses the whole config in words AND stops the
  // client, so a refused config leaves no libp2p node running on
  // the entries that landed before the bad one.
  if (config.byHand !== undefined) {
    try {
      for (const entry of config.byHand) {
        client.addByHand(entry.notisId, entry.addrs, entry.trusted);
      }
    } catch (e) {
      if (e instanceof MeshConfigError) {
        await client.stop();
        showError(opts.root, `config refused: byHand ${messageOf(e)}`);
        return;
      }
      throw e;
    }
  }

  client.onState((s) => render(s, opts.root, { client }));
  render(client.state(), opts.root, { client });

  attachHandForm({ root: opts.root, client });

  // MESH_INTERFACE → Acceptance — the one query parameter the page honours:
  // `?probe=<path>` reads `<path>` through the client's own fetch after the
  // first state with a non-null `nodeId`, and writes `<pre id="probe">`.
  const probePath = readProbePath();
  if (probePath !== null) {
    void runProbe({ client, path: probePath, root: opts.root });
  }

  // MESH_INTERFACE → The client's node list → "A routed read goes to
  // a node its need allows" — `?reads=<n>&need=<tip|older>` drives
  // routed reads after the first check.
  const reads = readReadsParams();
  if (reads !== null) {
    void runReads({ client, n: reads.n, need: reads.need, root: opts.root });
  }
}

/**
 * MESH_INTERFACE → What the client remembers — the genesis the record
 * is keyed under: `profile.genesisId` where it is 64 hex, `null`
 * otherwise. The fallback key (the network's name) is applied by the
 * caller.
 */
function pinnedGenesisHex(profile: { genesisId?: string | null }): string | null {
  const g = profile.genesisId;
  if (typeof g !== 'string') return null;
  if (!/^[0-9a-f]{64}$/.test(g)) return null;
  return g;
}

function mergeSeeds(fromConfig: MeshContact[], fromRecord: MeshContact[]): MeshContact[] {
  const seen = new Set<string>();
  const out: MeshContact[] = [];
  for (const n of fromConfig) {
    if (seen.has(n.notisId)) continue;
    seen.add(n.notisId);
    out.push(n);
  }
  for (const n of fromRecord) {
    if (seen.has(n.notisId)) continue;
    seen.add(n.notisId);
    out.push(n);
  }
  return out;
}

function defaultLockManager(): LockManagerLike {
  return {
    async request(name, fn) {
      // `navigator.locks.request` takes a callback the browser awaits;
      // its return value is what the callback resolves to. The store's
      // callback resolves to `void`, so the outer `Promise<void>` is
      // the natural fit.
      await navigator.locks.request(name, () => fn());
    },
  };
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function readProbePath(): string | null {
  if (typeof globalThis.location === 'undefined') return null;
  const params = new URLSearchParams(globalThis.location.search);
  const value = params.get('probe');
  return value === null || value === '' ? null : value;
}

function shouldClearMemory(): boolean {
  if (typeof globalThis.location === 'undefined') return false;
  const params = new URLSearchParams(globalThis.location.search);
  return params.get('clearMemory') === '1';
}

/**
 * Remove every `notis.mesh.memory.<key>` entry from `storage` — the
 * real `Storage` interface exposes `length` + `key(i)`, so the clear
 * walks the index. A `Storage` whose contents change mid-walk is
 * handled by taking a snapshot of the keys to remove before any
 * `removeItem` fires.
 */
function clearMeshMemoryKeys(storage: Storage): void {
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (typeof k === 'string' && k.startsWith('notis.mesh.memory.')) toRemove.push(k);
  }
  for (const k of toRemove) storage.removeItem(k);
}

function readReadsParams(): { n: number; need: ReadNeed } | null {
  if (typeof globalThis.location === 'undefined') return null;
  const params = new URLSearchParams(globalThis.location.search);
  const nRaw = params.get('reads');
  const needRaw = params.get('need');
  if (nRaw === null || nRaw === '' || needRaw === null) return null;
  if (needRaw !== 'tip' && needRaw !== 'older') return null;
  const n = Number(nRaw);
  if (!Number.isInteger(n)) return null;
  return { n, need: needRaw };
}

async function loadConfig(fetchFn: typeof globalThis.fetch): Promise<PageConfig> {
  const res = await fetchFn('./config.json');
  if (!res.ok) {
    throw new Error(`config.json request answered ${String(res.status)}`);
  }
  const raw: unknown = await res.json();
  return validateConfig(raw);
}

function validateConfig(raw: unknown): PageConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('config.json must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const net = o['network'];
  if (net !== 'devnet' && net !== 'testnet' && net !== 'mainnet') {
    throw new Error(`config.network must be 'devnet' | 'testnet' | 'mainnet', not ${JSON.stringify(net)}`);
  }
  const firstContact = o['firstContact'];
  if (!Array.isArray(firstContact)) {
    throw new Error('config.firstContact must be an array');
  }
  // MESH_INTERFACE → NAT → "A client's STUN list comes from the
  // public nodes it holds" — a config carrying the key is refused, in
  // words.
  if (o['stunServers'] !== undefined) {
    throw new Error(
      'config.stunServers is refused: the client takes its STUN servers from the nodes it holds',
    );
  }
  // MESH_INTERFACE → Discovery → "Known nodes" — optional, default
  // none; when present it must be an array (its addresses are refused
  // by `assertClientConfig`, not here).
  const seedsRaw = o['seeds'];
  let seeds: MeshContact[] | undefined;
  if (seedsRaw !== undefined) {
    if (!Array.isArray(seedsRaw)) {
      throw new Error('config.seeds must be an array when present');
    }
    seeds = seedsRaw as MeshContact[];
  }
  // MESH_INTERFACE → Discovery → "A node added by hand" — optional
  // list of `{ notisId, addrs, trusted }`. Shape only here; the
  // semantic refusals (bad hex, DNS, non-webrtc-direct) ride on the
  // runtime `addByHand` call.
  const byHandRaw = o['byHand'];
  let byHand: ByHandEntry[] | undefined;
  if (byHandRaw !== undefined) {
    if (!Array.isArray(byHandRaw)) {
      throw new Error('config.byHand must be an array when present');
    }
    byHand = byHandRaw.map((entry, i) => validateByHandEntry(entry, i));
  }
  return {
    network: net,
    firstContact: firstContact as MeshContact[],
    ...(seeds !== undefined ? { seeds } : {}),
    ...(byHand !== undefined ? { byHand } : {}),
  };
}

function validateByHandEntry(raw: unknown, index: number): ByHandEntry {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`config.byHand[${String(index)}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const notisId = o['notisId'];
  if (typeof notisId !== 'string') {
    throw new Error(`config.byHand[${String(index)}].notisId must be a string`);
  }
  const addrs = o['addrs'];
  if (!Array.isArray(addrs) || addrs.some((a) => typeof a !== 'string')) {
    throw new Error(`config.byHand[${String(index)}].addrs must be an array of strings`);
  }
  const trusted = o['trusted'];
  if (typeof trusted !== 'boolean') {
    throw new Error(`config.byHand[${String(index)}].trusted must be a boolean`);
  }
  return { notisId, addrs: addrs as string[], trusted };
}

function showError(root: HTMLElement, text: string): void {
  while (root.firstChild !== null) root.removeChild(root.firstChild);
  const box = document.createElement('div');
  box.setAttribute('data-role', 'error');
  box.textContent = text;
  root.appendChild(box);
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
