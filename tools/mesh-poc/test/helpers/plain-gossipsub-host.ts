// MESH_INTERFACE → Block gossip → "One router, net's rules" — a plain libp2p
// host wearing gossipsub on `gossipsubOptions(magic)`, used in-process by cases
// that measure the mesh node's router against the one net runs. The host
// subscribes to `blockTopic(magic)` and records every message it receives on
// that topic as raw bytes.

import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@libp2p/gossipsub';
import { blockTopic, gossipsubOptions } from '../../src/gossip-rules.js';

export interface PlainGossipsubHost {
  readonly libp2p: Libp2p;
  readonly received: Uint8Array[];
  publish(data: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}

export async function startPlainGossipsubHost(magic: number): Promise<PlainGossipsubHost> {
  const received: Uint8Array[] = [];
  const libp2p = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionMonitor: { enabled: false },
    services: {
      identify: identify(),
      pubsub: gossipsub(gossipsubOptions(magic)),
    },
  });
  const topic = blockTopic(magic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pubsub = (libp2p.services as any).pubsub;
  pubsub.subscribe(topic);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pubsub.addEventListener('gossipsub:message', (ev: any) => {
    const msg = ev.detail?.msg;
    if (msg && msg.topic === topic) received.push(msg.data);
  });
  return {
    libp2p,
    received,
    async publish(data: Uint8Array): Promise<void> {
      await pubsub.publish(topic, data);
    },
    async stop(): Promise<void> {
      try { await libp2p.stop(); } catch { /* already stopped */ }
    },
  };
}
