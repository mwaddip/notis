// MESH_INTERFACE → Transports / Discovery / The client's node list — stub,
// pending the cases. The implementation lands in a later commit; this file
// carries the names and shapes the tests import against.

import { resolveTip } from '@dagsocial/nipopow-client';
import type { TipResult } from '@dagsocial/nipopow-client';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { NetworkProfile } from '@dagsocial/types';
import type { NetworkName } from '../protocols.js';
import type { Anchor, NodeEntry } from './node-list.js';

export interface ClientState {
  nodeId: string | null;
  transport: 'webrtc-direct' | 'webrtc' | 'wss' | null;
  path: 'direct' | 'relay' | null;
  lastLeft: { nodeId: string; reason: string } | null;
  anchorReached: boolean;
  tip: { height: number; hash: string } | null;
  nodes: NodeEntry[];
}

export interface MeshClient {
  fetch: HttpFetch;
  check(): Promise<TipResult>;
  state(): ClientState;
  onState(cb: (s: ClientState) => void): () => void;
  stop(): Promise<void>;
}

export async function startMeshClient(_o: {
  anchors: Anchor[];
  network: NetworkName;
  profile: NetworkProfile;
  stunServers: string[];
  clock?: () => number;
  resolve?: typeof resolveTip;
}): Promise<MeshClient> {
  const EMPTY: TipResult = { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] };
  const state: ClientState = {
    nodeId: null, transport: null, path: null, lastLeft: null,
    anchorReached: false, tip: null, nodes: [],
  };
  return {
    fetch: async () => { throw new Error('stub'); },
    check: async () => EMPTY,
    state: () => state,
    onState: () => () => {},
    stop: async () => {},
  };
}
