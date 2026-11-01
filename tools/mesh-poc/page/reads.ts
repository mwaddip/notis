// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — the `?reads=<n>&need=<tip|older>` driver.
// Stub: the implementation lands in the next commit.

import type { MeshClient } from '../src/client/mesh-client.js';
import type { ReadNeed } from '../src/client/server-pick.js';

export interface RunReadsOptions {
  client: Pick<MeshClient, 'read' | 'state' | 'onState'>;
  n: number;
  need: ReadNeed;
  root: HTMLElement;
}

export async function runReads(_opts: RunReadsOptions): Promise<void> {
  // stub
}
