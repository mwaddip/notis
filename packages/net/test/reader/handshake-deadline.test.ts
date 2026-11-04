// NET_INTERFACE → Readers → "Readers have a budget of their own" —
// a connection libp2p admits above the readers' budget is held at
// most `HANDSHAKE_DEADLINE_FACTOR × syncRequestTimeoutMs` and then
// closed. A reader that connects and never opens the handshake
// stream is closed at that deadline. This test uses a plain libp2p
// host that connects over TCP and lets the handshake deadline fire;
// the mesh's WebRTC-direct transport is not under test here, so TCP
// keeps the case fast and fork-pool-safe.

import { afterEach, describe, expect, it } from 'vitest';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { generateKeyPair } from '@dagsocial/types';
import {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
} from '@dagsocial/validation';

import { NetNode } from '../../src/index.js';
import type { NetValidators } from '../../src/index.js';
import { makeConfig } from '../helpers.js';

const validators: NetValidators = {
  verifyOrderingBlockPoW,
  verifyProtocolVersion,
  verifyTxProtocolVersion,
  verifyTxStructure,
  verifyTxSignatures,
  verifyOrderingBlockStructure,
  verifyUtxoTxRoot,
  verifyHeaderFieldDomains,
  verifyValidatorSignature,
  verifyPostBody,
};

async function silentHost(): Promise<Libp2p> {
  return createLibp2p({
    addresses: { listen: [] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

function nodeTcpAddress(node: NetNode): string {
  const libp2p = (node as unknown as { libp2p: Libp2p }).libp2p;
  const addrs = libp2p.getMultiaddrs() ?? [];
  const match = addrs.find((a) => a.toString().includes('/tcp/'));
  if (!match) throw new Error('node has no TCP listen address');
  return match.toString();
}

describe('NET_INTERFACE → Readers — a connection that never handshakes', () => {
  const nodes: NetNode[] = [];
  const hosts: Libp2p[] = [];

  afterEach(async () => {
    for (const h of hosts) { try { await h.stop(); } catch { /* already stopped */ } }
    for (const n of nodes) { try { await n.stop(); } catch { /* already stopped */ } }
    hosts.length = 0; nodes.length = 0;
  });

  it('a reader that never handshakes is closed at the deadline', async () => {
    // `HANDSHAKE_DEADLINE_FACTOR` is 3; with `syncRequestTimeoutMs`
    // set to 500 ms the deadline is 1 500 ms, inside this file's
    // 15-second budget.
    const node = new NetNode(makeConfig({
      nodeKey: generateKeyPair(),
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      syncRequestTimeoutMs: 500,
    }), validators);
    nodes.push(node);
    await node.start();

    const silent = await silentHost();
    hosts.push(silent);
    const addr = nodeTcpAddress(node);

    const conn = await silent.dial(multiaddr(addr));
    // A plain dial hands no handshake stream — the node's deadline
    // begins at the connection's upgrade. `ConnectionStatus` is
    // 'open' | 'closing' | 'closed' | 'aborted' | 'reset' — any non-
    // 'open' value ends the wait.
    const deadlineMs = 3 * 500 + 1_500; // factor × timeout + margin
    const startedAt = Date.now();
    while (Date.now() - startedAt < deadlineMs && conn.status === 'open') {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(conn.status).not.toBe('open');
  }, 15_000);
});
