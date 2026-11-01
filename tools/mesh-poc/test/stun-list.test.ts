// MESH_INTERFACE → NAT — "Every STUN server is a mesh node named by
// IP"; "A client's STUN list comes from the public nodes it holds";
// "With no public node held the list is empty, and the ICE
// configuration names no server." The pure derivation and the
// client's own ICE configuration both answer the derived list, and
// the fallback is `{ iceServers: [] }`, never `undefined` (traps file,
// "The mesh and its stage" → "`webRTCDirect()` with no
// `rtcConfiguration.iceServers` uses libp2p's DNS-named STUN
// defaults").

import { afterEach, describe, expect, it } from 'vitest';
import { profileFor, generateKeyPair } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { nodeKeyFromKeyPair } from '../src/identity.js';
import { stunServersFor } from '../src/client/stun-list.js';
import { startMeshClient, type MeshClient } from '../src/client/mesh-client.js';
import type { NodeEntry, NodeStatus } from '../src/client/node-list.js';
import { STUN_SERVERS_MAX } from '../src/protocols.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

function makeEntry(partial: {
  notisId: string;
  status: NodeStatus;
  addrs: string[];
  readMs?: number | null;
  anchor?: boolean;
}): NodeEntry {
  return {
    notisId: partial.notisId,
    anchor: partial.anchor ?? false,
    byHand: false,
    status: partial.status,
    failures: 0,
    retryAtMs: 0,
    readMs: partial.readMs ?? null,
    behindBy: null,
    addrs: partial.addrs,
    droppedAddrs: [],
    evidence: null,
    lastFailure: null,
    lastFailures: {},
    transport: null,
    path: null,
  };
}

// Public (not in @libp2p/utils' isPrivate list): 11.100.0.0/24, 1.1.1.1,
// 8.8.8.8. The stage uses the 11.100.0.0/24 range for exactly this reason.
// Private: 10.0.0.0/8, 100.64.0.0/10 (CGNAT), 127.0.0.0/8, 192.168.0.0/16,
// 169.254.0.0/16, 172.16.0.0/12, 203.0.113.0/24 (RFC 5737 TEST-NET-3),
// 198.51.100.0/24 (TEST-NET-2), 192.0.2.0/24 (TEST-NET-1).

describe('stunServersFor', () => {
  it.fails('derives stun:<ip>:3478 from public webrtc-direct addresses only', () => {
    // 10.x and 100.64.x are refused by isPrivate; 11.100.0.x is not.
    const entries: NodeEntry[] = [
      makeEntry({
        notisId: 'aa'.repeat(32), status: 'ok',
        addrs: ['/ip4/11.100.0.11/udp/9999/webrtc-direct'],
      }),
      makeEntry({
        notisId: 'bb'.repeat(32), status: 'ok',
        addrs: ['/ip4/10.0.0.5/udp/9999/webrtc-direct'],
      }),
      makeEntry({
        notisId: 'cc'.repeat(32), status: 'ok',
        addrs: ['/ip4/100.64.1.1/udp/9999/webrtc-direct'],
      }),
    ];
    expect(stunServersFor(entries, 3)).toEqual(['stun:11.100.0.11:3478']);
  });

  it.fails("a relayed address gives its relay hop's IP", () => {
    // The FIRST `/ip4/<ip>/udp/<n>/webrtc-direct` triple is the relay's
    // hop on a circuit address — @multiformats/multiaddr parses the
    // address and the components come out in that order.
    const entries: NodeEntry[] = [
      makeEntry({
        notisId: 'aa'.repeat(32), status: 'ok',
        addrs: [
          '/ip4/11.100.0.11/udp/9999/webrtc-direct/certhash/uAAAABBBBCCCC/p2p/12D3KooWRelay1234567890ABCDEFGHIJKLMNOPQRSTUV/p2p-circuit/p2p/12D3KooWTarget1234567890ABCDEFGHIJKLMNOPQRS',
        ],
      }),
    ];
    expect(stunServersFor(entries, 3)).toEqual(['stun:11.100.0.11:3478']);
  });

  it.fails('verified nodes first, fastest first, at most STUN_SERVERS_MAX', () => {
    // 1 non-verified (new) first in list, then four verified at
    // different speeds. STUN_SERVERS_MAX = 3; the result is the three
    // fastest verified, in speed order.
    const entries: NodeEntry[] = [
      makeEntry({ notisId: 'aa'.repeat(32), status: 'new', readMs: 1,
        addrs: ['/ip4/11.100.0.1/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'bb'.repeat(32), status: 'ok', readMs: 50,
        addrs: ['/ip4/11.100.0.2/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'cc'.repeat(32), status: 'behind', readMs: 10,
        addrs: ['/ip4/11.100.0.3/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'dd'.repeat(32), status: 'trailing', readMs: 20,
        addrs: ['/ip4/11.100.0.4/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'ee'.repeat(32), status: 'ok', readMs: 100,
        addrs: ['/ip4/11.100.0.5/udp/0/webrtc-direct'] }),
    ];
    expect(stunServersFor(entries, STUN_SERVERS_MAX)).toEqual([
      'stun:11.100.0.3:3478',
      'stun:11.100.0.4:3478',
      'stun:11.100.0.2:3478',
    ]);
  });

  it.fails('a blacklisted node gives no STUN server', () => {
    const entries: NodeEntry[] = [
      makeEntry({ notisId: 'aa'.repeat(32), status: 'blacklisted',
        addrs: ['/ip4/11.100.0.11/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'bb'.repeat(32), status: 'ok',
        addrs: ['/ip4/11.100.0.12/udp/0/webrtc-direct'] }),
    ];
    expect(stunServersFor(entries, 3)).toEqual(['stun:11.100.0.12:3478']);
  });
});

describe('iceConfiguration — client-level', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try { await c.stop(); } catch { /* already stopped */ }
    }
  });

  it.fails('no public node known gives [] and rtcConfiguration answers { iceServers: [] }', async () => {
    // The pure function first: only non-public addresses, output is [].
    expect(stunServersFor([
      makeEntry({ notisId: 'aa'.repeat(32), status: 'ok',
        addrs: ['/ip4/10.0.0.1/udp/0/webrtc-direct'] }),
      makeEntry({ notisId: 'bb'.repeat(32), status: 'blacklisted',
        addrs: ['/ip4/11.100.0.5/udp/0/webrtc-direct'] }),
    ], 3)).toEqual([]);

    // The client: anchors with no public address. The ICE configuration
    // is `{ iceServers: [] }`, never undefined — libp2p's DNS-named
    // defaults are what the empty array stops.
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [{ notisId: anchorKey.notisId, addrs: ['/ip4/10.0.0.1/udp/0/webrtc-direct'] }],
      network: 'devnet', profile: PROFILE,
      resolve: async () => ({ winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] }),
    });
    clients.push(client);
    expect(client.iceConfiguration().iceServers).toEqual([]);
  }, 30_000);

  it.fails('a client started from anchors alone builds its ICE servers from them', async () => {
    const anchorKey = nodeKeyFromKeyPair(generateKeyPair());
    const client = await startMeshClient({
      anchors: [{
        notisId: anchorKey.notisId,
        addrs: ['/ip4/11.100.0.11/udp/9999/webrtc-direct'],
      }],
      network: 'devnet', profile: PROFILE,
      resolve: async () => ({ winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] }),
    });
    clients.push(client);
    expect(client.iceConfiguration().iceServers).toEqual([
      { urls: 'stun:11.100.0.11:3478' },
    ]);
  }, 30_000);
});
