import { describe, it, expect, afterEach } from 'vitest';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyPostBody,
} from '@dagsocial/validation';
import { computeContentHash } from '@dagsocial/types';
import { NetNode } from '../src/node.js';
import type { NetConfig, NetValidators } from '../src/types.js';
import { makeConfig as makeBaseConfig } from './helpers.js';

// ---------------------------------------------------------------------------
// NET_INTERFACE → Pull Requests → requestPostBodies:
// "Any number of ids, asked in requests of at most MAX_INV_IDS, one after
//  another, the answers merged; a request that fails fails the call".
//
// A caller asking for 401 ids in one go overshoots `MAX_INV_IDS` (400). The
// server's decode gates on that bound, so a 401-id ModifierRequest is
// malformed and permanently bans the sender. Paging splits the ask into one
// request of 400 and one of 1, and the server answers both.
// ---------------------------------------------------------------------------

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyContentLimits,
  verifyParentRefsCount,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyPostBody,
};

function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return makeBaseConfig({
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    syncRequestTimeoutMs: 5_000,
    ...overrides,
  });
}

const TIMEOUT = 30_000;

async function waitConnected(nodeA: NetNode, nodeB: NetNode, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nodeB.getConnectedPeers().includes(nodeA.peerId())
        && nodeA.getConnectedPeers().includes(nodeB.peerId())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('peers did not connect in time');
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('A paged post-body request: 401 ids through B', () => {
  let nodeA: NetNode | null = null;
  let nodeB: NetNode | null = null;

  afterEach(async () => {
    await nodeA?.stop();
    await nodeB?.stop();
    nodeA = null;
    nodeB = null;
  });

  it.fails('A.requestPostBodies for 401 ids returns 401 bodies from B', async () => {
    // Build 401 body entries. Each id is the hex of its content hash — any
    // 32-byte hex works for the modifier id, and sourcing it from the hash
    // keeps the fixture self-consistent.
    const posts = new Map<string, string>();
    const wanted: { id: string; contentHash: Uint8Array }[] = [];
    for (let i = 0; i < 401; i++) {
      const content = `post-body-${i}`;
      const contentHash = computeContentHash(content);
      const id = toHex(contentHash);
      posts.set(id, content);
      wanted.push({ id, contentHash });
    }

    nodeB = new NetNode(makeConfig(), validators);
    nodeB.setPostBodyProvider((id) => posts.get(id) ?? null);
    // Same height on A keeps auto-sync out of the exchange.
    nodeB.setChainHeightProvider(() => 0);
    await nodeB.start();
    const addrB = nodeB.libp2pNode!.getMultiaddrs()[0]!.toString();

    nodeA = new NetNode(makeConfig({ bootstrapPeers: [addrB] }), validators);
    nodeA.setChainHeightProvider(() => 0);
    await nodeA.start();
    await waitConnected(nodeA, nodeB);

    const result = await nodeA.requestPostBodies(wanted, nodeB.peerId())
      .catch((err: unknown) => err);
    // Pre-flip control: today the request returns an empty array (B replies
    // zero bytes after refusing the malformed body), so the call does not
    // throw. The paged future also does not throw. Both pass this.
    expect(result instanceof Error).toBe(false);
    expect((result as Array<unknown>).length).toBe(401);
  }, TIMEOUT);
});
