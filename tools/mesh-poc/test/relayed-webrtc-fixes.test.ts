// MESH_INTERFACE → NAT / Acceptance 1 / Acceptance 2 — guards around the
// relayed WebRTC path:
//   NAT routers drop unsolicited inbound on their outside interface so
//     plain `masquerade` keeps the source port on the first check,
//   WebRTC-direct names no ICE server
//     ("Only the relayed WebRTC path uses STUN"),
//   `classifyConnectionAddr` reads the multiaddr's own components (not
//     substring tests) and names every row MESH_INTERFACE lists,
//   the page's `RTCPeerConnection` constructions are recorded by the
//     wrapper the stage installs through
//     `Page.addScriptToEvaluateOnNewDocument`; a verdict reads the record,
//   s2's priv1 step records
//     `{ transport, path, anchorAddrRelayed, iceServers, … }` and the
//     verdict reads the ICE-record rule,
//   s2's priv2 step walks the state across one held page until priv2's
//     entry carries at least one failure and the client is on another
//     node.

import { vi, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import vm from 'node:vm';

// --- Mocked `execIn` + measure helpers used by s1 and s2 ------------------
//
// `vi.hoisted` lets the mock factory and the test bodies share one state
// bag; `vi.mock` is hoisted to the top of the module, so the bag must live
// outside the lexical imports. Each test calls `execInMock.reset()` and
// `execInMock.setResponder(fn)` to feed canned answers to `cdp.mjs poll`,
// `poll-ice` and `eval` invocations the scenarios issue.

const execInMock = vi.hoisted(() => {
  type Call = { ns: string; argv: readonly string[]; opts: unknown };
  const calls: Call[] = [];
  let responder: (ns: string, argv: readonly string[]) => Buffer | string = () => Buffer.from('{}');
  return {
    calls,
    setResponder(r: typeof responder) { responder = r; },
    reset() { calls.length = 0; responder = () => Buffer.from('{}'); },
    invoke(ns: string, argv: readonly string[], opts: unknown): Buffer {
      calls.push({ ns, argv, opts });
      const r = responder(ns, argv);
      return typeof r === 'string' ? Buffer.from(r) : r;
    },
  };
});

vi.mock('../stage/lib/measure.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    execIn: (ns: string, argv: readonly string[], opts: unknown) => execInMock.invoke(ns, argv, opts),
    readDirect: () => ({ sha256: 'cafebabe', bytes: 1 }),
    readLineCount: () => 0,
    readNftCounterSum: () => 0,
    findPid: () => null,
    signal: () => {},
    leafPids: () => [],
    sigterm: () => {},
    descendantPids: () => [],
    readMtimeMs: () => 0,
  };
});

import { classifyConnectionAddr, decorateEntries, pickConnectionForStream } from '../src/client/mesh-client.js';
import { peerIdFromNotisId } from '../src/identity.js';
import type { Connection } from '@libp2p/interface';
import type { NodeEntry } from '../src/client/node-list.js';
import { verdictIceServers, verdictS2Priv1, verdictS2Priv2 } from '../stage/lib/verdicts.mjs';
import { readTopology } from '../stage/lib/topology.mjs';
import { ICE_RECORD_INSTALL_SRC } from '../stage/cdp.mjs';

// Static import of the scenarios so vi.mock applies — a dynamic import
// after a test runs would race the module cache.
import * as s1Scenario from '../stage/scenarios/s1-no-name.mjs';
import * as s2Scenario from '../stage/scenarios/s2-nat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const UP_SCRIPT = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_MESH_CLIENT = join(PACKAGE_ROOT, 'src', 'client', 'mesh-client.ts');
const SRC_MESH_NODE = join(PACKAGE_ROOT, 'src', 'node', 'mesh-node.ts');
const TOPOLOGY_PATH = join(PACKAGE_ROOT, 'stage', 'topology.json');

// --- NAT routers drop unsolicited inbound ----------------------------------

