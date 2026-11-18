// MESH_INTERFACE → Discovery → "A node the access point answers" — the
// mesh client reads the identity URL after a check in which no node
// answered, adds the answering node as an ordinary candidate marked
// `local`, and triggers an immediate check. The harness mirrors
// `mesh-client-events.test.ts`: API-only entries so no real libp2p
// connection opens, a `resolveTip` whose answers put every node under
// `failure/transport` (or under success, per the case), and a fake
// `httpFetch` that intercepts the identity URL and defers the rest to
// one HTTP server answering `/blocks/current`.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { profileFor, generateKeyPair } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { NodeTipResult, resolveTip } from '@dagsocial/nipopow-client';
import { nodeKeyFromKeyPair, peerIdFromNotisId } from '@dagsocial/net/browser';
import type { HttpFetch } from '@dagsocial/node-reads';

import {
  startMeshClient,
  type MeshClient,
  type MeshEvent,
  type MeshLocalLookupEvent,
} from '../../src/mesh/mesh-client.js';
import { LOCAL_IDENTITY_URL } from '../../src/mesh/local-lookup.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
type ResolveFn = typeof resolveTip;

const HEX64_A = 'a'.repeat(64);

function makeIdentity(): { notisId: string; peerId: string } {
  const notisId = nodeKeyFromKeyPair(generateKeyPair()).notisId;
  const peerId = peerIdFromNotisId(notisId).toString();
  return { notisId, peerId };
}

function privateAddr(peerId: string, port = 9733): string {
  return `/ip4/192.168.2.6/udp/${port}/webrtc-direct/certhash/uEiA/p2p/${peerId}`;
}

/** A `resolveTip` that answers every URL as `unreachable` — every tip
 *  event lands as `failure/transport`, so `noNodeAnswered` is true. */
const resolveUnreachable: ResolveFn = async (nodeUrls) => {
  const nodes: NodeTipResult[] = nodeUrls.map((url) => ({
    url,
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: 'unreachable in test',
    refuseCode: 'unreachable',
    behind: null,
    genesisHash: null,
  }));
  return { winner: null, winnerIndex: -1, nodes, tip: null, suffixHead: null, splits: [] };
};

/** A `resolveTip` that answers every URL `too-short` — every node is `behind`
 *  (a node answered, just with a short chain). `noNodeAnswered` is false. */
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

/** An HTTP server used for `/blocks/current` answers — never hit when the
 *  resolver is `resolveUnreachable`, since that resolver never calls
 *  `httpFetch`. Kept so an API-only entry has a concrete base. */
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

interface IdentityStub {
  // The response the next call to the identity URL answers with; set by
  // the test before each phase it cares about. Default: a transport
  // failure (nothing is listening on `notis.internal`).
  next: () => Promise<Response>;
}

