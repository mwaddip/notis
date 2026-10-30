// MESH_INTERFACE → Place in the workspace — the HTML's script tag loads this
// entry; the entry wires `runMain` to the real `fetch` and the real
// `startMeshClient` and points it at `#root`. `main.ts` takes both as
// parameters so the cases can inject fakes.

import { runMain } from './main.js';
import { startMeshClient } from '../src/client/mesh-client.js';

const root = document.getElementById('root');
if (root !== null) {
  void runMain({ root, fetch: globalThis.fetch.bind(globalThis), startMeshClient });
}
