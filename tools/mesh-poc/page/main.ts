// MESH_INTERFACE → Place in the workspace / Discovery — stub, pending the
// cases. The implementation lands in a later commit; this file carries
// the name the tests import.

import type { startMeshClient } from '../src/client/mesh-client.js';

export interface RunMainOptions {
  root: HTMLElement;
  fetch: typeof globalThis.fetch;
  startMeshClient: typeof startMeshClient;
}

export async function runMain(_opts: RunMainOptions): Promise<void> {
  /* stub */
}
