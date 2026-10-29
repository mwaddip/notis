// MESH_INTERFACE → The client's node list, → No anchor reached, → Discovery
// (anchors: duplicates and the client's own key).
//
// NET_INTERFACE → Handshake → "Ban policy" is the split the client's list
// mirrors: a frame-tier failure (nothing proven about the peer) earns no
// penalty — a retry at growing intervals, never permanent; a body-tier
// failure (a lie, authenticated to the key) is permanent with its evidence.

import { describe, it, expect } from 'vitest';
import {
  NodeList,
  type Anchor,
  type FailureKind,
  type LieEvidence,
} from '../src/client/node-list.js';
import { MeshKeyError } from '../src/identity.js';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../src/protocols.js';

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const idC = 'c'.repeat(64);
const own = '0'.repeat(63) + '1';

const a1 = '/ip4/1.1.1.1/tcp/1';
const a2 = '/ip4/2.2.2.2/tcp/1';
const a3 = '/ip4/3.3.3.3/tcp/1';

describe('node-list', () => {
  it('no answer never blacklists', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
    const kinds: FailureKind[] = ['timeout', 'refused', 'dropped', 'transport'];
    for (const k of kinds) {
      for (let i = 0; i < 100; i++) list.failure(idA, k);
    }
    const e = list.entry(idA);
    expect(e).toBeDefined();
    expect(e!.status).toBe('retry');
    expect(e!.failures).toBe(400);
  });

  it('retry intervals double to the cap', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(5000);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(10000);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(20000);
    for (let i = 0; i < 5; i++) list.failure(idA, 'timeout'); // 8 total
    expect(list.entry(idA)!.failures).toBe(8);
    expect(list.entry(idA)!.retryAtMs - t).toBe(600000);
    for (let i = 0; i < 4; i++) list.failure(idA, 'timeout'); // 12 total
    expect(list.entry(idA)!.failures).toBe(12);
    expect(list.entry(idA)!.retryAtMs - t).toBe(600000);
  });

  it('a success clears the count', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t);
    list.failure(idA, 'timeout');
    list.failure(idA, 'timeout');
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.failures).toBe(3);
    list.success(idA);
    expect(list.entry(idA)!.failures).toBe(0);
    expect(list.entry(idA)!.status).toBe('ok');
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.failures).toBe(1);
    expect(list.entry(idA)!.retryAtMs - t).toBe(5000);
  });

  it('a lie is permanent and keeps its evidence', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
    const ev: LieEvidence = { kind: 'malformed', atMs: 1000, detail: 'bad bytes' };
    list.lie(idA, ev);
    expect(list.entry(idA)!.status).toBe('blacklisted');
    expect(list.entry(idA)!.evidence).toEqual(ev);
    list.success(idA);
    list.add(idA, [a2]);
    const after: LieEvidence = { kind: 'proof-invalid', atMs: 9000, detail: 'replaced' };
    list.lie(idA, after);
    expect(list.entry(idA)!.status).toBe('blacklisted');
    expect(list.entry(idA)!.evidence).toEqual(ev);
    expect(list.candidates()).not.toContain(idA);
  });

  it('a wrong key drops that address only', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1, a2] }], own, () => 0);
    const before = list.entry(idA)!;
    list.wrongKey(idA, a1, idB);
    const e = list.entry(idA)!;
    expect(e.droppedAddrs).toContain(a1);
    expect(e.addrs).not.toContain(a1);
    expect(e.addrs).toContain(a2);
    expect(e.status).toBe(before.status);
    expect(e.failures).toBe(before.failures);
    // `add` never brings a dropped address back.
    list.add(idA, [a1, a3]);
    const after = list.entry(idA)!;
    expect(after.addrs).not.toContain(a1);
    expect(after.addrs).toContain(a3);
    expect(after.droppedAddrs).toContain(a1);
  });

  it('behind ranks below ok', () => {
    const list = new NodeList(
      [
        { notisId: idA, addrs: [] },
        { notisId: idB, addrs: [] },
      ],
      own,
      () => 0,
    );
    list.behind(idB);
    list.success(idA);
    expect(list.candidates()).toEqual([idA, idB]);
  });

  it('a changed address revives an anchor', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1, a2] }], own, () => 0);
    list.wrongKey(idA, a1, idB);
    list.wrongKey(idA, a2, idB);
    list.failure(idA, 'transport');
    expect(list.entry(idA)!.status).toBe('retry');
    expect(list.entry(idA)!.evidence).toBeNull();
    list.add(idA, [a3]);
    list.success(idA);
    const e = list.entry(idA)!;
    expect(e.status).toBe('ok');
    expect(e.evidence).toBeNull();
    expect(e.addrs).toEqual([a3]);
    expect(e.droppedAddrs).toEqual([a1, a2]);
  });

  it('a clock that steps back does not hold a node out', () => {
    let t = 1_000_000;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS);
    t = 1_000_000 - 3_600_000; // step back 1 h
    const wait = list.entry(idA)!.retryAtMs - t;
    expect(wait).toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(wait).toBeGreaterThanOrEqual(0);
  });

  it("the client's own key is dropped and duplicate anchors are merged", () => {
    const anchors: Anchor[] = [
      { notisId: idA, addrs: [a1] },
      { notisId: idA, addrs: [a2] },
      { notisId: own, addrs: [a3] },
    ];
    const list = new NodeList(anchors, own, () => 0);
    const es = list.entries();
    expect(es.length).toBe(1);
    expect(es[0]!.notisId).toBe(idA);
    expect(es[0]!.anchor).toBe(true);
    expect(es[0]!.addrs).toEqual([a1, a2]);
    expect(list.entry(own)).toBeUndefined();
  });

  it("anchorReached follows the anchors' latest event", () => {
    const list = new NodeList(
      [
        { notisId: idA, addrs: [] },
        { notisId: idB, addrs: [] },
      ],
      own,
      () => 0,
    );
    expect(list.anchorReached()).toBe(false);
    list.success(idA);
    expect(list.anchorReached()).toBe(true);
    list.failure(idA, 'timeout');
    expect(list.anchorReached()).toBe(false);
    list.success(idB);
    expect(list.anchorReached()).toBe(true);
    list.lie(idB, { kind: 'malformed', atMs: 1, detail: 'x' });
    expect(list.anchorReached()).toBe(false);
  });

  it('an id that is not 64 lowercase hex is refused', () => {
    const bad = 'AB'.repeat(32);
    const tooShort = 'ab'.repeat(31);
    expect(() => new NodeList([{ notisId: bad, addrs: [] }], own, () => 0)).toThrow(MeshKeyError);
    expect(() => new NodeList([{ notisId: tooShort, addrs: [] }], own, () => 0)).toThrow(MeshKeyError);
    expect(() => new NodeList([], bad, () => 0)).toThrow(MeshKeyError);
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => 0);
    expect(() => list.add(bad, [])).toThrow(MeshKeyError);
    expect(() => list.success(bad)).toThrow(MeshKeyError);
    expect(() => list.failure(bad, 'timeout')).toThrow(MeshKeyError);
    expect(() => list.behind(bad)).toThrow(MeshKeyError);
    expect(() => list.wrongKey(bad, a1, null)).toThrow(MeshKeyError);
    expect(() => list.lie(bad, { kind: 'malformed', atMs: 0, detail: 'x' })).toThrow(MeshKeyError);
  });

  it('an anchor that answers behind is reached', () => {
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => 0);
    expect(list.anchorReached()).toBe(false);
    list.behind(idA);
    expect(list.anchorReached()).toBe(true);
  });

  it('candidates() keeps first-known order inside a status', () => {
    const list = new NodeList([], own, () => 0);
    list.add(idB, []);
    list.add(idA, []);
    list.add(idC, []);
    list.success(idA);
    list.success(idB);
    list.success(idC);
    expect(list.candidates()).toEqual([idB, idA, idC]);
  });

  it('a retry whose time has not come is not a candidate, and is once it has', () => {
    let t = 1000;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t);
    list.failure(idA, 'timeout');
    // Stored retry at t + 5000 = 6000; now 1000 → not a candidate.
    expect(list.candidates()).not.toContain(idA);
    t = 5999;
    expect(list.candidates()).not.toContain(idA);
    t = 6000;
    expect(list.candidates()).toContain(idA);
  });
});
