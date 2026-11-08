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
  verdictS6NotContinued,
  verdictS6Hostile,
  verdictS6Publisher,
  verdictS7Spread,
  verdictS7Fastest,
  verdictS7Lan,
  verdictS7Question,
  verdictS7Counts,
  verdictS8NoProofs,
  verdictS8Gossip,
  verdictS8Fork,
  verdictS8Gap,
} from '../stage/lib/verdicts.mjs';

describe('skipped — missing measurement', () => {
  // MESH_INTERFACE → Acceptance — a step that did not run reads
  // `skipped`, never a pass. Every verdict reads `null`, `undefined`
  // and an empty object as `skipped`.
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
    ['verdictS6NotContinued', verdictS6NotContinued],
    ['verdictS6Hostile', verdictS6Hostile],
    ['verdictS6Publisher', verdictS6Publisher],
    ['verdictS7Spread', verdictS7Spread],
    ['verdictS7Fastest', verdictS7Fastest],
    ['verdictS7Lan', verdictS7Lan],
    ['verdictS7Question', verdictS7Question],
    ['verdictS7Counts', verdictS7Counts],
    ['verdictS8NoProofs', verdictS8NoProofs],
    ['verdictS8Gossip', verdictS8Gossip],
    ['verdictS8Fork', verdictS8Fork],
    ['verdictS8Gap', verdictS8Gap],
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
  it('transport wss (reached over the fallback instead of webrtc-direct) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, transport: 'wss' })).toBe('FAIL');
  });
  it('transport webrtc (relayed) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, transport: 'webrtc' })).toBe('FAIL');
  });
  it('transport missing → FAIL', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['transport'];
    expect(verdictS1Node(m)).toBe('FAIL');
  });
  it('path relay (webrtc-direct over the limited link) → FAIL', () => {
    expect(verdictS1Node({ ...PASS, path: 'relay' })).toBe('FAIL');
  });
  it('path missing → FAIL', () => {
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
  // reads `status` ok, trailing or behind (all three say a checked
  // answer; `trailing` and `behind` are ranking, not reach) with a
  // WebRTC-direct link on the relayed anchor address and an IP-only
  // ICE-server record. `nodeIdInUse` and `priv1Failures` are
  // recorded, not conditions.
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
  it('priv1 trailing (one block behind on the tip\'s chain) → PASS', () => {
    expect(verdictS2Priv1({ ...PASS, priv1Status: 'trailing' })).toBe('PASS');
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
  it("nodeIdInUse null (priv1 reached but ranks below the latest routed read's node) → PASS", () => {
    expect(verdictS2Priv1({ ...PASS, nodeIdInUse: null })).toBe('PASS');
  });
});

describe('verdictS2Priv2 — symmetric NAT: reached through a relay that carries data', () => {
  // MESH_INTERFACE → NAT → "A relay carries data" / Acceptance 2 —
  // the node behind the symmetric NAT is reached through a relay
  // that carries its data; it reads `ok` or `trailing`, never
  // `blacklisted`, and a routed read lands on it.
  const PASS = {
    expectedNodeId: '1'.repeat(64),
    priv2Status: 'ok',
    priv2Path: 'relay',
    latestReadNodeId: '1'.repeat(64),
    blacklistedAtAnyPoll: false,
  };
  it('ok with path relay and the latest read landing on priv2 → PASS', () => {
    expect(verdictS2Priv2(PASS)).toBe('PASS');
  });
  it('trailing (one block behind on the tip\'s chain) → PASS', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Status: 'trailing' })).toBe('PASS');
  });
  it('priv2 status behind (lagging) → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Status: 'behind' })).toBe('FAIL');
  });
  it('priv2 status blacklisted → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Status: 'blacklisted' })).toBe('FAIL');
  });
  it('path direct (data not over the relay) → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, priv2Path: 'direct' })).toBe('FAIL');
  });
  it('latest read landed on another node → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, latestReadNodeId: '2'.repeat(64) })).toBe('FAIL');
  });
  it('priv2 blacklisted at an earlier poll → FAIL', () => {
    expect(verdictS2Priv2({ ...PASS, blacklistedAtAnyPoll: true })).toBe('FAIL');
  });
});

