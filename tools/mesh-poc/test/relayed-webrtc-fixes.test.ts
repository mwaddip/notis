// MESH_INTERFACE → NAT / Acceptance 1 / Acceptance 2 — five guards
// around the relayed WebRTC path:
//   A. a NAT router drops unsolicited inbound on its outside interface
//      so plain `masquerade` keeps the source port on the first check,
//   B. a WebRTC-direct transport names no ICE server
//      ("Only the relayed WebRTC path uses STUN"),
//   C. `transport` and `path` come from the multiaddr's own components
//      (not substring tests): the one function covers every row in the
//      brief's table,
//   D. the page's `RTCPeerConnection` constructions are recorded by a
//      wrapper the stage installs through
//      `Page.addScriptToEvaluateOnNewDocument`; the verdict reads the
//      record,
//   E. s2's priv1 step records `{ transport, path, anchorAddrRelayed,
//      iceServers, … }` and the verdict reads D's rule.
//
// Case shape: a case that depends on a new guard is `it.fails` while
// the guard is missing (and flipped to `it` once the guard lands);
// cases of invariants the fix keeps (`skipped` on missing, `FAIL` on a
// nodeId mismatch) stay as plain `it`.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { classifyConnectionAddr } from '../src/client/mesh-client.js';
import { verdictIceServers, verdictS2Priv1 } from '../stage/lib/verdicts.mjs';
import { readTopology } from '../stage/lib/topology.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const UP_SCRIPT = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_MESH_CLIENT = join(PACKAGE_ROOT, 'src', 'client', 'mesh-client.ts');
const SRC_MESH_NODE = join(PACKAGE_ROOT, 'src', 'node', 'mesh-node.ts');
const SRC_CDP = join(PACKAGE_ROOT, 'stage', 'cdp.mjs');
const SRC_S1 = join(PACKAGE_ROOT, 'stage', 'scenarios', 's1-no-name.mjs');
const SRC_S2 = join(PACKAGE_ROOT, 'stage', 'scenarios', 's2-nat.mjs');
const TOPOLOGY_PATH = join(PACKAGE_ROOT, 'stage', 'topology.json');

// --- A — NAT routers drop unsolicited inbound ------------------------------

describe('fix A — each NAT router has an input chain that drops unsolicited inbound', () => {
  // MESH_INTERFACE → NAT — "a browser reaches a private node over WebRTC
  // signalled through the relay". Plain `masquerade` preserves the
  // source port only when conntrack has not already recorded a tuple for
  // it; an inbound packet to the outside interface that is delivered to
  // the router itself establishes conntrack and causes the next outbound
  // masquerade to pick a different port. The input chain drops every
  // packet arriving on the outside interface that is not reply traffic.

  function runDry(): { status: number | null; stdout: string; stderr: string } {
    return spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
      encoding: 'utf8', timeout: 30_000,
    });
  }

  it.fails('every NAT router adds `table ip filter` and a drop-policy `input` chain', () => {
    const res = runDry();
    expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
    const topology = readTopology(TOPOLOGY_PATH);
    const natNames: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts) as Array<[string, { role: string }]>) {
      if (host.role === 'nat') natNames.push(name);
    }
    expect(natNames.length, 'at least one NAT router in topology').toBeGreaterThan(0);
    const lines = res.stdout.split('\n');
    const missing: string[] = [];
    for (const name of natNames) {
      const ns = `notismesh-${name}`;
      const hasTable = lines.some((l) => new RegExp(`\\[privileged\\] sudo ip netns exec ${ns} nft add table ip filter(\\s|$)`).test(l));
      const hasInputChain = lines.some((l) => new RegExp(`\\[privileged\\] sudo ip netns exec ${ns} nft add chain ip filter input .* type filter hook input .* policy drop`).test(l));
      if (!hasTable) missing.push(`${name}: no "add table ip filter"`);
      if (!hasInputChain) missing.push(`${name}: no drop-policy input chain`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  }, 30_000);

  it.fails('every NAT router accepts established,related and non-outside-interface traffic in the input chain', () => {
    const res = runDry();
    expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
    const topology = readTopology(TOPOLOGY_PATH);
    const missing: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts) as Array<[string, { role: string; veth: string }]>) {
      if (host.role !== 'nat') continue;
      const ns = `notismesh-${name}`;
      const outsideIf = `vp-${host.veth}-o`;
      const lines = res.stdout.split('\n');
      const hasEstRelated = lines.some((l) => new RegExp(`\\[privileged\\] sudo ip netns exec ${ns} nft add rule ip filter input ct state established,related accept`).test(l));
      // nft's `!=` operator and iifname share the same argv position; the
      // host-system quoting of the iface name is `"<name>"` or bare; the
      // test accepts either as long as the four tokens are adjacent.
      const hasIifnameNot = lines.some((l) => new RegExp(`\\[privileged\\] sudo ip netns exec ${ns} nft add rule ip filter input iifname != ['\"]?${outsideIf.replace(/-/g, '\\-')}['\"]? accept`).test(l));
      if (!hasEstRelated) missing.push(`${name}: no "ct state established,related accept"`);
      if (!hasIifnameNot) missing.push(`${name}: no "iifname != ${outsideIf} accept"`);
    }
    expect(missing, missing.join('\n')).toEqual([]);
  }, 30_000);

  it.fails('up.mjs holds no narration of a previous commit\'s nft spelling', () => {
    // CLAUDE.md → "Describe reality as it is" — the comment on the
    // symmetric NAT rule said what the previous commit got wrong; a
    // reader of the current tree has no need for that history.
    const src = readFileSync(UP_SCRIPT, 'utf8');
    expect(src, 'no mention of "previous commit"').not.toMatch(/previous commit/);
    expect(src, 'no "iptables\' spelling" narration').not.toMatch(/iptables'\s*spelling/);
  });
});