describe('NAT routers drop unsolicited inbound on the outside interface', () => {
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

  it('every NAT router adds `table ip filter` and a drop-policy `input` chain', () => {
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

  it('every NAT router accepts established,related and non-outside-interface traffic', () => {
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
});

// --- WebRTC-direct names no ICE server ------------------------------------

describe('WebRTC-direct names no ICE server; the relayed WebRTC path keeps STUN', () => {
  // MESH_INTERFACE → NAT — "Only the relayed WebRTC path uses STUN;
  // WebRTC-direct to a public address needs none." The client and the
  // mesh node both build `webRTCDirect({ rtcConfiguration: { iceServers:
  // [] } })`; `webRTC(...)` keeps the configured servers.
  //
  // Choice: a source regex rather than a `vi.mock('@libp2p/webrtc', ...)`
  // + startMeshClient / startMeshNode, because that would spin up three
  // libp2p nodes (one client, one public and one private mesh node) for
  // one assertion per node and the existing scenario suites already
  // exercise end-to-end startup. The regex matches the whole call
  // shape — `webRTCDirect({ rtcConfiguration: { iceServers: [] } })` —
  // so a wrapper that reads the string in a comment but builds the
  // transport differently fails it.

  it('the client calls webRTCDirect with an empty iceServers list', () => {
    const src = readFileSync(SRC_MESH_CLIENT, 'utf8');
    expect(
      src,
      'webRTCDirect({ rtcConfiguration: { iceServers: [] } })',
    ).toMatch(/\bwebRTCDirect\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*\[\s*\]\s*\}\s*\}\s*\)/);
  });

  it('the client passes the configured STUN list to webRTC()', () => {
    const src = readFileSync(SRC_MESH_CLIENT, 'utf8');
    expect(src, 'webRTC(...) carries non-empty iceServers from stunServers').toMatch(
      /\bwebRTC\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*iceConfigurations\(/,
    );
  });

  it('the mesh node calls webRTCDirect with an empty iceServers list', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(
      src,
      'webRTCDirect({ rtcConfiguration: { iceServers: [] } })',
    ).toMatch(/\bwebRTCDirect\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*\[\s*\]\s*\}\s*\}\s*\)/);
  });

  it('a private mesh node passes the configured STUN list to webRTC()', () => {
    const src = readFileSync(SRC_MESH_NODE, 'utf8');
    expect(src, 'webRTC() passes stunServers.map(...)').toMatch(
      /\bwebRTC\s*\(\s*\{\s*rtcConfiguration\s*:\s*\{\s*iceServers\s*:\s*stunServers\.map/,
    );
  });
});

// --- classifyConnectionAddr ------------------------------------------------

describe('classifyConnectionAddr reads transport/path from the multiaddr\'s components', () => {
  // MESH_INTERFACE → Transports / NAT — every row MESH_INTERFACE names,
  // asserted; an address the function cannot classify is a thrown error
  // (not `null`, which hides the bug).

  const CERTHASH = 'uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg';
  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const TARGET = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';

  it('a webrtc-direct address with /p2p-circuit/webrtc classifies as { webrtc, direct }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc', path: 'direct' });
  });

  it('a webrtc-direct address with /p2p-circuit and no /webrtc classifies as { webrtc-direct, relay }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc-direct', path: 'relay' });
  });

  it('a tls/ws address with /p2p-circuit classifies as { wss, relay }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/tls/ws/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'relay' });
  });

  it('a plain webrtc-direct address classifies as { webrtc-direct, direct }', () => {
    const ma = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'webrtc-direct', path: 'direct' });
  });

  it('a plain tls/ws address classifies as { wss, direct }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/tls/ws/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'direct' });
  });

  // The client dials `/wss/` addresses (secure WebSocket, a single
  // multiaddr component) alongside the two-component `/tls/ws/` form:
  // `src/client/mesh-client.ts`'s `isWSSAddr` reader skips only plain
  // `/ws/`. A `wss` component before any `p2p-circuit` names `wss`.
  it('a plain wss address classifies as { wss, direct }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/wss/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'direct' });
  });

  it('a wss address with /p2p-circuit classifies as { wss, relay }', () => {
    const ma = `/ip4/11.100.0.11/tcp/443/wss/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`;
    expect(classifyConnectionAddr(ma)).toEqual({ transport: 'wss', path: 'relay' });
  });

  it('an address with no classifiable base transport throws', () => {
    const ma = `/ip4/11.100.0.11/tcp/9999/p2p/${TARGET}`;
    expect(() => classifyConnectionAddr(ma)).toThrow();
  });
});

// --- pickConnectionForStream ---------------------------------------------

describe('pickConnectionForStream reads the connection libp2p would run a stream on', () => {
  // MESH_INTERFACE → NAT → "A relay carries signalling, not data." —
  // "a client opens no API stream on a limited connection". libp2p runs
  // a new stream on the connection its own `findExistingConnection`
  // picks: open connections only, direct ones first, the first with
  // `limits == null`. The page's transport and path name that same
  // connection, so the pick must match. Only when every open
  // connection to the node is limited does the helper fall back to a
  // limited one, which classifies as `relay`.

  const CERTHASH = 'uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg';
  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const TARGET = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';
  const OTHER = '12D3KooWKtkGK1u9H1dxGvV2m6V3h7F3BuzuNxEoiGHhvQdGLxui';

  type FakeOpts = {
    status: 'open' | 'closing' | 'closed' | 'aborted' | 'reset';
    direct: boolean;
    limited: boolean;
    remoteAddr: string;
    peer?: string;
  };
  function fake(o: FakeOpts): Connection {
    return {
      status: o.status,
      direct: o.direct,
      limits: o.limited ? { bytes: 1024n, seconds: 60 } : undefined,
      remoteAddr: { toString: () => o.remoteAddr },
      remotePeer: { toString: () => o.peer ?? TARGET },
    } as unknown as Connection;
  }

  it('a limited relayed connection listed before an unlimited WebRTC one reads { webrtc, direct }', () => {
    const limitedRelayed = fake({
      status: 'open', direct: false, limited: true,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`,
    });
    const unlimitedWebrtc = fake({
      status: 'open', direct: true, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`,
    });
    const picked = pickConnectionForStream([limitedRelayed, unlimitedWebrtc], TARGET);
    expect(picked, 'the unlimited WebRTC connection is picked over the limited relayed one').toBe(unlimitedWebrtc);
    expect(classifyConnectionAddr(picked!.remoteAddr.toString()))
      .toEqual({ transport: 'webrtc', path: 'direct' });
  });

  it('a closed unlimited connection is passed over for an open limited one', () => {
    const closedUnlimited = fake({
      status: 'closed', direct: true, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`,
    });
    const openLimited = fake({
      status: 'open', direct: false, limited: true,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`,
    });
    const picked = pickConnectionForStream([closedUnlimited, openLimited], TARGET);
    expect(picked, 'a closed connection is skipped — only open ones are considered').toBe(openLimited);
    expect(classifyConnectionAddr(picked!.remoteAddr.toString()))
      .toEqual({ transport: 'webrtc-direct', path: 'relay' });
  });

  it('only a limited connection open reads { webrtc-direct, relay }', () => {
    const limitedRelay = fake({
      status: 'open', direct: false, limited: true,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${TARGET}`,
    });
    const picked = pickConnectionForStream([limitedRelay], TARGET);
    expect(picked, 'the limited connection is the only open one, so it is picked').toBe(limitedRelay);
    expect(classifyConnectionAddr(picked!.remoteAddr.toString()))
      .toEqual({ transport: 'webrtc-direct', path: 'relay' });
  });

  it('no connection to the expected peer reads null', () => {
    expect(pickConnectionForStream([], TARGET)).toBeNull();
    const toOther = fake({
      status: 'open', direct: true, limited: false, peer: OTHER,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${OTHER}`,
    });
    expect(pickConnectionForStream([toOther], TARGET),
      'a connection to a different peer is not picked').toBeNull();
  });

  // --- mutation round ----------------------------------------------------

  it('MUTATION: direct-first sort — a direct unlimited later in the list still wins over an indirect unlimited first', () => {
    const indirectUnlimited = fake({
      status: 'open', direct: false, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`,
    });
    const directUnlimited = fake({
      status: 'open', direct: true, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`,
    });
    expect(pickConnectionForStream([indirectUnlimited, directUnlimited], TARGET)).toBe(directUnlimited);
  });

  it('MUTATION: status filter — a closed direct unlimited is skipped for an open indirect unlimited', () => {
    const closedDirect = fake({
      status: 'closed', direct: true, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`,
    });
    const openIndirect = fake({
      status: 'open', direct: false, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`,
    });
    expect(pickConnectionForStream([closedDirect, openIndirect], TARGET)).toBe(openIndirect);
  });

  it('MUTATION: limits filter — an unlimited indirect is picked over a limited direct', () => {
    const limitedDirect = fake({
      status: 'open', direct: true, limited: true,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${TARGET}`,
    });
    const unlimitedIndirect = fake({
      status: 'open', direct: false, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`,
    });
    expect(pickConnectionForStream([limitedDirect, unlimitedIndirect], TARGET)).toBe(unlimitedIndirect);
  });

  it('MUTATION: peer filter — a direct unlimited to a different peer does not win over an indirect unlimited to the target', () => {
    const directToOther = fake({
      status: 'open', direct: true, limited: false, peer: OTHER,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${OTHER}`,
    });
    const indirectToTarget = fake({
      status: 'open', direct: false, limited: false,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${TARGET}`,
    });
    expect(pickConnectionForStream([directToOther, indirectToTarget], TARGET)).toBe(indirectToTarget);
  });
});

