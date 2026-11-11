// MESH_INTERFACE → What the client remembers — the per-network store
// the client holds the kept proof, the remembered nodes and the
// answered branches under one lock. Each answered branch sits in its
// own side key beside the main record (`WEB_INTERFACE → The extension
// → "What the extension remembers"`). The store takes a `continues`
// seam over byte arrays, so these cases need no proof — a fake
// `continues` over bytes stands for the compare, and a fake lock runs
// one callback at a time, in order.

import { describe, it, expect } from 'vitest';
import {
  createMeshMemoryStore,
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
): string {
  // The main record is `{ genesis, proof, nodes }`; the store attaches
  // the answered proofs from its side keys at read time.
  return JSON.stringify({ genesis, proof, nodes });
}

const idA = idOf(0xa);
const idB = idOf(0xb);

describe('mesh memory store', () => {
  it('a snapshot whose proof does not continue the stored one keeps the stored proof and merges the nodes', async () => {
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
      answered: [],
      replace: false,
    };
    await store.write(snapshot, g1);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('kept');
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB, idA]);
  });

  it('replace writes the proof whatever it is', async () => {
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
        answered: [],
        replace: true,
      },
      g1,
    );
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('reader-continue');
  });

  it('a key in dropped leaves the remembered nodes', async () => {
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
        answered: [],
        replace: false,
      },
      g1,
    );
    const stored = store.read();
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB]);
  });

  it('two pages write in turn under the lock — the earlier page\'s older proof never overwrites the newer', async () => {
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
      answered: [],
      replace: false,
    };
    const older: MemorySnapshot = {
      proof: bytesFromAscii('Alo'),
      nodes: [],
      dropped: [],
      answered: [],
      replace: false,
    };
    await Promise.all([store.write(newer, g1), store.write(older, g1)]);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(b64ToAscii(stored!.proof)).toBe('Chi');
  });

  it('a damaged record reads null and is removed', () => {
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
      answered: [],
    });
    const s4 = fakeStorage({ [key]: s4Raw });
    const r4 = createMeshMemoryStore({ storage: s4, locks: fakeLocks(), network: 'devnet', continues: () => true });
    expect(r4.read()).toBeNull();
    expect(s4.map.has(key)).toBe(false);
  });

  it('a record under another genesis reads as none to write', async () => {
    const storage = fakeStorage();
    const key = `notis.mesh.memory.devnet`;
    // Stored record is under g1 and carries nodes to merge in.
    storage.setItem(
      key,
      record(g1, base64FromAscii('oldKept'), [{ notisId: idA, addrs: ['/ip4/1.1.1.1/tcp/1'] }]),
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
        answered: [bytesFromAscii('freshBranch')],
        replace: false,
      },
      g2,
    );
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.genesis).toBe(g2);
    expect(b64ToAscii(stored!.proof)).toBe('fresh');
    expect(stored!.nodes.map(n => n.notisId)).toEqual([idB]);
    expect(stored!.answered.length).toBe(1);
    expect(b64ToAscii(btoa(String.fromCharCode(...stored!.answered[0]!)))).toBe('freshBranch');
  });

  it('a snapshot with ANSWERED_FORKS_MAX + 4 answered branches keeps the first ANSWERED_FORKS_MAX', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    // One write carrying ANSWERED_FORKS_MAX + 4 entries: the store
    // writes up to ANSWERED_FORKS_MAX slots and removes every slot
    // past them; a read answers the first ANSWERED_FORKS_MAX entries.
    const answered: Uint8Array[] = [];
    for (let i = 0; i < ANSWERED_FORKS_MAX + 4; i++) {
      answered.push(bytesFromAscii(`a${i}`));
    }
    await store.write({ proof: bytesFromAscii('p1'), nodes: [], dropped: [], answered, replace: false }, g1);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.answered.length).toBe(ANSWERED_FORKS_MAX);
    // The store writes slots 0..ANSWERED_FORKS_MAX - 1 in order, so
    // the kept entries are the first ANSWERED_FORKS_MAX of the
    // snapshot — the mesh client's `answeredProofs` enforces the
    // oldest-dropped rule before it hands the snapshot to the store.
    for (let i = 0; i < ANSWERED_FORKS_MAX; i++) {
      expect(b64ToAscii(btoa(String.fromCharCode(...stored!.answered[i]!)))).toBe(`a${i}`);
    }
  });

  it('nodes capped at REMEMBERED_NODES_MAX', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    const nodes1: MeshContact[] = [];
    const nodes2: MeshContact[] = [];
    for (let i = 0; i < REMEMBERED_NODES_MAX + 4; i++) {
      nodes1.push({ notisId: idOf(0x100 + i), addrs: [`/ip4/10.0.0.${i + 1}/tcp/1`] });
      nodes2.push({ notisId: idOf(0x200 + i), addrs: [`/ip4/20.0.0.${i + 1}/tcp/1`] });
    }
    await store.write({ proof: bytesFromAscii('p1'), nodes: nodes1, dropped: [], answered: [], replace: false }, g1);
    await store.write({ proof: bytesFromAscii('p2'), nodes: nodes2, dropped: [], answered: [], replace: false }, g1);
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.nodes.length).toBe(REMEMBERED_NODES_MAX);
  });

  it('answered proofs are kept under their own keys and not written at a check that changes none', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    // Spy on setItem calls that target the side keys.
    const sideWrites: Array<{ key: string; value: string }> = [];
    const spy: StorageLike = {
      getItem: (k) => storage.map.get(k) ?? null,
      setItem: (k, v) => {
        if (k.startsWith('notis.mesh.memory.devnet.answered.')) {
          sideWrites.push({ key: k, value: v });
        }
        storage.map.set(k, v);
      },
      removeItem: (k) => { storage.map.delete(k); },
    };
    const store = createMeshMemoryStore({
      storage: spy,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    const branchBytes = bytesFromAscii('branch1');
    const snapshot: MemorySnapshot = {
      proof: bytesFromAscii('p1'),
      nodes: [],
      dropped: [],
      answered: [branchBytes],
      replace: false,
    };
    await store.write(snapshot, g1);
    expect(storage.map.get('notis.mesh.memory.devnet.answered.0'))
      .toBe(btoa('branch1'));
    const firstWriteCount = sideWrites.length;
    expect(firstWriteCount).toBe(1);
    // A second write with the same answered: no side-key setItem.
    await store.write(snapshot, g1);
    expect(sideWrites.length).toBe(firstWriteCount);
  });

  it('clear removes every answered side key beside the main record', async () => {
    const storage = fakeStorage();
    const locks = fakeLocks();
    const store = createMeshMemoryStore({
      storage,
      locks,
      network: 'devnet',
      continues: () => true,
    });
    await store.write({
      proof: bytesFromAscii('p'),
      nodes: [],
      dropped: [],
      answered: [bytesFromAscii('a'), bytesFromAscii('b')],
      replace: false,
    }, g1);
    expect(storage.map.get('notis.mesh.memory.devnet')).toBeDefined();
    expect(storage.map.get('notis.mesh.memory.devnet.answered.0')).toBeDefined();
    expect(storage.map.get('notis.mesh.memory.devnet.answered.1')).toBeDefined();
    store.clear();
    expect(storage.map.get('notis.mesh.memory.devnet')).toBeUndefined();
    expect(storage.map.get('notis.mesh.memory.devnet.answered.0')).toBeUndefined();
    expect(storage.map.get('notis.mesh.memory.devnet.answered.1')).toBeUndefined();
  });

  it('a damaged main record also clears the answered side keys', () => {
    const key = `notis.mesh.memory.devnet`;
    const storage = fakeStorage({ [key]: '{not json' });
    // A side key under the same network that would otherwise outlive
    // the main record.
    storage.setItem('notis.mesh.memory.devnet.answered.0', btoa('a'));
    const store = createMeshMemoryStore({
      storage,
      locks: fakeLocks(),
      network: 'devnet',
      continues: () => true,
    });
    expect(store.read()).toBeNull();
    expect(storage.map.has('notis.mesh.memory.devnet.answered.0')).toBe(false);
  });

  it('an answered side key that does not decode is dropped alone', () => {
    const storage = fakeStorage();
    const key = `notis.mesh.memory.devnet`;
    storage.setItem(key, record(g1, base64FromAscii('kept')));
    storage.setItem('notis.mesh.memory.devnet.answered.0', btoa('ok0'));
    storage.setItem('notis.mesh.memory.devnet.answered.1', 'not*valid base64!');
    storage.setItem('notis.mesh.memory.devnet.answered.2', btoa('ok2'));
    const store = createMeshMemoryStore({
      storage,
      locks: fakeLocks(),
      network: 'devnet',
      continues: () => true,
    });
    const stored = store.read();
    expect(stored).not.toBeNull();
    expect(stored!.answered.length).toBe(2);
    expect(btoa(String.fromCharCode(...stored!.answered[0]!))).toBe(btoa('ok0'));
    expect(btoa(String.fromCharCode(...stored!.answered[1]!))).toBe(btoa('ok2'));
    // The bad slot is removed; the valid slots stay.
    expect(storage.map.has('notis.mesh.memory.devnet.answered.1')).toBe(false);
    expect(storage.map.has('notis.mesh.memory.devnet.answered.0')).toBe(true);
    expect(storage.map.has('notis.mesh.memory.devnet.answered.2')).toBe(true);
  });
});
