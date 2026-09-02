import { describe, it, expect, beforeEach } from 'vitest';
import { PeerDb } from '@dagsocial/net';
import type { PeerRecord, PeerStorage } from '@dagsocial/net';

function makeRecord(addr: string, lastSeenMs: number): PeerRecord {
  return {
    address: addr,
    lastSeenMs,
    agentName: 'test',
    nodeName: addr,
    protocolVersion: 1,
    capabilities: [],
  };
}

describe('PeerDb', () => {
  let db: PeerDb;

  beforeEach(() => {
    db = new PeerDb(null, 100, []);
  });

  it('records and retrieves a peer', () => {
    const rec = makeRecord('/ip4/1.2.3.4/tcp/9000', 1000);
    db.record(rec);
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toEqual(rec);
    expect(db.count()).toBe(1);
  });

  it('merges lastSeenMs on duplicate', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 500)); // older — should keep 1000
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(1000);

    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 2000)); // newer
    expect(db.get('/ip4/1.2.3.4/tcp/9000')!.lastSeenMs).toBe(2000);
  });

  it('forgets a peer', () => {
    db.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    db.forget('/ip4/1.2.3.4/tcp/9000');
    expect(db.get('/ip4/1.2.3.4/tcp/9000')).toBeNull();
    expect(db.count()).toBe(0);
  });

  it('filters self addresses', () => {
    const selfDb = new PeerDb(null, 100, ['/ip4/127.0.0.1/tcp/9000']);
    selfDb.record(makeRecord('/ip4/127.0.0.1/tcp/9000', 1000));
    selfDb.record(makeRecord('/ip4/1.2.3.4/tcp/9000', 1000));
    expect(selfDb.count()).toBe(1);
    expect(selfDb.get('/ip4/1.2.3.4/tcp/9000')).not.toBeNull();
  });

  it('evicts oldest on overflow', () => {
    const smallDb = new PeerDb(null, 3, []);
    smallDb.record(makeRecord('a', 1000));
    smallDb.record(makeRecord('b', 2000));
    smallDb.record(makeRecord('c', 3000));
    smallDb.record(makeRecord('d', 4000)); // evicts 'a' (oldest)
    expect(smallDb.count()).toBe(3);
    expect(smallDb.get('a')).toBeNull();
    expect(smallDb.get('d')).not.toBeNull();
  });

  it('evicted entry is not persisted to storage', () => {
    const stored: PeerRecord[] = [];
    const storage = {
      loadAll: () => stored,
      put: (rec: PeerRecord) => {
        const idx = stored.findIndex((r) => r.address === rec.address);
        if (idx >= 0) stored[idx] = rec;
        else stored.push(rec);
      },
      delete: (addr: string) => {
        const idx = stored.findIndex((r) => r.address === addr);
        if (idx >= 0) stored.splice(idx, 1);
      },
    };
    const cap1Db = new PeerDb(storage, 1, []);
    cap1Db.record(makeRecord('a', 1000));
    cap1Db.record(makeRecord('b', 500)); // older — should be evicted and NOT persisted

    expect(cap1Db.count()).toBe(1);
    expect(cap1Db.all().map((r) => r.address)).toEqual(['a']);
    expect(stored.map((r) => r.address)).toEqual(['a']);
  });

  it('recent returns most recent excluding specified', () => {
    db.record(makeRecord('a', 1000));
    db.record(makeRecord('b', 2000));
    db.record(makeRecord('c', 3000));
    db.record(makeRecord('d', 4000));

    const recent = db.recent(2, new Set(['d']));
    expect(recent).toHaveLength(2);
    expect(recent[0]!.address).toBe('c');
    expect(recent[1]!.address).toBe('b');
  });

  // ---------------------------------------------------------------------
  // Addresses compare without their `/p2p/` component (NET_INTERFACE →
  // Outbound Manager → "Addresses compare without their `/p2p/`
  // component"; NET_INTERFACE → PeerDb).
  // ---------------------------------------------------------------------

  const PEER_ID = '12D3KooWKze1ug3uVs8EkynoWPGFY7GQKgT67VKMzvHVe3v6UhwV';

  it('recent excludes a candidate carrying /p2p/ when the exclude set holds its bare form', () => {
    db.record(makeRecord(`/ip4/1.2.3.4/tcp/9/p2p/${PEER_ID}`, 1000));
    db.record(makeRecord('/ip4/1.2.3.4/tcp/10', 900)); // control: different port

    const recent = db.recent(10, new Set(['/ip4/1.2.3.4/tcp/9']));
    expect(recent.map((r) => r.address)).toEqual(['/ip4/1.2.3.4/tcp/10']);
  });

  it('the self filter drops a record whose /p2p/ suffix differs from the self address, and the reverse', () => {
    const suffixedSelf = new PeerDb(null, 100, [`/ip4/1.2.3.4/tcp/9/p2p/${PEER_ID}`]);
    suffixedSelf.record(makeRecord('/ip4/1.2.3.4/tcp/9', 1000));
    expect(suffixedSelf.get('/ip4/1.2.3.4/tcp/9')).toBeNull();
    expect(suffixedSelf.count()).toBe(0);

    const bareSelf = new PeerDb(null, 100, ['/ip4/1.2.3.4/tcp/9']);
    bareSelf.record(makeRecord(`/ip4/1.2.3.4/tcp/9/p2p/${PEER_ID}`, 1000));
    expect(bareSelf.get(`/ip4/1.2.3.4/tcp/9/p2p/${PEER_ID}`)).toBeNull();
    expect(bareSelf.count()).toBe(0);
  });

  // ---------------------------------------------------------------------
  // The ban set compares without `/p2p/` (NET_INTERFACE → PeerDb — the
  // Blacklist filter bullet; NET_INTERFACE → Outbound Manager → "Addresses
  // compare without their `/p2p/` component").
  // ---------------------------------------------------------------------

  describe('the ban set compares without /p2p/', () => {
    /** Storage stub whose `delete` calls are recorded, in call order. */
    function makeRecordingStorage(): { storage: PeerStorage; deletes: string[] } {
      const stored: PeerRecord[] = [];
      const deletes: string[] = [];
      const storage: PeerStorage = {
        loadAll: () => stored,
        put: (rec) => {
          const idx = stored.findIndex((r) => r.address === rec.address);
          if (idx >= 0) stored[idx] = rec;
          else stored.push(rec);
        },
        delete: (addr) => {
          deletes.push(addr);
          const idx = stored.findIndex((r) => r.address === addr);
          if (idx >= 0) stored.splice(idx, 1);
        },
      };
      return { storage, deletes };
    }

    const BARE = '/ip4/1.2.3.4/tcp/9';
    const SUFFIXED = `${BARE}/p2p/${PEER_ID}`;

    it('banning the /p2p/ spelling evicts an entry recorded bare, deletes the bare key from storage, and bans both spellings', () => {
      const { storage, deletes } = makeRecordingStorage();
      const db = new PeerDb(storage, 100, []);
      db.record(makeRecord(BARE, 1000));

      db.ban(SUFFIXED);

      expect(db.get(BARE)).toBeNull();
      expect(db.recent(10, new Set())).toEqual([]);
      expect(db.all()).toEqual([]);
      expect(deletes).toContain(BARE);
      expect(db.isBanned(BARE)).toBe(true);
      expect(db.isBanned(SUFFIXED)).toBe(true);
      db.record(makeRecord(BARE, 2000));
      expect(db.get(BARE)).toBeNull();
      db.record(makeRecord(SUFFIXED, 2000));
      expect(db.get(SUFFIXED)).toBeNull();
    });

    it('banning the bare spelling evicts an entry recorded with /p2p/, deletes the /p2p/ key from storage, and bans both spellings', () => {
      const { storage, deletes } = makeRecordingStorage();
      const db = new PeerDb(storage, 100, []);
      db.record(makeRecord(SUFFIXED, 1000));

      db.ban(BARE);

      expect(db.get(SUFFIXED)).toBeNull();
      expect(db.recent(10, new Set())).toEqual([]);
      expect(db.all()).toEqual([]);
      expect(deletes).toContain(SUFFIXED);
      expect(db.isBanned(BARE)).toBe(true);
      expect(db.isBanned(SUFFIXED)).toBe(true);
      db.record(makeRecord(BARE, 2000));
      expect(db.get(BARE)).toBeNull();
      db.record(makeRecord(SUFFIXED, 2000));
      expect(db.get(SUFFIXED)).toBeNull();
    });

    it('unban of either spelling lifts both, and a later record is admitted', () => {
      const db = new PeerDb(null, 100, []);

      db.ban(SUFFIXED);
      db.unban(BARE);
      expect(db.isBanned(BARE)).toBe(false);
      expect(db.isBanned(SUFFIXED)).toBe(false);
      db.record(makeRecord(BARE, 1000));
      expect(db.get(BARE)).not.toBeNull();

      db.ban(BARE);
      db.unban(SUFFIXED);
      expect(db.isBanned(BARE)).toBe(false);
      expect(db.isBanned(SUFFIXED)).toBe(false);
      db.record(makeRecord(SUFFIXED, 1000));
      expect(db.get(SUFFIXED)).not.toBeNull();
    });

    it('control: a record on another port survives a ban of either spelling', () => {
      const db = new PeerDb(null, 100, []);
      const other = '/ip4/1.2.3.4/tcp/10';
      db.record(makeRecord(other, 1000));

      db.ban(SUFFIXED);
      expect(db.get(other)).not.toBeNull();

      db.ban(BARE);
      expect(db.get(other)).not.toBeNull();
    });
  });
});
