// MESH_INTERFACE → The client's node list, → Discovery
// → "First contact" (duplicates and the client's own key).
//
// NET_INTERFACE → Handshake → "Ban policy" is the split the client's list
// mirrors: a frame-tier failure (nothing proven about the peer) earns no
// penalty — a retry at growing intervals, never permanent; a body-tier
// failure (a lie, authenticated to the key) is permanent with its evidence.

import { describe, it, expect } from 'vitest';
import {
  NodeList,
  type MeshContact,
  type FailureKind,
  type LieEvidence,
} from '../../src/mesh/node-list.js';
import { MeshKeyError } from '@dagsocial/net/browser';
import { RETRY_BASE_MS, RETRY_CAP_MS } from '../../src/mesh/protocols.js';

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const idC = 'c'.repeat(64);
const own = '0'.repeat(63) + '1';

const a1 = '/ip4/1.1.1.1/tcp/1';
const a2 = '/ip4/2.2.2.2/tcp/1';
const a3 = '/ip4/3.3.3.3/tcp/1';

describe('node-list', () => {
  it('no answer never blacklists', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
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
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS / 2);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS * 2);
    for (let i = 0; i < 5; i++) list.failure(idA, 'timeout'); // 8 total
    expect(list.entry(idA)!.failures).toBe(8);
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_CAP_MS / 2);
    for (let i = 0; i < 4; i++) list.failure(idA, 'timeout'); // 12 total
    expect(list.entry(idA)!.failures).toBe(12);
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_CAP_MS / 2);
  });

  it('a success clears the count', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    list.failure(idA, 'timeout');
    list.failure(idA, 'timeout');
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.failures).toBe(3);
    list.success(idA);
    expect(list.entry(idA)!.failures).toBe(0);
    expect(list.entry(idA)!.status).toBe('ok');
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.failures).toBe(1);
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS / 2);
  });

  it('a lie is permanent and keeps its evidence', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
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
    const list = new NodeList([{ notisId: idA, addrs: [a1, a2] }], own, () => 0, () => 0);
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

  it('candidates order ok, trailing, behind, new, retry-due', () => {
    // MESH_INTERFACE → The client's node list → "Candidates" — the
    // one order every pick walks: `ok`, `trailing`, `behind`, nodes
    // not yet tried, then `retry` nodes whose time has come.
    let t = 100000;
    const idD = 'd'.repeat(64);
    const idE = 'e'.repeat(64);
    const list = new NodeList(
      [
        { notisId: idA, addrs: [] },
        { notisId: idB, addrs: [] },
        { notisId: idC, addrs: [] },
        { notisId: idD, addrs: [] },
        { notisId: idE, addrs: [] },
      ],
      own,
      () => t,
      () => 1 - 1e-12,
    );
    list.success(idA);
    list.trailing(idB);
    list.behind(idC);
    // idD is 'new' (never a success/failure call).
    list.failure(idE, 'timeout');
    // idE's drawn retry lands just under t + RETRY_BASE_MS — stored
    // just under 105000; step well past.
    t = 110000;
    expect(list.candidates()).toEqual([idA, idB, idC, idD, idE]);
  });

  it('a hand-added trusted node carries `yours`; untrusted does not', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" / "Your node
    // takes precedence" — the reader's trust assertion lands on `yours`.
    // `firstContact` is unchanged by `addByHand`: a new entry has it
    // `false`; a build node already in the list keeps it `true`.
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([], own, () => 0, () => 0);
    list.addByHand(idA, [addr], true);
    const trustedEntry = list.entry(idA)!;
    expect(trustedEntry.firstContact).toBe(false);
    expect(trustedEntry.byHand).toBe(true);
    expect(trustedEntry.yours).toBe(true);
    expect(trustedEntry.addrs).toEqual([addr]);
    expect(list.configuredAddrs(idA)).toEqual([addr]);

    const addr2 = '/ip4/10.0.0.2/udp/4001/webrtc-direct/certhash/uEiB';
    list.addByHand(idB, [addr2], false);
    const untrustedEntry = list.entry(idB)!;
    expect(untrustedEntry.firstContact).toBe(false);
    expect(untrustedEntry.byHand).toBe(true);
    expect(untrustedEntry.yours).toBe(false);
    expect(untrustedEntry.addrs).toEqual([addr2]);
    expect(list.configuredAddrs(idB)).toEqual([addr2]);

    // A build node (`firstContact: true`) marked by hand stays
    // `firstContact: true`, `yours` follows the latest trusted value.
    const addr3 = '/ip4/10.0.0.3/udp/4001/webrtc-direct/certhash/uEiC';
    const list3 = new NodeList([{ notisId: idC, addrs: [] }], own, () => 0, () => 0);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    list3.addByHand(idC, [addr3], true);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    expect(list3.entry(idC)!.yours).toBe(true);
    list3.addByHand(idC, [addr3], false);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    expect(list3.entry(idC)!.yours).toBe(false);
  });

  it('removeByHand deletes an entry added by hand alone', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" — a
    // hand-only entry (`byHand && !fromFirstContactList`) is deleted,
    // so its addresses no longer in the list and the gater refuses
    // the private one the reader entered next dial.
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([], own, () => 0, () => 0);
    list.addByHand(idA, [addr], true);
    expect(list.entry(idA)).toBeDefined();
    expect(list.configuredAddrs(idA)).toEqual([addr]);
    list.removeByHand(idA);
    expect(list.entry(idA)).toBeUndefined();
    expect(list.configuredAddrs(idA)).toEqual([]);
  });

  it('removeByHand leaves a first-contact entry in place, no longer yours', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" — an entry
    // the first-contact list named stays after `removeByHand`, with
    // `yours = false` and `byHand = false`; `configuredAddrs` still
    // answers the build addresses.
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
    list.addByHand(idA, [], true);
    expect(list.entry(idA)!.yours).toBe(true);
    expect(list.entry(idA)!.byHand).toBe(true);
    expect(list.entry(idA)!.firstContact).toBe(true);
    list.removeByHand(idA);
    const after = list.entry(idA)!;
    expect(after.yours).toBe(false);
    expect(after.byHand).toBe(false);
    expect(after.firstContact).toBe(true);
    expect(after.addrs).toEqual([a1]);
    expect(list.configuredAddrs(idA)).toEqual([a1]);
  });

  it('a hand-added node caught lying is blacklisted and leaves the candidate set', () => {
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([], own, () => 0, () => 0);
    list.addByHand(idA, [addr], true);
    list.success(idA);
    expect(list.entry(idA)!.yours).toBe(true);
    list.lie(idA, { kind: 'malformed', atMs: 1, detail: 'bad' });
    expect(list.entry(idA)!.status).toBe('blacklisted');
    expect(list.candidates()).not.toContain(idA);
    // A later addByHand on a blacklisted entry is unchanged.
    const addr2 = '/ip4/10.0.0.2/udp/4001/webrtc-direct/certhash/uEiB';
    list.addByHand(idA, [addr2], true);
    const after = list.entry(idA)!;
    expect(after.status).toBe('blacklisted');
    expect(after.addrs).toEqual([addr]);
    expect(list.configuredAddrs(idA)).toEqual([addr]);
  });

  it('a changed address revives a first-contact node', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1, a2] }], own, () => 0, () => 0);
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
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t).toBe(RETRY_BASE_MS / 2);
    t = 1_000_000 - 3_600_000; // step back 1 h
    const wait = list.entry(idA)!.retryAtMs - t;
    expect(wait).toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(wait).toBeGreaterThanOrEqual(0);
  });

  it("the client's own key is dropped and duplicate first-contact entries are merged", () => {
    const firstContact: MeshContact[] = [
      { notisId: idA, addrs: [a1] },
      { notisId: idA, addrs: [a2] },
      { notisId: own, addrs: [a3] },
    ];
    const list = new NodeList(firstContact, own, () => 0, () => 0);
    const es = list.entries();
    expect(es.length).toBe(1);
    expect(es[0]!.notisId).toBe(idA);
    expect(es[0]!.firstContact).toBe(true);
    expect(es[0]!.addrs).toEqual([a1, a2]);
    expect(list.entry(own)).toBeUndefined();
  });

  it('an id that is not 64 lowercase hex is refused', () => {
    const bad = 'AB'.repeat(32);
    const tooShort = 'ab'.repeat(31);
    expect(() => new NodeList([{ notisId: bad, addrs: [] }], own, () => 0, () => 0)).toThrow(MeshKeyError);
    expect(() => new NodeList([{ notisId: tooShort, addrs: [] }], own, () => 0, () => 0)).toThrow(MeshKeyError);
    expect(() => new NodeList([], bad, () => 0, () => 0)).toThrow(MeshKeyError);
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => 0, () => 0);
    expect(() => list.add(bad, [])).toThrow(MeshKeyError);
    expect(() => list.success(bad)).toThrow(MeshKeyError);
    expect(() => list.failure(bad, 'timeout')).toThrow(MeshKeyError);
    expect(() => list.behind(bad)).toThrow(MeshKeyError);
    expect(() => list.wrongKey(bad, a1, null)).toThrow(MeshKeyError);
    expect(() => list.lie(bad, { kind: 'malformed', atMs: 0, detail: 'x' })).toThrow(MeshKeyError);
  });

  it("a first-contact entry's api is kept on its entry; duplicate entries' first api stands", () => {
    // MESH_INTERFACE → The client's node list → "An entry may carry an
    // API base" — the entry's `api` lands on the entry and `entries()`
    // surfaces it; two entries with the same key keep the first api
    // (the pairing of a base with a key is the list's word).
    const list = new NodeList(
      [
        { notisId: idA, addrs: [a1], api: 'https://node.example' },
        { notisId: idA, addrs: [a2], api: 'https://other.example' },
        { notisId: idB, addrs: [], api: 'https://b.example' },
        { notisId: idC, addrs: [a3] },
      ],
      own,
      () => 0,
      () => 0,
    );
    expect(list.entry(idA)!.api).toBe('https://node.example');
    expect(list.entry(idA)!.addrs).toEqual([a1, a2]);
    expect(list.entry(idB)!.api).toBe('https://b.example');
    expect(list.entry(idB)!.addrs).toEqual([]);
    expect(list.entry(idC)!.api).toBeNull();
  });

  it('an entry added through `add` or `addByHand` has api null', () => {
    // MESH_INTERFACE → The client's node list — the api is the list's
    // own; DHT- or hand-added entries carry none.
    const list = new NodeList([], own, () => 0, () => 0);
    list.add(idA, [a1]);
    expect(list.entry(idA)!.api).toBeNull();
    const webrtc = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    list.addByHand(idB, [webrtc], true);
    expect(list.entry(idB)!.api).toBeNull();
  });

  it('candidates() keeps first-known order inside a status', () => {
    const list = new NodeList([], own, () => 0, () => 0);
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
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 1 - 1e-12);
    list.failure(idA, 'timeout');
    // Drawn retry just under t + RETRY_BASE_MS — stored just under 6000;
    // now 1000 → not a candidate.
    expect(list.candidates()).not.toContain(idA);
    t = 5999;
    expect(list.candidates()).not.toContain(idA);
    t = 6000;
    expect(list.candidates()).toContain(idA);
  });

  it('removeByHand on a pure hand-added entry removes it; on a build node it clears yours and byHand', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" — the settings
    // row's commit path. A hand-only entry is removed. A build node
    // marked by hand stays with `yours = false` and `byHand = false`.
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
    list.addByHand(idB, [a2], true);
    expect(list.entries().map((e) => e.notisId).sort()).toEqual([idA, idB].sort());
    expect(list.entry(idB)!.yours).toBe(true);
    list.removeByHand(idB);
    expect(list.entry(idB)).toBeUndefined();
    expect(list.entries().map((e) => e.notisId)).toEqual([idA]);
    // On a build node marked by hand: `yours` and `byHand` clear, the
    // entry stays.
    list.addByHand(idA, [a2], true);
    expect(list.entry(idA)!.yours).toBe(true);
    expect(list.entry(idA)!.byHand).toBe(true);
    list.removeByHand(idA);
    const after = list.entry(idA)!;
    expect(after.yours).toBe(false);
    expect(after.byHand).toBe(false);
    expect(list.entries().map((e) => e.notisId)).toEqual([idA]);
  });

  it('removeByHand on an id the list does not hold is a no-op', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
    list.removeByHand(idC);
    expect(list.entries().map((e) => e.notisId)).toEqual([idA]);
  });

  it('removeByHand refuses a non-64-hex id', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
    expect(() => list.removeByHand('abc')).toThrow(MeshKeyError);
  });

  it('an event for an id the list does not hold throws', () => {
    // Every correct caller sends an event only for an id it `add`ed or saw
    // through `candidates()`; an unknown id is a bug in the caller, so the
    // list throws rather than swallows. The two no-ops the contract keeps
    // apply only to a `blacklisted` entry (the lie is for good) and to `add`
    // on one (MESH_INTERFACE → The client's node list).
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0, () => 0);
    const unknown = idB; // valid 64-hex, not held
    const calls: Array<[string, () => void]> = [
      ['success', () => list.success(unknown)],
      ['failure', () => list.failure(unknown, 'timeout')],
      ['trailing', () => list.trailing(unknown)],
      ['behind', () => list.behind(unknown)],
      ['wrongKey', () => list.wrongKey(unknown, a1, null)],
      ['lie', () => list.lie(unknown, { kind: 'malformed', atMs: 0, detail: 'x' })],
    ];
    for (const [name, fn] of calls) {
      let thrown: unknown;
      try {
        fn();
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(MeshKeyError);
      expect((thrown as Error).message).toContain(name);
      expect((thrown as Error).message).toContain(unknown);
    }
  });

  // MESH_INTERFACE → The client's node list → "Retry" — the wait after
  // the n-th failure in a row is drawn uniformly between half and the
  // whole of `min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n − 1))`; the draw
  // spreads the clients that failed at one instant. The random source
  // is a required argument on the list's constructor.

  it('a random source at 0 answers half the schedule at n = 1, n = 2, and past the cap', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 1: at most RETRY_BASE_MS').toBeLessThanOrEqual(RETRY_BASE_MS);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 2: at most 2·RETRY_BASE_MS').toBeLessThanOrEqual(RETRY_BASE_MS * 2);
    // Drive the failure count past the cap — the schedule saturates
    // to RETRY_CAP_MS, half of which is RETRY_CAP_MS / 2.
    for (let i = 0; i < 20; i++) list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'past the cap: at most RETRY_CAP_MS').toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(list.entry(idA)!.retryAtMs - t, 'past the cap: half of RETRY_CAP_MS').toBe(RETRY_CAP_MS / 2);
  });

  it('a random source near 1 answers just under the whole schedule at n = 1, n = 2, and past the cap', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 1 - 1e-12);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 1: at least half').toBeGreaterThanOrEqual(RETRY_BASE_MS / 2);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 2: at least half').toBeGreaterThanOrEqual(RETRY_BASE_MS);
    for (let i = 0; i < 20; i++) list.failure(idA, 'timeout');
    const wCap = list.entry(idA)!.retryAtMs - t;
    expect(wCap, 'past the cap: at least half the cap').toBeGreaterThanOrEqual(RETRY_CAP_MS / 2);
    expect(wCap, 'past the cap: strictly less than the cap').toBeLessThan(RETRY_CAP_MS);
  });

  it('a random source at 0.5 answers three quarters of the schedule at n = 1, n = 2, and past the cap', () => {
    let t = 0;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0.5);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 1: at least half').toBeGreaterThanOrEqual(RETRY_BASE_MS / 2);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'n = 2: at least half').toBeGreaterThanOrEqual(RETRY_BASE_MS);
    for (let i = 0; i < 20; i++) list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'past the cap: at least half the cap').toBeGreaterThanOrEqual(RETRY_CAP_MS / 2);
    expect(list.entry(idA)!.retryAtMs - t, 'past the cap: three quarters of RETRY_CAP_MS').toBe((RETRY_CAP_MS * 3) / 4);
  });

  it('the clamp caps the exposed wait at RETRY_CAP_MS from the current clock when the clock steps back below the failure, with a drawn wait', () => {
    // The clamp (`clampedRetryAt`) reads `min(stored, now + RETRY_CAP_MS)`
    // when the clock has stepped back below the failure — a draw does
    // not change that. A big step-back lands below the clamp and the
    // exposed wait is `RETRY_CAP_MS` from `now`; a tiny step-back
    // leaves `stored` under the clamp and the exposed wait is the
    // drawn wait plus the step-back.
    let t = 1_000_000;
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    list.failure(idA, 'timeout');
    expect(list.entry(idA)!.retryAtMs - t, 'at failure: at most RETRY_BASE_MS').toBeLessThanOrEqual(RETRY_BASE_MS);
    t = 1_000_000 - 3_600_000; // step back 1 h; `now + RETRY_CAP_MS` sits well below `stored`
    const wBig = list.entry(idA)!.retryAtMs - t;
    expect(wBig, 'big step back: non-negative').toBeGreaterThanOrEqual(0);
    expect(wBig, 'big step back: the clamp caps at RETRY_CAP_MS from now').toBe(RETRY_CAP_MS);
    t = 1_000_000 - 10; // tiny step back; `stored` sits under the clamp
    const wSmall = list.entry(idA)!.retryAtMs - t;
    expect(wSmall, 'tiny step back: at most RETRY_CAP_MS').toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(wSmall, 'tiny step back: the drawn wait reaches the exposed view').toBe(RETRY_BASE_MS / 2 + 10);
  });

  it('two lists failed at one clock reading, each with its own random source, expose different retry times — the draw is per failure', () => {
    // The draw lands on the moment of the failure through the list's
    // random source, so two lists with different sources, failed at
    // one clock reading, hold two different stored waits.
    const t = 0;
    const listLo = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 0);
    const listHi = new NodeList([{ notisId: idA, addrs: [] }], own, () => t, () => 1 - 1e-12);
    listLo.failure(idA, 'timeout');
    listHi.failure(idA, 'timeout');
    const wLo = listLo.entry(idA)!.retryAtMs - t;
    const wHi = listHi.entry(idA)!.retryAtMs - t;
    expect(wLo, 'low source: at most RETRY_BASE_MS').toBeLessThanOrEqual(RETRY_BASE_MS);
    expect(wHi, 'high source: at most RETRY_BASE_MS').toBeLessThanOrEqual(RETRY_BASE_MS);
    expect(wHi, 'the draw is per failure: the two lists differ').not.toBe(wLo);
  });

  // MESH_INTERFACE → Discovery → "A node the access point answers" —
  // addLocal cases.
  const localAddr = '/ip4/10.78.79.1/udp/9733/webrtc-direct/certhash/uEiA/p2p/A';
  const localAddr2 = '/ip4/10.78.79.1/udp/9734/webrtc-direct/certhash/uEiB/p2p/A';

  it('addLocal adds a local candidate the gater allows for that key alone', () => {
    // A new entry carries `local: true`, `byHand: false`, `yours: false`,
    // `firstContact: false`, `known: false`; its addresses are in
    // `configured` for the key alone, not another key's.
    const list = new NodeList([], own, () => 0, () => 0);
    const added = list.addLocal(idA, [localAddr]);
    expect(added, 'addLocal answers true on a fresh key').toBe(true);
    const e = list.entry(idA)!;
    expect(e.local, 'the mark is set').toBe(true);
    expect(e.byHand, 'byHand stays false').toBe(false);
    expect(e.yours, 'yours stays false').toBe(false);
    expect(e.firstContact, 'firstContact stays false').toBe(false);
    expect(e.known, 'known stays false').toBe(false);
    expect(list.configuredAddrs(idA), 'the address passes the gater for this key').toEqual([localAddr]);
    expect(list.configuredAddrs(idB), "not for another key").toEqual([]);
  });

  it('addLocal merges addresses and sets the mark on an existing entry', () => {
    const list = new NodeList([{ notisId: idA, addrs: [localAddr] }], own, () => 0, () => 0);
    expect(list.entry(idA)!.local, 'a first-contact entry starts with local false').toBe(false);
    const added = list.addLocal(idA, [localAddr, localAddr2]);
    expect(added).toBe(true);
    const e = list.entry(idA)!;
    expect(e.local, 'the mark is set').toBe(true);
    expect(e.addrs, 'the new address is merged').toEqual([localAddr, localAddr2]);
    expect(list.configuredAddrs(idA), 'the new address joins configured').toEqual([localAddr, localAddr2]);
    expect(e.firstContact, 'firstContact is kept').toBe(true);
  });

  it('addLocal on a blacklisted entry changes nothing and answers false', () => {
    const list = new NodeList([{ notisId: idA, addrs: [localAddr] }], own, () => 0, () => 0);
    const evidence: LieEvidence = { kind: 'malformed', atMs: 0, detail: 'x' };
    list.lie(idA, evidence);
    const before = list.entry(idA)!;
    const answered = list.addLocal(idA, [localAddr2]);
    expect(answered, 'addLocal on a blacklisted entry answers false').toBe(false);
    const after = list.entry(idA)!;
    expect(after.status, 'a blacklisted entry stays blacklisted').toBe('blacklisted');
    expect(after.local, 'the mark is not set on a blacklisted entry').toBe(before.local);
    expect(after.addrs, 'no address is added').toEqual(before.addrs);
    expect(after.evidence, 'the evidence is kept').toEqual(evidence);
  });

  it('addLocal refuses the client\'s own key and answers false', () => {
    const list = new NodeList([], own, () => 0, () => 0);
    const answered = list.addLocal(own, [localAddr]);
    expect(answered, 'addLocal on the own key answers false').toBe(false);
    expect(list.entry(own), 'no entry is created for the own key').toBeUndefined();
  });

  it('addLocal refuses a non-64-hex id', () => {
    const list = new NodeList([], own, () => 0, () => 0);
    expect(() => list.addLocal('abc', [localAddr])).toThrow(MeshKeyError);
  });

  it('removeByHand leaves a local entry', () => {
    // `removeByHand` is the settings row's commit path, bound to the
    // hand-added arm; a local entry's `byHand` is false, so
    // `removeByHand` returns at its `!e.byHand` guard and leaves the
    // entry where it stood.
    const list = new NodeList([], own, () => 0, () => 0);
    list.addLocal(idA, [localAddr]);
    expect(list.entry(idA)).toBeDefined();
    list.removeByHand(idA);
    const after = list.entry(idA)!;
    expect(after, 'the local entry stays').toBeDefined();
    expect(after.local, 'the mark stays').toBe(true);
    expect(list.configuredAddrs(idA), 'the gater still allows the address').toEqual([localAddr]);
  });

  it("a failure recorded against one of a local entry's addresses leaves the entry, its mark and its other address", () => {
    // Review Focus 2 at the list's level: a node with two addresses is
    // dialled as one operation; a failure against one address alone
    // reads through `recordAddrFailure`, which leaves `addrs`,
    // `configured`, `local` and the entry's other address as they
    // were, and writes only `lastFailures[addr]`.
    const list = new NodeList([], own, () => 0, () => 0);
    list.addLocal(idA, [localAddr, localAddr2]);
    list.recordAddrFailure(idA, localAddr, 'transport', 'unreachable');
    const e = list.entry(idA)!;
    expect(e.local, 'the mark stays').toBe(true);
    expect(e.addrs, 'both addresses stay').toEqual([localAddr, localAddr2]);
    expect(list.configuredAddrs(idA), 'the gater still allows both').toEqual([localAddr, localAddr2]);
    expect(e.lastFailures[localAddr]?.kind, 'the per-address failure is recorded').toBe('transport');
    expect(e.lastFailures[localAddr2], 'the other address carries no failure').toBeUndefined();
  });

  it('addLocal answers false for an answer that changes nothing, true for a new address and for the mark on an existing entry', () => {
    // MESH_INTERFACE → Discovery → "A node the access point answers" —
    // "A check runs at once where the answer added the node, an address
    // or the mark"; an answer that changes nothing waits for the
    // check's own cadence. `addLocal` answers `true` only where it
    // changed the list.
    const list = new NodeList([], own, () => 0, () => 0);
    // Fresh entry → true (the new entry case).
    expect(list.addLocal(idA, [localAddr])).toBe(true);
    // Same addrs, mark already set → false (nothing changed).
    expect(list.addLocal(idA, [localAddr])).toBe(false);
    // A new address on an existing local entry → true.
    expect(list.addLocal(idA, [localAddr, localAddr2])).toBe(true);
    // Again with the same two addresses → false.
    expect(list.addLocal(idA, [localAddr, localAddr2])).toBe(false);
    // The mark newly set on a first-contact entry → true.
    const list2 = new NodeList([{ notisId: idB, addrs: [localAddr] }], own, () => 0, () => 0);
    expect(list2.entry(idB)!.local, 'first-contact starts with local false').toBe(false);
    expect(list2.addLocal(idB, [localAddr])).toBe(true);
    expect(list2.entry(idB)!.local, 'the mark is now set').toBe(true);
    // Same call again → the mark is already set and the address was
    // already known: nothing changes, false.
    expect(list2.addLocal(idB, [localAddr])).toBe(false);
  });
});
