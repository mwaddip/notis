// AHEAD OF CODE — stub, filled by this unit.

import type { Libp2p } from '@libp2p/interface';

export interface StartNodePeerOptions {
  readonly nodeP2p: string;
  readonly magic: number;
  readonly protocolVersion: number;
  readonly nodeName: string;
  readonly retryMs?: number;
}

export interface NodePeer {
  stop(): Promise<void>;
  connected(): boolean;
}

export function startNodePeer(
  _libp2p: Libp2p,
  _opts: StartNodePeerOptions,
): NodePeer {
  return {
    stop: async () => {},
    connected: () => false,
  };
}
