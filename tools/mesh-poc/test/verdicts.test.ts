// MESH_INTERFACE → Acceptance — every verdict function, fed recorded
// measurements: the table's verdicts, including a missing measurement →
// `skipped`. Each case holds one pass condition the verdict's function
// names; a mutation that deletes a condition turns the matching case
// red.

import { describe, expect, it } from 'vitest';
import {
  verdictS1Node,
  verdictS1Probe,
  verdictS1DnsSilent,
  verdictS2Priv1,
  verdictS2Priv2,
  verdictS3Moved,
  verdictS3Recovered,
  verdictS4Pub1UdpDrop,
  verdictS4AllUdpDrop,
  verdictS4Renewal,
  verdictS5,
  verdictS6NoAnchor,
  verdictS6Hostile,
} from '../stage/lib/verdicts.mjs';

describe('skipped — missing measurement', () => {
  // MESH_INTERFACE → Acceptance — "a step that did not run — or ran and
  // recorded nothing — reads `skipped`, never `PASS`". Every verdict
  // reads `null`, `undefined` and an empty object as `skipped`.
  const verdicts: ReadonlyArray<[string, (m: unknown) => string]> = [
    ['verdictS1Node', verdictS1Node],
    ['verdictS1Probe', verdictS1Probe],
    ['verdictS1DnsSilent', verdictS1DnsSilent],
    ['verdictS2Priv1', verdictS2Priv1],
    ['verdictS2Priv2', verdictS2Priv2],
    ['verdictS3Moved', verdictS3Moved],
    ['verdictS3Recovered', verdictS3Recovered],
    ['verdictS4Pub1UdpDrop', verdictS4Pub1UdpDrop],
    ['verdictS4AllUdpDrop', verdictS4AllUdpDrop],
    ['verdictS4Renewal', verdictS4Renewal],
    ['verdictS5', verdictS5],
    ['verdictS6NoAnchor', verdictS6NoAnchor],
    ['verdictS6Hostile', verdictS6Hostile],
  ];
  for (const [name, f] of verdicts) {
    it(`${name}: null → skipped`, () => {
      expect(f(null)).toBe('skipped');
    });
    it(`${name}: undefined → skipped`, () => {
      expect(f(undefined)).toBe('skipped');
    });
    it(`${name}: {} → skipped`, () => {
      expect(f({})).toBe('skipped');
    });
  }
});

describe('verdictS1Node — the node is an anchor within 60 s, reached over WebRTC-direct', () => {
  const PASS = {
    nodeId: 'a'.repeat(64),
    isAnchor: true,
    timeMs: 10_000,
    transport: 'webrtc-direct',
    path: 'direct',
  };
  it('every pass condition holds → PASS', () => {
    expect(verdictS1Node(PASS)).toBe('PASS');
  });
  it('nodeId null → FAIL', () => {
    expect(verdictS1Node({ ...PASS, nodeId: null })).toBe('FAIL');
  });
  it('isAnchor false (a discovered node, not an anchor) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, isAnchor: false })).toBe('FAIL');
  });
  it('timeMs past 60 s → FAIL', () => {
    expect(verdictS1Node({ ...PASS, timeMs: 60_001 })).toBe('FAIL');
  });
  it.fails('transport wss (reached over the fallback instead of webrtc-direct) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, transport: 'wss' })).toBe('FAIL');
  });
  it.fails('transport webrtc (relayed) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, transport: 'webrtc' })).toBe('FAIL');
  });
  it.fails('transport missing → FAIL', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['transport'];
    expect(verdictS1Node(m)).toBe('FAIL');
  });
  it.fails('path relay (webrtc-direct over the limited link) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, path: 'relay' })).toBe('FAIL');
  });
  it.fails('path missing → FAIL', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['path'];
    expect(verdictS1Node(m)).toBe('FAIL');
  });
});

