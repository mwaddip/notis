// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — the `?reads=<n>&need=<tip|older>` driver.
//
// Waits for the first completed check (`agreement !== null`), then
// makes `n` reads one after another — `/blocks/current` for `tip`,
// `/blocks/1` for `older` — through `client.read`. For each it
// records the answering `nodeId`, that node's `status` in
// `state().nodes` as the read resolves, the client's `checks`
// count at the read — so a reader of the measurement can tell one
// read's state from the next — the client's tip height at the read,
// and the list of nodes the pick was made from, each entry's status
// and its last check's figures. The node list is sampled BEFORE
// `client.read` so the entries name the state the pick reads —
// `MeshClient.read` picks synchronously from `nodeList.entries()`,
// `state_.disagreement`, `readMsMap` and `behindByMap`, with no
// `await` before the pick. A failed read records
// `{ nodeId: null, status: null, checks, tipHeight, nodes, error: <message> }`.
// The driver writes `<pre id="reads">` with `{ need, served }` as a
// sibling of the state root (the probe's sibling pattern), so a
// render leaves it in place. `n` is 1–100; anything else is ignored
// and writes nothing.

import type { ClientState, MeshClient } from '@dagsocial/web/mesh';
import type { NodeStatus } from '@dagsocial/web/mesh';
import type { ReadNeed } from '@dagsocial/web/mesh';

export interface RunReadsOptions {
  client: Pick<MeshClient, 'read' | 'state' | 'onState'>;
  n: number;
  need: ReadNeed;
  root: HTMLElement;
}

export interface ReadsPickedNode {
  /** First 8 hex of the entry's `notisId`. */
  id: string;
  status: NodeStatus;
  behindBy: number | null;
  readMs: number | null;
  /** The entry's `lastFailure.message`, or `null` when none. */
  lastFailure: string | null;
}

type ServedEntry =
  | {
      nodeId: string;
      status: NodeStatus | null;
      checks: number;
      tipHeight: number | null;
      nodes: ReadsPickedNode[];
    }
  | {
      nodeId: null;
      status: null;
      checks: number;
      tipHeight: number | null;
      nodes: ReadsPickedNode[];
      error: string;
    };

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
    // Sample the state the pick reads: `checks`, the client's tip
    // height, and the entries the pick is made from — every entry
    // whose status is NOT `new`, so a reader of the measurement
    // sees the ranked candidates and each one's last check
    // (MESH_INTERFACE → The client's node list → "A routed read
    // goes to a node its need allows"). `read` picks synchronously
    // from these fields with no `await` before the pick, so the
    // sample taken here is what the pick sees.
    const stateBefore = opts.client.state();
    const checks = stateBefore.checks;
    const tipHeight = stateBefore.tip?.height ?? null;
    const nodesSampled: ReadsPickedNode[] = [];
    for (const e of stateBefore.nodes) {
      if (e.status === 'new') continue;
      nodesSampled.push({
        id: e.notisId.slice(0, 8),
        status: e.status,
        behindBy: e.behindBy,
        readMs: e.readMs,
        lastFailure: e.lastFailure !== null ? e.lastFailure.message : null,
      });
    }
    try {
      // MESH_INTERFACE → The client's node list → "A read opens no
      // connection" — the body is drained before the entry is
      // recorded, so the stream closes and the connection the read
      // rides is free for the next one. A body that fails mid-read
      // records the error entry.
      const { response, nodeId } = await opts.client.read(path, opts.need);
      try {
        await response.arrayBuffer();
      } catch (bodyErr) {
        const message = bodyErr instanceof Error ? bodyErr.message : String(bodyErr);
        served.push({ nodeId: null, status: null, checks, tipHeight, nodes: nodesSampled, error: message });
        continue;
      }
      const node = opts.client.state().nodes.find((e) => e.notisId === nodeId);
      served.push({ nodeId, status: node?.status ?? null, checks, tipHeight, nodes: nodesSampled });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      served.push({ nodeId: null, status: null, checks, tipHeight, nodes: nodesSampled, error: message });
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
