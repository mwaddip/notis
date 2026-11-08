// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows." A tip read goes to an `ok` node; an older
// read may go to an `ok` or `trailing` node; the fast set is each
// `usable` allowed node within `FAST_SET_FACTOR` times the fastest's
// `readMs` plus `FAST_SET_SLACK_MS`. First-check and all-failed cases,
// where no allowed node has a `readMs`, spread uniformly over the
// allowed.

import { describe, it, expect } from 'vitest';
import {
  pickServer,
  orderServers,
  type OrderCandidate,
  type PickCandidate,
} from '../../src/mesh/server-pick.js';

function cand(id: string, over: Partial<PickCandidate> = {}): PickCandidate {
  return {
    id,
    status: over.status ?? 'ok',
    readMs: over.readMs ?? null,
    usable: over.usable ?? true,
  };
}

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const idC = 'c'.repeat(64);

function ocand(id: string, over: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    id,
    status: over.status ?? 'ok',
    readMs: over.readMs ?? null,
    meshUsable: over.meshUsable ?? false,
    firstContact: over.firstContact ?? false,
    api: over.api ?? null,
    meshBase: over.meshBase ?? `notis-mesh://${id}`,
  };
}

describe('pickServer', () => {
  it('a tip read picks only ok nodes', () => {
    // trailing is fast (10ms), ok is slow (100ms); a tip read still
    // picks the ok one — trailing is not allowed under 'tip'.
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 100 }),
      cand(idB, { status: 'trailing', readMs: 10 }),
    ];
    for (let seed = 0; seed < 20; seed++) {
      const r = seed / 20;
      expect(pickServer(nodes, 'tip', () => r)).toBe(idA);
    }
  });

  it('an older read may pick a trailing node', () => {
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 10 }),
      cand(idB, { status: 'trailing', readMs: 15 }),
    ];
    const picked = new Set<string>();
    for (let seed = 0; seed < 100; seed++) {
      const id = pickServer(nodes, 'older', () => seed / 100);
      if (id !== null) picked.add(id);
    }
    expect(picked.has(idA)).toBe(true);
    expect(picked.has(idB)).toBe(true);
  });

  it('a node slower than 2× the fastest + 50 ms is never picked', () => {
    // readMs 10, 15, 200. min = 10, bound = 2*10 + 50 = 70. 200 is
    // outside, 10 and 15 are in.
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 10 }),
      cand(idB, { status: 'ok', readMs: 15 }),
      cand(idC, { status: 'ok', readMs: 200 }),
    ];
    for (let seed = 0; seed < 100; seed++) {
      const r = seed / 100;
      expect(pickServer(nodes, 'tip', () => r)).not.toBe(idC);
    }
  });

  it('picks spread across the fast set', () => {
    // All three within the fast bound (readMs 10, 15, 20; min = 10,
    // bound = 70). A rand sweep over [0, 1) must hit all three ids.
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 10 }),
      cand(idB, { status: 'ok', readMs: 15 }),
      cand(idC, { status: 'ok', readMs: 20 }),
    ];
    const seen = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      const id = pickServer(nodes, 'tip', () => seed / 300);
      if (id !== null) seen.add(id);
    }
    expect(seen).toEqual(new Set([idA, idB, idC]));
  });

  it('unknown readMs everywhere spreads uniformly over the allowed', () => {
    // Review Focus 4 — first check, or every proof read failed: no
    // allowed node has a `readMs`. The fast set is every allowed; the
    // pick never answers `null` while one is allowed.
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: null }),
      cand(idB, { status: 'ok', readMs: null }),
      cand(idC, { status: 'trailing', readMs: null }),
    ];
    const seenTip = new Set<string>();
    const seenOlder = new Set<string>();
    for (let seed = 0; seed < 300; seed++) {
      const r = seed / 300;
      const tipId = pickServer(nodes, 'tip', () => r);
      if (tipId !== null) seenTip.add(tipId);
      const olderId = pickServer(nodes, 'older', () => r);
      if (olderId !== null) seenOlder.add(olderId);
    }
    expect(seenTip).toEqual(new Set([idA, idB]));
    expect(seenOlder).toEqual(new Set([idA, idB, idC]));
  });

  it('an unusable node is never picked; none usable answers null', () => {
    const nodes: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 10, usable: false }),
      cand(idB, { status: 'ok', readMs: 20, usable: true }),
    ];
    for (let seed = 0; seed < 100; seed++) {
      const r = seed / 100;
      expect(pickServer(nodes, 'tip', () => r)).toBe(idB);
    }
    const noneUsable: PickCandidate[] = [
      cand(idA, { status: 'ok', readMs: 10, usable: false }),
      cand(idB, { status: 'ok', readMs: 20, usable: false }),
    ];
    expect(pickServer(noneUsable, 'tip', () => 0)).toBeNull();
    const emptyAllowed: PickCandidate[] = [cand(idA, { status: 'behind', readMs: 10 })];
    expect(pickServer(emptyAllowed, 'tip', () => 0)).toBeNull();
  });
});