describe('verdictS1Probe — the mesh answer equals the node\'s direct HTTP answer', () => {
  const PASS = {
    probe: { sha256: 'ab'.repeat(32), bytes: 123 },
    direct: { sha256: 'ab'.repeat(32), bytes: 123 },
  };
  it('equal sha256 and bytes → PASS', () => {
    expect(verdictS1Probe(PASS)).toBe('PASS');
  });
  it('different sha256 → FAIL', () => {
    expect(verdictS1Probe({ ...PASS, direct: { sha256: 'cd'.repeat(32), bytes: 123 } })).toBe('FAIL');
  });
  it('different bytes → FAIL', () => {
    expect(verdictS1Probe({ ...PASS, direct: { sha256: PASS.probe.sha256, bytes: 999 } })).toBe('FAIL');
  });
  it('direct missing → FAIL', () => {
    expect(verdictS1Probe({ probe: PASS.probe })).toBe('FAIL');
  });
  it('tip moved: first direct differs but retryDirect matches → PASS', () => {
    expect(verdictS1Probe({
      probe: { sha256: 'ab'.repeat(32), bytes: 123 },
      direct: { sha256: 'cd'.repeat(32), bytes: 456 },
      retryDirect: { sha256: 'ab'.repeat(32), bytes: 123 },
    })).toBe('PASS');
  });
});

describe('verdictS1DnsSilent — no DNS during the scenario', () => {
  const PASS = { dnsLines: 0, nftCounterPackets: 0, connected: true };
  it('both counters zero and the page connected → PASS', () => {
    expect(verdictS1DnsSilent(PASS)).toBe('PASS');
  });
  it('one DNS log line → FAIL', () => {
    expect(verdictS1DnsSilent({ ...PASS, dnsLines: 1 })).toBe('FAIL');
  });
  it('one nft counter packet → FAIL', () => {
    expect(verdictS1DnsSilent({ ...PASS, nftCounterPackets: 1 })).toBe('FAIL');
  });
  it('both counters zero but the page never connected → FAIL (no vacuous PASS)', () => {
    expect(verdictS1DnsSilent({ dnsLines: 0, nftCounterPackets: 0, connected: false })).toBe('FAIL');
  });
});

describe('verdictS2Priv1 — endpoint-independent NAT: WebRTC signalled through a relay', () => {
  // MESH_INTERFACE → Acceptance 2 — reach, not ranking: priv1's entry
  // reads `status` ok or behind (both say a checked answer; `behind`
  // is ranking, not reach) with a WebRTC-direct link on the relayed
  // anchor address and an IP-only ICE-server record. `nodeIdInUse`
  // and `priv1Failures` are recorded, not conditions.
  const PASS = {
    expectedNodeId: 'f'.repeat(64),
    priv1Status: 'ok',
    priv1Failures: 0,
    transport: 'webrtc',
    path: 'direct',
    anchorAddrRelayed: '/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiA/p2p/R/p2p-circuit/webrtc/p2p/P',
    connectMs: 1_200,
    iceServers: [{ urls: ['stun:11.100.0.11:3478'] }],
    nodeIdInUse: 'f'.repeat(64),
  };
  it('relay-signalled WebRTC, priv1 ok → PASS', () => {
    expect(verdictS2Priv1(PASS)).toBe('PASS');
  });
  it('priv1 behind (ranks below pub1 but was reached) → PASS', () => {
    expect(verdictS2Priv1({ ...PASS, priv1Status: 'behind' })).toBe('PASS');
  });
  it('priv1 retry → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, priv1Status: 'retry' })).toBe('FAIL');
  });
  it('transport other than webrtc → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, transport: 'webrtc-direct' })).toBe('FAIL');
  });
  it('path still relay → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, path: 'relay' })).toBe('FAIL');
  });
  it('anchor address does not hold /p2p-circuit/webrtc → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, anchorAddrRelayed: '/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiA/p2p/R/p2p-circuit/p2p/P' })).toBe('FAIL');
  });
  it('ICE record carries a host name → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, iceServers: [{ urls: ['stun:stun.example.com:3478'] }] })).toBe('FAIL');
  });
  it('nodeIdInUse null (priv1 reached but ranks below the node in use) → PASS', () => {
    expect(verdictS2Priv1({ ...PASS, nodeIdInUse: null })).toBe('PASS');
  });
});