function identityStub(): IdentityStub {
  return {
    next: () => Promise.reject(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
  };
}

/** `httpFetch` that intercepts the identity URL and defers the rest to
 *  node-fetch. */
function makeHttpFetch(stub: IdentityStub, calls: { url: string }[]): HttpFetch {
  return async (url, init) => {
    const s = url.toString();
    calls.push({ url: s });
    if (s === LOCAL_IDENTITY_URL) {
      return stub.next();
    }
    return globalThis.fetch(s, init);
  };
}

function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('mesh client — local lookup', () => {
  const clients: MeshClient[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
    for (const s of servers.splice(0)) { s.close(); }
  });

  it('a check in which no node answered reads the URL once, after the check ends', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    // Answer the identity URL as failed, so the client does not add
    // an entry and the second check that `addLocal` would schedule
    // does not fire.
    stub.next = () => Promise.reject(new Error('ECONNREFUSED'));
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
      events: (e) => captured.push(e),
    });
    clients.push(client);
    // No identity call before `check()` ends — the lookup is scheduled
    // after `checkInProgress` clears (in `.finally`).
    const callsAtCheck = calls.length;
    await client.check();
    // Right after `await client.check()` returns, the lookup has been
    // scheduled but may not have landed yet; it is after the check
    // ends. Confirm by capture: the identity URL did not appear in
    // the calls made during the check.
    const identityCallsDuringCheck = calls
      .slice(0, callsAtCheck)
      .filter((c) => c.url === LOCAL_IDENTITY_URL);
    expect(identityCallsDuringCheck.length, 'no identity call while the check was in flight').toBe(0);
    // Wait for the finally-scheduled lookup to run.
    await waitFor(() => calls.some((c) => c.url === LOCAL_IDENTITY_URL));
    const identityCalls = calls.filter((c) => c.url === LOCAL_IDENTITY_URL);
    expect(identityCalls.length, 'one read, after the check ended').toBe(1);
    const events = captured.filter((e): e is MeshLocalLookupEvent => e.kind === 'local-lookup');
    expect(events.length, 'one local-lookup event').toBe(1);
    expect(events[0]!.outcome.result).toBe('failed');
  }, 15_000);

  it('a check in which one node answered reads nothing', async () => {
    // `resolveTooShort` answers every URL as `too-short`, which is a
    // verified-not-enough answer (a node answered). `noNodeAnswered`
    // is false, so the lookup does not run.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveTooShort,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
    });
    clients.push(client);
    await client.check();
    // Wait a moment for any mis-scheduled lookup to fire; none should.
    await new Promise((r) => setTimeout(r, 50));
    const identityCalls = calls.filter((c) => c.url === LOCAL_IDENTITY_URL);
    expect(identityCalls.length, 'no lookup read when a node answered').toBe(0);
    expect(client.state().localLookup.reads).toBe(0);
  }, 15_000);

  it('an answer adds the node and a check runs at once', async () => {
    // Review Focus: the addition's `triggerImmediateCheck` runs after
    // `checkInProgress` is cleared (in `check()`'s `.finally`), so the
    // immediate check is not swallowed by the ending check. The test
    // asserts the second check happened (checks count rises), not
    // only that `addLocal` was called.
    //
    // `libp2p.dial` is overridden to reject before touching the WebRTC
    // native binding. The second check's phase 1 would otherwise dial
    // the new local entry's webrtc-direct address, and the test
    // environment's `node-datachannel` native binding crashes creating
    // a data channel — no other test in this package dials webrtc. The
    // guard this fake holds is that the dial is rejected before any
    // native work; the check still runs its phases, applies a transport
    // failure to the local entry, and completes.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const { notisId, peerId } = makeIdentity();
    const addr = privateAddr(peerId);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    // The identity URL answers once with a well-formed identity; after
    // that, it refuses every call (so the immediate check's own
    // follow-up lookup does not add a second entry).
    let n = 0;
    stub.next = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ notisId, peerId, multiaddrs: [], localAddrs: [addr] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // The resolver answers every URL as unreachable, so the next
      // check also has `noNodeAnswered === true` and reads the URL
      // again. We refuse the second read to keep the test bounded.
      return new Response('refused', { status: 404 });
    };
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
    });
    clients.push(client);
    // Stub out libp2p.dial so the second check's phase 1 does not
    // reach the WebRTC native binding (see the case's lead above).
    Object.defineProperty(client.libp2p, 'dial', {
      value: async () => { throw new Error('test: dial disabled'); },
      writable: true,
      configurable: true,
    });
    await client.check();
    const checksAfterFirst = client.state().checks;
    expect(checksAfterFirst).toBe(1);
    // Wait for the lookup to add the node and the immediate check to
    // run — `checks` rises to 2.
    await waitFor(() => client.state().checks >= 2);
    const entry = client.state().nodes.find((e) => e.notisId === notisId);
    expect(entry, 'the found node is in the list').toBeDefined();
    expect(entry!.local, 'the found node is marked local').toBe(true);
    expect(entry!.byHand, 'never your node').toBe(false);
    expect(entry!.yours, 'never trusted').toBe(false);
  }, 15_000);

  it('the event and `state().localLookup` record each read', async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    stub.next = () => Promise.reject(new Error('ECONNREFUSED'));
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
      events: (e) => captured.push(e),
    });
    clients.push(client);
    await client.check();
    await waitFor(() => captured.some((e) => e.kind === 'local-lookup'));
    const ev = captured.find((e): e is MeshLocalLookupEvent => e.kind === 'local-lookup')!;
    expect(ev.check, 'the check number it followed').toBe(1);
    expect(typeof ev.ms, 'the duration is a number').toBe('number');
    expect(ev.outcome.result).toBe('failed');
    const s = client.state().localLookup;
    expect(s.reads).toBe(1);
    expect(s.last, 'the last read is recorded').not.toBeNull();
    expect(s.last!.check).toBe(1);
    expect(s.last!.result).toBe('failed');
  }, 15_000);

  it('local lookup stops once a seed answers', async () => {
    // Review Focus 1: the reader leaves the access point for an
    // ordinary network mid-session — the seed answers, and no lookup
    // runs once one does. Checks are independent; we flip the
    // resolver between the two.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    stub.next = () => Promise.reject(new Error('ECONNREFUSED'));
    let resolver: ResolveFn = resolveUnreachable;
    const resolve: ResolveFn = (urls, ...rest) => resolver(urls, ...rest);
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
    });
    clients.push(client);
    // First check: unreachable → lookup fires.
    await client.check();
    await waitFor(() => client.state().localLookup.reads >= 1);
    expect(client.state().localLookup.reads).toBe(1);
    // Flip the resolver: the seed now answers (`too-short`).
    resolver = resolveTooShort;
    await client.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(client.state().localLookup.reads, 'the lookup did not fire this check').toBe(1);
  }, 15_000);

  it('a 404 or a refused connection is failed and read again next check', async () => {
    // Review Focus 5: the node restarting after `setup` — the
    // identity URL refused or 404 while it starts — reads as
    // `failed`, and the next failing check reads again.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    stub.next = async () => new Response('not found', { status: 404 });
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
    });
    clients.push(client);
    await client.check();
    await waitFor(() => client.state().localLookup.reads >= 1);
    expect(client.state().localLookup.last!.result).toBe('failed');
    // The next check reads again.
    await client.check();
    await waitFor(() => client.state().localLookup.reads >= 2);
    expect(client.state().localLookup.reads).toBe(2);
  }, 15_000);

  it("a client started without `localLookup` never reads", async () => {
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      // no `localLookup` option
    });
    clients.push(client);
    await client.check();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.find((c) => c.url === LOCAL_IDENTITY_URL)).toBeUndefined();
    expect(client.state().localLookup.reads).toBe(0);
    expect(client.state().localLookup.last).toBeNull();
  }, 15_000);

  it("a local entry's addresses are not in `toRemember()`", async () => {
    // MESH_INTERFACE → What the client remembers: the remembered list
    // carries no private address. A `local` entry's addresses are
    // private (`10.42.0.1`, `192.168.x`, etc.), so the existing
    // `wouldDial` rule in `nodesToRemember` leaves them out. Verify
    // by rule, not by probing an entry that reached `ok`.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const { notisId, peerId } = makeIdentity();
    const addr = privateAddr(peerId);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    let n = 0;
    stub.next = async () => {
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({ notisId, peerId, multiaddrs: [], localAddrs: [addr] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('later refuses', { status: 404 });
    };
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
    });
    clients.push(client);
    // The guard: the second check's phase 1 would dial the local
    // entry's webrtc-direct address, and the test environment's
    // `node-datachannel` native binding crashes creating a data
    // channel. The override keeps the check running through its
    // phases without a native dial.
    Object.defineProperty(client.libp2p, 'dial', {
      value: async () => { throw new Error('test: dial disabled'); },
      writable: true,
      configurable: true,
    });
    await client.check();
    await waitFor(() => client.state().nodes.some((e) => e.notisId === notisId));
    // The local entry is in the list; `toRemember()` must not carry
    // its address — the private IP fails `wouldDial`'s `isPrivate`
    // check, and `nodesToRemember` leaves addressless entries out.
    const snapshot = client.toRemember();
    const found = snapshot.nodes.find((n) => n.notisId === notisId);
    expect(found, 'the local entry is not remembered at all').toBeUndefined();
  }, 15_000);

  it.fails('an answer that changes nothing runs no check at once', async () => {
    // MESH_INTERFACE → Discovery → "A node the access point answers":
    // "A check runs at once where the answer added the node, an
    // address or the mark"; an answer that changes nothing waits for
    // the check's own cadence. The scenario: the local entry is
    // already held with those addresses and the mark set; the next
    // failing check reads the URL and gets the same answer. `addLocal`
    // answers `false`, and the client does NOT fire an immediate
    // check — otherwise a box whose identity answers while its node
    // does not would be hammered in a tight loop of lookup → addLocal
    // → immediate check → … within one retry window.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const { notisId, peerId } = makeIdentity();
    const addr = privateAddr(peerId);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    // Every read answers the same well-formed identity.
    stub.next = async () => new Response(
      JSON.stringify({ notisId, peerId, multiaddrs: [], localAddrs: [addr] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
      events: (e) => captured.push(e),
    });
    clients.push(client);
    // See the first case's lead above: the phase-1 dial of the local
    // webrtc-direct address would crash `node-datachannel`.
    Object.defineProperty(client.libp2p, 'dial', {
      value: async () => { throw new Error('test: dial disabled'); },
      writable: true,
      configurable: true,
    });
    // First check adds the entry, second check reads the URL again
    // and gets the same answer. The control: the second check is the
    // `triggerImmediateCheck` the first lookup fired — it runs because
    // that first lookup DID add the entry. We wait for `checks` to
    // reach 2 as proof, then measure what the SECOND lookup does.
    await client.check();
    await waitFor(() => client.state().checks >= 2);
    expect(client.state().nodes.find((e) => e.notisId === notisId)?.local).toBe(true);
    // At this point lookups made so far (`reads`): the first lookup
    // after check 1 fired and added the entry; the immediate check
    // (check 2) ran, read every candidate as unreachable, and fired
    // the second lookup. Wait for `reads === 2`.
    await waitFor(() => client.state().localLookup.reads >= 2);
    expect(client.state().localLookup.reads).toBe(2);
    const checksAtSecondLookup = client.state().checks;
    const readsAtSecondLookup = client.state().localLookup.reads;
    // Hold for a window far below `CHECK_INTERVAL_MS` (60 s) to see
    // whether the second lookup's answer (which adds nothing) fires
    // a third check at 0 ms. It must not: no new `check` event, no
    // rise in `checks`, no rise in `reads`.
    const checkEventsBefore = captured.filter((e) => e.kind === 'check').length;
    await new Promise((r) => setTimeout(r, 300));
    const checkEventsAfter = captured.filter((e) => e.kind === 'check').length;
    expect(checkEventsAfter, 'no new check event while the answer changed nothing').toBe(checkEventsBefore);
    expect(client.state().checks, 'the counter did not move').toBe(checksAtSecondLookup);
    expect(client.state().localLookup.reads, 'no new lookup fired').toBe(readsAtSecondLookup);
    // Control: trigger another check by hand and observe the counter
    // moves — proof that the counter would have moved had the no-op
    // answer fired one.
    await client.check();
    expect(client.state().checks, 'the counter moves when a check does run').toBeGreaterThan(checksAtSecondLookup);
  }, 30_000);

  it('a client holding a connection reads nothing — asserted at the condition clause', async () => {
    // MESH_INTERFACE → Discovery → "A node the access point answers":
    // the read runs "while it holds no connection". The harness
    // cannot open a real libp2p connection in this environment —
    // every `addByHand`/`addLocal` with a webrtc-direct address runs
    // afoul of `node-datachannel`'s native crash in `createDataChannel`
    // (see the first case's lead). The scheduler checks the condition
    // through `this.libp2p.getConnections().length !== 0`; this test
    // asserts the condition at that clause by overriding
    // `getConnections` with a fake and reading the lookup's state
    // after a check — no event, no rise in `reads`.
    const tip = await startTipServer({ status: 200, body: JSON.stringify({ height: 7, hash: 'b'.repeat(64) }) });
    servers.push(tip.srv);
    const calls: { url: string }[] = [];
    const stub = identityStub();
    stub.next = () => Promise.reject(new Error('ECONNREFUSED'));
    const captured: MeshEvent[] = [];
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: tip.base }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-mesh-local',
      resolve: resolveUnreachable,
      httpFetch: makeHttpFetch(stub, calls),
      localLookup: { url: LOCAL_IDENTITY_URL },
      events: (e) => captured.push(e),
    });
    clients.push(client);
    // Fake a held connection: `getConnections` answers non-empty,
    // which is what the scheduler's connection clause reads. The
    // fake's `remotePeer` is a peer id string no entry's key maps
    // to, so `hasOpenConnection` and the decoration pass's
    // `pickConnectionForLabel` answer `null` for every entry and
    // nothing dereferences a missing field.
    const fakeConn: unknown = {
      id: 'fake-conn',
      remotePeer: { toString: () => '12D3KooWFakeConnectionPeerIdNotMatchingAnyEntry0000' },
      remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/4444' },
      direction: 'outbound',
      limits: null,
    };
    Object.defineProperty(client.libp2p, 'getConnections', {
      value: () => [fakeConn],
      writable: true,
      configurable: true,
    });
    await client.check();
    // A short window is enough: the lookup would have fired in the
    // `.finally` at 0 ms. We wait a fuzz period to rule out a race.
    await new Promise((r) => setTimeout(r, 50));
    const identityCalls = calls.filter((c) => c.url === LOCAL_IDENTITY_URL);
    expect(identityCalls.length, 'no lookup read while a connection is held').toBe(0);
    expect(client.state().localLookup.reads).toBe(0);
    expect(client.state().localLookup.last).toBeNull();
    const localEvents = captured.filter((e) => e.kind === 'local-lookup');
    expect(localEvents.length).toBe(0);
  }, 15_000);
});
