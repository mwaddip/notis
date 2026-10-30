// STUB — the real implementation lands in the next commit.

import type { MeshClient } from '../src/client/mesh-client.js';

export interface ProbeResult {
  path: string;
  nodeId: string;
  status: number;
  bytes: number;
  sha256: string;
}

export interface RunProbeOptions {
  client: Pick<MeshClient, 'fetch' | 'state' | 'onState'>;
  path: string;
  root: HTMLElement;
}

export async function runProbe(_opts: RunProbeOptions): Promise<ProbeResult> {
  throw new Error('runProbe: not implemented');
}