describe('verdictS2Priv2 — symmetric NAT: retry, the client on another node', () => {
  // MESH_INTERFACE → NAT → "A relay carries signalling, not data" /
  // Acceptance 2 — "The node behind the symmetric NAT has no direct
  // path to the browser behind its NAT: it reads `retry`, never
  // `blacklisted`, and the client stays on a node it reaches."
  const PASS = {
    expectedNodeId: '1'.repeat(64),
    priv2Status: 'retry',
    priv2Failures: 2,
    priv2LastFailure: { kind: 'other', message: 'All multiaddr dials failed' },
    nodeIdInUse: '2'.repeat(64),
    everInUse: false,
    blacklistedAtAnyPoll: false,
  };
  it('retry with ≥1 failure, page on another node → PASS', () => {
    expect(verdictS2Priv2(PASS)).toBe('PASS');
  });
  it('priv2 status blacklisted → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Status: 'blacklisted' })).toBe('FAIL');
  });
  it('no failure recorded → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Failures: 0 })).toBe('FAIL');
  });
  it('priv2 blacklisted at an earlier poll → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, blacklistedAtAnyPoll: true })).toBe('FAIL');
  });
  it('page reached no other node (nodeIdInUse null) → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, nodeIdInUse: null })).toBe('FAIL');
  });
  it('page in use is priv2 itself → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, nodeIdInUse: PASS.expectedNodeId })).toBe('FAIL');
  });
});

describe('verdictS3Moved — move to another node, old reads retry, within 2 checks', () => {
  const PASS = {
    newNodeId: 'b'.repeat(64),
    oldNodeId: 'a'.repeat(64),
    oldStatus: 'retry',
    movedWithinChecks: 1,
    checkIntervalMs: 30_000,
  };
  it('moved + retry within 2 checks → PASS', () => {
    expect(verdictS3Moved(PASS)).toBe('PASS');
  });
  it('did not move (same node) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, newNodeId: PASS.oldNodeId })).toBe('FAIL');
  });
  it('old reads blacklisted (not retry) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, oldStatus: 'blacklisted' })).toBe('FAIL');
  });
  it('took more than 2 checks → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, movedWithinChecks: 3 })).toBe('FAIL');
  });
});

describe('verdictS3Recovered — once the node is back it reads ok', () => {
  const PASS = { nodeId: 'a'.repeat(64), status: 'ok', recoveryTimeMs: 20_000 };
  it('status ok with a recovery time → PASS', () => {
    expect(verdictS3Recovered(PASS)).toBe('PASS');
  });
  it('status still retry → FAIL', () => {
    expect(verdictS3Recovered({ ...PASS, status: 'retry' })).toBe('FAIL');
  });
  it('recoveryTimeMs missing → FAIL', () => {
    expect(verdictS3Recovered({ nodeId: PASS.nodeId, status: 'ok' })).toBe('FAIL');
  });
});

describe('verdictS4Pub1UdpDrop — UDP to pub1 cut, client gets in through another', () => {
  const PASS = { connected: true, nodeId: 'b'.repeat(64), blockedNodeId: 'a'.repeat(64) };
  it('connected via a different node → PASS', () => {
    expect(verdictS4Pub1UdpDrop(PASS)).toBe('PASS');
  });
  it('not connected → FAIL', () => {
    expect(verdictS4Pub1UdpDrop({ ...PASS, connected: false })).toBe('FAIL');
  });
  it('connected but still using the blocked node → FAIL', () => {
    expect(verdictS4Pub1UdpDrop({ ...PASS, nodeId: PASS.blockedNodeId })).toBe('FAIL');
  });
});

describe('verdictS4AllUdpDrop — UDP to all cut: WSS to pub1, Pebble-issued cert', () => {
  const PASS = {
    transport: 'wss',
    nodeId: 'a'.repeat(64),
    expectedNodeId: 'a'.repeat(64),
    certIssuerName: 'Pebble Intermediate CA',
    expectedIssuerName: 'Pebble Intermediate CA',
  };
  it('WSS to pub1 with Pebble-issued cert → PASS', () => {
    expect(verdictS4AllUdpDrop(PASS)).toBe('PASS');
  });
  it('transport is not wss → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, transport: 'webrtc-direct' })).toBe('FAIL');
  });
  it('not pub1 → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, nodeId: 'b'.repeat(64) })).toBe('FAIL');
  });
  it('cert issuer mismatch → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, certIssuerName: 'Someone Else' })).toBe('FAIL');
  });
});

