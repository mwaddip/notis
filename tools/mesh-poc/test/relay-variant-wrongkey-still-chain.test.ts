// MESH_INTERFACE → NAT / The client's node list / Acceptance — three more
// guards: s2's variant builds from the private node's own announced
// circuit address (not from a hardcoded via-public id); `wrongKeyInfo`
// recognises both "Payload peer id X does not match" and "connected to Y"
// regardless of the error's name — the browser throws
// `UnexpectedPeerError` with the former message, Node's noise throws
// `EncryptionFailedError` with the same message; and s1 pauses
// `miner-steady` by SIGSTOP for the probe window so `/blocks/current`
// does not move between the bracket and the probe.

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildPrivateViaAnnouncedRelayVariant } from '../stage/lib/config-variants.mjs';
import { wrongKeyInfo } from '../src/client/mesh-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const SRC_S1 = join(PACKAGE_ROOT, 'stage', 'scenarios', 's1-no-name.mjs');
const SRC_MEASURE = join(PACKAGE_ROOT, 'stage', 'lib', 'measure.mjs');

// A base config a stage would hand each scenario — anchors are the two
// public mesh hosts' WebRTC-direct addresses with certhash.
const BASE_CONFIG = {
  network: 'devnet',
  anchors: [
    { notisId: 'aa'.repeat(32), addrs: ['/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/CHASH1/p2p/PUB1PEER'] },
    { notisId: 'bb'.repeat(32), addrs: ['/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/CHASH2/p2p/PUB2PEER'] },
  ],
  stunServers: ['stun:11.100.0.11:3478', 'stun:11.100.0.12:3478'],
  seeds: [],
};

// Identities a real stage writes to `stage/out/identities.json`. priv1
// and priv2 both reserved on pub2's circuit relay — the relay the
// private node picks is a run-time choice, not something s2 can
// hard-code.
const IDENTITIES = {
  pub1: {
    notisId: 'aa'.repeat(32),
    meshRole: 'public',
    addr: '11.100.0.11',
    httpPort: 3100,
    multiaddrs: [
      '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/CHASH1/p2p/PUB1PEER',
      '/ip4/11.100.0.11/tcp/4002/p2p/PUB1PEER',
    ],
  },
  pub2: {
    notisId: 'bb'.repeat(32),
    meshRole: 'public',
    addr: '11.100.0.12',
    httpPort: 3100,
    multiaddrs: [
      '/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/CHASH2/p2p/PUB2PEER',
      '/ip4/11.100.0.12/tcp/4002/p2p/PUB2PEER',
    ],
  },
  priv1: {
    notisId: 'cc'.repeat(32),
    meshRole: 'private',
    addr: '10.101.0.11',
    httpPort: 3100,
    multiaddrs: [
      '/ip4/10.101.0.11/udp/4001/webrtc-direct/certhash/PRIV1HASH/p2p/PRIV1PEER',
      '/ip4/11.100.0.12/tcp/4002/p2p/PUB2PEER/p2p-circuit/p2p/PRIV1PEER',
    ],
  },
  priv2: {
    notisId: 'dd'.repeat(32),
    meshRole: 'private',
    addr: '10.102.0.11',
    httpPort: 3100,
    multiaddrs: [
      '/ip4/10.102.0.11/udp/4001/webrtc-direct/certhash/PRIV2HASH/p2p/PRIV2PEER',
      '/ip4/11.100.0.12/tcp/4002/p2p/PUB2PEER/p2p-circuit/p2p/PRIV2PEER',
    ],
  },
};

describe('finding 6 — s2 variant is built from the private node\'s own announced /p2p-circuit', () => {
  // A private node picks its relay at run time; the stage cannot
  // know a priori that priv1 reserved on pub2 instead of pub1. The
  // variant builder reads the private node's announced circuit
  // address, extracts its relay's peer id, and composes the browser-
  // dialable form (relay WebRTC-direct + /p2p-circuit).

  it.fails('builds priv1\'s variant through its real relay (pub2 in this run), using the relay\'s WebRTC-direct address', () => {
    const r = buildPrivateViaAnnouncedRelayVariant(BASE_CONFIG, {
      privRow: IDENTITIES.priv1,
      identities: IDENTITIES,
    });
    expect(r.network).toBe('devnet');
    expect(r.anchors.length).toBe(1);
    expect(r.anchors[0]!.notisId).toBe('cc'.repeat(32));
    // Composed from pub2's WebRTC-direct (not pub1's), /p2p-circuit/p2p/<priv1 peer>.
    expect(r.anchors[0]!.addrs[0]).toBe('/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/CHASH2/p2p/PUB2PEER/p2p-circuit/p2p/PRIV1PEER');
    // No other address — a browser dials only through the relay here.
    expect(r.anchors[0]!.addrs.length).toBe(1);
    expect(r.seeds).toEqual([]);
    expect(r.stunServers).toEqual(['stun:11.100.0.11:3478', 'stun:11.100.0.12:3478']);
  });

  it.fails('builds priv2\'s variant through its real relay (pub2) too', () => {
    const r = buildPrivateViaAnnouncedRelayVariant(BASE_CONFIG, {
      privRow: IDENTITIES.priv2,
      identities: IDENTITIES,
    });
    expect(r.anchors[0]!.addrs[0]).toBe('/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/CHASH2/p2p/PUB2PEER/p2p-circuit/p2p/PRIV2PEER');
  });

  it.fails('fails loudly when the private node announces no /p2p-circuit address a browser can reach', () => {
    const privNoCircuit = {
      ...IDENTITIES.priv1,
      multiaddrs: ['/ip4/10.101.0.11/udp/4001/webrtc-direct/certhash/PRIV1HASH/p2p/PRIV1PEER'],
    };
    expect(() => buildPrivateViaAnnouncedRelayVariant(BASE_CONFIG, {
      privRow: privNoCircuit,
      identities: IDENTITIES,
    })).toThrow(/no .*p2p-circuit/i);
  });

  it.fails('fails loudly when the circuit\'s relay has no WebRTC-direct address a browser can dial', () => {
    const identitiesNoRelayWebrtc = {
      ...IDENTITIES,
      pub2: {
        ...IDENTITIES.pub2,
        // Only TCP — not browser-dialable.
        multiaddrs: ['/ip4/11.100.0.12/tcp/4002/p2p/PUB2PEER'],
      },
    };
    expect(() => buildPrivateViaAnnouncedRelayVariant(BASE_CONFIG, {
      privRow: IDENTITIES.priv1,
      identities: identitiesNoRelayWebrtc,
    })).toThrow(/no .*webrtc-direct/i);
  });

  it.fails('fails loudly when the circuit\'s relay is not in identities', () => {
    const identitiesNoRelay = {
      pub1: IDENTITIES.pub1,
      priv1: IDENTITIES.priv1, // its circuit names PUB2PEER, but pub2 is missing
    };
    expect(() => buildPrivateViaAnnouncedRelayVariant(BASE_CONFIG, {
      privRow: IDENTITIES.priv1,
      identities: identitiesNoRelay,
    })).toThrow(/no identity row for relay/i);
  });
});

