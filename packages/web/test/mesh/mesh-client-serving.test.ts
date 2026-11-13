// MESH_INTERFACE → Block gossip → "A client that serves answers the nodes it
// reads" — the mesh client takes an optional `PostTextProvider` and a
// setting. While the setting is on, its handshake declares
// `SERVING_READER_CAPABILITIES` and libp2p registers `postTextsHandler`
// on `SYNC_PROTOCOL`; off or absent, it declares nothing and registers
// nothing. `setServing(on)` moves the state; without a way to serve the
// call resolves and does nothing.
//
// A seam harness: entries carry an API base and no addrs, so the
// client holds no outbound connection to measure. The fake `httpFetch`
// and `resolve` answer the first check with `too-short` so the chain
// does not seat — the cases read libp2p's registered protocols.

import { afterEach, describe, expect, it } from 'vitest';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { HttpFetch } from '@dagsocial/node-reads';
import { SYNC_PROTOCOL } from '@dagsocial/net/browser';
import type { PostTextProvider } from '@dagsocial/net/browser';
import type { NodeTipResult, resolveTip } from '@dagsocial/nipopow-client';

import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

type ResolveFn = typeof resolveTip;

/** An `httpFetch` that answers every `/blocks/current` with 404. */
const httpFetch404: HttpFetch = async () =>
  new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });

/** A `resolveTip` that answers every URL `too-short` — the chain stays unseated. */
const resolveTooShort: ResolveFn = async (nodeUrls) => {
  const nodes: NodeTipResult[] = nodeUrls.map((url) => ({
    url,
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: 'chain too short',
    refuseCode: 'too-short',
    behind: null,
    genesisHash: null,
  }));
  return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
};

/** A `PostTextProvider` that answers the ids the caller asks for from one map. */
function providerFor(map: Map<string, string>): PostTextProvider {
  return async (ids) => {
    const out = new Map<string, string>();
    for (const id of ids) {
      const t = map.get(id);
      if (t !== undefined) out.set(id, t);
    }
    return out;
  };
}

describe('mesh-client — serving: `SYNC_PROTOCOL` is registered while serving', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try { await c.stop(); } catch { /* already stopped */ }
    }
  });

  it('serving on registers the sync handler; off or absent does not', async () => {
    // Serving absent: libp2p does not list `SYNC_PROTOCOL`.
    const absent = await startMeshClient({
      firstContact: [],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      httpFetch: httpFetch404,
      resolve: resolveTooShort,
    });
    clients.push(absent);
    expect(absent.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);

    // Serving off: idem.
    const off = await startMeshClient({
      firstContact: [],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      httpFetch: httpFetch404,
      resolve: resolveTooShort,
      serving: { on: false, texts: providerFor(new Map()) },
    });
    clients.push(off);
    expect(off.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);

    // Serving on: libp2p lists `SYNC_PROTOCOL`.
    const on = await startMeshClient({
      firstContact: [],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      httpFetch: httpFetch404,
      resolve: resolveTooShort,
      serving: { on: true, texts: providerFor(new Map()) },
    });
    clients.push(on);
    expect(on.libp2p.getProtocols()).toContain(SYNC_PROTOCOL);
  }, 60_000);

  it('setServing changes the handler, and does nothing without a way to serve', async () => {
    const started = await startMeshClient({
      firstContact: [],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      httpFetch: httpFetch404,
      resolve: resolveTooShort,
      serving: { on: false, texts: providerFor(new Map()) },
    });
    clients.push(started);
    expect(started.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);

    await started.setServing(true);
    expect(started.libp2p.getProtocols()).toContain(SYNC_PROTOCOL);

    await started.setServing(false);
    expect(started.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);

    // A client with no `serving` option: `setServing(true)` resolves
    // and registers nothing — there is no provider to call.
    const noSeam = await startMeshClient({
      firstContact: [],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      httpFetch: httpFetch404,
      resolve: resolveTooShort,
    });
    clients.push(noSeam);
    await noSeam.setServing(true);
    expect(noSeam.libp2p.getProtocols()).not.toContain(SYNC_PROTOCOL);
  }, 60_000);
});