// --- decorateEntries carries transport/path per entry --------------------

describe('decorateEntries carries each entry\'s transport and path', () => {
  // MESH_INTERFACE → NAT / The client's node list — every `nodes[]` entry
  // carries the pair `{ transport, path }` of its connection, read with
  // the same pick + classify the top-level pair uses. An entry with no
  // open connection reads `null`/`null`; the pair for the node in use
  // reads the same as the top-level pair.
  //
  // The ids live under their Notis spelling (64 lowercase hex). The
  // helper converts each to the libp2p peer id string before matching
  // against `connections`.

  const CERTHASH = 'uEiAVZaUYSQpGvbSz9JTC4e4hT4qg9eDWVvHe4lhPUT_wxg';
  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const AA_NOTIS = 'aa'.repeat(32);
  const BB_NOTIS = 'bb'.repeat(32);

  // The helper reads the peer id string from the stored notisId through
  // libp2p's own encoding, so the fake connection's `remotePeer` must
  // answer that same string. The test rebuilds the peer id string with
  // the same function the implementation uses, so the fixture tracks a
  // key-encoding change instead of hard-coding a byte sequence.
  function peerIdFor(notisId: string): string {
    return peerIdFromNotisId(notisId).toString();
  }

  type FakeOpts = {
    status: 'open' | 'closing' | 'closed' | 'aborted' | 'reset';
    direct: boolean;
    limited: boolean;
    remoteAddr: string;
    peerIdString: string;
  };
  function fakeConn(o: FakeOpts): Connection {
    return {
      status: o.status,
      direct: o.direct,
      limits: o.limited ? { bytes: 1024n, seconds: 60 } : undefined,
      remoteAddr: { toString: () => o.remoteAddr },
      remotePeer: { toString: () => o.peerIdString },
    } as unknown as Connection;
  }

  function entry(over: Partial<NodeEntry> & { notisId: string }): NodeEntry {
    return {
      notisId: over.notisId,
      anchor: over.anchor ?? false,
      status: over.status ?? 'new',
      failures: over.failures ?? 0,
      retryAtMs: over.retryAtMs ?? 0,
      addrs: over.addrs ?? [],
      droppedAddrs: over.droppedAddrs ?? [],
      evidence: over.evidence ?? null,
      lastFailure: over.lastFailure ?? null,
      lastFailures: over.lastFailures ?? {},
      transport: over.transport ?? null,
      path: over.path ?? null,
    };
  }

  it.fails('an entry with an unlimited WebRTC-over-relay connection reads { webrtc, direct }', () => {
    const aaPeerString = peerIdFor(AA_NOTIS);
    const conn = fakeConn({
      status: 'open', direct: true, limited: false,
      peerIdString: aaPeerString,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${aaPeerString}`,
    });
    const [decorated] = decorateEntries([entry({ notisId: AA_NOTIS })], [conn]);
    expect(decorated).toMatchObject({ transport: 'webrtc', path: 'direct' });
  });

  it.fails('an entry with no open connection reads null transport and null path', () => {
    const [decorated] = decorateEntries([entry({ notisId: AA_NOTIS })], []);
    expect(decorated).toMatchObject({ transport: null, path: null });
  });

  it.fails('the pair for the node in use matches the pair top-level refreshTransportPath reads', () => {
    // Both the top-level pair and the entry pair are derived from the
    // same `pickConnectionForStream` + `classifyConnectionAddr` for the
    // same id; they must agree. This case asserts that invariant on a
    // mixed list (one entry has an open connection, the other does not).
    const aaPeerString = peerIdFor(AA_NOTIS);
    const conn = fakeConn({
      status: 'open', direct: true, limited: false,
      peerIdString: aaPeerString,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${aaPeerString}`,
    });
    const decorated = decorateEntries(
      [entry({ notisId: AA_NOTIS }), entry({ notisId: BB_NOTIS })],
      [conn],
    );
    const aa = decorated.find((n) => n.notisId === AA_NOTIS);
    const bb = decorated.find((n) => n.notisId === BB_NOTIS);
    // Match the top-level reading: the same conn → classify its addr →
    // `{ webrtc-direct, direct }`.
    expect(aa).toMatchObject({ transport: 'webrtc-direct', path: 'direct' });
    expect(bb).toMatchObject({ transport: null, path: null });
    expect(aa!.transport).toBe(classifyConnectionAddr(conn.remoteAddr.toString()).transport);
    expect(aa!.path).toBe(classifyConnectionAddr(conn.remoteAddr.toString()).path);
  });

  // --- mutation round --------------------------------------------------

  it.fails('MUTATION: peer filter — a connection to another peer leaves the entry at null/null', () => {
    const bbPeerString = peerIdFor(BB_NOTIS);
    const conn = fakeConn({
      status: 'open', direct: true, limited: false,
      peerIdString: bbPeerString,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${bbPeerString}`,
    });
    const [decorated] = decorateEntries([entry({ notisId: AA_NOTIS })], [conn]);
    expect(decorated).toMatchObject({ transport: null, path: null });
  });

  it.fails('MUTATION: status filter — a closed connection leaves the entry at null/null', () => {
    const aaPeerString = peerIdFor(AA_NOTIS);
    const conn = fakeConn({
      status: 'closed', direct: true, limited: false,
      peerIdString: aaPeerString,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${aaPeerString}`,
    });
    const [decorated] = decorateEntries([entry({ notisId: AA_NOTIS })], [conn]);
    expect(decorated).toMatchObject({ transport: null, path: null });
  });

  it.fails('MUTATION: limited-only connection reads { webrtc-direct, relay } for its entry', () => {
    const aaPeerString = peerIdFor(AA_NOTIS);
    const conn = fakeConn({
      status: 'open', direct: false, limited: true,
      peerIdString: aaPeerString,
      remoteAddr: `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/${CERTHASH}/p2p/${RELAY}/p2p-circuit/p2p/${aaPeerString}`,
    });
    const [decorated] = decorateEntries([entry({ notisId: AA_NOTIS })], [conn]);
    expect(decorated).toMatchObject({ transport: 'webrtc-direct', path: 'relay' });
  });
});