describe('verdictS3Moved — pub1 reads retry; the latest routed read moved off pub1; within 2 checks', () => {
  // MESH_INTERFACE → Acceptance 3 — the step names pub1 (its subject),
  // not the state's latest routed read's node, which under the spread
  // can be pub2. The measurement reads pub1's own entry status and
  // the latest routed read's node after the fault.
  const PASS = {
    stoppedNodeId: 'a'.repeat(64),
    stoppedStatus: 'retry',
    latestReadNodeId: 'b'.repeat(64),
    movedWithinChecks: 1,
  };
  it('pub1 retry + latest routed read on another node, within 2 checks → PASS', () => {
    expect(verdictS3Moved(PASS)).toBe('PASS');
  });
  it('latest routed read still on pub1 (never moved off) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, latestReadNodeId: PASS.stoppedNodeId })).toBe('FAIL');
  });
  it('pub1 reads blacklisted (not retry) → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, stoppedStatus: 'blacklisted' })).toBe('FAIL');
  });
  it('took more than 2 checks → FAIL', () => {
    expect(verdictS3Moved({ ...PASS, movedWithinChecks: 3 })).toBe('FAIL');
  });
  it('stoppedNodeId missing → FAIL', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['stoppedNodeId'];
    expect(verdictS3Moved(m)).toBe('FAIL');
  });
  // The measurement names pub1 as `stoppedNodeId`. Under the spread
  // the latest routed read can stay on pub2 (still ok) throughout;
  // the rule — "pub1 reads retry, the latest routed read is not on
  // pub1" — holds and the verdict is PASS.
  it('pub1 retry under spread (latest routed read never went to pub1) → PASS', () => {
    expect(verdictS3Moved({
      stoppedNodeId: 'a'.repeat(64),
      stoppedStatus: 'retry',
      latestReadNodeId: 'b'.repeat(64),
      movedWithinChecks: 0,
    })).toBe('PASS');
  });
});

