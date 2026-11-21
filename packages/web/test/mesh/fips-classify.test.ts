// MESH_INTERFACE → The client's node list → "A FIPS address is ranked last"
// — the classifier names a FIPS connection, the sorter ranks a FIPS address
// after every other, and the gater admits a FIPS address only while a link
// is up. MESH_INTERFACE → FIPS → "A private node's relay addresses ride IP"
// — a client refuses an address carrying both a `fips` and a `p2p-circuit`
// component.

import { describe, it, expect } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import type { Address, Connection } from '@libp2p/interface';
import {
  fipsMultiaddr,
  peerIdFromNotisId,
  registerFipsProtocol,
} from '@dagsocial/net/browser';
import {
  classifyConnectionAddr,
  clientDenyDialMultiaddr,
  decorateEntries,
  notisAddressSorter,
} from '../../src/mesh/mesh-client.js';
import { NodeList } from '../../src/mesh/node-list.js';
import { nodesToRemember } from '../../src/mesh/memory.js';

// The `fips` multiaddr protocol must be known before any `multiaddr('/fips/…')`
// runs; the call is idempotent.
registerFipsProtocol();

const notisId = 'a'.repeat(64);
const relayNotisId = 'b'.repeat(64);
const ownId = '0'.repeat(63) + '1';

// A 32-byte x-only FIPS key — `encodeNpub` is bech32 encoding over the
// bytes, with no point validation.
const xOnly = new Uint8Array(32);
for (let i = 0; i < 32; i++) xOnly[i] = (i * 17 + 1) & 0xff;

const peerIdString = peerIdFromNotisId(notisId).toString();
const relayPeerIdString = peerIdFromNotisId(relayNotisId).toString();

const fipsAddrMa = fipsMultiaddr(xOnly, peerIdString);
const fipsAddr = fipsAddrMa.toString();
// The npub text as the multiaddr spells it.
const npub = String(fipsAddrMa.getComponents()[0]!.value);

type FakeOpts = {
  status: 'open' | 'closing' | 'closed' | 'aborted' | 'reset';
  direct: boolean;
  limited: boolean;
  remoteAddr: string;
  peer: string;
};

function fakeConn(o: FakeOpts): Connection {
  return {
    status: o.status,
    direct: o.direct,
    limits: o.limited ? { bytes: 1024n, seconds: 60 } : undefined,
    remoteAddr: { toString: () => o.remoteAddr },
    remotePeer: { toString: () => o.peer },
  } as unknown as Connection;
}

