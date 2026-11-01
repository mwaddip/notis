// MESH_INTERFACE → Discovery / NAT — pure config.json variants a scenario
// writes beside the stage's own file: a private node reached through a
// public relay, and the stage's anchors plus hostile seeds.

import { describe, expect, it } from 'vitest';
import {
  buildPrivateViaRelayVariant,
  buildWithHostileSeedsVariant,
  buildHostileSeeds,
} from '../stage/lib/config-variants.mjs';

const BASE_CONFIG = {
  network: 'devnet',
  anchors: [
    { notisId: 'aa'.repeat(32), addrs: ['/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/CHASH1/p2p/PUB1PEER'] },
    { notisId: 'bb'.repeat(32), addrs: ['/ip4/10.100.0.12/udp/4001/webrtc-direct/certhash/CHASH2/p2p/PUB2PEER'] },
  ],
  seeds: [],
};

describe('buildPrivateViaRelayVariant', () => {
  it('builds priv1-via-pub1 relay multiaddr from the base config', () => {
    const r = buildPrivateViaRelayVariant(BASE_CONFIG, {
      privNotisId: 'ff'.repeat(32),
      privPeerIdString: 'PRIV1PEER',
      viaPublicNotisId: 'aa'.repeat(32),
    });
    expect(r.network).toBe('devnet');
    expect(r.anchors.length).toBe(1);
    expect(r.anchors[0]!.notisId).toBe('ff'.repeat(32));
    expect(r.anchors[0]!.addrs[0]).toBe('/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/CHASH1/p2p/PUB1PEER/p2p-circuit/p2p/PRIV1PEER');
    expect(r.seeds).toEqual([]);
    // MESH_INTERFACE → NAT → "A client's STUN list comes from the
    // public nodes it holds" — the variant writes no `stunServers`
    // key; the client derives its list from its node entries.
    expect('stunServers' in r).toBe(false);
  });

  it('refuses a base config that does not name the via public anchor', () => {
    expect(() => buildPrivateViaRelayVariant(BASE_CONFIG, {
      privNotisId: 'ff'.repeat(32),
      privPeerIdString: 'PRIV1PEER',
      viaPublicNotisId: 'cc'.repeat(32),
    })).toThrow(/does not name the public anchor/);
  });

  it('refuses a public anchor whose addresses have no webrtc-direct', () => {
    const noWebrtc = { ...BASE_CONFIG, anchors: [{ notisId: 'aa'.repeat(32), addrs: ['/ip4/10.100.0.11/tcp/443/tls/ws/p2p/PUB1PEER'] }] };
    expect(() => buildPrivateViaRelayVariant(noWebrtc, {
      privNotisId: 'ff'.repeat(32),
      privPeerIdString: 'PRIV1PEER',
      viaPublicNotisId: 'aa'.repeat(32),
    })).toThrow(/no \/webrtc-direct\/ multiaddr/);
  });
});

describe('buildWithHostileSeedsVariant', () => {
  it('keeps anchors and appends the given seeds', () => {
    const seeds = [{ notisId: 'cc'.repeat(32), addrs: ['/ip4/10.100.0.31/tcp/4002/p2p/HM'] }];
    const r = buildWithHostileSeedsVariant(BASE_CONFIG, seeds);
    expect(r.anchors.length).toBe(2);
    expect(r.seeds).toEqual(seeds);
  });

  it('refuses a null base config', () => {
    expect(() => buildWithHostileSeedsVariant(null as unknown as typeof BASE_CONFIG, [])).toThrow();
  });
});

describe('buildHostileSeeds', () => {
  const TOPOLOGY = {
    hosts: {
      'hostile-malformed': { role: 'hostile', addr: '10.100.0.31', mesh: { role: 'private', tcpPort: 4002 }, node: { p2pPort: 9100 } },
      'hostile-invalid': { role: 'hostile', addr: '10.100.0.32', mesh: { role: 'private', tcpPort: 4002 }, node: { p2pPort: 9100 } },
      'hostile-lagging': { role: 'hostile', addr: '10.100.0.33', mesh: { role: 'private', tcpPort: 4002 }, node: { p2pPort: 9100 } },
      pub1: { role: 'public', addr: '10.100.0.11', mesh: { role: 'public', tcpPort: 4002 } },
    },
  };
  const IDENTITIES = {
    'hostile-malformed': { notisId: 'cc'.repeat(32) },
    'hostile-invalid': { notisId: 'dd'.repeat(32) },
    'hostile-lagging': { notisId: 'ee'.repeat(32) },
    pub1: { notisId: 'aa'.repeat(32) },
  };
  const fakePeerIdOf = (notisId: string): string => `peer-${notisId.slice(0, 8)}`;

  it('builds one seed per hostile host, IP + tcp port + peer id', () => {
    const seeds = buildHostileSeeds(IDENTITIES, TOPOLOGY, { peerIdStringOf: fakePeerIdOf });
    expect(seeds.length).toBe(3);
    const malformed = seeds.find((s) => s.notisId === 'cc'.repeat(32))!;
    expect(malformed.addrs[0]).toBe('/ip4/10.100.0.31/tcp/4002/p2p/peer-cccccccc');
  });

  it('skips a public host', () => {
    const seeds = buildHostileSeeds(IDENTITIES, TOPOLOGY, { peerIdStringOf: fakePeerIdOf });
    expect(seeds.find((s) => s.notisId === 'aa'.repeat(32)), 'pub1 is not a seed').toBeUndefined();
  });

  it('empty / null inputs → empty list', () => {
    expect(buildHostileSeeds(null, TOPOLOGY, { peerIdStringOf: fakePeerIdOf })).toEqual([]);
    expect(buildHostileSeeds(IDENTITIES, null, { peerIdStringOf: fakePeerIdOf })).toEqual([]);
  });
});
