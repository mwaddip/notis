// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows". A routed read is one the client sends to a
// node it picks, not to a key the caller names. One that needs the tip
// goes to an `ok` node; a read of content older than the newest block
// goes to an `ok` or a `trailing` node; a `behind` node serves no
// read. Among the nodes a read may go to and the client holds a
// connection to (`usable`), the fast set is each node whose
// `readMs` is within `FAST_SET_FACTOR` times the fastest's plus
// `FAST_SET_SLACK_MS` — every one of them while none has a `readMs` —
// and the read goes to one of the fast set at random. With none
// allowed the pick is `null`, which the client reads as a transport
// failure. Pure, browser-safe (`MESH_INTERFACE → Place in the
// workspace`).

import type { NodeStatus } from './node-list.js';
import { FAST_SET_FACTOR, FAST_SET_SLACK_MS } from '../protocols.js';

export type ReadNeed = 'tip' | 'older';

export interface PickCandidate {
  id: string;
  status: NodeStatus;
  readMs: number | null;
  usable: boolean;
}

export function pickServer(
  nodes: ReadonlyArray<PickCandidate>,
  need: ReadNeed,
  rand: () => number,
): string | null {
  const allowed: PickCandidate[] = [];
  for (const n of nodes) {
    if (!n.usable) continue;
    if (need === 'tip') {
      if (n.status === 'ok') allowed.push(n);
    } else {
      if (n.status === 'ok' || n.status === 'trailing') allowed.push(n);
    }
  }
  if (allowed.length === 0) return null;

  // When any allowed node has a `readMs`, the fast set is those within
  // the bound; nodes with `readMs === null` are not in it. When none
  // has a `readMs`, the fast set is every allowed — the first-check
  // and all-failed cases spread uniformly rather than answering "no
  // node" while one is allowed.
  let min: number | null = null;
  for (const n of allowed) {
    if (n.readMs !== null && (min === null || n.readMs < min)) min = n.readMs;
  }
  let fast: PickCandidate[];
  if (min !== null) {
    const bound = FAST_SET_FACTOR * min + FAST_SET_SLACK_MS;
    fast = allowed.filter((n) => n.readMs !== null && n.readMs <= bound);
  } else {
    fast = allowed;
  }
  if (fast.length === 0) return null;
  const idx = Math.floor(rand() * fast.length);
  const picked = fast[Math.min(idx, fast.length - 1)]!;
  return picked.id;
}
