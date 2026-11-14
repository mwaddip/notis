// MESH_INTERFACE → The client's node list → "Retry" — the shipped
// call site: `MeshClientImpl` hands the client's `random` to the
// node list, so the drawn wait after a failure reads it. A case
// that reads `retryAtMs` through `startMeshClient` holds the
// wiring; the pure node-list cases would pass whichever source
// mesh-client passed.

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair, profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { nodeKeyFromKeyPair } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { resolveTip } from '@dagsocial/nipopow-client';

import { startMeshClient } from '../../src/mesh/mesh-client.js';
import type { MeshClient } from '../../src/mesh/mesh-client.js';
import { RETRY_BASE_MS } from '../../src/mesh/protocols.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const NOW = 100_000_000;

function keyPair(): { notisId: string } {
  return { notisId: nodeKeyFromKeyPair(generateKeyPair()).notisId };
}

// An HTTP fetch that throws on every call: every tip read fails,
// and the client records a transport failure through the shipped
// `NodeList.failure` — the point of entry the draw's random source
// is read at.
const everyCallThrows: HttpFetch = async (url) => {
  throw new Error(`transport failure: ${url}`);
};

const resolveNeverCalled: typeof resolveTip = async () => {
  throw new Error('resolve is never called when every tip read throws');
};

describe('mesh-client — the shipped call site hands the client\'s random source to the node list', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) {
      try { await c.stop(); } catch { /* already stopped */ }
    }
  });

  it('a failing tip read records `retryAtMs` at the failure\'s clock plus 0.625·RETRY_BASE_MS, under `random () => 0.25` and `clock () => 1_000_000`', async () => {
    const CLOCK_AT_FAILURE = 1_000_000;
    const aId = keyPair().notisId;
    const aBase = 'http://127.0.0.1:1';
    const client = await startMeshClient({
      firstContact: [{ notisId: aId, addrs: [], api: aBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-poc',
      wallClock: () => NOW,
      clock: () => CLOCK_AT_FAILURE,
      random: () => 0.25,
      httpFetch: everyCallThrows,
      resolve: resolveNeverCalled,
    });
    clients.push(client);
    await client.check();
    const eA = client.state().nodes.find((n) => n.notisId === aId)!;
    expect(eA.status, 'the node is in retry').toBe('retry');
    expect(eA.failures, 'one failure').toBe(1);
    // At source 0.25 and n = 1: `half + 0.25·half = 0.625·whole =
    // 0.625·RETRY_BASE_MS`.
    expect(eA.retryAtMs - CLOCK_AT_FAILURE, 'drawn wait at source 0.25 and n = 1').toBe(0.625 * RETRY_BASE_MS);
  }, 60_000);
});
