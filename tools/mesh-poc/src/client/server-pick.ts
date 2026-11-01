// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows" — stub; the rule lands with the test cases
// that pin it.

import type { NodeStatus } from './node-list.js';

export type ReadNeed = 'tip' | 'older';

export interface PickCandidate {
  id: string;
  status: NodeStatus;
  readMs: number | null;
  usable: boolean;
}

export function pickServer(
  _nodes: ReadonlyArray<PickCandidate>,
  _need: ReadNeed,
  _rand: () => number,
): string | null {
  return null;
}