describe('verdictS3Recovered — once the node is back it reads at or one block short of the tip', () => {
  const AT_TIP = { nodeId: 'a'.repeat(64), status: 'ok', behindBy: 0, recoveryTimeMs: 20_000 };
  const ONE_SHORT = { nodeId: 'a'.repeat(64), status: 'trailing', behindBy: 1, recoveryTimeMs: 20_000 };
  it('ok with behindBy 0 (at the tip) → PASS', () => {
    expect(verdictS3Recovered(AT_TIP)).toBe('PASS');
  });
  it('trailing with behindBy 1 (one block short) → PASS', () => {
    expect(verdictS3Recovered(ONE_SHORT)).toBe('PASS');
  });
  it('ok with behindBy 1 (status and distance disagree) → FAIL', () => {
    expect(verdictS3Recovered({ ...AT_TIP, behindBy: 1 })).toBe('FAIL');
  });
  it('trailing with behindBy 0 (status and distance disagree) → FAIL', () => {
    expect(verdictS3Recovered({ ...ONE_SHORT, behindBy: 0 })).toBe('FAIL');
  });
  it('status still retry → FAIL', () => {
    expect(verdictS3Recovered({ ...AT_TIP, status: 'retry' })).toBe('FAIL');
  });
  it('status blacklisted → FAIL', () => {
    expect(verdictS3Recovered({ ...AT_TIP, status: 'blacklisted' })).toBe('FAIL');
  });
  it('recoveryTimeMs missing → FAIL', () => {
    expect(verdictS3Recovered({ nodeId: AT_TIP.nodeId, status: 'ok', behindBy: 0 })).toBe('FAIL');
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

describe("verdictS6NotContinued — a kept chain stands when no reachable node continues it", () => {
  // MESH_INTERFACE → What the client remembers → "When no node
  // continues it" — a page with an honest kept chain whose reachable
  // nodes all serve the hostile chain keeps its own and says so. The
  // property rests on positive evidence that the hostile-fork node
  // answered this session (its status is `behind`, its tip hash is a
  // real string), so a page that reached nothing cannot read PASS.
  const PASS = {
    firstSession: { keptChainHash: 'aa'.repeat(32) },
    secondSession: {
      notContinued: true,
      bannerText: 'No node reached continues the chain you verified.',
      chainName: 'aa'.repeat(32),
      forkEntry: { status: 'behind', tipHash: 'bb'.repeat(32) },
    },
  };
  it('notContinued true + exact banner + chain is the kept one + fork `behind` answered → PASS', () => {
    expect(verdictS6NotContinued(PASS)).toBe('PASS');
  });
  it('notContinued false → FAIL', () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: { ...PASS.secondSession, notContinued: false },
    })).toBe('FAIL');
  });
  it('banner text differs by one byte → FAIL', () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: {
        ...PASS.secondSession,
        bannerText: 'No node reached continues the chain you verified',
      },
    })).toBe('FAIL');
  });
  it('the chain name moved (the kept proof was dropped) → FAIL', () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: { ...PASS.secondSession, chainName: 'cc'.repeat(32) },
    })).toBe('FAIL');
  });
  it('the fork node never answered (no positive evidence) → FAIL', () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: { ...PASS.secondSession, forkEntry: null },
    })).toBe('FAIL');
  });
  it("the fork node's tip hash is null (no positive evidence) → FAIL", () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: {
        ...PASS.secondSession,
        forkEntry: { status: 'behind', tipHash: null },
      },
    })).toBe('FAIL');
  });
  it('the fork node is blacklisted (not `behind`) → FAIL', () => {
    expect(verdictS6NotContinued({
      ...PASS,
      secondSession: {
        ...PASS.secondSession,
        forkEntry: { status: 'blacklisted', tipHash: 'bb'.repeat(32) },
      },
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

describe('verdictS6Publisher — publisher blacklisted for gossip-block; the client forwarded nothing', () => {
  const PASS = {
    publisher: { status: 'blacklisted', evidenceKind: 'gossip-block' },
    publisherPeerIdString: '12D3KooWPublisher',
    otherRejectSources: [],
  };
  it('publisher blacklisted with gossip-block evidence and no other reject source → PASS', () => {
    expect(verdictS6Publisher(PASS)).toBe('PASS');
  });
  it('publisher not blacklisted → FAIL', () => {
    expect(verdictS6Publisher({ ...PASS, publisher: { status: 'retry', evidenceKind: 'gossip-block' } })).toBe('FAIL');
  });
  it('publisher evidence is not gossip-block → FAIL', () => {
    expect(verdictS6Publisher({ ...PASS, publisher: { status: 'blacklisted', evidenceKind: 'malformed' } })).toBe('FAIL');
  });
  it('one honest mesh log named a reject source that is not the publisher → FAIL', () => {
    expect(verdictS6Publisher({
      ...PASS,
      otherRejectSources: [{ host: 'pub1', peerIdString: '12D3KooWBrowser' }],
    })).toBe('FAIL');
  });
  it('a missing publisherPeerIdString → FAIL', () => {
    expect(verdictS6Publisher({ ...PASS, publisherPeerIdString: '' })).toBe('FAIL');
  });
  it('otherRejectSources is not an array → FAIL', () => {
    expect(verdictS6Publisher({ ...PASS, otherRejectSources: null })).toBe('FAIL');
  });
});

describe('verdictS7Spread — older reads spread over ≥2 nodes; tip reads only go to ok nodes', () => {
  const AT_LEAST_TWO = [
    { nodeId: 'a'.repeat(64) }, { nodeId: 'b'.repeat(64) },
    { nodeId: 'a'.repeat(64) }, { nodeId: 'b'.repeat(64) },
  ];
  const TIP_SERVED = [
    { nodeId: 'a'.repeat(64), statusAtRead: 'ok' },
    { nodeId: 'b'.repeat(64), statusAtRead: 'ok' },
  ];
  it('≥2 distinct older ids AND every tip read on an ok node → PASS', () => {
    expect(verdictS7Spread({ olderServed: AT_LEAST_TWO, tipServed: TIP_SERVED })).toBe('PASS');
  });
  it('older reads all one node → FAIL', () => {
    expect(verdictS7Spread({
      olderServed: [{ nodeId: 'a'.repeat(64) }, { nodeId: 'a'.repeat(64) }],
      tipServed: TIP_SERVED,
    })).toBe('FAIL');
  });
  it('a tip read served by a trailing node → FAIL', () => {
    expect(verdictS7Spread({
      olderServed: AT_LEAST_TWO,
      tipServed: [{ nodeId: 'a'.repeat(64), statusAtRead: 'ok' }, { nodeId: 'b'.repeat(64), statusAtRead: 'trailing' }],
    })).toBe('FAIL');
  });
  it('a tip read with no serving node (null) → FAIL', () => {
    expect(verdictS7Spread({
      olderServed: AT_LEAST_TWO,
      tipServed: [{ nodeId: null, statusAtRead: 'ok' }],
    })).toBe('FAIL');
  });
});

describe('verdictS7Fastest — the delayed node serves no read', () => {
  const PASS = {
    delayedNodeId: 'a'.repeat(64),
    served: [{ nodeId: 'b'.repeat(64) }, { nodeId: 'c'.repeat(64) }],
  };
  it('every read on another node → PASS', () => {
    expect(verdictS7Fastest(PASS)).toBe('PASS');
  });
  it('one read on the delayed node → FAIL', () => {
    expect(verdictS7Fastest({ ...PASS, served: [{ nodeId: 'b'.repeat(64) }, { nodeId: 'a'.repeat(64) }] })).toBe('FAIL');
  });
  it('no reads at all → FAIL (no vacuous PASS)', () => {
    expect(verdictS7Fastest({ ...PASS, served: [] })).toBe('FAIL');
  });
});

describe("verdictS7Lan — a local node by the reader's hand", () => {
  // MESH_INTERFACE → Discovery → "A node added by hand" — "A node on
  // the browser's own network, named only by a seed, is never
  // dialled; added by hand, it is reached at its private address and
  // takes precedence." The `yours` flag on the entry is the trust
  // assertion; `anchorReached` is retired.
  const PASS = {
    seedPhase: { lan1EverConnected: false, lan1InboundLogged: false },
    trustedPhase: { lan1Status: 'ok', transport: 'webrtc-direct', path: 'direct', yours: true },
    untrustedPhase: { lan1Status: 'ok', transport: 'webrtc-direct', path: 'direct', yours: false },
  };
  it('all three phases hold the rule → PASS', () => {
    expect(verdictS7Lan(PASS)).toBe('PASS');
  });
  it('trailing in trusted phase (one block short) → PASS', () => {
    expect(verdictS7Lan({ ...PASS, trustedPhase: { ...PASS.trustedPhase, lan1Status: 'trailing' } })).toBe('PASS');
  });
  it('lan1 held a connection in the seed phase → FAIL', () => {
    expect(verdictS7Lan({ ...PASS, seedPhase: { lan1EverConnected: true, lan1InboundLogged: false } })).toBe('FAIL');
  });
  it('mesh log recorded an inbound from the browser in the seed phase → FAIL', () => {
    expect(verdictS7Lan({ ...PASS, seedPhase: { lan1EverConnected: false, lan1InboundLogged: true } })).toBe('FAIL');
  });
  it('transport not webrtc-direct in trusted phase → FAIL', () => {
    expect(verdictS7Lan({ ...PASS, trustedPhase: { ...PASS.trustedPhase, transport: 'webrtc' } })).toBe('FAIL');
  });
  it('yours true in untrusted phase → FAIL', () => {
    expect(verdictS7Lan({ ...PASS, untrustedPhase: { ...PASS.untrustedPhase, yours: true } })).toBe('FAIL');
  });
  it('yours false in trusted phase → FAIL', () => {
    expect(verdictS7Lan({ ...PASS, trustedPhase: { ...PASS.trustedPhase, yours: false } })).toBe('FAIL');
  });
});

describe("verdictS7Question — the heavier question: the page raises it, each answer does what it says", () => {
  // MESH_INTERFACE → Discovery → "A disagreement is the reader's
  // question, never the client's choice" — the four phases: (a) lan1
  // as `yours` on the chain, (b) lan1 cut and forking lighter —
  // `which: 'heavier'`, the chain not moving, the buttons shown; (c)
  // `disable it` clears `yours` and seats the honest chain; (d)
  // `continue on this node` seats lan1's chain and the same branch
  // growing raises no new question.
  const PASS = {
    onChainPhase: { lan1Yours: true, lan1Status: 'ok', onChain: 2 },
    heavierPhase: {
      disagreementWhich: 'heavier',
      chainStillHeld: true,
      tipStillHeld: true,
      buttonsShown: true,
    },
    disablePhase: {
      answerCalls: 1,
      lan1YoursAfter: false,
      disagreementAfter: false,
      chainOnHonest: true,
    },
    continuePhase: {
      answerCalls: 1,
      chainOnLan1: true,
      disagreementAfter: false,
      disagreementOnNextCheck: false,
    },
  };
  it('every phase holds the rule → PASS', () => {
    expect(verdictS7Question(PASS)).toBe('PASS');
  });
  it('lan1 not yours in the on-chain phase → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      onChainPhase: { ...PASS.onChainPhase, lan1Yours: false },
    })).toBe('FAIL');
  });
  it("the heavier phase names 'memory' (wrong question) → FAIL", () => {
    expect(verdictS7Question({
      ...PASS,
      heavierPhase: { ...PASS.heavierPhase, disagreementWhich: 'memory' },
    })).toBe('FAIL');
  });
  it('the chain moved while the disagreement stood → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      heavierPhase: { ...PASS.heavierPhase, chainStillHeld: false },
    })).toBe('FAIL');
  });
  it('the buttons were not shown while the disagreement stood → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      heavierPhase: { ...PASS.heavierPhase, buttonsShown: false },
    })).toBe('FAIL');
  });
  it("`disable it` was pressed but lan1 still carries `yours` → FAIL", () => {
    expect(verdictS7Question({
      ...PASS,
      disablePhase: { ...PASS.disablePhase, lan1YoursAfter: true },
    })).toBe('FAIL');
  });
  it('after `disable it` the chain did not seat on the honest side → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      disablePhase: { ...PASS.disablePhase, chainOnHonest: false },
    })).toBe('FAIL');
  });
  it('after `continue on this node` the chain is not lan1\'s → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      continuePhase: { ...PASS.continuePhase, chainOnLan1: false },
    })).toBe('FAIL');
  });
  it("the same branch growing raised a new disagreement → FAIL", () => {
    expect(verdictS7Question({
      ...PASS,
      continuePhase: { ...PASS.continuePhase, disagreementOnNextCheck: true },
    })).toBe('FAIL');
  });
  it('`answer` was called more than once per press → FAIL', () => {
    expect(verdictS7Question({
      ...PASS,
      disablePhase: { ...PASS.disablePhase, answerCalls: 2 },
    })).toBe('FAIL');
  });
});

