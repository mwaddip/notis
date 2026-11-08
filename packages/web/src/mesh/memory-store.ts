// MESH_INTERFACE → What the client remembers — "A client remembers,
// per network, the nodes it found, the proof of the chain it verified,
// and the forks the reader answered — keyed by the genesis the
// network's profile pins, or by the network's name where it pins
// none." The browser-safe store that holds that record under one lock
// (`notis.mesh.memory`): seams for storage and the lock manager, a
// `continues` seam over byte arrays so the store itself carries no
// `@dagsocial/nipopow` import.
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
 * start, latest first; `answeredForks` the forks the reader has
 * answered.
 */
export interface MeshMemoryRecord {
  genesis: string;
  proof: string;
  nodes: MeshContact[];
  answeredForks: string[];
}

/**
 * The snapshot a check hands to `write`. `proof` the bytes of
 * `encodeNipopowProof` of the proof to write — `null` keeps the stored
 * one. `nodes` the nodes to prepend; `dropped` their keys to drop from
 * the merged list; `answeredForks` to merge in. `replace` the
 * reader's *continue* (`→ "What the client remembers"`): the kept proof
 * moves to `proof` whatever `continues(stored, proof)` answers.
 */
export interface MemorySnapshot {
  proof: Uint8Array | null;
  nodes: MeshContact[];
  dropped: string[];
  answeredForks: string[];
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
 * record is held under. The network argument carries what the store is
 * keyed by (`profile.genesisId` or the network name) and the key is
 * `notis.mesh.memory.<network>`.
 */
function storageKey(network: string): string {
  return `notis.mesh.memory.${network}`;
}

export function createMeshMemoryStore(
  opts: CreateMeshMemoryStoreOptions,
): MeshMemoryStore {
  const key = storageKey(opts.network);

  function readRaw(): MeshMemoryRecord | null {
    const raw = opts.storage.getItem(key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      opts.storage.removeItem(key);
      return null;
    }
    if (!isRecord(parsed)) {
      opts.storage.removeItem(key);
      return null;
    }
    const { genesis, proof, nodes, answeredForks } = parsed as Record<string, unknown>;
    if (typeof genesis !== 'string' || !HEX64_RE.test(genesis)) {
      opts.storage.removeItem(key);
      return null;
    }
    if (typeof proof !== 'string' || !BASE64_RE.test(proof)) {
      opts.storage.removeItem(key);
      return null;
    }
    if (!Array.isArray(nodes) || !nodes.every(isMeshContact)) {
      opts.storage.removeItem(key);
      return null;
    }
    if (!Array.isArray(answeredForks) || !answeredForks.every(s => typeof s === 'string')) {
      opts.storage.removeItem(key);
      return null;
    }
    return { genesis, proof, nodes: nodes as MeshContact[], answeredForks: answeredForks as string[] };
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
        const forks = mergeForks(basis?.answeredForks ?? [], snapshot.answeredForks);
        const record: MeshMemoryRecord = {
          genesis,
          proof: bytesToBase64(keptBytes),
          nodes,
          answeredForks: forks,
        };
        opts.storage.setItem(key, JSON.stringify(record));
      });
    },
    clear(): void {
      opts.storage.removeItem(key);
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

function mergeForks(stored: readonly string[], fresh: readonly string[]): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const f of [...stored, ...fresh]) {
    if (seen.has(f)) continue;
    seen.add(f);
    combined.push(f);
  }
  // "The latest `ANSWERED_FORKS_MAX` kept": the tail of the combined
  // list is the newer end (stored then fresh).
  return combined.slice(Math.max(0, combined.length - ANSWERED_FORKS_MAX));
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
