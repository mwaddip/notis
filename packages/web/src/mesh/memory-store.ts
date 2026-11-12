// MESH_INTERFACE → What the client remembers — "A client remembers,
// per network, the nodes it found, the proof of the chain it verified,
// and the branches the reader answered — keyed by the genesis the
// network's profile pins, or by the network's name where it pins
// none." The browser-safe store that holds that record under one lock
// (`notis.mesh.memory`): seams for storage and the lock manager, a
// `continues` seam over byte arrays so the store itself carries no
// `@dagsocial/nipopow` import.
//
// WEB_INTERFACE → The extension → "What the extension remembers" —
// "The answered branches are kept apart from it, each its competing
// proof as base64 under a key of its own beside the record, written
// when the reader answers and when the branch it names grows". The
// main record carries the genesis, the kept proof's base64 and the
// known nodes; each answered branch holds its competing proof as
// base64 under `notis.mesh.memory.<network>.answered.<n>`, slot 0 the
// oldest and the last slot the newest. A side key that does not
// parse as base64 or whose bytes a caller rejects as undecodable is
// dropped alone.
//
// Browser-safe (`MESH_INTERFACE → Place in the workspace`): no `node:`
// import, `atob`/`btoa` from the DOM lib, no global state.

import { REMEMBERED_NODES_MAX, ANSWERED_FORKS_MAX } from './protocols.js';
import type { MeshContact } from './node-list.js';

/**
 * The narrow storage shape the store takes. `window.localStorage` fits;
 * tests pass a fake. Also the shape `src/extension/mesh-seams.ts`
 * takes for its hand-added-node address — one shared contract.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * MESH_INTERFACE → What the client remembers — the per-network record
 * the store holds. `proof` the base64 of `encodeNipopowProof` of the
 * kept proof; `genesis` 64 lowercase hex, the pin the record is keyed
 * under; `nodes` the known nodes the client would dial at its next
 * start, latest first; `answered` the competing proofs the reader has
 * answered, each the bytes of `encodeNipopowProof`, decoded from the
 * side keys at read time.
 */
export interface MeshMemoryRecord {
  genesis: string;
  proof: string;
  nodes: MeshContact[];
  answered: Uint8Array[];
}

/**
 * The snapshot a check hands to `write`. `proof` the bytes of
 * `encodeNipopowProof` of the proof to write — `null` keeps the stored
 * one. `nodes` the nodes to prepend; `dropped` their keys to drop from
 * the merged list; `answered` the full current answered-branches set,
 * one `encodeNipopowProof` per entry, slot 0 oldest. `replace` the
 * reader's *continue* (`→ "What the client remembers"`): the kept proof
 * moves to `proof` whatever `continues(stored, proof)` answers.
 */
export interface MemorySnapshot {
  proof: Uint8Array | null;
  nodes: MeshContact[];
  dropped: string[];
  answered: Uint8Array[];
  replace: boolean;
}

export interface MeshMemoryStore {
  read(): MeshMemoryRecord | null;
  write(snapshot: MemorySnapshot, genesis: string): Promise<void>;
  clear(): void;
}