describe('verdictS7Counts — agreement counts after a completed check', () => {
  // MESH_INTERFACE → Acceptance 7 / What the client remembers → "The
  // agreement counts" — "The page shows the agreement counts."
  it('onChain ≥ 2 → PASS', () => {
    expect(verdictS7Counts({ onChain: 2, offChain: 0 })).toBe('PASS');
  });
  it('onChain 1 (below the two-node threshold) → FAIL', () => {
    expect(verdictS7Counts({ onChain: 1, offChain: 0 })).toBe('FAIL');
  });
  it('onChain not a number → FAIL', () => {
    expect(verdictS7Counts({ onChain: '2', offChain: 0 })).toBe('FAIL');
  });
  // MESH_INTERFACE → What the client remembers → "The agreement
  // counts" — step 4 records a `{ reason, state }` measurement when
  // the completed-check state's `agreement` is null; the verdict
  // FAILs that measurement (its `onChain` is not a number), so the
  // step names the null instead of silently zeroing to `onChain: 0`.
  it('a measurement that names a null-agreement reason → FAIL', () => {
    const m = {
      reason: 'completed-check state has a null agreement',
      state: { checks: 1, agreement: null },
    };
    expect(verdictS7Counts(m)).toBe('FAIL');
  });
});

describe('verdictS8NoProofs — no proof is read across five checks and every honest node is on the chain', () => {
  // MESH_INTERFACE → Acceptance 8 — "After the first check, no proof
  // is read across five checks while every node names a tip on the
  // client's chain". PASS when the baseline-to-final `proofReads` is
  // unchanged across at least five checks AND every honest node reads
  // `ok`, `trailing` or `behind`.
  const PASS = {
    proofReadsBaseline: 4,
    proofReadsFinal: 4,
    checksBaseline: 2,
    checksFinal: 7,
    honestNodeStatuses: [
      { notisId: 'a'.repeat(64), status: 'ok' },
      { notisId: 'b'.repeat(64), status: 'ok' },
      { notisId: 'c'.repeat(64), status: 'trailing' },
    ],
  };
  it('every pass condition holds → PASS', () => {
    expect(verdictS8NoProofs(PASS)).toBe('PASS');
  });
  it('a node reads behind → PASS (behind is still on the chain)', () => {
    expect(verdictS8NoProofs({
      ...PASS,
      honestNodeStatuses: [
        { notisId: 'a'.repeat(64), status: 'ok' },
        { notisId: 'b'.repeat(64), status: 'behind' },
      ],
    })).toBe('PASS');
  });
  it('proofReadsFinal rose above baseline (a proof was read) → FAIL', () => {
    expect(verdictS8NoProofs({ ...PASS, proofReadsFinal: 5 })).toBe('FAIL');
  });
  it('fewer than five checks past baseline → FAIL', () => {
    expect(verdictS8NoProofs({ ...PASS, checksFinal: 6 })).toBe('FAIL');
  });
  it('honestNodeStatuses empty (no positive evidence) → FAIL', () => {
    expect(verdictS8NoProofs({ ...PASS, honestNodeStatuses: [] })).toBe('FAIL');
  });
  it('a honest node reads retry → FAIL', () => {
    expect(verdictS8NoProofs({
      ...PASS,
      honestNodeStatuses: [
        { notisId: 'a'.repeat(64), status: 'ok' },
        { notisId: 'b'.repeat(64), status: 'retry' },
      ],
    })).toBe('FAIL');
  });
  // A node the client's list does not hold names no tip to it: `absent` is not judged.
  const MEASURED = {
    proofReadsBaseline: 1,
    proofReadsFinal: 1,
    checksBaseline: 1,
    checksFinal: 6,
    honestNodeStatuses: [
      { notisId: 'edd6cabcde08ce2a0bd4d1b91fe59daaec1f2da4d5eff15e053ecf884449d4fe', status: 'ok' },
      { notisId: '031f99957be4f37bffc2078dc64ceeab3463066625b339112d0d51244a0f7a06', status: 'ok' },
      { notisId: '0a253dcbd57b58744b105f78d4f4d0d77a3287c28229ccd8b61e8096b61faffe', status: 'absent' },
      { notisId: '86ccc280fe7e406b86c4cba71201a617d1720e9976e0114e5f7744addab9d81a', status: 'absent' },
    ],
  };
  it('two held nodes ok, two absent (a measured step 1) → PASS', () => {
    expect(verdictS8NoProofs(MEASURED)).toBe('PASS');
  });
  it('one held honest node in retry beside absent entries → FAIL', () => {
    expect(verdictS8NoProofs({
      ...MEASURED,
      honestNodeStatuses: [
        { notisId: 'a'.repeat(64), status: 'ok' },
        { notisId: 'b'.repeat(64), status: 'ok' },
        { notisId: 'c'.repeat(64), status: 'retry' },
        { notisId: 'd'.repeat(64), status: 'absent' },
      ],
    })).toBe('FAIL');
  });
  it('fewer than two held reads (one ok, the rest absent) → FAIL', () => {
    expect(verdictS8NoProofs({
      ...MEASURED,
      honestNodeStatuses: [
        { notisId: 'a'.repeat(64), status: 'ok' },
        { notisId: 'b'.repeat(64), status: 'absent' },
        { notisId: 'c'.repeat(64), status: 'absent' },
      ],
    })).toBe('FAIL');
  });
  it('a honest node reads blacklisted → FAIL', () => {
    expect(verdictS8NoProofs({
      ...PASS,
      honestNodeStatuses: [
        { notisId: 'a'.repeat(64), status: 'blacklisted' },
        { notisId: 'b'.repeat(64), status: 'ok' },
      ],
    })).toBe('FAIL');
  });
  it('proofReadsFinal missing (not a number) → FAIL, never PASS', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['proofReadsFinal'];
    expect(verdictS8NoProofs(m)).toBe('FAIL');
  });
  it('honestNodeStatuses not an array → FAIL', () => {
    expect(verdictS8NoProofs({ ...PASS, honestNodeStatuses: null })).toBe('FAIL');
  });
});

