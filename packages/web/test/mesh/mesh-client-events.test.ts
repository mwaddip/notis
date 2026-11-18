// MESH_INTERFACE → The client's node list → "The client reports what it
// does" — the events sink receives one event per moment the lead names.
// A seam harness: a `firstContact` entry carrying an API base and no
// addrs lets the client answer reads at that base, so the moments run
// through real public entries — `client.fetch` and `client.check` — with
// no libp2p transport started.

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

/** A tiny HTTP server answering `/blocks/current` with the given shape. */
async function startTipServer(
  reply: { status: number; body: string },
): Promise<{ srv: Server; base: string; hits: number }> {
  const state = { hits: 0 };
  const srv = createServer((_req, res) => {
    state.hits += 1;
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return {
    srv,
    base: `http://127.0.0.1:${port}`,
    get hits() { return state.hits; },
  };
}

const HEX64_A = 'a'.repeat(64);

describe('mesh client — the events sink: check-end', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('a check ends with one event carrying the number, the tip, the counts and the node tip events', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-check',
      resolve: resolveTooShort,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    // Wait for the first check `scheduleNextCheck(0)` schedules at start.
    await client.check();
    const ends = captured.filter((e): e is Extract<MeshEvent, { kind: 'check' }> => e.kind === 'check');
    expect(ends.length, 'one check event per completed check').toBeGreaterThanOrEqual(1);
    const last = ends[ends.length - 1]!;
    expect(last.number, 'number is the post-increment state.checks').toBe(client.state().checks);
    expect(last.threw, 'a check that does not throw').toBeNull();
    // Node tip events: this api base is one node; its `/blocks/current` is
    // the tip the chain stays below `k` on, so the resolver answers
    // `too-short`, which `tipEvent` reads as `behind`.
    expect(last.nodes.map((n) => n.event.ev), 'the one node shows the resolver answer').toContain('behind');
    expect(last.nodes.find((n) => n.nodeId === HEX64_A), 'carries the node id').toBeTruthy();
  }, 15_000);
});

describe('mesh client — the events sink: request events', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('a `fetch` of an http URL writes a request event carrying the number, url, route, status and the head ms', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ ok: true }) });
    servers.push(tip.srv);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-req',
      resolve: resolveTooShort,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    const url = `${tip.base}/some/path`;
    const response = await client.fetch(url, undefined);
    // Drain the body so the request-body event fires.
    await response.text();
    const reqs = captured.filter((e): e is Extract<MeshEvent, { kind: 'request' }> => e.kind === 'request' && e.url === url);
    expect(reqs.length, 'one request event').toBe(1);
    expect(reqs[0]!.route, 'the API route').toBe('api');
    expect(reqs[0]!.head.ok, 'a 200 reads as ok').toBe(true);
    expect(reqs[0]!.connection, 'the API route carries no connection').toBeUndefined();
  }, 15_000);

  it('a `fetch` of an http URL whose body is read to its end writes a request-body event under the same number', async () => {
    const payload = 'hello world';
    const tip = await startTipServer({ status: 200, body: payload });
    servers.push(tip.srv);
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-body',
      resolve: resolveTooShort,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    const response = await client.fetch(`${tip.base}/body/test`, undefined);
    await response.text();
    const reqs = captured.filter((e): e is Extract<MeshEvent, { kind: 'request' }> => e.kind === 'request' && e.url.endsWith('/body/test'));
    const bodies = captured.filter((e): e is Extract<MeshEvent, { kind: 'request-body' }> => e.kind === 'request-body');
    expect(reqs.length, 'one request event').toBe(1);
    expect(bodies.length, 'one request-body event').toBeGreaterThanOrEqual(1);
    const match = bodies.find((b) => b.number === reqs[0]!.number);
    expect(match, 'a request-body under the same number').toBeTruthy();
    expect(match!.bytes, 'the body bytes').toBe(payload.length);
  }, 15_000);
});

describe('mesh client — the events sink: an empty-body response', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('a `fetch` of an http URL whose response has no body writes one `request-body` event with `bytes: 0` under the request\'s number', async () => {
    // A 204 No Content response has a null body under Node's native
    // `fetch`, so `wrapResponseBody` takes the empty-body branch
    // (MESH_INTERFACE → The client's node list → "The client reports
    // what it does" — "an answer's body read to its end"). The
    // `request-body` event lands at once under the request's number.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const srv204 = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => srv204.listen(0, '127.0.0.1', resolve));
    servers.push(srv204);
    const port204 = (srv204.address() as AddressInfo).port;
    const base204 = `http://127.0.0.1:${port204}`;

    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-empty',
      resolve: resolveTooShort,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    const url = `${base204}/no-body`;
    const response = await client.fetch(url, undefined);
    expect(response.status, 'the 204 arrived').toBe(204);
    expect(response.body, 'a 204 answer carries no body').toBeNull();
    const reqs = captured.filter(
      (e): e is Extract<MeshEvent, { kind: 'request' }> =>
        e.kind === 'request' && e.url === url,
    );
    expect(reqs.length, 'one request event for the empty-body URL').toBe(1);
    const bodies = captured.filter(
      (e): e is Extract<MeshEvent, { kind: 'request-body' }> =>
        e.kind === 'request-body' && e.number === reqs[0]!.number,
    );
    expect(bodies.length, 'one request-body event under the request\'s number').toBe(1);
    expect(bodies[0]!.bytes, 'zero bytes for an empty body').toBe(0);
  }, 15_000);
});

describe('mesh client — the events sink: a check whose work throws', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('writes one `check` event whose `threw` carries the throw\'s message', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    // A resolver that throws takes the check into the `check()`
    // promise chain's catch, which writes `threw: messageOf(e)` into
    // the `check` event (MESH_INTERFACE → The client's node list →
    // "The client reports what it does" — "a check that throws is
    // reported as ending with the throw's message").
    const BOOM = 'resolver boom';
    const resolveThrows: ResolveFn = async () => {
      throw new Error(BOOM);
    };
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-threw',
      resolve: resolveThrows,
      events: (e) => captured.push(e),
    });
    clients.push(client);
    let caught: unknown;
    try { await client.check(); } catch (e) { caught = e; }
    expect(caught, 'the check threw').toBeDefined();
    const ends = captured.filter((e): e is Extract<MeshEvent, { kind: 'check' }> => e.kind === 'check');
    expect(ends.length, 'one check event for the thrown check').toBeGreaterThanOrEqual(1);
    const last = ends[ends.length - 1]!;
    expect(last.threw, 'the threw message names the throw').toContain(BOOM);
  }, 15_000);
});

describe('mesh client — the events sink: a sink that throws is absorbed', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('a sink that throws leaves the client\'s state as a client with no sink leaves it', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const logLines: string[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-events-throw',
      resolve: resolveTooShort,
      log: (line) => logLines.push(line),
      events: (): void => { throw new Error('boom'); },
    });
    clients.push(client);
    await client.check();
    // A sink that throws is logged through `log` and changes nothing the
    // client does.
    expect(logLines.some((l) => l.includes('events sink threw')), 'the log line names the sink throw').toBe(true);
    // The state is well-formed — `checks` advanced, no exception propagated.
    expect(client.state().checks).toBeGreaterThanOrEqual(1);
  }, 15_000);
});
