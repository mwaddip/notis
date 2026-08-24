import { describe, it, expect } from 'vitest';
import {
  encodeGetPeers,
  decodeGetPeers,
  encodePeers,
  decodePeers,
  peersCodec,
} from '../src/sync-codec.js';
import { decodeFrame, MAGIC_MAINNET, MAGIC_TESTNET } from '../src/frame.js';
import { MSG_GET_PEERS, MSG_PEERS } from '../src/types.js';
import type { PeerEntryMsg } from '../src/types.js';
import {
  MAX_PEERS_ENTRIES,
  MAX_CAPABILITY_CODE,
  MAX_CAPABILITY_ENTRIES,
  MAX_NAME_BYTES,
  MAX_ADDRESS_BYTES,
} from '../src/msg-guards.js';
import { isBogusAddress } from '../src/bogus-addr.js';
import { encodeStruct } from '@dagsocial/types';

function entry(overrides: Partial<PeerEntryMsg> = {}): PeerEntryMsg {
  return {
    address: '/ip4/93.184.216.34/tcp/4001',
    agentName: 'dagsocial/0.1.0',
    nodeName: 'test-node',
    protocolVersion: 1,
    capabilities: [8, 9],
    ...overrides,
  };
}

function entries(n: number): PeerEntryMsg[] {
  return Array.from({ length: n }, (_, i) => ({
    address: `/ip4/51.15.${Math.floor(i / 256)}.${i % 256}/tcp/4001`,
    agentName: `agent-${i}`,
    nodeName: `node-${i}`,
    protocolVersion: 1,
    capabilities: [8],
  }));
}

describe('GetPeers codec', () => {
  it('frames a zero-byte body under code 8 and round-trips', () => {
    const frame = encodeGetPeers(MAGIC_TESTNET);
    const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
    expect(code).toBe(MSG_GET_PEERS);
    expect(b.length).toBe(0);
    expect(decodeGetPeers(b)).toEqual({});
  });

  it('accepts an empty body', () => {
    expect(decodeGetPeers(new Uint8Array(0))).toEqual({});
  });

  it('rejects a non-empty body', () => {
    expect(decodeGetPeers(new Uint8Array([0x01]))).toBeNull();
  });
});

describe('Peers codec round-trip', () => {
  for (const n of [0, 1, 8, MAX_PEERS_ENTRIES]) {
    it(`round-trips ${n} entries through the frame`, () => {
      const msg = { peers: entries(n) };
      const frame = encodePeers(MAGIC_TESTNET, msg);
      const { code, body: b } = decodeFrame(MAGIC_TESTNET, frame);
      expect(code).toBe(MSG_PEERS);
      expect(decodePeers(b)).toEqual(msg);
    });
  }

  it('round-trips IPv4 and IPv6 multiaddr addresses', () => {
    const msg = {
      peers: [
        entry({ address: '/ip4/93.184.216.34/tcp/4001' }),
        entry({ address: '/ip6/2001:4860:4860::8888/tcp/4001' }),
      ],
    };
    const body = encodeStruct(peersCodec, msg);
    expect(decodePeers(body)).toEqual(msg);
  });

  for (const caps of [[], [0], [0, 1, 2, 3, 4, 5, 6, 7]]) {
    it(`round-trips capabilities of length ${caps.length}`, () => {
      const msg = { peers: [entry({ capabilities: caps })] };
      const body = encodeStruct(peersCodec, msg);
      expect(decodePeers(body)).toEqual(msg);
    });
  }

  it('accepts a capability code at exactly MAX_CAPABILITY_CODE', () => {
    const msg = { peers: [entry({ capabilities: [MAX_CAPABILITY_CODE] })] };
    const body = encodeStruct(peersCodec, msg);
    expect(decodePeers(body)).toEqual(msg);
  });
});