describe('verdictS8Gossip — three new blocks reach the browser quickly, no check moved them', () => {
  // MESH_INTERFACE → Acceptance 8 — a block mined on a node reaches
  // the browser by gossip through a mesh service and moves the
  // client's tip before its next check. A delivery is a (height,
  // delayMs, checksMoved) record; PASS requires two of three to carry
  // delayMs ≤ 5000 AND checksMoved === false.
  const PASS = {
    deliveries: [
      { height: 42, delayMs: 1_200, checksMoved: false },
      { height: 43, delayMs: 2_300, checksMoved: false },
      { height: 44, delayMs: 1_800, checksMoved: false },
    ],
  };
  it('three deliveries within 5 s, no check moved → PASS', () => {
    expect(verdictS8Gossip(PASS)).toBe('PASS');
  });
  it('two within and one that coincided with a check → PASS (two of three)', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, delayMs: 1_200, checksMoved: false },
        { height: 43, delayMs: 2_300, checksMoved: true },
        { height: 44, delayMs: 1_800, checksMoved: false },
      ],
    })).toBe('PASS');
  });
  it('only one delivery within 5 s with checks unchanged → FAIL', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, delayMs: 1_200, checksMoved: false },
        { height: 43, delayMs: 6_000, checksMoved: false },
        { height: 44, delayMs: 1_800, checksMoved: true },
      ],
    })).toBe('FAIL');
  });
  it('two below the 5 s bound but one coincided with a check (one net clean) → FAIL', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, delayMs: 1_200, checksMoved: false },
        { height: 43, delayMs: 2_300, checksMoved: true },
        { height: 44, delayMs: 2_000, checksMoved: true },
      ],
    })).toBe('FAIL');
  });
  it('fewer than three deliveries → FAIL', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, delayMs: 1_200, checksMoved: false },
        { height: 43, delayMs: 2_300, checksMoved: false },
      ],
    })).toBe('FAIL');
  });
  it('deliveries is not an array → FAIL', () => {
    expect(verdictS8Gossip({ deliveries: null })).toBe('FAIL');
  });
  it('a delivery with no delayMs field → FAIL, never PASS', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, checksMoved: false },
        { height: 43, delayMs: 2_300, checksMoved: false },
        { height: 44, delayMs: 1_800, checksMoved: false },
      ],
    })).toBe('FAIL');
  });
  it('a delivery with checksMoved as a non-boolean → FAIL', () => {
    expect(verdictS8Gossip({
      deliveries: [
        { height: 42, delayMs: 1_200, checksMoved: 0 },
        { height: 43, delayMs: 2_300, checksMoved: false },
        { height: 44, delayMs: 1_800, checksMoved: false },
      ],
    })).toBe('FAIL');
  });
});