describe('verdictS4Renewal — across one renewal the probes keep succeeding', () => {
  const PASS = {
    renewalSeen: true, probeSuccessAcrossRenewal: true, lastLeftFailure: false,
    connectedBeforeWindow: true, connectedAfterWindow: true,
  };
  it('renewal + probe success + no failure + connected before/after → PASS', () => {
    expect(verdictS4Renewal(PASS)).toBe('PASS');
  });
  it('no renewal seen → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, renewalSeen: false })).toBe('FAIL');
  });
  it('probe did not succeed across renewal → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, probeSuccessAcrossRenewal: false })).toBe('FAIL');
  });
  it('lastLeft names a failure → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, lastLeftFailure: true })).toBe('FAIL');
  });
  it('page never connected before the window → FAIL (no vacuous PASS)', () => {
    expect(verdictS4Renewal({ ...PASS, connectedBeforeWindow: false })).toBe('FAIL');
  });
  it('page never connected after the window → FAIL (no vacuous PASS)', () => {
    expect(verdictS4Renewal({ ...PASS, connectedAfterWindow: false })).toBe('FAIL');
  });
});

describe('verdictS5 — impostor: anchor not blacklisted, its address dropped', () => {
  const PASS = {
    anchorStatus: 'ok',
    droppedAddrs: ['/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/abc'],
    blockedAddr: '/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/abc',
  };
  it('address dropped, anchor not blacklisted → PASS', () => {
    expect(verdictS5(PASS)).toBe('PASS');
  });
  it('anchor blacklisted → FAIL', () => {
    expect(verdictS5({ ...PASS, anchorStatus: 'blacklisted' })).toBe('FAIL');
  });
  it('address not in droppedAddrs → FAIL', () => {
    expect(verdictS5({ ...PASS, droppedAddrs: [] })).toBe('FAIL');
  });
});

describe('verdictS6NoAnchor — all anchors unreachable, page says the contract words', () => {
  const PASS = {
    anchorReached: false,
    bannerText: 'No anchor reached. Nothing shown here is verified.',
    // Positive evidence: at least one seed answered inside the window.
    // The property is "a client talking to hostile nodes alone says no
    // anchor was reached", not "a page that reached nothing shows the
    // banner" (which the stage's own broken page would also do).
    seedAnswered: true,
    seedId: 'cc'.repeat(32),
    seedStatus: 'blacklisted',
  };
  it('anchorReached false + exact banner words + a seed answered → PASS', () => {
    expect(verdictS6NoAnchor(PASS)).toBe('PASS');
  });
  it('anchorReached true → FAIL', () => {
    expect(verdictS6NoAnchor({ ...PASS, anchorReached: true })).toBe('FAIL');
  });
  it('banner text differs by one byte → FAIL', () => {
    expect(verdictS6NoAnchor({ ...PASS, bannerText: 'No anchor reached. Nothing shown here is verified' })).toBe('FAIL');
  });
  it('page reached nothing (no seed answered) → FAIL (no vacuous PASS)', () => {
    expect(verdictS6NoAnchor({
      anchorReached: false,
      bannerText: 'No anchor reached. Nothing shown here is verified.',
      seedAnswered: false,
      seedId: null,
      seedStatus: null,
    })).toBe('FAIL');
  });
  it("a seed in 'new' (never contacted) does not count as answered", () => {
    expect(verdictS6NoAnchor({
      ...PASS,
      seedAnswered: false,
      seedId: 'cc'.repeat(32),
      seedStatus: 'new',
    })).toBe('FAIL');
  });
});

describe('verdictS6Hostile — malformed + invalid blacklisted; lagging behind, not blacklisted', () => {
  const PASS = {
    malformed: { status: 'blacklisted', evidenceKind: 'malformed' },
    invalid: { status: 'blacklisted', evidenceKind: 'proof-invalid' },
    lagging: { status: 'behind', blacklisted: false },
  };
  it('every row holds → PASS', () => {
    expect(verdictS6Hostile(PASS)).toBe('PASS');
  });
  it('malformed not blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, malformed: { status: 'retry', evidenceKind: 'malformed' } })).toBe('FAIL');
  });
  it('malformed evidence of a different kind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, malformed: { status: 'blacklisted', evidenceKind: 'proof-invalid' } })).toBe('FAIL');
  });
  it('invalid not blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, invalid: { status: 'retry', evidenceKind: 'proof-invalid' } })).toBe('FAIL');
  });
  it('invalid evidence of a different kind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, invalid: { status: 'blacklisted', evidenceKind: 'malformed' } })).toBe('FAIL');
  });
  it('lagging status is not behind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, lagging: { status: 'blacklisted', blacklisted: true } })).toBe('FAIL');
  });
  it('lagging also blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, lagging: { status: 'behind', blacklisted: true } })).toBe('FAIL');
  });
});