export interface CreateMeshMemoryStoreOptions {
  storage: StorageLike;
  locks: { request(name: string, fn: () => Promise<void>): Promise<void> };
  network: string;
  continues: (kept: Uint8Array, next: Uint8Array) => boolean;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LOCK_NAME = 'notis.mesh.memory';

/**
 * MESH_INTERFACE → What the client remembers — the per-network key the
 * main record is held under: `notis.mesh.memory.<network name>`. The
 * record's `genesis` field pins the chain inside the record; the key
 * is always the network's name.
 */
function storageKey(network: string): string {
  return `notis.mesh.memory.${network}`;
}

/**
 * WEB_INTERFACE → The extension → "What the extension remembers" —
 * the side key one answered branch sits under: the main key, then
 * `.answered.<n>`, slot 0 oldest, up to `ANSWERED_FORKS_MAX - 1`.
 */
function answeredSlotKey(network: string, n: number): string {
  return `notis.mesh.memory.${network}.answered.${n}`;
}

export function createMeshMemoryStore(
  opts: CreateMeshMemoryStoreOptions,
): MeshMemoryStore {
  const key = storageKey(opts.network);

  function readAnsweredFromStorage(): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let n = 0; n < ANSWERED_FORKS_MAX; n++) {
      const k = answeredSlotKey(opts.network, n);
      const raw = opts.storage.getItem(k);
      if (raw === null) continue;
      if (!BASE64_RE.test(raw)) {
        // A stored proof that does not decode is dropped alone.
        opts.storage.removeItem(k);
        continue;
      }
      try {
        out.push(base64ToBytes(raw));
      } catch {
        opts.storage.removeItem(k);
      }
    }
    return out;
  }

  function clearAnsweredSideKeys(): void {
    for (let n = 0; n < ANSWERED_FORKS_MAX; n++) {
      opts.storage.removeItem(answeredSlotKey(opts.network, n));
    }
  }

  function readRaw(): MeshMemoryRecord | null {
    const raw = opts.storage.getItem(key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
      return null;
    }
    if (!isRecord(parsed)) {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
      return null;
    }
    const { genesis, proof, nodes } = parsed as Record<string, unknown>;
    if (typeof genesis !== 'string' || !HEX64_RE.test(genesis)) {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
      return null;
    }
    if (typeof proof !== 'string' || !BASE64_RE.test(proof)) {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
      return null;
    }
    if (!Array.isArray(nodes) || !nodes.every(isMeshContact)) {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
      return null;
    }
    const answered = readAnsweredFromStorage();
    return {
      genesis,
      proof,
      nodes: nodes as MeshContact[],
      answered,
    };
  }

  function writeAnsweredSideKeys(answered: Uint8Array[]): void {
    // "written only when answered or advanced, never at a check that
    // changes none of them": the side-key write diffs slot by slot
    // against what is stored and only hands the storage a changed
    // value.
    const upper = Math.min(answered.length, ANSWERED_FORKS_MAX);
    for (let n = 0; n < upper; n++) {
      const k = answeredSlotKey(opts.network, n);
      const want = bytesToBase64(answered[n]!);
      const have = opts.storage.getItem(k);
      if (have !== want) opts.storage.setItem(k, want);
    }
    for (let n = upper; n < ANSWERED_FORKS_MAX; n++) {
      const k = answeredSlotKey(opts.network, n);
      if (opts.storage.getItem(k) !== null) opts.storage.removeItem(k);
    }
  }

  return {
    read: readRaw,
    async write(snapshot: MemorySnapshot, genesis: string): Promise<void> {
      await opts.locks.request(LOCK_NAME, async () => {
        // "A record under another genesis reads as none to write": the
        // old chain's record carries no node to merge and no proof to
        // compare against the new one — the fresh record stands.
        const stored = readRaw();
        const basis = stored !== null && stored.genesis === genesis ? stored : null;
        let keptBytes: Uint8Array | null = null;
        if (snapshot.proof === null) {
          if (basis !== null) keptBytes = base64ToBytes(basis.proof);
        } else if (snapshot.replace || basis === null) {
          keptBytes = snapshot.proof;
        } else {
          const basisBytes = base64ToBytes(basis.proof);
          keptBytes = opts.continues(basisBytes, snapshot.proof) ? snapshot.proof : basisBytes;
        }
        if (keptBytes === null) return;
        const nodes = mergeNodes(snapshot.nodes, basis?.nodes ?? [], snapshot.dropped);
        const record = {
          genesis,
          proof: bytesToBase64(keptBytes),
          nodes,
        };
        opts.storage.setItem(key, JSON.stringify(record));
        writeAnsweredSideKeys(snapshot.answered);
      });
    },
    clear(): void {
      opts.storage.removeItem(key);
      clearAnsweredSideKeys();
    },
  };
}

function mergeNodes(
  fresh: readonly MeshContact[],
  stored: readonly MeshContact[],
  dropped: readonly string[],
): MeshContact[] {
  const droppedSet = new Set(dropped);
  const seen = new Set<string>();
  const out: MeshContact[] = [];
  for (const n of fresh) {
    if (droppedSet.has(n.notisId)) continue;
    if (seen.has(n.notisId)) continue;
    seen.add(n.notisId);
    out.push(copyContact(n));
    if (out.length >= REMEMBERED_NODES_MAX) return out;
  }
  for (const n of stored) {
    if (droppedSet.has(n.notisId)) continue;
    if (seen.has(n.notisId)) continue;
    seen.add(n.notisId);
    out.push(copyContact(n));
    if (out.length >= REMEMBERED_NODES_MAX) return out;
  }
  return out;
}

function copyContact(c: MeshContact): MeshContact {
  const out: MeshContact = { notisId: c.notisId, addrs: [...c.addrs] };
  if (c.api !== undefined) out.api = c.api;
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isMeshContact(v: unknown): v is MeshContact {
  if (!isRecord(v)) return false;
  if (typeof v['notisId'] !== 'string' || !HEX64_RE.test(v['notisId'] as string)) return false;
  if (!Array.isArray(v['addrs']) || !v['addrs'].every((s: unknown) => typeof s === 'string')) return false;
  if ('api' in v && v['api'] !== undefined && typeof v['api'] !== 'string') return false;
  return true;
}

// Base64 without a Node `Buffer`: the client holds no Node global, and
// atob/btoa are in the DOM lib and present under vitest too. Local
// copies keep the module self-contained — no import on identity code.
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