// --- the installer behaviour of the page's ICE-record wrapper -------------

describe('the page\'s RTCPeerConnection wrapper installer', () => {
  // MESH_INTERFACE → Acceptance 1 — the record is what the stage reads
  // instead of the DNS witness (which Chromium bypasses with its own
  // --host-resolver-rules). The installer source is exported from
  // `stage/cdp.mjs`; each case runs it in a `node:vm` context with a
  // fake `window.RTCPeerConnection` and asserts behaviour.

  function makeContext() {
    const calls: Array<{ cfg: unknown }> = [];
    function OrigPC(this: Record<string, unknown>, cfg: unknown): void {
      calls.push({ cfg });
      this.cfg = cfg;
    }
    (OrigPC as unknown as { staticK: string }).staticK = 'static-value';
    const win: Record<string, unknown> = { RTCPeerConnection: OrigPC };
    const ctx = { window: win };
    vm.createContext(ctx);
    return { ctx, win, OrigPC, calls };
  }

  it('records a construction with its URLs and passes the config to the original', () => {
    const { ctx, win, calls } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const cfg = { iceServers: [{ urls: ['stun:11.100.0.11:3478', 'stun:11.100.0.12:3478'] }] };
    const Wrapped = win.RTCPeerConnection as new (c: unknown) => unknown;
    const pc = new Wrapped(cfg) as { cfg: unknown };
    expect(win.__notismeshIceRecord).toEqual([{ urls: ['stun:11.100.0.11:3478', 'stun:11.100.0.12:3478'] }]);
    expect(pc.cfg, 'the config reaches the original constructor').toBe(cfg);
    expect(calls.length, 'the original was called exactly once').toBe(1);
  });

  it('records a construction built with iceServers whose urls is a string', () => {
    const { ctx, win } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const Wrapped = win.RTCPeerConnection as new (c: unknown) => unknown;
    new Wrapped({ iceServers: [{ urls: 'stun:11.100.0.11:3478' }] });
    expect(win.__notismeshIceRecord).toEqual([{ urls: ['stun:11.100.0.11:3478'] }]);
  });

  it('records an iceServers: [] construction as one empty-URL bucket', () => {
    const { ctx, win } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const Wrapped = win.RTCPeerConnection as new (c: unknown) => unknown;
    new Wrapped({ iceServers: [] });
    expect(win.__notismeshIceRecord).toEqual([{ urls: [] }]);
  });

  it('a second install is a no-op', () => {
    const { ctx, win } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const Wrapped = win.RTCPeerConnection as new (c: unknown) => unknown;
    new Wrapped({ iceServers: [{ urls: ['stun:11.100.0.11:3478'] }] });
    expect((win.__notismeshIceRecord as unknown[]).length, 'exactly one record').toBe(1);
  });

  it('instanceof holds through the wrapper', () => {
    const { ctx, win, OrigPC } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const Wrapped = win.RTCPeerConnection as new (c: unknown) => unknown;
    const pc = new Wrapped({ iceServers: [] });
    expect(pc instanceof OrigPC, 'pc instanceof OrigPC through the wrapper').toBe(true);
  });

  it('static properties on the original are copied to the wrapper', () => {
    const { ctx, win } = makeContext();
    vm.runInContext(ICE_RECORD_INSTALL_SRC, ctx);
    const Wrapped = win.RTCPeerConnection as unknown as { staticK: string };
    expect(Wrapped.staticK, 'static-value copied').toBe('static-value');
  });
});

