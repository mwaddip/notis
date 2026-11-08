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
    );
    list.success(idA);
    list.trailing(idB);
    list.behind(idC);
    // idD is 'new' (never a success/failure call).
    list.failure(idE, 'timeout');
    // idE's retry fires at t + RETRY_BASE_MS = 105000; step past.
    t = 110000;
    expect(list.candidates()).toEqual([idA, idB, idC, idD, idE]);
  });

  it('a hand-added trusted node carries `yours`; untrusted does not', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" / "Your node
    // takes precedence" — the reader's trust assertion lands on `yours`.
    // `firstContact` is unchanged by `addByHand`: a new entry has it
    // `false`; a build node already in the list keeps it `true`.
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([], own, () => 0);
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
    const list3 = new NodeList([{ notisId: idC, addrs: [] }], own, () => 0);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    list3.addByHand(idC, [addr3], true);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    expect(list3.entry(idC)!.yours).toBe(true);
    list3.addByHand(idC, [addr3], false);
    expect(list3.entry(idC)!.firstContact).toBe(true);
    expect(list3.entry(idC)!.yours).toBe(false);
  });

  it('removeByHand clears `yours` and leaves the entry in the list', () => {
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([{ notisId: idA, addrs: [] }], own, () => 0);
    list.addByHand(idA, [addr], true);
    expect(list.entry(idA)!.yours).toBe(true);
    expect(list.entry(idA)!.firstContact).toBe(true);
    list.removeByHand(idA);
    const after = list.entry(idA)!;
    expect(after.yours).toBe(false);
    // The entry stays; the build-list entry keeps its firstContact and byHand.
    expect(after.firstContact).toBe(true);
    expect(after.byHand).toBe(true);
    expect(after.addrs).toEqual([addr]);
  });

  it('a hand-added node caught lying is blacklisted and leaves the candidate set', () => {
    const addr = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    const list = new NodeList([], own, () => 0);
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

  it("the client's own key is dropped and duplicate first-contact entries are merged", () => {
    const firstContact: MeshContact[] = [
      { notisId: idA, addrs: [a1] },
      { notisId: idA, addrs: [a2] },
      { notisId: own, addrs: [a3] },
    ];
    const list = new NodeList(firstContact, own, () => 0);
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
    const list = new NodeList([], own, () => 0);
    list.add(idA, [a1]);
    expect(list.entry(idA)!.api).toBeNull();
    const webrtc = '/ip4/10.0.0.1/udp/4001/webrtc-direct/certhash/uEiA';
    list.addByHand(idB, [webrtc], true);
    expect(list.entry(idB)!.api).toBeNull();
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

  it('removeByHand clears `yours` on a hand-added entry and on a build node', () => {
    // MESH_INTERFACE → Discovery → "A node added by hand" — the settings
    // row's commit path. `removeByHand` clears `yours`; the entry stays in
    // the list, whether it was a build node or a pure hand-added one.
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
    list.addByHand(idB, [a2], true);
    expect(list.entries().map((e) => e.notisId).sort()).toEqual([idA, idB].sort());
    expect(list.entry(idB)!.yours).toBe(true);
    list.removeByHand(idB);
    expect(list.entry(idB)!.yours).toBe(false);
    expect(list.entries().map((e) => e.notisId).sort()).toEqual([idA, idB].sort());
    // On a build node marked by hand: `yours` clears, the entry stays.
    list.addByHand(idA, [a2], true);
    expect(list.entry(idA)!.yours).toBe(true);
    list.removeByHand(idA);
    expect(list.entry(idA)!.yours).toBe(false);
    expect(list.entries().map((e) => e.notisId).sort()).toEqual([idA, idB].sort());
  });

  it('removeByHand on an id the list does not hold is a no-op', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
    list.removeByHand(idC);
    expect(list.entries().map((e) => e.notisId)).toEqual([idA]);
  });

  it('removeByHand refuses a non-64-hex id', () => {
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
    expect(() => list.removeByHand('abc')).toThrow(MeshKeyError);
  });

  it('an event for an id the list does not hold throws', () => {
    // Every correct caller sends an event only for an id it `add`ed or saw
    // through `candidates()`; an unknown id is a bug in the caller, so the
    // list throws rather than swallows. The two no-ops the contract keeps
    // apply only to a `blacklisted` entry (the lie is for good) and to `add`
    // on one (MESH_INTERFACE → The client's node list).
    const list = new NodeList([{ notisId: idA, addrs: [a1] }], own, () => 0);
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
});
