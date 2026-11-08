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
import { FAST_SET_FACTOR, FAST_SET_SLACK_MS } from './protocols.js';

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

/**
 * MESH_INTERFACE → The client's node list → "The client's order for a need"
 * — every node the need allows reached over the mesh (`meshUsable`), the
 * fast set first, as `notis-mesh://<id>` bases, then the API bases of the
 * entries the need allows in the same order; before the first check ends,
 * every first-contact node, over its mesh base if connected else at its API
 * base.
 * Duplicates dropped. A write and a resolve walk this order.
 *
 * Pure, browser-safe (`MESH_INTERFACE → Place in the workspace`): the
 * caller composes the candidates and tells us whether the first check
 * ended.
 */
export interface OrderCandidate {
  id: string;
  status: NodeStatus;
  readMs: number | null;
  meshUsable: boolean;
  firstContact: boolean;
  /** The API base `(scheme)://(host)[:(port)]` with no trailing `/`. */
  api: string | null;
  /** The `notis-mesh://<id>` base, so the caller does not restate it. */
  meshBase: string;
}

export function orderServers(
  nodes: ReadonlyArray<OrderCandidate>,
  need: ReadNeed,
  firstCheckEnded: boolean,
): string[] {
  const out: string[] = [];
  // MESH_INTERFACE → The client's node list → "An entry may carry an
  // API base" — "It is one entry whichever way it answers — one witness
  // in every count". An entry's URL appears once in the order: its mesh
  // base when connected, else its API base. The `seenIds` map carries
  // that per-entry dedupe; URL-level dedupe is a safety belt.
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const push = (id: string, url: string): void => {
    if (seenIds.has(id) || seenUrls.has(url)) return;
    seenIds.add(id);
    seenUrls.add(url);
    out.push(url);
  };

  if (!firstCheckEnded) {
    // Before the first check ends, every first-contact node serves any
    // need: its mesh base if connected, else at its API base
    // (`MESH_INTERFACE → The client's node list → "Before the first check
    // ends a node the client started from serves any need"`). The others do
    // not serve until a check has read them; a `blacklisted` node never —
    // "A `blacklisted` node is never one [a candidate]" holds at every
    // stage.
    for (const n of nodes) {
      if (!n.firstContact) continue;
      if (n.status === 'blacklisted') continue;
      if (n.meshUsable) push(n.id, n.meshBase);
      else if (n.api !== null) push(n.id, n.api);
    }
    return out;
  }

  const allows = (s: NodeStatus): boolean =>
    need === 'tip' ? s === 'ok' : s === 'ok' || s === 'trailing';

  // Fast-set-first among mesh-reachable, need-allowed nodes.
  const meshAllowed = nodes.filter((n) => n.meshUsable && allows(n.status));
  let min: number | null = null;
  for (const n of meshAllowed) {
    if (n.readMs !== null && (min === null || n.readMs < min)) min = n.readMs;
  }
  const inFastSet = (n: OrderCandidate): boolean => {
    if (min === null) return true; // first-check or all-failed: spread uniformly
    if (n.readMs === null) return false;
    return n.readMs <= FAST_SET_FACTOR * min + FAST_SET_SLACK_MS;
  };
  for (const n of meshAllowed) if (inFastSet(n)) push(n.id, n.meshBase);
  for (const n of meshAllowed) if (!inFastSet(n)) push(n.id, n.meshBase);

  // Then the API bases of the entries the need allows, in the same
  // order; an entry already emitted over the mesh is `seenIds` and
  // does not re-emit at its API base.
  for (const n of nodes) {
    if (n.api === null) continue;
    if (!allows(n.status)) continue;
    push(n.id, n.api);
  }
  return out;
}