// --- verdictIceServers reads the record per MESH_INTERFACE → NAT ----------

describe('verdictIceServers reads the record per MESH_INTERFACE → NAT', () => {
  // MESH_INTERFACE → NAT — "every STUN server is a mesh node named by
  // IP"; a client refuses a hostname. The verdict:
  //   PASS when at least one PC was recorded AND every URL matches
  //        stun:<IPv4>:<port> or stun:[<IPv6>]:<port>
  //   FAIL on any other URL
  //   skipped when nothing was recorded

  it('skipped when the record is missing or empty', () => {
    expect(verdictIceServers(null)).toBe('skipped');
    expect(verdictIceServers(undefined)).toBe('skipped');
    expect(verdictIceServers([])).toBe('skipped');
  });

  it('PASS when every URL is stun:<IPv4>:<port>', () => {
    expect(verdictIceServers([{ urls: ['stun:11.100.0.11:3478'] }])).toBe('PASS');
    expect(verdictIceServers([
      { urls: ['stun:11.100.0.11:3478'] },
      { urls: ['stun:11.100.0.12:3478'] },
    ])).toBe('PASS');
  });

  it('PASS when a PC was recorded with no URLs (the WebRTC-direct, no-STUN path)', () => {
    expect(verdictIceServers([{ urls: [] }])).toBe('PASS');
  });

  it('PASS when a URL is stun:[<IPv6>]:<port>', () => {
    expect(verdictIceServers([{ urls: ['stun:[2001:db8::1]:3478'] }])).toBe('PASS');
  });

  it('FAIL when a URL names a hostname', () => {
    expect(verdictIceServers([{ urls: ['stun:stun.example.com:3478'] }])).toBe('FAIL');
    expect(verdictIceServers([{ urls: ['stun:global.stun.twilio.com:3478'] }])).toBe('FAIL');
  });

  it('FAIL when a URL is not a stun: URL', () => {
    expect(verdictIceServers([{ urls: ['turn:11.100.0.11:3478'] }])).toBe('FAIL');
  });

  it('FAIL when a URL has no port', () => {
    expect(verdictIceServers([{ urls: ['stun:11.100.0.11'] }])).toBe('FAIL');
  });
});

// --- verdictS2Priv1 --------------------------------------------------------

