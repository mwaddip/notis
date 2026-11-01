// MESH_INTERFACE → Discovery → "A node added by hand" — the page's
// form for adding a node by key and address. Stub: the implementation
// lands in the next commit.

import type { MeshClient } from '../src/client/mesh-client.js';

export interface AttachHandFormOptions {
  root: HTMLElement;
  client: Pick<MeshClient, 'addByHand'>;
}

export function attachHandForm(_opts: AttachHandFormOptions): void {
  // stub
}
