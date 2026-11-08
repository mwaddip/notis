// MESH_INTERFACE → What the client remembers — the per-network store
// the client holds the kept proof, the remembered nodes and the
// answered forks under one lock. Ahead of code: the signatures stand
// and the bodies throw, so the cases catch them as failing until the
// implementation lands.

import type { MeshContact } from './node-list.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MeshMemoryRecord {
  genesis: string;
  proof: string;
  nodes: MeshContact[];
  answeredForks: string[];
}

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

export function createMeshMemoryStore(
  _opts: CreateMeshMemoryStoreOptions,
): MeshMemoryStore {
  throw new Error('createMeshMemoryStore: AHEAD OF CODE');
}
