import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/db.js';
import { loadAllPeers, putPeer } from '../../src/store/peers.js';
import { MAX_CAPABILITY_CODE } from '@dagsocial/net';

describe('loadAllPeers', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  it('skips a row whose capabilities contain an out-of-bound code', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO peers (address, last_seen_ms, agent_name, node_name, protocol_version, capabilities)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('/ip4/1.2.3.4/tcp/5000', 1000, 'agent', 'node', 1, JSON.stringify([1, MAX_CAPABILITY_CODE + 1]));

    db.prepare(
      `INSERT INTO peers (address, last_seen_ms, agent_name, node_name, protocol_version, capabilities)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('/ip4/5.6.7.8/tcp/5001', 2000, 'agent2', 'node2', 1, JSON.stringify([0, 100]));

    const peers = loadAllPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.address).toBe('/ip4/5.6.7.8/tcp/5001');
  });

  it('skips a row whose capabilities contain a negative code', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO peers (address, last_seen_ms, agent_name, node_name, protocol_version, capabilities)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('/ip4/1.2.3.4/tcp/5000', 1000, 'agent', 'node', 1, JSON.stringify([-1, 5]));

    expect(loadAllPeers()).toHaveLength(0);
  });

  it('accepts a row whose capabilities are all within [0, MAX_CAPABILITY_CODE]', () => {
    putPeer({
      address: '/ip4/1.2.3.4/tcp/5000',
      lastSeenMs: 1000,
      agentName: 'agent',
      nodeName: 'node',
      protocolVersion: 1,
      capabilities: [0, MAX_CAPABILITY_CODE],
    });

    const peers = loadAllPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.capabilities).toEqual([0, MAX_CAPABILITY_CODE]);
  });
});
