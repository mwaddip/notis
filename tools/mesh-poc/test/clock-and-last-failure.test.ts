// MESH_INTERFACE → "Two clocks" + "a proof refused by the clock check
// alone is a failure, never a lie" + "An entry keeps its last failure's
// kind and message".
//
// Cases:
//   - `tipEvents` maps `refuseCode: 'invalid'` with `verifyResult.reason
//     === 'clock'` to a `failure` with `FailureKind: 'clock'`, not a lie.
//   - `NodeList.failure(id, kind, message)` writes `lastFailure`;
//     `success(id)` clears it.
//   - `startMeshClient` hands its `wallClock` to the resolve seam, not
//     the retry clock — a fake wallClock asserts `now() > 1e12`.
//   - `page/render.ts` shows `lastFailure` under a retry entry.

// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { tipEvents } from '../src/client/tip-events.js';
import { NodeList } from '../src/client/node-list.js';
import type { NodeEntry } from '../src/client/node-list.js';
import { render } from '../page/render.js';
import type { ClientState } from '../src/client/mesh-client.js';
import { startMeshClient } from '../src/client/mesh-client.js';
import { profileFor } from '@dagsocial/types';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

function fakeTipResult(nodes: NodeTipResult[], winnerIndex = -1): TipResult {
  return {
    winnerIndex,
    nodes,
    // The rest of TipResult only matters when some node is the winner;
    // these fields are nullable or 0 for a losing-only result.
    winner: null,
    tip: null,
    suffixHead: null,
    splits: [],
  } as unknown as TipResult;
}

function entry(over: Partial<NodeEntry> & { notisId: string }): NodeEntry {
  return {
    notisId: over.notisId,
    anchor: over.anchor ?? false,
    status: over.status ?? 'new',
    failures: over.failures ?? 0,
    retryAtMs: over.retryAtMs ?? 0,
    addrs: over.addrs ?? [],
    droppedAddrs: over.droppedAddrs ?? [],
    evidence: over.evidence ?? null,
    lastFailure: over.lastFailure ?? null,
    lastFailures: over.lastFailures ?? {},
  };
}
function emptyState(over: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: over.nodeId ?? null,
    transport: over.transport ?? null,
    path: over.path ?? null,
    lastLeft: over.lastLeft ?? null,
    anchorReached: over.anchorReached ?? false,
    tip: over.tip ?? null,
    nodes: over.nodes ?? [],
  };
}

describe('tipEvents — clock refusal is a failure, not a lie', () => {
  const id = 'a'.repeat(64);
  const url = `notis-mesh://${id}`;
  it('refuseCode "invalid" + verifyResult.reason "clock" → failure, kind clock', () => {
    const events = tipEvents(fakeTipResult([{
      url,
      verified: false,
      proof: null,
      verifyResult: { ok: false, reason: 'clock', index: 134 },
      refuseReason: 'verify failed: clock at index 134',
      refuseCode: 'invalid',
      behind: null,
      genesisHash: null,
    } as unknown as NodeTipResult]), 1000);
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.ev).toBe('failure');
    expect(ev.ev === 'failure' ? ev.kind : null).toBe('clock');
    expect(ev.ev === 'failure' ? ev.message : null).toContain('clock');
  });
  it('refuseCode "invalid" + verifyResult.reason "pow" (not clock) → lie, kind proof-invalid', () => {
    const events = tipEvents(fakeTipResult([{
      url,
      verified: false,
      proof: { prefix: [], suffixHead: null, suffixTail: [] } as unknown as NonNullable<NodeTipResult['proof']>,
      verifyResult: { ok: false, reason: 'pow', index: 7 },
      refuseReason: 'verify failed: pow at index 7',
      refuseCode: 'invalid',
      behind: null,
      genesisHash: null,
    } as unknown as NodeTipResult]), 1000);
    const ev = events[0]!;
    expect(ev.ev).toBe('lie');
    if (ev.ev === 'lie') expect(ev.evidence.kind).toBe('proof-invalid');
  });
});