describe('orderServers', () => {
  it('mesh-reached nodes come first, API bases after, deduplicated on the mesh base', () => {
    // MESH_INTERFACE → The client's node list → "The client's order for
    // a need" — every node the need allows reached over the mesh, the
    // fast set first, then the API bases of the entries it allows, in
    // the same order; duplicates dropped.
    const nodes: OrderCandidate[] = [
      ocand(idA, { status: 'ok', meshUsable: true, readMs: 10, api: 'https://a.example' }),
      ocand(idB, { status: 'ok', meshUsable: false, api: 'https://b.example' }),
      ocand(idC, { status: 'ok', meshUsable: true, readMs: 15, api: null }),
    ];
    const order = orderServers(nodes, 'tip', true);
    expect(order).toEqual([
      `notis-mesh://${idA}`,
      `notis-mesh://${idC}`,
      'https://b.example',
    ]);
  });

  it('the fast set comes first; slower mesh nodes after', () => {
    // A (readMs 10), B (readMs 100) — bound is 2*10+50=70, so B is
    // outside the fast set but still mesh-reached. The fast node is
    // first, then the slow one.
    const nodes: OrderCandidate[] = [
      ocand(idA, { status: 'ok', meshUsable: true, readMs: 10 }),
      ocand(idB, { status: 'ok', meshUsable: true, readMs: 100 }),
    ];
    expect(orderServers(nodes, 'tip', true)).toEqual([
      `notis-mesh://${idA}`,
      `notis-mesh://${idB}`,
    ]);
  });

  it('an older read picks ok or trailing; behind nodes are refused', () => {
    const nodes: OrderCandidate[] = [
      ocand(idA, { status: 'ok', meshUsable: true, readMs: 10, api: 'https://a.example' }),
      ocand(idB, { status: 'trailing', meshUsable: true, readMs: 15, api: 'https://b.example' }),
      ocand(idC, { status: 'behind', meshUsable: true, readMs: 20, api: 'https://c.example' }),
    ];
    const older = orderServers(nodes, 'older', true);
    expect(older).toEqual([
      `notis-mesh://${idA}`,
      `notis-mesh://${idB}`,
    ]);
    // A tip read: trailing is not allowed either — so neither B nor
    // its api is in the order.
    const tip = orderServers(nodes, 'tip', true);
    expect(tip).toEqual([`notis-mesh://${idA}`]);
  });

  it('before the first check ends, every first-contact node serves any need; others do not', () => {
    // MESH_INTERFACE → The client's node list → "Before the first check
    // ends a node the client started from serves any need". Another node's status alone
    // would allow nothing — until a check reads it.
    const nodes: OrderCandidate[] = [
      ocand(idA, { status: 'new', meshUsable: true, firstContact: true, api: 'https://a.example' }),
      ocand(idB, { status: 'new', meshUsable: false, firstContact: true, api: 'https://b.example' }),
      ocand(idC, { status: 'new', meshUsable: true, firstContact: false, api: 'https://c.example' }),
    ];
    // Mesh first-contact node first (its meshBase), API-only one at its base,
    // the other dropped.
    expect(orderServers(nodes, 'tip', false)).toEqual([
      `notis-mesh://${idA}`,
      'https://b.example',
    ]);
  });

  it('a blacklisted first-contact node is never in the order, at any stage', () => {
    // MESH_INTERFACE → The client's node list → "Candidates" — a
    // `blacklisted` node is never one, the before-first-check branch
    // honours this too; and a blacklisted node is not need-allowed in
    // the after-first-check branch.
    const nodes: OrderCandidate[] = [
      ocand(idA, { status: 'blacklisted', meshUsable: true, firstContact: true, api: 'https://a.example' }),
      ocand(idB, { status: 'ok', meshUsable: true, firstContact: true, api: 'https://b.example' }),
    ];
    expect(orderServers(nodes, 'tip', false)).toEqual([`notis-mesh://${idB}`]);
    expect(orderServers(nodes, 'tip', true)).toEqual([`notis-mesh://${idB}`]);
  });
});
