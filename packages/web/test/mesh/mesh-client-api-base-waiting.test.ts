// MESH_INTERFACE → The client's node list → "A failure at an API base
// while a node's wait stands moves nothing on" — a check reads a
// `retry` node at its API base whatever its wait; a failure there
// before its time has come is kept as the entry's last failure, and
// leaves the run and the wait as they were.

import { afterEach, describe, expect, it } from 'vitest';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import type { HttpFetch } from '@dagsocial/node-reads';
import type { NodeTipResult, resolveTip } from '@dagsocial/nipopow-client';

import { startMeshClient, type MeshClient } from '../../src/mesh/mesh-client.js';
import { RETRY_BASE_MS } from '../../src/mesh/protocols.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const NOW = 1_000_000;

type ResolveFn = typeof resolveTip;

const resolveNeverCalled: ResolveFn = async () => {
  throw new Error('resolve is never called when every tip read fails');
};

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

const HEX64_A = 'a'.repeat(64);

/**
 * An `HttpFetch` whose answer the caller swaps between calls — a throw
 * (transport failure) or a 200 with a non-tip body (`retry` as an api
 * malformed answer).
 */
interface Controlled {
  readonly fetch: HttpFetch;
  readonly calls: number;
  mode: 'throw' | 'malformed';
}

function controlledFetch(): Controlled {
  const state: { calls: number; mode: 'throw' | 'malformed' } = { calls: 0, mode: 'throw' };
  const fetch: HttpFetch = async () => {
    state.calls += 1;
    if (state.mode === 'throw') throw new Error('transport failure');
    return new Response('not a tip', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch,
    get calls() { return state.calls; },
    get mode() { return state.mode; },
    set mode(m: 'throw' | 'malformed') { state.mode = m; },
  };
}

describe('mesh client — a failure at an api base while the wait stands moves nothing on', () => {
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { await c.stop(); } catch { /* already stopped */ } }
  });

  it.fails('a `retry` entry whose wait has not come: a transport failure at its api base updates `lastFailure` only', async () => {
    const http = controlledFetch();
    const apiBase = 'http://127.0.0.1:1/testnet/api';
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: apiBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-api-base-waiting',
      clock: () => NOW,
      wallClock: () => NOW,
      random: () => 0.25,
      httpFetch: http.fetch,
      resolve: resolveNeverCalled,
    });
    clients.push(client);

    // First check: transport failure places the entry in retry.
    await client.check();
    const after1 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    // Controls: the entry moved to retry with one failure.
    expect(after1.status, 'first check leaves the entry in retry').toBe('retry');
    expect(after1.failures, 'one failure counted').toBe(1);
    const waitAfter1 = after1.retryAtMs;
    expect(waitAfter1, 'the wait is in the future').toBeGreaterThan(NOW);
    expect(after1.lastFailure, 'a lastFailure record was captured').not.toBeNull();
    expect(after1.lastFailure!.kind, 'first failure kind is transport').toBe('transport');

    // Second check while the wait stands: the client reads the retry
    // node at its api base (→ "Candidates"), and this read fails.
    const callsBefore = http.calls;
    await client.check();
    // Control: the api-base read happened.
    expect(http.calls, 'the retry entry was read at its api base').toBeGreaterThan(callsBefore);

    const after2 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    // The run and the wait stand.
    expect(after2.failures, '`failures` stands while the wait holds').toBe(1);
    expect(after2.retryAtMs, '`retryAtMs` stands while the wait holds').toBe(waitAfter1);
    // `lastFailure` carries the new read's kind and message.
    expect(after2.lastFailure, 'lastFailure records the new read').not.toBeNull();
    expect(after2.lastFailure!.kind, 'the new failure kind is transport').toBe('transport');
  }, 15_000);

  it.fails('a malformed answer at its api base while the wait stands reads as a transport failure that moves nothing on', async () => {
    const http = controlledFetch();
    const apiBase = 'http://127.0.0.1:1/testnet/api';
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: apiBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-api-base-waiting-malformed',
      clock: () => NOW,
      wallClock: () => NOW,
      random: () => 0.25,
      httpFetch: http.fetch,
      resolve: resolveNeverCalled,
    });
    clients.push(client);

    await client.check();
    const after1 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    expect(after1.status, 'first check leaves the entry in retry').toBe('retry');
    expect(after1.failures, 'one failure counted').toBe(1);
    const waitAfter1 = after1.retryAtMs;

    // Swap the controlled fetch to answer a well-formed 200 with a body
    // that does not parse as a tip — an api lie, which reads as a
    // transport failure (the api-base row).
    http.mode = 'malformed';
    const callsBefore = http.calls;
    await client.check();
    expect(http.calls, 'the retry entry was read at its api base').toBeGreaterThan(callsBefore);

    const after2 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    expect(after2.failures, '`failures` stands while the wait holds').toBe(1);
    expect(after2.retryAtMs, '`retryAtMs` stands while the wait holds').toBe(waitAfter1);
    // The new malformed read lands as the entry's lastFailure (kind
    // `transport`, the api-base row — never a `malformed`/lie kind).
    expect(after2.lastFailure, 'lastFailure records the new read').not.toBeNull();
    expect(after2.lastFailure!.kind, 'the api-base row reads a lie as transport').toBe('transport');
    expect(after2.lastFailure!.message, 'the new message names the api lie').toMatch(/api/);
  }, 15_000);

  it('control — once the wait has come, the same failure at the api base advances `failures` and `retryAtMs`', async () => {
    const http = controlledFetch();
    const apiBase = 'http://127.0.0.1:1/testnet/api';
    // Clock that steps forward on each read: the first check runs at
    // NOW; the second runs at NOW + 10 · RETRY_BASE_MS, past the first
    // check's drawn wait.
    const clockState = { now: NOW };
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: apiBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-api-base-waiting-elapsed',
      clock: () => clockState.now,
      wallClock: () => clockState.now,
      random: () => 0.25,
      httpFetch: http.fetch,
      resolve: resolveNeverCalled,
    });
    clients.push(client);

    await client.check();
    const after1 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    expect(after1.status, 'first check leaves the entry in retry').toBe('retry');
    expect(after1.failures).toBe(1);
    const waitAfter1 = after1.retryAtMs;

    // Advance the clock past the retry wait.
    clockState.now = waitAfter1 + 1;
    await client.check();
    const after2 = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    expect(after2.failures, '`failures` advances once the wait has come').toBe(2);
    expect(after2.retryAtMs, '`retryAtMs` is redrawn from the new clock').toBeGreaterThan(waitAfter1);
  }, 15_000);

  it('control — a non-retry entry still moves to `retry` on a transport failure at its api base', async () => {
    const http = controlledFetch();
    const apiBase = 'http://127.0.0.1:1/testnet/api';
    const client = await startMeshClient({
      firstContact: [{ notisId: HEX64_A, addrs: [], api: apiBase }],
      network: 'devnet',
      profile: PROFILE,
      agentName: 'notis-api-base-non-retry',
      clock: () => NOW,
      wallClock: () => NOW,
      random: () => 0.25,
      httpFetch: http.fetch,
      resolve: resolveTooShort,
    });
    clients.push(client);
    // Fresh entry starts `new`; the first check's transport failure at
    // its api base moves it to `retry` with one failure.
    await client.check();
    const e = client.state().nodes.find((n) => n.notisId === HEX64_A)!;
    expect(e.status, 'the fresh entry moved to retry').toBe('retry');
    expect(e.failures, 'one failure counted on a non-retry entry').toBe(1);
  }, 15_000);
});
