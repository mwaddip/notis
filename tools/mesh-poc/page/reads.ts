// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — the `?reads=<n>&need=<tip|older>` driver.
//
// Waits for the first completed check (`agreement !== null`), then
// makes `n` reads one after another — `/blocks/current` for `tip`,
// `/blocks/1` for `older` — through `client.read`. For each it
// records the answering `nodeId` and that node's `status` in
// `state().nodes` as the read resolves. A failed read records
// `{ nodeId: null, status: null, error: <message> }`. The driver
// writes `<pre id="reads">` with `{ need, served }` as a sibling of
// the state root (the probe's sibling pattern), so a render leaves
// it in place. `n` is 1–100; anything else is ignored and writes
// nothing.

import type { ClientState, MeshClient } from '../src/client/mesh-client.js';
import type { NodeStatus } from '../src/client/node-list.js';
import type { ReadNeed } from '../src/client/server-pick.js';

export interface RunReadsOptions {
  client: Pick<MeshClient, 'read' | 'state' | 'onState'>;
  n: number;
  need: ReadNeed;
  root: HTMLElement;
}

type ServedEntry =
  | { nodeId: string; status: NodeStatus | null }
  | { nodeId: null; status: null; error: string };

interface ReadsOutput {
  need: ReadNeed;
  served: ServedEntry[];
}

const N_MIN = 1;
const N_MAX = 100;

export async function runReads(opts: RunReadsOptions): Promise<void> {
  if (!Number.isInteger(opts.n) || opts.n < N_MIN || opts.n > N_MAX) return;

  await firstAgreement(opts.client);

  const path = opts.need === 'tip' ? '/blocks/current' : '/blocks/1';
  const served: ServedEntry[] = [];
  for (let i = 0; i < opts.n; i += 1) {
    try {
      const { nodeId } = await opts.client.read(path, opts.need);
      const node = opts.client.state().nodes.find((e) => e.notisId === nodeId);
      served.push({ nodeId, status: node?.status ?? null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      served.push({ nodeId: null, status: null, error: message });
    }
  }
  writeReads(opts.root, { need: opts.need, served });
}

function firstAgreement(
  client: Pick<MeshClient, 'state' | 'onState'>,
): Promise<void> {
  if (client.state().agreement !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = client.onState((s: ClientState) => {
      if (s.agreement !== null) {
        unsubscribe();
        resolve();
      }
    });
  });
}

function writeReads(root: HTMLElement, out: ReadsOutput): void {
  // The driver owns `<pre id="reads">` as a sibling of the state
  // renderer's `[data-role="state-root"]` container; a render
  // replaces only its own container's children, so this element is
  // never touched by the state renderer.
  const existing = root.querySelector('pre#reads');
  if (existing !== null) existing.remove();
  const pre = document.createElement('pre');
  pre.id = 'reads';
  pre.textContent = JSON.stringify(out);
  root.appendChild(pre);
}