// MESH_INTERFACE → The client's node list, → FIPS
describe('fips: classification, rank and gate', () => {
  it('a FIPS connection is classified fips', () => {
    expect(classifyConnectionAddr(fipsAddr))
      .toEqual({ transport: 'fips', path: 'direct' });
  });

  it('a FIPS address sorts after a plain relay address and after the secure WebSocket', () => {
    const wssAddr = `/ip4/11.100.0.11/tcp/443/wss/p2p/${peerIdString}`;
    const circuitAddr = `/ip4/11.100.0.11/tcp/4002/p2p/${relayPeerIdString}/p2p-circuit/p2p/${peerIdString}`;
    const webrtcDirect = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${peerIdString}`;
    const addrs: Address[] = [
      { multiaddr: multiaddr(fipsAddr), isCertified: false },
      { multiaddr: multiaddr(circuitAddr), isCertified: false },
      { multiaddr: multiaddr(wssAddr), isCertified: false },
      { multiaddr: multiaddr(webrtcDirect), isCertified: false },
    ];
    const sorted = addrs.sort(notisAddressSorter).map((a) => a.multiaddr.toString());
    expect(sorted).toEqual([webrtcDirect, wssAddr, circuitAddr, fipsAddr]);
  });

  it('the gater refuses a FIPS address while no link is up', () => {
    const ma = multiaddr(fipsAddr);
    expect(clientDenyDialMultiaddr(ma, () => [], () => false)).toBe(true);
    expect(clientDenyDialMultiaddr(ma, () => [], () => true)).toBe(false);
  });

  it('the gater refuses a relay address over a FIPS address', () => {
    // MESH_INTERFACE → FIPS → "A private node's relay addresses ride IP"
    // — a node is reached over FIPS at its own address, through no relay.
    const composite = `/fips/${npub}/p2p/${relayPeerIdString}/p2p-circuit/p2p/${peerIdString}`;
    const ma = multiaddr(composite);
    expect(clientDenyDialMultiaddr(ma, () => [], () => true)).toBe(true);
  });

  it('a FIPS address that does not parse is dropped at intake and never reaches a dial', () => {
    const bad = `/fips/npub1notreal/p2p/${peerIdString}`;
    const webrtc = `/ip4/8.8.8.8/udp/1/webrtc-direct/certhash/uEiA/p2p/${peerIdString}`;
    const list = new NodeList(
      [{ notisId, addrs: [bad, webrtc] }],
      ownId,
      () => 0,
      () => 0,
    );
    const entry = list.entry(notisId);
    expect(entry).toBeDefined();
    expect(entry!.addrs).toEqual([webrtc]);
  });

  it('a relay address over a FIPS address is dropped at intake', () => {
    // MESH_INTERFACE → FIPS → "A private node's relay addresses ride IP"
    // — a client refuses an address carrying both a `fips` and a
    // `p2p-circuit` component wherever it arrives.
    const composite = `/fips/${npub}/p2p/${relayPeerIdString}/p2p-circuit/p2p/${peerIdString}`;
    const webrtc = `/ip4/8.8.8.8/udp/1/webrtc-direct/certhash/uEiA/p2p/${peerIdString}`;
    const list = new NodeList(
      [{ notisId, addrs: [composite, webrtc] }],
      ownId,
      () => 0,
      () => 0,
    );
    const entry = list.entry(notisId);
    expect(entry).toBeDefined();
    expect(entry!.addrs).toEqual([webrtc]);
  });

  it('a FIPS address of the wrong shape is dropped at intake', () => {
    // MESH_INTERFACE → The client's node list → "A FIPS address is ranked
    // last" — an address whose `fips` component parses but is not the
    // strict `/fips/<npub>/p2p/<peer id>` shape (`parseFipsMultiaddr`
    // answers null) is refused wherever it arrives: a bare `/fips/<npub>`
    // with no trailing `/p2p/<peer id>` is the one checked here.
    const wrongShape = `/fips/${npub}`;
    const webrtc = `/ip4/8.8.8.8/udp/1/webrtc-direct/certhash/uEiA/p2p/${peerIdString}`;
    const list = new NodeList(
      [{ notisId, addrs: [wrongShape, webrtc] }],
      ownId,
      () => 0,
      () => 0,
    );
    const entry = list.entry(notisId);
    expect(entry).toBeDefined();
    expect(entry!.addrs).toEqual([webrtc]);
  });

  it('state() names a FIPS connection', () => {
    const list = new NodeList(
      [{ notisId, addrs: [fipsAddr] }],
      ownId,
      () => 0,
      () => 0,
    );
    const conn = fakeConn({
      status: 'open', direct: true, limited: false,
      remoteAddr: fipsAddr, peer: peerIdString,
    });
    const decorated = decorateEntries(list.entries(), [conn]);
    const e = decorated.find((x) => x.notisId === notisId);
    expect(e).toBeDefined();
    expect(e!.transport).toBe('fips');
    expect(e!.path).toBe('direct');
  });

  it('a remembered node keeps its FIPS address', () => {
    const list = new NodeList(
      [{ notisId, addrs: [fipsAddr] }],
      ownId,
      () => 1000,
      () => 0,
    );
    list.success(notisId);
    const out = nodesToRemember(list.entries(), ownId, 16);
    expect(out.map((n) => n.notisId)).toEqual([notisId]);
    expect(out[0]!.addrs).toContain(fipsAddr);
  });
});