describe('verdictS2Priv1 reads reach — priv1Status (ok|behind), transport, path, anchor address and ICE', () => {
  // MESH_INTERFACE → Acceptance 2 — "The browser reaches the node behind
  // the endpoint-independent NAT over WebRTC signalled through a relay,
  // its data direct." Reach is `status ok or behind` on priv1's entry
  // (both say the client got a checked answer; `behind` is a ranking
  // outcome, not a reach failure) and a WebRTC-direct link on the
  // relayed-WebRTC anchor address. `nodeIdInUse` is recorded in the
  // measurement — a reader can see which node the client stayed on —
  // but it is not a condition: priv1 may rank below pub1 and still be
  // reached.

  const RELAY = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
  const PRIV = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';
  const RELAYED_WEBRTC = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY}/p2p-circuit/webrtc/p2p/${PRIV}`;
  const RELAYED_PLAIN = `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY}/p2p-circuit/p2p/${PRIV}`;

  function base() {
    return {
      expectedNodeId: 'aa'.repeat(32),
      priv1Status: 'ok',
      priv1Failures: 0,
      transport: 'webrtc',
      path: 'direct',
      anchorAddrRelayed: RELAYED_WEBRTC,
      connectMs: 1200,
      iceServers: [{ urls: ['stun:11.100.0.11:3478'] }],
      nodeIdInUse: 'aa'.repeat(32),
    };
  }

  it('skipped on missing measurement', () => {
    expect(verdictS2Priv1(null)).toBe('skipped');
    expect(verdictS2Priv1(undefined)).toBe('skipped');
  });

  it.fails('PASS on the full green shape (priv1Status ok)', () => {
    expect(verdictS2Priv1(base())).toBe('PASS');
  });

  it.fails('PASS when priv1 is behind — behind is a ranking, not a reach failure', () => {
    expect(verdictS2Priv1({ ...base(), priv1Status: 'behind' })).toBe('PASS');
  });

  it('FAIL when priv1 is retry (no answered proof)', () => {
    expect(verdictS2Priv1({ ...base(), priv1Status: 'retry' })).toBe('FAIL');
  });

  it('FAIL when priv1 is blacklisted', () => {
    expect(verdictS2Priv1({ ...base(), priv1Status: 'blacklisted' })).toBe('FAIL');
  });

  it('FAIL when priv1 is new (never tried)', () => {
    expect(verdictS2Priv1({ ...base(), priv1Status: 'new' })).toBe('FAIL');
  });

  it('FAIL when transport is not webrtc (the direct WebRTC upgrade did not land)', () => {
    expect(verdictS2Priv1({ ...base(), transport: 'webrtc-direct' })).toBe('FAIL');
  });

  it('FAIL when path is not direct (still relay-only)', () => {
    expect(verdictS2Priv1({ ...base(), path: 'relay' })).toBe('FAIL');
  });

  it('FAIL when anchorAddrRelayed does not hold /p2p-circuit/webrtc', () => {
    expect(verdictS2Priv1({ ...base(), anchorAddrRelayed: RELAYED_PLAIN })).toBe('FAIL');
  });

  it('FAIL when the ICE-server record carries a host name', () => {
    expect(verdictS2Priv1({ ...base(), iceServers: [{ urls: ['stun:stun.example.com:3478'] }] })).toBe('FAIL');
  });

  it('FAIL when no ICE record was captured (empty array)', () => {
    expect(verdictS2Priv1({ ...base(), iceServers: [] })).toBe('FAIL');
  });

  // --- mutation round --------------------------------------------------
  //
  // Each PASS condition is load-bearing; nodeIdInUse is NOT a condition.

  it.fails('MUTATION: nodeIdInUse is recorded, not a condition — null still PASS', () => {
    expect(verdictS2Priv1({ ...base(), nodeIdInUse: null })).toBe('PASS');
  });

  it.fails('MUTATION: nodeIdInUse is recorded, not a condition — a different node still PASS', () => {
    expect(verdictS2Priv1({ ...base(), nodeIdInUse: 'cc'.repeat(32) })).toBe('PASS');
  });

  it.fails('MUTATION: priv1Failures is recorded, not a condition — a non-zero count under ok still PASS', () => {
    // A past failure that recovered to `ok` records a failure count the
    // reader sees, but it does not FAIL the step on reach.
    expect(verdictS2Priv1({ ...base(), priv1Failures: 3 })).toBe('PASS');
  });

  it('MUTATION: expectedNodeId missing is FAIL (shape sanity)', () => {
    const m = base();
    // @ts-expect-error — remove a required field
    delete m.expectedNodeId;
    expect(verdictS2Priv1(m)).toBe('FAIL');
  });
});

// --- verdictS2Priv2 --------------------------------------------------------

describe('verdictS2Priv2 reads a retried entry with ≥1 failure, the page on another node', () => {
  // MESH_INTERFACE → NAT → "A relay carries signalling, not data" /
  // Acceptance 2 — "The node behind the symmetric NAT has no direct
  // path to the browser behind its NAT: it reads `retry`, never
  // `blacklisted`, and the client stays on a node it reaches." The
  // verdict reads a measurement the scenario builds across the poll
  // window; a mutation deleting any pass condition turns one of these
  // cases red.

  const PRIV2 = 'p2'.repeat(32);
  const OTHER = 'oo'.repeat(32);

  function base() {
    return {
      expectedNodeId: PRIV2,
      priv2Status: 'retry',
      priv2Failures: 2,
      priv2LastFailure: { kind: 'other', message: 'All multiaddr dials failed' },
      nodeIdInUse: OTHER,
      everInUse: false,
      blacklistedAtAnyPoll: false,
    };
  }

  it('skipped on missing measurement', () => {
    expect(verdictS2Priv2(null)).toBe('skipped');
    expect(verdictS2Priv2(undefined)).toBe('skipped');
    expect(verdictS2Priv2({})).toBe('skipped');
  });

  it('PASS on the full green shape', () => {
    expect(verdictS2Priv2(base())).toBe('PASS');
  });

  it('FAIL when priv2\'s status is blacklisted at the end', () => {
    expect(verdictS2Priv2({ ...base(), priv2Status: 'blacklisted' })).toBe('FAIL');
  });

  it('FAIL when priv2\'s status is ok (never retried)', () => {
    expect(verdictS2Priv2({ ...base(), priv2Status: 'ok' })).toBe('FAIL');
  });

  it('FAIL when priv2 has no recorded failure', () => {
    expect(verdictS2Priv2({ ...base(), priv2Failures: 0 })).toBe('FAIL');
  });

  it('FAIL when priv2 was blacklisted at any poll', () => {
    expect(verdictS2Priv2({ ...base(), blacklistedAtAnyPoll: true })).toBe('FAIL');
  });

  it('FAIL when the page reached no other node (nodeIdInUse null)', () => {
    expect(verdictS2Priv2({ ...base(), nodeIdInUse: null })).toBe('FAIL');
  });

  it('FAIL when the page\'s node in use is priv2 itself', () => {
    expect(verdictS2Priv2({ ...base(), nodeIdInUse: PRIV2 })).toBe('FAIL');
  });

  it('FAIL when expectedNodeId is missing', () => {
    const m = base();
    // @ts-expect-error — remove a required field
    delete m.expectedNodeId;
    expect(verdictS2Priv2(m)).toBe('FAIL');
  });
});

// --- s1 and s2 scenario wiring, through mocked execIn ---------------------

const TOPOLOGY_FIXTURE = {
  network: 'devnet',
  hosts: {
    browser: { role: 'browser', nat: 'endpoint-independent', parent: 'natC', addr: '10.103.0.11', veth: 'br', httpPort: 80 },
    pub1: {
      role: 'public', nat: 'none', addr: '10.100.0.11', veth: 'p1',
      mesh: { role: 'public', webrtcPort: 4001, tcpPort: 4002, stunPort: 3478 },
      node: { httpPort: 3100, p2pPort: 9100, role: 'miner' },
    },
    pub2: {
      role: 'public', nat: 'none', addr: '10.100.0.12', veth: 'p2',
      mesh: { role: 'public', webrtcPort: 4001, tcpPort: 4002, stunPort: 3478 },
      node: { httpPort: 3100, p2pPort: 9100, role: 'server' },
    },
  },
};

const RELAY_PEER_FIXTURE = '12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH';
const PRIV_PEER_FIXTURE = '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4';

function makeOutDir(opts: { anchorNotisId: string; identities: Record<string, unknown> }): string {
  const outDir = mkdtempSync(join(tmpdir(), 'mesh-scenario-'));
  mkdirSync(join(outDir, 'browser'), { recursive: true });
  const config = {
    network: 'devnet',
    anchors: [{
      notisId: opts.anchorNotisId,
      addrs: [`/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY_PEER_FIXTURE}`],
    }],
    stunServers: [],
    seeds: [],
  };
  writeFileSync(join(outDir, 'browser', 'config.json'), JSON.stringify(config));
  writeFileSync(join(outDir, 'browser', 'config.default.json'), JSON.stringify(config));
  writeFileSync(join(outDir, 'dns.log'), '');
  writeFileSync(join(outDir, 'identities.json'), JSON.stringify(opts.identities));
  return outDir;
}

function ctxFor(outDir: string): { dryRun: false; topology: unknown; outDir: string; pids: { pids: unknown[] }; nodeBin: string; cdpScript: string; invokingUser: string } {
  return {
    dryRun: false,
    topology: TOPOLOGY_FIXTURE,
    outDir,
    pids: { pids: [] },
    nodeBin: '/usr/bin/node',
    cdpScript: '/tmp/cdp.mjs',
    invokingUser: 'tester',
  };
}

describe('s1 wires the ICE-record step through cdp.mjs poll-ice', () => {
  // MESH_INTERFACE → Acceptance 1 — the ICE-record step is reached by
  // running the scenario with mocked `execIn`. Each `cdp.mjs` subcommand
  // is answered with a canned stdout, and the step's recorded verdict
  // reads the record from the `poll-ice` answer.

  const anchorNotisId = 'aa'.repeat(32);

  it('s1 issues one poll-ice call with the stage-canned ICE record and PASSes the step', async () => {
    execInMock.reset();
    const canned = { value: JSON.stringify({ nodeId: anchorNotisId }), iceRecord: [{ urls: [] }] };
    execInMock.setResponder((_ns, argv) => {
      if (argv.includes('poll-ice')) {
        return JSON.stringify(canned);
      }
      if (argv.includes('poll')) {
        return JSON.stringify({ nodeId: anchorNotisId });
      }
      return '{}';
    });
    const outDir = makeOutDir({
      anchorNotisId,
      identities: { pub1: { notisId: anchorNotisId, httpPort: 3100 } },
    });
    try {
      const result = await s1Scenario.run(ctxFor(outDir));
      const pollIceCalls = execInMock.calls.filter((c) => c.argv.includes('poll-ice'));
      expect(pollIceCalls.length, 's1 issues exactly one poll-ice call').toBe(1);
      const iceStep = result.steps.find((s: { name: string }) => s.name.includes('RTCPeerConnection'));
      expect(iceStep?.verdict, 'ICE step reads the canned record and PASSes').toBe('PASS');
      expect(iceStep?.measurement, 'measurement carries the iceServers from the record')
        .toMatchObject({ iceServers: [{ urls: [] }] });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('s2\'s priv1 step measures reach, not ranking', () => {
  // MESH_INTERFACE → Acceptance 2 — the step polls `poll-ice` on one
  // held page until priv1's entry carries `status` ok or behind AND a
  // non-null `transport` — reach, not ranking (priv1 may rank below
  // pub1 at check time, and the browser still reached it). Measurement:
  // `{ expectedNodeId, priv1Status, priv1Failures, transport, path,
  //    anchorAddrRelayed, connectMs, iceServers, nodeIdInUse }`.

  const priv1NotisId = 'aa'.repeat(32);
  const pub1NotisId = 'pp'.repeat(32);

  function identitiesFixture(): Record<string, unknown> {
    return {
      priv1: {
        notisId: priv1NotisId,
        httpPort: 3100,
        multiaddrs: [
          `/ip4/10.101.0.11/udp/4001/webrtc-direct`,
          `/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY_PEER_FIXTURE}/p2p-circuit/webrtc/p2p/${PRIV_PEER_FIXTURE}`,
        ],
      },
      pub1: {
        notisId: pub1NotisId,
        httpPort: 3100,
        multiaddrs: [`/ip4/10.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY_PEER_FIXTURE}`],
      },
    };
  }

  function cannedBehindState() {
    // priv1 answered a valid proof and is a block short of pub1 (the
    // live-stage case the step must still read as reach). pub1 is `ok`
    // and the node in use.
    return {
      nodeId: pub1NotisId,
      transport: 'webrtc-direct',
      path: 'direct',
      nodes: [
        {
          notisId: priv1NotisId, status: 'behind', failures: 0,
          lastFailure: null, transport: 'webrtc', path: 'direct',
        },
        {
          notisId: pub1NotisId, status: 'ok', failures: 0,
          lastFailure: null, transport: 'webrtc-direct', path: 'direct',
        },
      ],
    };
  }

  it.fails('polls poll-ice until priv1 answers and builds the reach measurement', async () => {
    execInMock.reset();
    const state = cannedBehindState();
    const iceRecord = [{ urls: ['stun:11.100.0.11:3478'] }];
    execInMock.setResponder((_ns, argv) => {
      if (argv.includes('poll-ice')) {
        return JSON.stringify({ value: JSON.stringify(state), iceRecord });
      }
      return '{}';
    });
    const outDir = makeOutDir({ anchorNotisId: priv1NotisId, identities: identitiesFixture() });
    try {
      const result = await s2Scenario.run(ctxFor(outDir));
      const pollIceCalls = execInMock.calls.filter((c) => c.argv.includes('poll-ice'));
      expect(pollIceCalls.length, 'priv1 issues exactly one poll-ice').toBe(1);
      const priv1Step = result.steps[0];
      expect(priv1Step?.measurement, 'priv1 step records the reach-shaped measurement').toMatchObject({
        expectedNodeId: priv1NotisId,
        priv1Status: 'behind',
        priv1Failures: 0,
        transport: 'webrtc',
        path: 'direct',
        iceServers: iceRecord,
        nodeIdInUse: pub1NotisId,
      });
      expect(priv1Step?.measurement, 'priv1 step records connectMs as a number')
        .toHaveProperty('connectMs');
      expect(typeof (priv1Step?.measurement as { connectMs?: unknown })?.connectMs).toBe('number');
      expect(priv1Step?.measurement, 'priv1 step records the dialled anchor address')
        .toHaveProperty('anchorAddrRelayed');
      expect(priv1Step?.verdict, 'priv1 PASSes on reach, even though it ranks behind pub1').toBe('PASS');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('does not reopen the page per poll — no cdp.mjs eval calls, only poll-ice', async () => {
    execInMock.reset();
    const state = cannedBehindState();
    const iceRecord = [{ urls: ['stun:11.100.0.11:3478'] }];
    execInMock.setResponder((_ns, argv) => {
      if (argv.includes('eval')) {
        return JSON.stringify(JSON.stringify(state));
      }
      if (argv.includes('poll-ice')) {
        return JSON.stringify({ value: JSON.stringify(state), iceRecord });
      }
      return '{}';
    });
    const outDir = makeOutDir({ anchorNotisId: priv1NotisId, identities: identitiesFixture() });
    try {
      await s2Scenario.run(ctxFor(outDir));
      const evalCalls = execInMock.calls.filter((c) => c.argv.includes('eval'));
      const pollIceCalls = execInMock.calls.filter((c) => c.argv.includes('poll-ice'));
      expect(evalCalls.length, 'no cdp.mjs eval calls (that would reopen the page per poll)').toBe(0);
      expect(pollIceCalls.length, 'at least one held-page poll-ice call for priv1').toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('s2\'s priv2 step', () => {
  // MESH_INTERFACE → NAT → "A relay carries signalling, not data" /
  // Acceptance 2 — priv2 is behind a symmetric NAT. The variant lists
  // priv2 by both its /p2p-circuit/webrtc and plain /p2p-circuit
  // addresses; the step polls one held page across the window, tracks
  // `everInUse` and `blacklistedAtAnyPoll` as an in-page accumulator,
  // and finishes when priv2's entry has ≥1 failure and the client's
  // nodeId is a non-null node other than priv2.

  const priv2NotisId = 'bb'.repeat(32);
  const otherNotisId = 'cc'.repeat(32);

  function identitiesFixture(): Record<string, unknown> {
    return {
      priv2: {
        notisId: priv2NotisId,
        httpPort: 3100,
        multiaddrs: [
          `/ip4/10.102.0.11/udp/4001/webrtc-direct`,
          `/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY_PEER_FIXTURE}/p2p-circuit/webrtc/p2p/${PRIV_PEER_FIXTURE}`,
        ],
      },
      pub2: {
        notisId: otherNotisId,
        httpPort: 3100,
        multiaddrs: [`/ip4/10.100.0.12/udp/4001/webrtc-direct/certhash/uEiA/p2p/${RELAY_PEER_FIXTURE}`],
      },
    };
  }

  function cannedPriv2State() {
    return {
      nodeId: otherNotisId,
      transport: 'webrtc-direct',
      path: 'direct',
      nodes: [
        { notisId: priv2NotisId, status: 'retry', failures: 2, lastFailure: { kind: 'other', message: 'All multiaddr dials failed' } },
      ],
    };
  }

  // MESH_INTERFACE → Acceptance 2 — the step holds ONE page open and
  // polls it; it never opens a fresh target per poll. `cdp.mjs eval`
  // opens a fresh target each call (through `evaluate()` →
  // `openTarget` + `closeTarget`), so the step must use `poll` or
  // `poll-ice` (which both keep one page open across polls). Red
  // first: the current step issues `eval` calls in a loop.
  //
  // The mock satisfies BOTH `eval` and `poll` responders so the
  // current (eval) loop exits on the first iteration too — then the
  // test's own assertion is the one that FAILs the test under
  // current, not a scenario timeout.
  it('issues one poll or poll-ice call for its whole window, never eval', async () => {
    execInMock.reset();
    const state = cannedPriv2State();
    const acc = { everInUse: false, blacklistedAtAnyPoll: false };
    execInMock.setResponder((_ns, argv) => {
      if (argv.includes('eval')) {
        // Current `cdpEval` reads a stringified JSON state from the
        // page's #state: `JSON.stringify(stateString)` as stdout.
        return JSON.stringify(JSON.stringify(state));
      }
      if (argv.includes('poll-ice') || argv.includes('poll')) {
        // New `cdp.mjs poll` writes `JSON.stringify(matchingValue)`;
        // the matching value is `JSON.stringify({ state, acc })`.
        return JSON.stringify(JSON.stringify({ state, acc }));
      }
      return '{}';
    });
    const outDir = makeOutDir({ anchorNotisId: priv2NotisId, identities: identitiesFixture() });
    try {
      await s2Scenario.run(ctxFor(outDir));
      const evalCalls = execInMock.calls.filter((c) => c.argv.includes('eval'));
      const pollCalls = execInMock.calls.filter((c) => c.argv.includes('poll') || c.argv.includes('poll-ice'));
      expect(evalCalls.length, 'no `cdp.mjs eval` calls for priv2 (that would reopen the page per poll)').toBe(0);
      expect(pollCalls.length, 'at least one held-page poll call for priv2').toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