describe('Peers codec rejections', () => {
  it('rejects truncated bytes', () => {
    expect(decodePeers(new Uint8Array([0x01]))).toBeNull();
  });

  it('rejects trailing bytes', () => {
    const valid = encodeStruct(peersCodec, { peers: [] });
    const extra = new Uint8Array(valid.length + 1);
    extra.set(valid);
    expect(decodePeers(extra)).toBeNull();
  });

  it(`rejects ${MAX_PEERS_ENTRIES + 1} entries where ${MAX_PEERS_ENTRIES} decode`, () => {
    const valid = { peers: entries(MAX_PEERS_ENTRIES) };
    expect(decodePeers(encodeStruct(peersCodec, valid))).not.toBeNull();
    const over = { peers: entries(MAX_PEERS_ENTRIES + 1) };
    expect(decodePeers(encodeStruct(peersCodec, over))).toBeNull();
  });

  it('rejects empty agentName', () => {
    const msg = { peers: [entry({ agentName: '' })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects agentName exceeding MAX_NAME_BYTES', () => {
    const msg = { peers: [entry({ agentName: 'a'.repeat(MAX_NAME_BYTES + 1) })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects nodeName exceeding MAX_NAME_BYTES', () => {
    const msg = { peers: [entry({ nodeName: 'n'.repeat(MAX_NAME_BYTES + 1) })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects address exceeding MAX_ADDRESS_BYTES', () => {
    const msg = { peers: [entry({ address: 'a'.repeat(MAX_ADDRESS_BYTES + 1) })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects protocolVersion above MAX_CAPABILITY_CODE', () => {
    const msg = { peers: [entry({ protocolVersion: MAX_CAPABILITY_CODE + 1 })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects capabilities count exceeding MAX_CAPABILITY_ENTRIES', () => {
    const caps = Array.from({length: MAX_CAPABILITY_ENTRIES + 1}, (_, i) => i);
    const msg = { peers: [entry({ capabilities: caps })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('rejects capability code above MAX_CAPABILITY_CODE', () => {
    const msg = { peers: [entry({ capabilities: [MAX_CAPABILITY_CODE + 1] })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toBeNull();
  });

  it('accepts empty peers list', () => {
    const msg = { peers: [] as PeerEntryMsg[] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toEqual(msg);
  });

  it('accepts empty nodeName', () => {
    const msg = { peers: [entry({ nodeName: '' })] };
    expect(decodePeers(encodeStruct(peersCodec, msg))).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Bogus address classification — unchanged by the codec migration
// ---------------------------------------------------------------------------

const ALWAYS_BOGUS: [string, string][] = [
  ['IPv4 loopback 127/8', '/ip4/127.5.6.7/tcp/4001'],
  ['IPv4 link-local 169.254/16', '/ip4/169.254.9.9/tcp/4001'],
  ['IPv4 multicast 224/4', '/ip4/231.1.2.3/tcp/4001'],
  ['IPv4 broadcast', '/ip4/255.255.255.255/tcp/4001'],
  ['IPv4 unspecified', '/ip4/0.0.0.0/tcp/4001'],
  ['IPv4 benchmark 198.18/15', '/ip4/198.19.200.1/tcp/4001'],
  ['IPv4 reserved Class E 240/4', '/ip4/246.1.2.3/tcp/4001'],
  ['IPv6 loopback ::1', '/ip6/::1/tcp/4001'],
  ['IPv6 unspecified ::', '/ip6/::/tcp/4001'],
  ['IPv6 multicast ff00::/8', '/ip6/ff05::2/tcp/4001'],
  ['IPv6 link-local fe80::/10', '/ip6/fe9b::1/tcp/4001'],
  ['IPv6 IPv4-mapped ::ffff:0:0/96 (public embedded v4)', '/ip6/::ffff:8.8.8.8/tcp/4001'],
];

const MAINNET_ONLY_BOGUS: [string, string][] = [
  ['IPv4 RFC 1918 10/8', '/ip4/10.1.2.3/tcp/4001'],
  ['IPv4 RFC 1918 172.16/12', '/ip4/172.20.0.5/tcp/4001'],
  ['IPv4 RFC 1918 192.168/16', '/ip4/192.168.44.55/tcp/4001'],
  ['IPv4 CGN 100.64/10', '/ip4/100.100.1.1/tcp/4001'],
  ['IPv4 documentation 192.0.2/24', '/ip4/192.0.2.55/tcp/4001'],
  ['IPv4 documentation 198.51.100/24', '/ip4/198.51.100.7/tcp/4001'],
  ['IPv4 documentation 203.0.113/24', '/ip4/203.0.113.99/tcp/4001'],
  ['IPv6 unique-local fc00::/7', '/ip6/fd12:3456::1/tcp/4001'],
  ['IPv6 documentation 2001:db8::/32', '/ip6/2001:db8:dead::beef/tcp/4001'],
];

const NEVER_BOGUS: [string, string][] = [
  ['public IPv4', '/ip4/93.184.216.34/tcp/4001'],
  ['public IPv6', '/ip6/2001:4860:4860::8888/tcp/4001'],
  ['IPv4 just below 172.16/12', '/ip4/172.15.1.1/tcp/4001'],
  ['IPv4 just above 172.16/12', '/ip4/172.32.1.1/tcp/4001'],
  ['IPv4 just above CGN 100.64/10', '/ip4/100.128.1.1/tcp/4001'],
  ['IPv4 just outside benchmark 198.18/15', '/ip4/198.20.1.1/tcp/4001'],
  ['IPv4 just below multicast', '/ip4/223.255.255.254/tcp/4001'],
  ['IPv6 fe00:: outside fe80::/10', '/ip6/fe00::1/tcp/4001'],
];

describe('isBogusAddress', () => {
  for (const [name, addr] of ALWAYS_BOGUS) {
    it(`${name} is bogus under both magics`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(true);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(true);
    });
  }

  for (const [name, addr] of MAINNET_ONLY_BOGUS) {
    it(`${name} is bogus under mainnet magic only`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(true);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(false);
    });
  }

  for (const [name, addr] of NEVER_BOGUS) {
    it(`${name} is not bogus under either magic`, () => {
      expect(isBogusAddress(addr, MAGIC_MAINNET)).toBe(false);
      expect(isBogusAddress(addr, MAGIC_TESTNET)).toBe(false);
    });
  }

  it('fails closed on an unparseable string, without throwing', () => {
    expect(isBogusAddress('not a multiaddr', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('not a multiaddr', MAGIC_TESTNET)).toBe(true);
  });

  it('fails closed on the empty string', () => {
    expect(isBogusAddress('', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('', MAGIC_TESTNET)).toBe(true);
  });

  it('fails closed on a multiaddr with no IP component', () => {
    expect(isBogusAddress('/dns4/example.com/tcp/443', MAGIC_MAINNET)).toBe(true);
    expect(isBogusAddress('/unix/tmp/sock', MAGIC_TESTNET)).toBe(true);
  });
});
