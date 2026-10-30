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
    it.fails(`${name}: null → skipped`, () => {
      expect(f(null)).toBe('skipped');
    });
    it.fails(`${name}: undefined → skipped`, () => {
      expect(f(undefined)).toBe('skipped');
    });
    it.fails(`${name}: {} → skipped`, () => {
      expect(f({})).toBe('skipped');
    });
  }
});

describe('verdictS1Node — the node is an anchor within 60 s', () => {
  const PASS = { nodeId: 'a'.repeat(64), isAnchor: true, timeMs: 10_000 };
  it.fails('every pass condition holds → PASS', () => {
    expect(verdictS1Node(PASS)).toBe('PASS');
  });
  it.fails('nodeId null → FAIL', () => {
    expect(verdictS1Node({ ...PASS, nodeId: null })).toBe('FAIL');
  });
  it.fails('isAnchor false (a discovered node, not an anchor) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, isAnchor: false })).toBe('FAIL');
  });
  it.fails('timeMs past 60 s → FAIL', () => {
    expect(verdictS1Node({ ...PASS, timeMs: 60_001 })).toBe('FAIL');
  });
});

describe('verdictS1Probe — the mesh answer equals the node\'s direct HTTP answer', () => {
  const PASS = {
    probe: { sha256: 'ab'.repeat(32), bytes: 123 },
    direct: { sha256: 'ab'.repeat(32), bytes: 123 },
  };
  it.fails('equal sha256 and bytes → PASS', () => {
    expect(verdictS1Probe(PASS)).toBe('PASS');
  });
  it.fails('different sha256 → FAIL', () => {
    expect(verdictS1Probe({ ...PASS, direct: { sha256: 'cd'.repeat(32), bytes: 123 } })).toBe('FAIL');
  });
  it.fails('different bytes → FAIL', () => {
    expect(verdictS1Probe({ ...PASS, direct: { sha256: PASS.probe.sha256, bytes: 999 } })).toBe('FAIL');
  });
  it.fails('direct missing → FAIL', () => {
    expect(verdictS1Probe({ probe: PASS.probe })).toBe('FAIL');
  });
  it.fails('tip moved: first direct differs but retryDirect matches → PASS', () => {
    expect(verdictS1Probe({
      probe: { sha256: 'ab'.repeat(32), bytes: 123 },
      direct: { sha256: 'cd'.repeat(32), bytes: 456 },
      retryDirect: { sha256: 'ab'.repeat(32), bytes: 123 },
    })).toBe('PASS');
  });
});

describe('verdictS1DnsSilent — no DNS during the scenario', () => {
  const PASS = { dnsLines: 0, nftCounterPackets: 0 };
  it.fails('both counters zero → PASS', () => {
    expect(verdictS1DnsSilent(PASS)).toBe('PASS');
  });
  it.fails('one DNS log line → FAIL', () => {
    expect(verdictS1DnsSilent({ ...PASS, dnsLines: 1 })).toBe('FAIL');
  });
  it.fails('one nft counter packet → FAIL', () => {
    expect(verdictS1DnsSilent({ ...PASS, nftCounterPackets: 1 })).toBe('FAIL');
  });
});

describe('verdictS2Priv1 — endpoint-independent NAT: relay, then direct', () => {
  const PASS = {
    nodeId: 'f'.repeat(64),
    expectedNodeId: 'f'.repeat(64),
    relayedTimeMs: 5_000,
    directTimeMs: 12_000,
  };
  it.fails('relay before direct, right node → PASS', () => {
    expect(verdictS2Priv1(PASS)).toBe('PASS');
  });
  it.fails('wrong node → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, nodeId: 'a'.repeat(64) })).toBe('FAIL');
  });
  it.fails('direct before relay (never upgraded) → FAIL', () => {
    expect(verdictS2Priv1({ ...PASS, directTimeMs: 1_000 })).toBe('FAIL');
  });
  it.fails('direct missing → FAIL', () => {
    expect(verdictS2Priv1({ nodeId: PASS.nodeId, expectedNodeId: PASS.expectedNodeId, relayedTimeMs: 5_000 })).toBe('FAIL');
  });
});

describe('verdictS2Priv2 — symmetric NAT: through the relay', () => {
  const PASS = {
    nodeId: '1'.repeat(64),
    expectedNodeId: '1'.repeat(64),
    relayedTimeMs: 7_000,
    everDirect: false,
  };
  it.fails('relayed, right node → PASS (direct not required)', () => {
    expect(verdictS2Priv2(PASS)).toBe('PASS');
  });
  it.fails('wrong node → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, nodeId: 'a'.repeat(64) })).toBe('FAIL');
  });
  it.fails('relay missing → FAIL', () => {
    expect(verdictS2Priv2({ nodeId: PASS.nodeId, expectedNodeId: PASS.expectedNodeId, everDirect: false })).toBe('FAIL');
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
  it.fails('moved + retry within 2 checks → PASS', () => {
    expect(verdictS3Moved(PASS)).toBe('PASS');
  });
  it.fails('did not move (same node) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, newNodeId: PASS.oldNodeId })).toBe('FAIL');
  });
  it.fails('old reads blacklisted (not retry) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, oldStatus: 'blacklisted' })).toBe('FAIL');
  });
  it.fails('took more than 2 checks → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, movedWithinChecks: 3 })).toBe('FAIL');
  });
});

