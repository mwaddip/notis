// MESH_INTERFACE → What the client remembers — the per-network store
// the client holds the kept proof, the remembered nodes and the
// answered forks under one lock. The store takes a `continues` seam
// over byte arrays, so these cases need no proof — a fake `continues`
// over bytes stands for the compare, and a fake lock runs one callback
// at a time, in order.

import { describe, it, expect } from 'vitest';
import {
  createMeshMemoryStore,
  type MeshMemoryRecord,
  type MemorySnapshot,
  type StorageLike,
} from '../../src/mesh/memory-store.js';
import {
  REMEMBERED_NODES_MAX,
  ANSWERED_FORKS_MAX,
} from '../../src/mesh/protocols.js';
import type { MeshContact } from '../../src/mesh/node-list.js';

const g1 = 'a'.repeat(64);
const g2 = 'b'.repeat(64);

function idOf(n: number): string {
  return n.toString(16).padStart(64, '0');
}

function fakeStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem(key) { return map.get(key) ?? null; },
    setItem(key, value) { map.set(key, value); },
    removeItem(key) { map.delete(key); },
  };
}

interface FakeLocks {
  request(name: string, fn: () => Promise<void>): Promise<void>;
  holdHistory: string[];
}

function fakeLocks(): FakeLocks {
  const tails = new Map<string, Promise<void>>();
  const holdHistory: string[] = [];
  return {
    holdHistory,
    async request(name, fn) {
      const prev = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const next = prev.then(() => held);
      tails.set(name, next);
      await prev;
      holdHistory.push(name);
      try {
        await fn();
      } finally {
        release();
        if (tails.get(name) === next) tails.delete(name);
      }
    },
  };
}

// base64 of the ASCII bytes of the argument — a short, legible form
// the cases can match against with `base64FromAscii('kept')` etc.
function base64FromAscii(s: string): string {
  return btoa(s);
}
function b64ToAscii(b64: string): string {
  return atob(b64);
}

function bytesFromAscii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function record(
  genesis: string,
  proof: string,
  nodes: MeshContact[] = [],
  answeredForks: string[] = [],
): string {
  const r: MeshMemoryRecord = { genesis, proof, nodes, answeredForks };
  return JSON.stringify(r);
}

const idA = idOf(0xa);
const idB = idOf(0xb);