// --- B — WebRTC-direct carries an empty iceServers list ---------------------

describe('fix B — WebRTC-direct names no ICE server, the relayed WebRTC path keeps STUN', () => {
  // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses STUN;
  // WebRTC-direct to a public address needs none." The client and the
  // mesh node both build `webRTCDirect({ rtcConfiguration: { iceServers:
  // [] } })`; `webRTC(...)` keeps the configured servers. (Chosen
  // check: source regex, same pattern as
  // `test/mesh-listen-and-dial-attribution.test.ts` uses on the
  // transport-list construction.)

  it.fails('src/client/mesh-client.ts builds webRTCDirect with an empty iceServers list', () => {
    const src = readFileSync(SRC_MESH_CLIENT, 'utf8');
    expect(
      src,
      'webRTCDirect({ rtcConfiguration: { iceServers: [] } })',
    ).toMatch(/\bwebRTCDirect\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*\[\s*\]\s*\}\s*\}\s*\)/);
  });

  it('src/client/mesh-client.ts keeps the configured STUN list on webRTC()', () => {
    const src = readFileSync(SRC_MESH_CLIENT, 'utf8');
    // The webRTC(...) call still passes the configured servers; the
    // fixture holds the existing `iceConfigurations(o.stunServers)` shape.
    expect(src, 'webRTC(...) carries non-empty iceServers from stunServers').toMatch(
      /\bwebRTC\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*iceConfigurations\(/,
    );
  });

  it.fails('src/node/mesh-node.ts builds webRTCDirect with an empty iceServers list', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(
      src,
      'webRTCDirect({ rtcConfiguration: { iceServers: [] } })',
    ).toMatch(/\bwebRTCDirect\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*\[\s*\]\s*\}\s*\}\s*\)/);
  });

  it('src/node/mesh-node.ts keeps webRTC() with the stunServers mapping on a private role', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    // The webRTC call for a private node still carries the stunServers
    // list (urls per server) as before fix B.
    expect(src, 'webRTC() passes stunServers.map(...)').toMatch(
      /\bwebRTC\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*stunServers\.map/,
    );
  });
});

// --- C — classifyConnectionAddr is a pure function over components ----------

describe('fix C — classifyConnectionAddr reads transport/path from the multiaddr\'s components', () => {
  // MESH_INTERFACE → Transports / NAT — the brief's table, each row
  // asserted; an address the function cannot classify is a thrown error
  // (not `null`, which hides the bug).

  const CERTHASH = 'uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg';
  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const TARGET = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';

  it.fails('a webrtc-direct address with /p2p-circuit/webrtc classifies as { webrtc, direct }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc', path: 'direct' });
  });

  it.fails('a webrtc-direct address with /p2p-circuit and no /webrtc classifies as { webrtc-direct, relay }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc-direct', path: 'relay' });
  });

  it.fails('a tls/ws address with /p2p-circuit classifies as { wss, relay }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/tls/ws/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'relay' });
  });

  it.fails('a plain webrtc-direct address classifies as { webrtc-direct, direct }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc-direct', path: 'direct' });
  });

  it.fails('a plain tls/ws address classifies as { wss, direct }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/tls/ws/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'direct' });
  });

  it('an address with no classifiable base transport throws', () => {
    // Invariant under both current and new: the pre-fix `transportOf`
    // returns `null` and `pathOf` returns `direct`, but the imported
    // symbol does not exist, so calling it throws. After the fix the
    // function exists and throws explicitly on an unclassifiable address.
    const ma = `/ip4/11.100.0.11/tcp/9999/p2p/${TARGET}`;
    expect(() => classifyConnectionAddr(ma)).toThrow();
  });
});

