// MESH_INTERFACE → Block gossip → "A node's readers are its router's direct peers" — the node's router holds a reader as a direct peer and lists it among a topic's subscribers while the node holds a connection to it; no topic's mesh holds the reader.

import type { Libp2p } from '@libp2p/interface';
import { expect, vi } from 'vitest';

interface DirectPeerRouter {
  readonly direct: Set<string>;
  getSubscribers(topic: string): Array<{ toString(): string }>;
}

function routerOf(libp2p: Libp2p): DirectPeerRouter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (libp2p as any).services.pubsub as DirectPeerRouter;
}

/**
 * Wait for the state the rule makes between a node and its reader at
 * `topic`: the node's router holds the reader as a direct peer and
 * lists it among the topic's subscribers, and the reader's router
 * lists the node among the same topic's subscribers — the three
 * readings together name the moment the node publishes to the reader
 * on it.
 */
export async function waitReaderHeldAsDirect(
  nodeLibp2p: Libp2p,
  readerLibp2p: Libp2p,
  topic: string,
  timeoutMs: number = 60_000,
): Promise<void> {
  const nodeRouter = routerOf(nodeLibp2p);
  const readerRouter = routerOf(readerLibp2p);
  const readerPeerIdStr = readerLibp2p.peerId.toString();
  const nodePeerIdStr = nodeLibp2p.peerId.toString();
  await vi.waitFor(() => {
    expect(nodeRouter.direct.has(readerPeerIdStr)).toBe(true);
    expect(nodeRouter.getSubscribers(topic).map((p) => p.toString())).toContain(readerPeerIdStr);
    expect(readerRouter.getSubscribers(topic).map((p) => p.toString())).toContain(nodePeerIdStr);
  }, { timeout: timeoutMs, interval: 300 });
}
