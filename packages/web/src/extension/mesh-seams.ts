// The extension's seams built on a mesh client (WEB_INTERFACE → The extension
// → "The mesh is the extension's first path"). AHEAD OF CODE (2026-11-05):
// the real implementation lands in the feat commit beside this stub.

import { NodeClient } from '../api/client.js';
import { WriteClient } from '../api/write.js';
import type { NetworkType } from '@dagsocial/types';
import type { PostCheck } from '@dagsocial/nipopow-client';
import type { MeshClient, MeshAnchor, StartMeshClientOptions } from '../mesh/index.js';
import type { HttpFetch } from '@dagsocial/node-reads';
import type {
  FiguresVerifier,
  NamesVerifier,
  PostResolver,
  TipVerifier,
} from '../model/state.js';
import type { HandNodeSeam } from '../view/settings.js';

export interface MeshSeams {
  readClient: NodeClient;
  writeClient: WriteClient;
  tipVerifier: TipVerifier;
  figuresVerifier: FiguresVerifier;
  namesVerifier: NamesVerifier;
  postResolver: PostResolver;
  handNodeSeam: HandNodeSeam;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CreateMeshSeamsOptions {
  client: MeshClient;
  network: NetworkType;
  check: (rows: unknown[]) => PostCheck[];
  storage: StorageLike;
}

export function parseHandNodeAddress(_input: string): { notisId: string; addr: string } | { error: string } {
  throw new Error('parseHandNodeAddress(): not implemented');
}

export function createMeshSeams(_opts: CreateMeshSeamsOptions): MeshSeams {
  throw new Error('createMeshSeams(): not implemented');
}

export interface StartExtensionMeshOptions {
  anchors: MeshAnchor[];
  network: NetworkType;
  agentName: string;
  httpFetch: HttpFetch;
  check: (rows: unknown[]) => PostCheck[];
  storage: StorageLike;
  window: Pick<Window, 'addEventListener'>;
  startMeshClient: (o: StartMeshClientOptions) => Promise<MeshClient>;
}

export async function startExtensionMesh(
  _opts: StartExtensionMeshOptions,
): Promise<{ client: MeshClient; seams: MeshSeams }> {
  throw new Error('startExtensionMesh(): not implemented');
}