// --- D — the page's RTCPeerConnection constructions are recorded ------------

describe('fix D — cdp.mjs installs an RTCPeerConnection wrapper via Page.addScriptToEvaluateOnNewDocument', () => {
  // MESH_INTERFACE → Acceptance 1 — the record is what the stage reads
  // instead of the DNS witness (which Chromium bypasses with its own
  // --host-resolver-rules). The wrapper lives in the page; cdp.mjs
  // enables Page and installs the script before navigating.

  it.fails('cdp.mjs references Page.addScriptToEvaluateOnNewDocument', () => {
    const src = readFileSync(SRC_CDP, 'utf8');
    expect(src, 'cdp.mjs installs a script before document creation').toContain('Page.addScriptToEvaluateOnNewDocument');
  });

  it.fails('cdp.mjs wraps RTCPeerConnection in the installed script', () => {
    const src = readFileSync(SRC_CDP, 'utf8');
    expect(src, 'script wraps window.RTCPeerConnection').toMatch(/window\.RTCPeerConnection\s*=/);
  });

  it.fails('cdp.mjs exposes a sub-command that returns both the state and the ICE record', () => {
    const src = readFileSync(SRC_CDP, 'utf8');
    // The sub-command is named `poll-ice` and surfaces `{ value, iceRecord }`.
    expect(src, 'poll-ice sub-command').toContain('poll-ice');
    expect(src, 'result carries iceRecord').toMatch(/iceRecord/);
  });
});

describe('fix D — verdictIceServers reads the record per MESH_INTERFACE → NAT', () => {
  // MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
  // IP"; a client refuses a hostname. The verdict:
  //   PASS when at least one PC was recorded AND every URL matches
  //        stun:<IPv4>:<port> or stun:[<IPv6>]:<port>
  //   FAIL on any other URL
  //   skipped when nothing was recorded

  it.fails('skipped when the record is missing or empty', () => {
    expect(verdictIceServers(null)).toBe('skipped');
    expect(verdictIceServers(undefined)).toBe('skipped');
    expect(verdictIceServers([])).toBe('skipped');
  });

  it.fails('PASS when every URL is stun:<IPv4>:<port>', () => {
    expect(verdictIceServers([{ urls: ['stun:11.100.0.11:3478'] }])).toBe('PASS');
    expect(verdictIceServers([
      { urls: ['stun:11.100.0.11:3478'] },
      { urls: ['stun:11.100.0.12:3478'] },
    ])).toBe('PASS');
  });

  it.fails('PASS when a PC was recorded with no URLs (WebRTC-direct, no STUN)', () => {
    // A PC built with iceServers: [] still counts as a recording: the
    // page constructed a peer connection and named no server, which
    // is the fix B check from the browser's angle.
    expect(verdictIceServers([{ urls: [] }])).toBe('PASS');
  });

  it.fails('PASS when a URL is stun:[<IPv6>]:<port>', () => {
    expect(verdictIceServers([{ urls: ['stun:[2001:db8::1]:3478'] }])).toBe('PASS');
  });

  it.fails('FAIL when a URL names a hostname', () => {
    expect(verdictIceServers([{ urls: ['stun:stun.example.com:3478'] }])).toBe('FAIL');
    expect(verdictIceServers([{ urls: ['stun:global.stun.twilio.com:3478'] }])).toBe('FAIL');
  });

  it.fails('FAIL when a URL is not a stun: URL', () => {
    expect(verdictIceServers([{ urls: ['turn:11.100.0.11:3478'] }])).toBe('FAIL');
  });

  it.fails('FAIL when a URL has no port', () => {
    expect(verdictIceServers([{ urls: ['stun:11.100.0.11'] }])).toBe('FAIL');
  });
});

// --- E — s2's priv1 step records transport/path/anchor/iceServers ----------