describe('NodeList — lastFailure set on failure, cleared on success', () => {
  it('a failure sets lastFailure with kind + message + atMs', () => {
    const id = 'a'.repeat(64);
    let now = 100;
    const list = new NodeList(
      [{ notisId: id, addrs: [] }],
      'b'.repeat(64),
      () => now,
    );
    now = 500;
    list.failure(id, 'transport', 'DialDeniedError: gater refused');
    const e = list.entry(id)!;
    expect(e.status).toBe('retry');
    expect(e.lastFailure).not.toBeNull();
    expect(e.lastFailure!.kind).toBe('transport');
    expect(e.lastFailure!.message).toContain('DialDeniedError');
    expect(e.lastFailure!.atMs).toBe(500);
  });
  it('a success after a failure clears lastFailure', () => {
    const id = 'a'.repeat(64);
    let now = 100;
    const list = new NodeList(
      [{ notisId: id, addrs: [] }],
      'b'.repeat(64),
      () => now,
    );
    list.failure(id, 'timeout', 'DialTimeoutError');
    expect(list.entry(id)!.lastFailure).not.toBeNull();
    now = 200;
    list.success(id);
    const e = list.entry(id)!;
    expect(e.status).toBe('ok');
    expect(e.lastFailure).toBeNull();
  });
  it('a clock failure leaves the node retry, not blacklisted', () => {
    const id = 'a'.repeat(64);
    const list = new NodeList(
      [{ notisId: id, addrs: [] }],
      'b'.repeat(64),
      () => 100,
    );
    list.failure(id, 'clock', 'verify failed: clock at index 134');
    const e = list.entry(id)!;
    expect(e.status).toBe('retry');
    expect(e.evidence).toBeNull();
    expect(e.lastFailure!.kind).toBe('clock');
  });
});

describe('page/render — lastFailure under a retry entry', () => {
  it("a retry entry's lastFailure is shown as text", () => {
    const root = document.createElement('div');
    const retryEntry = entry({
      notisId: 'a'.repeat(64),
      status: 'retry',
      failures: 1,
      lastFailure: { kind: 'transport', message: 'DialDeniedError: gater refused', atMs: 1234 },
    });
    render(emptyState({ nodes: [retryEntry], anchorReached: true }), root);
    const lf = root.querySelector('.last-failure');
    expect(lf, 'last-failure block').not.toBeNull();
    expect(lf!.textContent).toContain('kind=transport');
    expect(lf!.textContent).toContain('DialDeniedError');
  });
  it('a non-retry entry hides lastFailure even if present', () => {
    const root = document.createElement('div');
    const okEntry = entry({
      notisId: 'a'.repeat(64),
      status: 'ok',
      lastFailure: { kind: 'transport', message: 'stale', atMs: 1 },
    });
    render(emptyState({ nodes: [okEntry], anchorReached: true }), root);
    const lf = root.querySelector('.last-failure');
    expect(lf, 'last-failure hidden on ok').toBeNull();
  });
});

describe('startMeshClient — wallClock is handed to the resolve seam', () => {
  it('the resolve seam receives a wall-clock now (reads > 1e12 ms)', async () => {
    // happy-dom lives in this file, so we need a minimal libp2p-less
    // start: `resolve` is a stub that captures the `now` argument the
    // client passes.
    const anchors = [{
      notisId: 'a'.repeat(64),
      addrs: ['/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/A/p2p/PA'],
    }];
    let capturedNow: (() => number) | null = null;
    // The real resolveTip takes (urls, m, k, profile, now, fetch).
    const resolveStub = (async (_urls: unknown, _m: unknown, _k: unknown, _profile: unknown, now: () => number) => {
      capturedNow = now;
      return { winnerIndex: -1, nodes: [] };
    }) as unknown as Parameters<typeof startMeshClient>[0]['resolve'];
    // The client's `clock` default is monotonic (`performance.now`,
    // which happy-dom supports); scenarios inject a fake monotonic
    // clock. We skip injecting one and only check wallClock.
    const client = await startMeshClient({
      anchors,
      network: 'devnet',
      profile: profileFor('devnet'),
      stunServers: [],
      resolve: resolveStub,
      // Explicitly set wallClock to a fake that is clearly wall-clock
      // (ms since epoch >> 1e12).
      wallClock: () => 1_900_000_000_000,
    });
    try {
      // Force a check so the resolve stub runs.
      await client.check();
      expect(capturedNow, 'resolve was called').not.toBeNull();
      expect(capturedNow!(), 'wallClock reads > 1e12 ms').toBeGreaterThan(1e12);
    } finally {
      await client.stop();
    }
  });
});
