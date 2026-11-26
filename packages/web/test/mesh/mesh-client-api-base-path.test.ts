// MESH_INTERFACE → The client's node list → "A check knows an API base's
// URL by the base it asked" — every place a check maps a URL back to its
// entry maps a URL at an API base by the base the check asked, which may
// carry a path, never by parsing a key or a host out of the URL.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { NodeTipResult, resolveTip } from '@dagsocial/nipopow-client';

import { startMeshClient, type MeshClient, type MeshEvent } from '../../src/mesh/mesh-client.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);

type ResolveFn = typeof resolveTip;

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

/**
 * An HTTP server bound on a loopback port that answers `<pathPrefix>/blocks/current`
 * with the given shape. Other paths answer 404. Its base URL carries the
 * path prefix — the testnet shape `https://notis.fun/testnet/api`.
 */
async function startApiBase(
  pathPrefix: string,
  reply: { status: number; body: string },
): Promise<{ srv: Server; base: string; readonly hits: number; readonly paths: string[] }> {
  const state = { hits: 0, paths: [] as string[] };
  const srv = createServer((req, res) => {
    state.paths.push(req.url ?? '');
    if (req.url === `${pathPrefix}/blocks/current`) {
      state.hits += 1;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('not found');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    srv,
    base: `http://127.0.0.1:${port}${pathPrefix}`,
    get hits() { return state.hits; },
    get paths() { return state.paths; },
  };
}

const HEX64_A = 'a'.repeat(64);

describe('mesh client — a check reads an entry whose api carries a path at that base', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it.fails('an api base carrying a path reaches `/blocks/current`; its tip read lands as the entry\'s speed and tipBytes', async () => {
    const body = JSON.stringify({ height: 7, hash: 'b'.repeat(64) });
    const api = await startApiBase('/testnet/api', { status: 200, body });
    servers.push(api.srv);

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: api.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-api-base-path',
      resolve: resolveTooShort,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();

    // Control: the one `/blocks/current` request lands at the api base.
    // Without this, every assertion below is vacuous.
    expect(api.hits, 'one `/blocks/current` request at the api base').toBe(1);

    const state = client.state();
    const entry = state.nodes.find((n) => n.notisId === HEX64_A);
    expect(entry, 'the entry exists').toBeDefined();
    // Control: the tip read did not fail.
    expect(entry!.status, 'the entry is not in retry').not.toBe('retry');
    expect(entry!.failures, 'no failure counted').toBe(0);
    // The speed is the entry's, the bytes land in `tipBytes`.
    expect(entry!.readMs, 'a speed was recorded').not.toBeNull();
    expect(state.traffic.tipBytes, 'the body read landed in `tipBytes`').toBeGreaterThan(0);
  }, 15_000);
});
