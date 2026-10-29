// MESH_INTERFACE → The client's node list — stub, pending the cases.
// The implementation lands in a later commit; this file carries the names
// and shapes the tests import against.

export interface Anchor {
  notisId: string;
  addrs: string[];
}

export type FailureKind = 'timeout' | 'refused' | 'dropped' | 'transport';

export interface LieEvidence {
  kind: 'malformed' | 'proof-invalid';
  atMs: number;
  detail: string;
}

export type NodeStatus = 'ok' | 'retry' | 'behind' | 'blacklisted' | 'new';

export interface NodeEntry {
  notisId: string;
  anchor: boolean;
  status: NodeStatus;
  failures: number;
  retryAtMs: number;
  addrs: string[];
  droppedAddrs: string[];
  evidence: LieEvidence | null;
}

export class NodeList {
  constructor(_anchors: Anchor[], _ownId: string, _clock: () => number) {}
  add(_id: string, _addrs: string[]): void {}
  success(_id: string): void {}
  failure(_id: string, _kind: FailureKind): void {}
  behind(_id: string): void {}
  wrongKey(_id: string, _addr: string, _answeredId: string | null): void {}
  lie(_id: string, _evidence: LieEvidence): void {}
  candidates(): string[] {
    return [];
  }
  entry(_id: string): NodeEntry | undefined {
    return undefined;
  }
  entries(): NodeEntry[] {
    return [];
  }
  anchorReached(): boolean {
    return false;
  }
}