describe('fix E — verdictS2Priv1 reads transport, path, anchorAddrRelayed and iceServers', () => {
  // MESH_INTERFACE → NAT — "A browser reaches a private node over WebRTC
  // signalled through the relay". The verdict rests on positive
  // evidence the browser dialled the relayed WebRTC form and the
  // connection runs over WebRTC (not just a relayed data stream), and
  // the ICE-server record passes D's rule.
  //
  // Base holds BOTH the new fields and the fields the pre-fix verdict
  // reads, so the current implementation returns `PASS` on it: FAIL
  // cases below break one new field alone, giving a case that is red
  // under the current rule (PASS) and green under the new one (FAIL).

  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const PRIV = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';
  const RELAYED_WEBRTC = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${PRIV}`;
  const RELAYED_PLAIN = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY}/p2p-circuit/p2p/${PRIV}`;

  function base() {
    return {
      // New fields
      nodeId: 'aa'.repeat(32),
      expectedNodeId: 'aa'.repeat(32),
      transport: 'webrtc',
      path: 'direct',
      anchorAddrRelayed: RELAYED_WEBRTC,
      connectMs: 1200,
      iceServers: [{ urls: ['stun:11.100.0.11:3478'] }],
      // Pre-fix fields — present so the current verdict reads PASS.
      relayedTimeMs: 1200,
      directTimeMs: 2400,
    };
  }

  it('skipped on missing measurement', () => {
    expect(verdictS2Priv1(null)).toBe('skipped');
    expect(verdictS2Priv1(undefined)).toBe('skipped');
  });

  it('PASS on the full green shape', () => {
    // Green under both pre-fix (reads old fields) and post-fix (reads
    // new fields). Stays plain `it`.
    expect(verdictS2Priv1(base())).toBe('PASS');
  });

  it('FAIL when nodeId does not match expectedNodeId', () => {
    expect(verdictS2Priv1({ ...base(), nodeId: 'bb'.repeat(32) })).toBe('FAIL');
  });

  it.fails('FAIL when transport is not webrtc (webrtc-direct over a plain relayed address)', () => {
    expect(verdictS2Priv1({ ...base(), transport: 'webrtc-direct', anchorAddrRelayed: RELAYED_PLAIN })).toBe('FAIL');
  });

  it.fails('FAIL when path is not direct (still relay-only)', () => {
    expect(verdictS2Priv1({ ...base(), path: 'relay' })).toBe('FAIL');
  });

  it.fails('FAIL when anchorAddrRelayed does not hold /p2p-circuit/webrtc', () => {
    expect(verdictS2Priv1({ ...base(), anchorAddrRelayed: RELAYED_PLAIN })).toBe('FAIL');
  });

  it.fails('FAIL when the ICE-server record fails D\'s rule (hostname)', () => {
    expect(verdictS2Priv1({ ...base(), iceServers: [{ urls: ['stun:stun.example.com:3478'] }] })).toBe('FAIL');
  });

  it.fails('FAIL when no ICE record was captured (empty array)', () => {
    // D says "skipped when nothing was recorded"; s2's priv1 step then
    // FAILs — the whole step cannot PASS on an unmeasured ICE path.
    expect(verdictS2Priv1({ ...base(), iceServers: [] })).toBe('FAIL');
  });
});

// --- E — s1 and s2 scenarios reach the ICE-record step --------------------

describe('fix E / D — s1 and s2 scenarios wire the ICE-record step', () => {
  // s1 gains a step reading the record (every PC's URL is stun:ip:port
  // or the PC was built with no URL); s2's priv1 step carries the
  // record inline.

  it.fails('s1 scenario names the ICE-record step and calls poll-ice', () => {
    const src = readFileSync(SRC_S1, 'utf8');
    expect(src, 's1 uses the poll-ice cdp command').toContain('poll-ice');
    expect(src, 's1 reads verdictIceServers').toContain('verdictIceServers');
  });

  it.fails('s2 scenario reads iceServers through the poll-ice cdp command', () => {
    const src = readFileSync(SRC_S2, 'utf8');
    expect(src, 's2 uses the poll-ice cdp command').toContain('poll-ice');
    expect(src, 's2 records anchorAddrRelayed in priv1\'s measurement').toMatch(/anchorAddrRelayed/);
    expect(src, 's2 passes iceServers').toMatch(/iceServers\s*:/);
  });

  it.fails('s2\'s priv1 step records connectMs, not the pre-fix directTimeMs/everDirect pair', () => {
    const src = readFileSync(SRC_S2, 'utf8');
    expect(src, 's2 priv1 names connectMs').toMatch(/connectMs\s*:/);
    // The old shared body declared `let directTimeMs = null;` and
    // `let everDirect = false;` in priv1's path and set them in a
    // catch{} that swallowed the direct-wait timeout. The new priv1
    // code has neither declaration (priv2 keeps its own, in its own
    // sub-step).
    const priv1End = src.indexOf("sub.privHost === 'priv2'");
    const priv1Slice = priv1End > 0 ? src.slice(0, priv1End) : src;
    expect(priv1Slice, 's2 priv1 does not declare directTimeMs').not.toMatch(/\blet\s+directTimeMs\b/);
  });
});