describe('finding 7 — wrongKeyInfo recognises both error names and both message formats', () => {
  // In the browser, libp2p 3.5 throws `UnexpectedPeerError` from the
  // WebRTC-direct dial path even for noise's own refusal, so the
  // thrown error carries the "Payload peer id X does not match
  // expected remote peer id Y" message under the `UnexpectedPeerError`
  // name. On Node, noise throws `EncryptionFailedError` with the same
  // message. Attribution has to key on the error's name AND the
  // message pattern — either name with the "Payload peer id" format,
  // or either name with the upgrader's "connected to" format.

  it.fails('reads the browser\'s UnexpectedPeerError + "Payload peer id" message', () => {
    const err = Object.assign(new Error(
      'Payload peer id 12D3KooWFwYu does not match expected remote peer id 12D3KooWPtGv',
    ), { name: 'UnexpectedPeerError' });
    const info = wrongKeyInfo(err);
    expect(info, 'UnexpectedPeerError + "Payload peer id" message is recognised').not.toBeNull();
    expect(info!.answeredPeerIdString).toBe('12D3KooWFwYu');
  });

  it.fails('reads an EncryptionFailedError + "connected to" message (defense in depth)', () => {
    const err = Object.assign(new Error(
      'Expected remote peer 12D3KooWPtGv but connected to 12D3KooWFwYu',
    ), { name: 'EncryptionFailedError' });
    const info = wrongKeyInfo(err);
    expect(info, 'EncryptionFailedError + "connected to" message is recognised').not.toBeNull();
    expect(info!.answeredPeerIdString).toBe('12D3KooWFwYu');
  });
});

describe('finding 8 — s1 pauses miner-steady by SIGSTOP for the probe window', () => {
  // The chain's tip moves at mining speed, so `/blocks/current` and the
  // proof route may differ between the pre-probe direct read, the probe
  // itself, and the post-probe direct read. s1's probe steps halt
  // `miner-steady` (recorded in pids.json) with SIGSTOP, run the two
  // probes, and resume it with SIGCONT in `finally`. The verdict stays
  // the bracket check — probe equals either direct read.

  it('stage/lib/measure.mjs exports a signal(pid, sig) helper for arbitrary signals', () => {
    const src = readFileSync(SRC_MEASURE, 'utf8');
    expect(src, 'measure.mjs exports a signal function').toMatch(/^export function signal\s*\(/m);
  });

  it('signal(pid, sig) reads ESRCH on a missing pid, never throws', async () => {
    const { signal } = await import('../stage/lib/measure.mjs');
    const r = signal(999_999_999, 'SIGSTOP');
    expect(r, 'ESRCH is reported, not thrown').toEqual({ sent: false, reason: 'ESRCH' });
  });

  it.fails('s1 applies SIGSTOP on miner-steady before the probe steps and SIGCONT in finally', () => {
    const src = readFileSync(SRC_S1, 'utf8');
    // The scenario finds the miner-steady pid, stops it, runs the
    // probes, and resumes it inside the `finally` block so a thrown
    // step still releases the miner.
    expect(src, 's1 finds the miner-steady pid').toMatch(/findPid\([\s\S]*?['"]miner-steady['"]/);
    expect(src, 's1 pauses with SIGSTOP').toMatch(/signal\([\s\S]*?SIGSTOP/);
    // The SIGCONT lives inside the `finally` so a failed probe still
    // releases the miner (the SIGCONT paired with the SIGSTOP by
    // reading the same pid).
    const finallyIdx = src.indexOf('} finally {');
    expect(finallyIdx, 's1 has a finally block').toBeGreaterThan(0);
    const finallyBody = src.slice(finallyIdx, src.length);
    expect(finallyBody, 's1\'s finally resumes the miner').toContain('SIGCONT');
  });
});