describe('mesh memory store', () => {
  it.fails('a snapshot whose proof does not continue the stored one keeps the stored proof and merges the nodes', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const key = `notis.mesh.memory.devnet`;
    storage.setItem(
      key,
      record(g1, base64FromAscii('kept'), [{ notisId: idA, addrs: ['/ip4/1.1.1.1/tcp/1'] }]),
    );
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => false,
    });
    const snapshot: MemorySnapshot = {
      proof: bytesFromAscii('new'),
      nodes: [{ notisId: idB, addrs: ['/ip4/2.2.2.2/tcp/1'] }],
      dropped: [],
      answeredForks: [],
      replace: false,
    };
    await store.write(snapshot, g1);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('kept');
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB, idA]);
  });

  it.fails('replace writes the proof whatever it is', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const key = `notis.mesh.memory.devnet`;
    storage.setItem(key, record(g1, base64FromAscii('kept')));
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => false,
    });
    await store.write(
      {
        proof: bytesFromAscii('reader-continue'),
        nodes: [],
        dropped: [],
        answeredForks: [],
        replace: true,
      },
      g1,
    );
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('reader-continue');
  });

  it.fails('a key in dropped leaves the remembered nodes', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const key = `notis.mesh.memory.devnet`;
    storage.setItem(
      key,
      record(g1, base64FromAscii('kept'), [
        { notisId: idA, addrs: ['/ip4/1.1.1.1/tcp/1'] },
        { notisId: idB, addrs: ['/ip4/2.2.2.2/tcp/1'] },
      ]),
    );
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    await store.write(
      {
        proof: null,
        nodes: [],
        dropped: [idA],
        answeredForks: [],
        replace: false,
      },
      g1,
    );
    const stored = store.read();
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB]);
  });

  it.fails('two pages write in turn under the lock — the earlier page\'s older proof never overwrites the newer', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    // `continues(kept, next)` reads whether `next`'s height — the first
    // byte of its ASCII payload — is above `kept`'s: so a write whose
    // byte is lower than the stored one is kept out as the stored proof
    // being newer.
    function byteContinues(kept: Uint8Array, next: Uint8Array): boolean {
      return next[0]! > kept[0]!;
    }
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: byteContinues,
    });
    // The newer write ('C' = 0x43) lands first, then the older ('A' =
    // 0x41). Serialised through the lock, the second observes 'C' and
    // its continues returns false, so 'C' stands.
    const newer: MemorySnapshot = {
      proof: bytesFromAscii('Chi'),
      nodes: [],
      dropped: [],
      answeredForks: [],
      replace: false,
    };
    const older: MemorySnapshot = {
      proof: bytesFromAscii('Alo'),
      nodes: [],
      dropped: [],
      answeredForks: [],
      replace: false,
    };
    await Promise.all([store.write(newer, g1), store.write(older, g1)]);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('Chi');
  });

  it.fails('a damaged record reads null and is removed', () => {
    const key = `notis.mesh.memory.devnet`;
    // Bad JSON.
    const s1 = fakeStorage({ [key]: '{not json' });
    const r1 = createMeshMemoryStore({ storage: s1, locks: fakeLocks(), network: 'devnet', continues: () => true });
    expect(r1.read()).toBeNull();
    expect(s1.map.has(key)).toBe(false);

    // Bad base64 proof.
    const s2 = fakeStorage({ [key]: record(g1, 'not*valid base64!') });
    const r2 = createMeshMemoryStore({ storage: s2, locks: fakeLocks(), network: 'devnet', continues: () => true });
    expect(r2.read()).toBeNull();
    expect(s2.map.has(key)).toBe(false);

    // Genesis not 64 hex.
    const s3 = fakeStorage({ [key]: record('ABC', base64FromAscii('kept')) });
    const r3 = createMeshMemoryStore({ storage: s3, locks: fakeLocks(), network: 'devnet', continues: () => true });
    expect(r3.read()).toBeNull();
    expect(s3.map.has(key)).toBe(false);

    // A node without notisId.
    const s4Raw = JSON.stringify({
      genesis: g1,
      proof: base64FromAscii('kept'),
      nodes: [{ addrs: ['/ip4/1.1.1.1/tcp/1'] }],
      answeredForks: [],
    });
    const s4 = fakeStorage({ [key]: s4Raw });
    const r4 = createMeshMemoryStore({ storage: s4, locks: fakeLocks(), network: 'devnet', continues: () => true });
    expect(r4.read()).toBeNull();
    expect(s4.map.has(key)).toBe(false);
  });

  it.fails('a record under another genesis reads as none to write', async () => {
    const storage = fakeStorage();
    const key = `notis.mesh.memory.devnet`;
    // Stored record is under g1 and carries nodes to merge in.
    storage.setItem(
      key,
      record(g1, base64FromAscii('oldKept'), [{ notisId: idA, addrs: ['/ip4/1.1.1.1/tcp/1'] }], ['oldFork']),
    );
    // `continues` returns false so a stored record would keep the old
    // proof; writing under g2 must ignore that record whole.
    const store = createMeshMemoryStore({
      storage,
      locks: fakeLocks(),
      network: 'devnet',
      continues: () => false,
    });
    await store.write(
      {
        proof: bytesFromAscii('fresh'),
        nodes: [{ notisId: idB, addrs: ['/ip4/2.2.2.2/tcp/1'] }],
        dropped: [],
        answeredForks: ['freshFork'],
        replace: false,
      },
      g2,
    );
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.genesis).toBe(g2);
    expect(b64ToAscii(stored!.proof)).toBe('fresh');
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB]);
    expect(stored!.answeredForks).toEqual(['freshFork']);
  });

  it.fails('nodes and answered forks capped at REMEMBERED_NODES_MAX and ANSWERED_FORKS_MAX', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    // Two writes, each carrying REMEMBERED_NODES_MAX + 4 nodes and
    // ANSWERED_FORKS_MAX + 4 forks. After the merge the caps hold.
    const nodes1: MeshContact[] = [];
    const nodes2: MeshContact[] = [];
    for (let i = 0; i < REMEMBERED_NODES_MAX + 4; i++) {
      nodes1.push({ notisId: idOf(0x100 + i), addrs: [`/ip4/10.0.0.${i + 1}/tcp/1`] });
      nodes2.push({ notisId: idOf(0x200 + i), addrs: [`/ip4/20.0.0.${i + 1}/tcp/1`] });
    }
    const forks1 = Array.from({ length: ANSWERED_FORKS_MAX + 4 }, (_, i) => `f1-${i}`);
    const forks2 = Array.from({ length: ANSWERED_FORKS_MAX + 4 }, (_, i) => `f2-${i}`);
    await store.write({ proof: bytesFromAscii('p1'), nodes: nodes1, dropped: [], answeredForks: forks1, replace: false }, g1);
    await store.write({ proof: bytesFromAscii('p2'), nodes: nodes2, dropped: [], answeredForks: forks2, replace: false }, g1);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.nodes.length).toBe(REMEMBERED_NODES_MAX);
    expect(stored!.answeredForks.length).toBe(ANSWERED_FORKS_MAX);
    // The latest `ANSWERED_FORKS_MAX` kept — the last `ANSWERED_FORKS_MAX`
    // values of `forks1 ++ forks2`, duplicates dropped.
    const combined = [...forks1, ...forks2];
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const f of combined) {
      if (seen.has(f)) continue;
      seen.add(f);
      deduped.push(f);
    }
    expect(stored!.answeredForks).toEqual(deduped.slice(-ANSWERED_FORKS_MAX));
  });
});
