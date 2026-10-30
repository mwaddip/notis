// MESH_INTERFACE → Place in the workspace — the HTML's script tag loads this
// entry; the entry wires `runMain` to the real `fetch` and points it at
// `#root`. `main.ts` takes `fetch` as a parameter so the cases can inject
// a fake; it imports `startMeshClient` directly.

import { runMain } from './main.js';

const root = document.getElementById('root');
if (root !== null) {
  void runMain({ root, fetch: globalThis.fetch.bind(globalThis) });
}