describe('verdictS8Fork — the lagging fork is behind; the client stays on the heavier chain', () => {
  // MESH_INTERFACE → Acceptance 8 — a node on another chain has its
  // proof read when its tip moves, with the client's own, and the
  // client's tip stays the honest chain's. PASS when lagging reads
  // `behind`, client's tip hash equals pub1's node's hash at that
  // height, and the check that read lagging raised proofReads by
  // exactly two (lagging + own tip; the one check in which lagging's
  // tip was the one tip not on the chain).
  const PASS = {
    laggingStatus: 'behind',
    clientTipHash: 'ab'.repeat(32),
    pub1BlockHashAtClientHeight: 'ab'.repeat(32),
    proofReadsDeltaAtCheck: 2,
  };
  it('every pass condition holds → PASS', () => {
    expect(verdictS8Fork(PASS)).toBe('PASS');
  });
  it('lagging reads blacklisted (never) → FAIL', () => {
    expect(verdictS8Fork({ ...PASS, laggingStatus: 'blacklisted' })).toBe('FAIL');
  });
  it('lagging reads retry → FAIL (lagging names a valid proof of a lighter chain)', () => {
    expect(verdictS8Fork({ ...PASS, laggingStatus: 'retry' })).toBe('FAIL');
  });
  it('lagging reads ok (its tip is on the chain, no fork left) → FAIL', () => {
    expect(verdictS8Fork({ ...PASS, laggingStatus: 'ok' })).toBe('FAIL');
  });
  it('client tip hash differs from pub1\'s hash at that height (fork won) → FAIL', () => {
    expect(verdictS8Fork({ ...PASS, pub1BlockHashAtClientHeight: 'cd'.repeat(32) })).toBe('FAIL');
  });
  it('proofReadsDelta at the check is 1 (own tip only, lagging never read) → FAIL', () => {
    expect(verdictS8Fork({ ...PASS, proofReadsDeltaAtCheck: 1 })).toBe('FAIL');
  });
  it('proofReadsDelta at the check is 3 (another off-chain tip too) → FAIL', () => {
    expect(verdictS8Fork({ ...PASS, proofReadsDeltaAtCheck: 3 })).toBe('FAIL');
  });
  it('clientTipHash missing → FAIL, never PASS', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['clientTipHash'];
    expect(verdictS8Fork(m)).toBe('FAIL');
  });
});