describe('verdictS3Recovered — once the node is back it reads ok', () => {
  const PASS = { nodeId: 'a'.repeat(64), status: 'ok', recoveryTimeMs: 20_000 };
  it.fails('status ok with a recovery time → PASS', () => {
    expect(verdictS3Recovered(PASS)).toBe('PASS');
  });
  it.fails('status still retry → FAIL', () => {
    expect(verdictS3Recovered({ ...PASS, status: 'retry' })).toBe('FAIL');
  });
  it.fails('recoveryTimeMs missing → FAIL', () => {
    expect(verdictS3Recovered({ nodeId: PASS.nodeId, status: 'ok' })).toBe('FAIL');
  });
});

describe('verdictS4Pub1UdpDrop — UDP to pub1 cut, client gets in through another', () => {
  const PASS = { connected: true, nodeId: 'b'.repeat(64), blockedNodeId: 'a'.repeat(64) };
  it.fails('connected via a different node → PASS', () => {
    expect(verdictS4Pub1UdpDrop(PASS)).toBe('PASS');
  });
  it.fails('not connected → FAIL', () => {
    expect(verdictS4Pub1UdpDrop({ ...PASS, connected: false })).toBe('FAIL');
  });
  it.fails('connected but still using the blocked node → FAIL', () => {
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
  it.fails('WSS to pub1 with Pebble-issued cert → PASS', () => {
    expect(verdictS4AllUdpDrop(PASS)).toBe('PASS');
  });
  it.fails('transport is not wss → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, transport: 'webrtc-direct' })).toBe('FAIL');
  });
  it.fails('not pub1 → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, nodeId: 'b'.repeat(64) })).toBe('FAIL');
  });
  it.fails('cert issuer mismatch → FAIL', () => {
    expect(verdictS4AllUdpDrop({ ...PASS, certIssuerName: 'Someone Else' })).toBe('FAIL');
  });
});

describe('verdictS4Renewal — across one renewal the probes keep succeeding', () => {
  const PASS = { renewalSeen: true, probeSuccessAcrossRenewal: true, lastLeftFailure: false };
  it.fails('renewal + probe success + no failure → PASS', () => {
    expect(verdictS4Renewal(PASS)).toBe('PASS');
  });
  it.fails('no renewal seen → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, renewalSeen: false })).toBe('FAIL');
  });
  it.fails('probe did not succeed across renewal → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, probeSuccessAcrossRenewal: false })).toBe('FAIL');
  });
  it.fails('lastLeft names a failure → FAIL', () => {
    expect(verdictS4Renewal({ ...PASS, lastLeftFailure: true })).toBe('FAIL');
  });
});

describe('verdictS5 — impostor: anchor not blacklisted, its address dropped', () => {
  const PASS = {
    anchorStatus: 'ok',
    droppedAddrs: ['/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/abc'],
    blockedAddr: '/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/abc',
  };
  it.fails('address dropped, anchor not blacklisted → PASS', () => {
    expect(verdictS5(PASS)).toBe('PASS');
  });
  it.fails('anchor blacklisted → FAIL', () => {
    expect(verdictS5({ ...PASS, anchorStatus: 'blacklisted' })).toBe('FAIL');
  });
  it.fails('address not in droppedAddrs → FAIL', () => {
    expect(verdictS5({ ...PASS, droppedAddrs: [] })).toBe('FAIL');
  });
});

describe('verdictS6NoAnchor — all anchors unreachable, page says the contract words', () => {
  const PASS = { anchorReached: false, bannerText: 'No anchor reached. Nothing shown here is verified.' };
  it.fails('anchorReached false + exact banner words → PASS', () => {
    expect(verdictS6NoAnchor(PASS)).toBe('PASS');
  });
  it.fails('anchorReached true → FAIL', () => {
    expect(verdictS6NoAnchor({ ...PASS, anchorReached: true })).toBe('FAIL');
  });
  it.fails('banner text differs by one byte → FAIL', () => {
    expect(verdictS6NoAnchor({ ...PASS, bannerText: 'No anchor reached. Nothing shown here is verified' })).toBe('FAIL');
  });
});

describe('verdictS6Hostile — malformed + invalid blacklisted; lagging behind, not blacklisted', () => {
  const PASS = {
    malformed: { status: 'blacklisted', evidenceKind: 'malformed' },
    invalid: { status: 'blacklisted', evidenceKind: 'proof-invalid' },
    lagging: { status: 'behind', blacklisted: false },
  };
  it.fails('every row holds → PASS', () => {
    expect(verdictS6Hostile(PASS)).toBe('PASS');
  });
  it.fails('malformed not blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, malformed: { status: 'retry', evidenceKind: 'malformed' } })).toBe('FAIL');
  });
  it.fails('malformed evidence of a different kind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, malformed: { status: 'blacklisted', evidenceKind: 'proof-invalid' } })).toBe('FAIL');
  });
  it.fails('invalid not blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, invalid: { status: 'retry', evidenceKind: 'proof-invalid' } })).toBe('FAIL');
  });
  it.fails('invalid evidence of a different kind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, invalid: { status: 'blacklisted', evidenceKind: 'malformed' } })).toBe('FAIL');
  });
  it.fails('lagging status is not behind → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, lagging: { status: 'blacklisted', blacklisted: true } })).toBe('FAIL');
  });
  it.fails('lagging also blacklisted → FAIL', () => {
    expect(verdictS6Hostile({ ...PASS, lagging: { status: 'behind', blacklisted: true } })).toBe('FAIL');
  });
});
