import { describe, it, expect } from 'vitest';
import { PeerDb, MAX_CAPABILITY_CODE } from '@dagsocial/net';
import type { PeerRecord, PeerStorage } from '@dagsocial/net';

/**
 * The storage intake is the third way a row enters PeerDb, alongside
 * `validateHandshake` and `decodePeers` (NET_INTERFACE → Peers). Every entry
 * PeerDb holds is served verbatim through `recent()` into a `Peers` body, and
 * the receiver of that body applies `decodePeers`' bounds to each entry —
 * rejecting the whole body and permanently banning the sender on a single
 * out-of-domain field. A persisted row is therefore held to the same bounds as
 * a wire entry: what we cannot represent validly, we do not serve.
 */

const VALID: PeerRecord = {
  address: '/ip4/1.2.3.4/tcp/9000',
  lastSeenMs: 1000,
  agentName: 'notis',
  nodeName: 'alpha',
  protocolVersion: 1,
  capabilities: [1, 2],
};

/** A stored row with one field replaced by a value the type does not allow. */
function withField(field: string, value: unknown): PeerRecord {
  return { ...VALID, [field]: value } as unknown as PeerRecord;
}

function storageOf(...rows: PeerRecord[]): PeerStorage & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    loadAll: () => rows,
    put: () => {},
    delete: (addr: string) => {
      deleted.push(addr);
    },
  };
}

describe('PeerDb storage intake', () => {
  it('does not serve a persisted row whose capability is above MAX_CAPABILITY_CODE', () => {
    const storage = storageOf(withField('capabilities', [1, MAX_CAPABILITY_CODE + 1]));
    const db = new PeerDb(storage, 100, []);

    expect(db.recent(10, new Set())).toEqual([]);
    expect(db.count()).toBe(0);
  });

  it('loads a persisted row whose every field is in domain', () => {
    const db = new PeerDb(storageOf(VALID), 100, []);

    expect(db.recent(10, new Set())).toEqual([VALID]);
    expect(db.get(VALID.address)).toEqual(VALID);
  });

  it('drops only the out-of-domain row when a valid one sits beside it', () => {
    const bad = withField('address', '/ip4/5.6.7.8/tcp/9000');
    bad.protocolVersion = MAX_CAPABILITY_CODE + 1;
    const db = new PeerDb(storageOf(VALID, bad), 100, []);

    expect(db.recent(10, new Set()).map((r) => r.address)).toEqual([VALID.address]);
  });

  it('leaves a dropped row in storage rather than deleting it at construction', () => {
    const storage = storageOf(withField('capabilities', [-1]));
    new PeerDb(storage, 100, []);

    expect(storage.deleted).toEqual([]);
  });

  // Every field of PeerRecord, in the order the interface declares them. The
  // five wire fields carry the bounds `decodePeers` applies to the same names;
  // `lastSeenMs` never travels on the wire, so its bound is the one both
  // writers already satisfy by stamping a clock.
  const outOfDomain: Array<[string, unknown]> = [
    ['address', null],
    ['address', 42],
    ['lastSeenMs', null],
    ['lastSeenMs', Number.NaN],
    ['lastSeenMs', -1],
    ['agentName', null],
    ['agentName', 7],
    ['nodeName', null],
    ['nodeName', ['alpha']],
    ['protocolVersion', MAX_CAPABILITY_CODE + 1],
    ['protocolVersion', -1],
    ['protocolVersion', 1.5],
    ['protocolVersion', '1'],
    ['capabilities', null],
    ['capabilities', 'none'],
    ['capabilities', [-1]],
    ['capabilities', [1.5]],
    ['capabilities', ['1']],
  ];

  for (const [field, value] of outOfDomain) {
    it(`drops a persisted row whose ${field} is ${JSON.stringify(value) ?? String(value)}`, () => {
      const db = new PeerDb(storageOf(withField(field, value)), 100, []);
      expect(db.count()).toBe(0);
    });
  }

  it('drops a persisted entry that is not a record at all', () => {
    const db = new PeerDb(storageOf(null as unknown as PeerRecord), 100, []);
    expect(db.count()).toBe(0);
  });
});