describe('verdictS8Gap — the browser\'s tip catches up by headers with no proof read', () => {
  // MESH_INTERFACE → Acceptance 8 — "the browser's gossip cut for three
  // blocks and restored, its tip catches up by headers with no proof
  // read". PASS when `proofReads` did not move across the window, the
  // tracker's jump was three or more blocks at once (a fill — gossip
  // moves the tip one block at a time), and the tip the fill landed on
  // is within two of pub1's read.
  const PASS = {
    proofReadsBefore: 6,
    proofReadsAfter: 6,
    tipHeightBefore: 100,
    tipHeightFinal: 104,
    jump: 4,
    pub1HeightFinal: 105,
  };
  it('every pass condition holds → PASS', () => {
    expect(verdictS8Gap(PASS)).toBe('PASS');
  });
  it('tip is level with pub1 (within zero) → PASS', () => {
    expect(verdictS8Gap({ ...PASS, tipHeightFinal: 105 })).toBe('PASS');
  });
  it('tip is two blocks past pub1 (pub1 trailing the client within two) → PASS', () => {
    expect(verdictS8Gap({ ...PASS, tipHeightFinal: 107, pub1HeightFinal: 105 })).toBe('PASS');
  });
  it('jump is exactly three (the smallest fill) → PASS', () => {
    expect(verdictS8Gap({ ...PASS, jump: 3 })).toBe('PASS');
  });
  it('proofReads moved during the window → FAIL (a proof was read)', () => {
    expect(verdictS8Gap({ ...PASS, proofReadsAfter: 7 })).toBe('FAIL');
  });
  it('jump is two (gossip-paced, not a header fill) → FAIL', () => {
    expect(verdictS8Gap({ ...PASS, jump: 2 })).toBe('FAIL');
  });
  it('jump missing → FAIL, never PASS', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['jump'];
    expect(verdictS8Gap(m)).toBe('FAIL');
  });
  it('pub1 is three past the client (tip not within two) → FAIL', () => {
    expect(verdictS8Gap({ ...PASS, pub1HeightFinal: 107 })).toBe('FAIL');
  });
  it('pub1 is three behind the client (tip not within two) → FAIL', () => {
    expect(verdictS8Gap({ ...PASS, tipHeightFinal: 108, pub1HeightFinal: 105 })).toBe('FAIL');
  });
  it('pub1HeightFinal missing → FAIL, never PASS', () => {
    const m: Record<string, unknown> = { ...PASS };
    delete m['pub1HeightFinal'];
    expect(verdictS8Gap(m)).toBe('FAIL');
  });
});
