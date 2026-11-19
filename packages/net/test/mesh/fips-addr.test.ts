// MESH_INTERFACE → FIPS → "A node's FIPS address is `/fips/<npub>/p2p/<peer id>`"
// — the `fips` multiaddr protocol, named `FIPS_MULTIADDR_CODE`, whose value
// is the npub as text and the 32-byte x-only key as bytes.

import { describe, it, expect } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { encodeNpub, generateIdentity } from '@fips/core';
import {
  FIPS_PROTOCOL_NAME,
  registerFipsProtocol,
  fipsMultiaddr,
  parseFipsMultiaddr,
} from '../../src/mesh/fips-addr.js';

const PEER_ID = '12D3KooWBhvoYgPHrAtwiBXcsnwGPrfhXAR9n1Cxj5E6o7qFmp7G';

describe('MESH_INTERFACE → FIPS: the fips multiaddr', () => {
  it('fipsMultiaddr prints /fips/<npub>/p2p/<peerId>', async () => {
    registerFipsProtocol();
    const id = await generateIdentity();
    const ma = fipsMultiaddr(id.xOnlyPubkey, PEER_ID);
    expect(ma.toString()).toBe(
      `/${FIPS_PROTOCOL_NAME}/${encodeNpub(id.xOnlyPubkey)}/p2p/${PEER_ID}`,
    );
  });

  it('a string and its bytes round-trip', async () => {
    registerFipsProtocol();
    const id = await generateIdentity();
    const str = `/${FIPS_PROTOCOL_NAME}/${encodeNpub(id.xOnlyPubkey)}/p2p/${PEER_ID}`;
    const fromString = multiaddr(str);
    const fromBytes = multiaddr(fromString.bytes);
    expect(fromBytes.toString()).toBe(str);
  });

  it('parseFipsMultiaddr answers null for a WebRTC-direct address and for /fips/<npub> with no /p2p/', async () => {
    registerFipsProtocol();
    const webrtc = multiaddr('/ip4/127.0.0.1/udp/9000/webrtc-direct');
    expect(parseFipsMultiaddr(webrtc)).toBe(null);
    const id = await generateIdentity();
    const bare = multiaddr(`/${FIPS_PROTOCOL_NAME}/${encodeNpub(id.xOnlyPubkey)}`);
    expect(parseFipsMultiaddr(bare)).toBe(null);
  });

  it('a value that is not a valid npub is refused when the string is parsed', () => {
    registerFipsProtocol();
    expect(() =>
      multiaddr(`/${FIPS_PROTOCOL_NAME}/not-a-real-npub/p2p/${PEER_ID}`),
    ).toThrow();
  });

  it('registering twice is harmless', async () => {
    registerFipsProtocol();
    registerFipsProtocol();
    const id = await generateIdentity();
    const ma = fipsMultiaddr(id.xOnlyPubkey, PEER_ID);
    expect(ma.toString().startsWith(`/${FIPS_PROTOCOL_NAME}/npub1`)).toBe(true);
  });
});
