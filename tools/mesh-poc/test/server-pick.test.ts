// MESH_INTERFACE → The client's node list → "A routed read goes to a
// node its need allows." A tip read goes to an `ok` node; an older
// read may go to an `ok` or `trailing` node; the fast set is each
// `usable` allowed node within `FAST_SET_FACTOR` times the fastest's
// `readMs` plus `FAST_SET_SLACK_MS`. First-check and all-failed cases,
// where no allowed node has a `readMs`, spread uniformly over the
// allowed.

import { describe, it, expect } from 'vitest';
import { pickServer, type PickCandidate } from '../src/client/server-pick.js';

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

describe('pickServer', () => {
  it.fails('a tip read picks only ok nodes', () => {
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

  it.fails('an older read may pick a trailing node', () => {
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

  it.fails('picks spread across the fast set', () => {
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

  it.fails('unknown readMs everywhere spreads uniformly over the allowed', () => {
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

  it.fails('an unusable node is never picked; none usable answers null', () => {
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
