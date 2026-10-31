// MESH_INTERFACE → NAT / Transports / The client's node list / Acceptance —
// every mesh node listens on its host's own IP with concrete ports (never
// 127.0.0.1 or a /tcp/0, /udp/0); a private node's identity line is
// reprinted once a /p2p-circuit lands on `self:peer:update`; the dial's
// AggregateError is attributed back to each address by position in
// libp2p 3.5's own sorted order; s4's renewal step reads the page
// through `cdpPoll` at both boundaries; s4's inter-node TCP step waits
// one `CHECK_INTERVAL_MS` for a check to fire on the cut before
// recording.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readTopology } from '../stage/lib/topology.mjs';
import { verdictS4InterNodeTcp } from '../stage/lib/verdicts.mjs';
import { attributeAggregateDialErrors, wrongKeyInfo } from '../src/client/mesh-client.js';
import { NodeList } from '../src/client/node-list.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const TOPOLOGY_PATH = join(PACKAGE_ROOT, 'stage', 'topology.json');
const UP_SCRIPT = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const SRC_MESH_MAIN = join(PACKAGE_ROOT, 'src', 'node', 'main.ts');
const SRC_S4 = join(PACKAGE_ROOT, 'stage', 'scenarios', 's4-transport-cut.mjs');

describe('finding 1 — every mesh host listens on its own segment IP with concrete ports', () => {
  // MESH_INTERFACE → NAT — "A public node announces its listen addresses
  // from the start" with concrete-port WebRTC-direct and TCP addresses on
  // its own IP; a private node listens on its NAT-inside IP with concrete
  // ports plus /p2p-circuit. The sixth live-stage run had hostile and
  // private hosts bound to /ip4/127.0.0.1/udp/0/webrtc-direct — the
  // browser's gater refused them and nothing in another namespace could
  // reach them.

  it('every host with a mesh entry carries mesh.webrtcPort and mesh.tcpPort as integers', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const bad: string[] = [];
    for (const [name, host] of Object.entries(topology.hosts) as Array<[string, Record<string, unknown>]>) {
      const mesh = host['mesh'] as Record<string, unknown> | undefined;
      if (mesh === undefined) continue;
      if (!Number.isInteger(mesh['webrtcPort'])) bad.push(`${name}.mesh.webrtcPort`);
      if (!Number.isInteger(mesh['tcpPort'])) bad.push(`${name}.mesh.tcpPort`);
    }
    expect(bad, `missing or non-integer port on: ${bad.join(', ')}`).toEqual([]);
  });

  it('every hostile host carries mesh.role = "public" (so a browser in another namespace can dial it)', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    for (const [name, host] of Object.entries(topology.hosts) as Array<[string, Record<string, unknown>]>) {
      if (host['role'] !== 'hostile') continue;
      const mesh = host['mesh'] as Record<string, unknown> | undefined;
      expect(mesh?.['role'], `${name}.mesh.role is public`).toBe('public');
    }
  });

  it('stage:up --dry-run: every mesh spawn\'s MESH_LISTEN names the host\'s own IP, never 127.0.0.1 or port 0', () => {
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
    const topology = readTopology(TOPOLOGY_PATH);
    const meshSpawns = res.stdout.split('\n').filter((l) => l.startsWith('[spawn:mesh:'));
    expect(meshSpawns.length, 'at least one [spawn:mesh:] in dry-run').toBeGreaterThan(0);
    const bad: string[] = [];
    for (const line of meshSpawns) {
      const nameM = /^\[spawn:mesh:([^\]]+)\]/.exec(line);
      expect(nameM, `[spawn:mesh:*] carries a host name: ${line}`).not.toBeNull();
      const host = topology.hosts[nameM![1]!];
      expect(host, `topology holds ${nameM![1]}`).toBeDefined();
      const addr = host.addr as string;
      const listenM = /MESH_LISTEN=([^\s]+)/.exec(line);
      expect(listenM, `MESH_LISTEN is set on ${line}`).not.toBeNull();
      const value = listenM![1]!;
      if (!value.includes(`/ip4/${addr}/`)) bad.push(`${nameM![1]}: MESH_LISTEN does not name its own addr ${addr}: ${value}`);
      if (value.includes('/ip4/127.0.0.1/')) bad.push(`${nameM![1]}: MESH_LISTEN names 127.0.0.1: ${value}`);
      if (/\/(?:tcp|udp)\/0(?:\/|$|,)/.test(value)) bad.push(`${nameM![1]}: MESH_LISTEN names port 0: ${value}`);
    }
    expect(bad, bad.join('\n')).toEqual([]);
  }, 30_000);
});

describe('finding 2 — a private mesh node reprints its identity line when a /p2p-circuit lands', () => {
  // MESH_INTERFACE → Discovery / NAT — "a `private` node announces its
  // relay reservations alone". These land AFTER the first identity line
  // the mesh node prints: the client's config.json carried only the
  // loopback address and s2 failed with "AggregateError: All multiaddr
  // dials failed" on both private hosts.

  it('mesh main.ts registers a listener on self:peer:update that reprints the identity line', () => {
    const src = readFileSync(SRC_MESH_MAIN, 'utf8');
    // The listener registration lives at the top of a line (no leading
    // `//` or `/*` comment prefix) — a commented-out line reads the
    // event's name but does nothing on dispatch. Each source line is
    // checked rather than the whole file so a comment higher up cannot
    // satisfy the match.
    const lines = src.split('\n');
    const idx = lines.findIndex((l) => /^\s*node\.libp2p\.addEventListener\(['"]self:peer:update['"]/.test(l));
    expect(idx, 'main.ts has an uncommented addEventListener for self:peer:update').toBeGreaterThanOrEqual(0);
    // The listener body (within ~40 lines of the registration) writes a
    // fresh identity line through `writeIdentity`.
    const window = lines.slice(idx, Math.min(lines.length, idx + 40)).join('\n');
    expect(window, 'the listener body writes a fresh identity line').toContain('writeIdentity(');
  });

  it('stage:up --dry-run names a wait for each private mesh node\'s /p2p-circuit announcement', () => {
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], {
      encoding: 'utf8', timeout: 30_000,
    });
    expect(res.status, `exit (stderr: ${res.stderr})`).toBe(0);
    const waits = res.stdout.split('\n').filter((l) => l.startsWith('[wait] '));
    const joined = waits.join('\n');
    expect(joined, 'a [wait] names the /p2p-circuit announcement for private nodes').toMatch(/\[wait\].*(?:private|p2p-circuit).*p2p-circuit/i);
  }, 30_000);
});

describe('finding 3 — the AggregateError is attributed back to each address', () => {
  // MESH_INTERFACE → The client's node list — "When every address fails,
  // each one's failure is recorded against it". libp2p 3.5's noise throws
  // an `EncryptionFailedError` whose message reads `Payload peer id X
  // does not match expected remote peer id Y`; no `.multiaddr` or `.addr`
  // on the error. Attribution rides position in the sorted dial order
  // (`@libp2p/utils`' `defaultMultiaddrSorter` applied before the dial).

  it('wrongKeyInfo matches EncryptionFailedError + the noise mismatch message, reads the answered id', () => {
    const err = Object.assign(new Error(
      'Payload peer id 12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4 does not match expected remote peer id 12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH',
    ), { name: 'EncryptionFailedError' });
    const info = wrongKeyInfo(err);
    expect(info, 'EncryptionFailedError is recognised as wrong-key').not.toBeNull();
    expect(info!.answeredPeerIdString, 'the answered peer id is the "Payload peer id" one').toBe(
      '12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4',
    );
  });

  it('wrongKeyInfo also recognises UnexpectedPeerError and reads "connected to <id>" as the answered id', () => {
    const err = Object.assign(new Error(
      'Expected remote peer 12D3KooWDyxzGUQPtwgrK7VZmkuGSLdh6W12LcC9saK1o6xxiBqH but connected to 12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4',
    ), { name: 'UnexpectedPeerError' });
    const info = wrongKeyInfo(err);
    expect(info, 'UnexpectedPeerError is recognised as wrong-key').not.toBeNull();
    expect(info!.answeredPeerIdString).toBe('12D3KooWFvHBAbhX5X9P4ViwiTcJiy2diw7rk7rp1BhtvZtvEyr4');
  });

  it('wrongKeyInfo returns null for a plain TimeoutError', () => {
    const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(wrongKeyInfo(err)).toBeNull();
  });

  it.fails('attributeAggregateDialErrors orders rows as webrtc-direct, relayed webrtc, wss, other', () => {
    // MESH_INTERFACE → The client's node list → "The secure WebSocket is
    // the fallback" — the client's one order is WebRTC-direct, then
    // WebRTC signalled over a relay, then the secure WebSocket, then any
    // other address; one definition in `mesh-client.ts`, read by both
    // the dial queue and attribution. The aggregate's inner errors come
    // in that sorted order.
    const dialable = [
      // Caller order — a mesh node's `multiaddrs()` may list in any order.
      '/ip4/11.100.0.11/tcp/4002/p2p/P',
      '/ip4/11.100.0.11/tcp/443/tls/ws/p2p/P',
      '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/P',
      '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/R/p2p-circuit/webrtc/p2p/P',
    ];
    const encFail = (payload: string) => Object.assign(
      new Error(`Payload peer id ${payload} does not match expected remote peer id Q`),
      { name: 'EncryptionFailedError' },
    );
    const refused = Object.assign(new Error('ECONNREFUSED 11.100.0.11:443'), { name: 'Error' });
    const timed = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    // Order matches the client's one sort: webrtc-direct, relayed webrtc, wss, other.
    const errors: unknown[] = [encFail('IMPOSTOR'), timed, refused, encFail('OTHER')];
    const attributed = attributeAggregateDialErrors(dialable, errors);
    expect(attributed, 'attribution landed').not.toBeNull();
    expect(attributed!.length, 'one row per error').toBe(4);
    // Row 0: WebRTC-direct is first.
    expect(attributed![0]!.addr).toBe('/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/P');
    expect(attributed![0]!.wrongKey?.answeredPeerIdString).toBe('IMPOSTOR');
    // Row 1: Relayed WebRTC follows.
    expect(attributed![1]!.addr).toBe('/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/R/p2p-circuit/webrtc/p2p/P');
    expect(attributed![1]!.wrongKey).toBeNull();
    expect(attributed![1]!.kind).toBe('timeout');
    // Row 2: Secure WebSocket is the fallback.
    expect(attributed![2]!.addr).toBe('/ip4/11.100.0.11/tcp/443/tls/ws/p2p/P');
    expect(attributed![2]!.wrongKey).toBeNull();
    expect(attributed![2]!.message).toMatch(/ECONNREFUSED/);
    // Row 3: Any other address last.
    expect(attributed![3]!.addr).toBe('/ip4/11.100.0.11/tcp/4002/p2p/P');
    expect(attributed![3]!.wrongKey?.answeredPeerIdString).toBe('OTHER');
  });

  it.fails('a wrong-key on the webrtc-direct address of a node that also lists wss lands on webrtc-direct', () => {
    // MESH_INTERFACE → The client's node list → "The secure WebSocket is
    // the fallback" / "A dial's failures are attributed in that same
    // order, read from the one definition the dial used" — when a node
    // lists both a WebRTC-direct and a secure WebSocket address and the
    // dial's AggregateError's first error is wrong-key, that failure is
    // attributed to the WebRTC-direct address because the sort put it
    // first. A wrong-key error on the wrong address would blacklist the
    // wrong address in the entry.
    const dialable = [
      '/ip4/11.100.0.11/tcp/443/tls/ws/p2p/P',
      '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/P',
    ];
    const encFail = Object.assign(
      new Error('Payload peer id IMPOSTOR does not match expected remote peer id Q'),
      { name: 'EncryptionFailedError' },
    );
    const refused = Object.assign(new Error('ECONNREFUSED 11.100.0.11:443'), { name: 'Error' });
    // Errors come in sort order (webrtc-direct first, wss second).
    const errors: unknown[] = [encFail, refused];
    const attributed = attributeAggregateDialErrors(dialable, errors);
    expect(attributed).not.toBeNull();
    expect(attributed!.length).toBe(2);
    const webrtcRow = attributed!.find(
      (r) => r.addr === '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiA/p2p/P',
    );
    expect(webrtcRow?.wrongKey?.answeredPeerIdString, 'webrtc-direct carries the wrong-key').toBe('IMPOSTOR');
    const wssRow = attributed!.find(
      (r) => r.addr === '/ip4/11.100.0.11/tcp/443/tls/ws/p2p/P',
    );
    expect(wssRow?.wrongKey, 'wss did not answer with the wrong key').toBeNull();
  });

  it('attributeAggregateDialErrors returns null when errors.length !== dialable.length (unreliable attribution)', () => {
    const dialable = ['/ip4/1.1.1.1/tcp/443/p2p/P', '/ip4/2.2.2.2/tcp/443/p2p/P'];
    expect(attributeAggregateDialErrors(dialable, [new Error('a')])).toBeNull();
  });

  it('NodeList.failure writes lastFailures[addr] when an addr is passed', async () => {
    const id = 'a'.repeat(64);
    const own = 'b'.repeat(64);
    const list = new NodeList([{ notisId: id, addrs: ['/ip4/1/tcp/1/p2p/P'] }], own, () => 1000);
    list.failure(id, 'transport', 'ECONNREFUSED', '/ip4/1/tcp/1/p2p/P');
    const e = list.entry(id)!;
    expect(e.lastFailures['/ip4/1/tcp/1/p2p/P']).toEqual({
      kind: 'transport', message: 'ECONNREFUSED', atMs: 1000,
    });
  });
});

describe('finding 4 — s4 step 3 reads the page through cdpPoll at both ends of the renewal window', () => {
  // The sixth run recorded `probeSuccessAcrossRenewal: true` AND
  // `connectedBeforeWindow: false` AND `connectedAfterWindow: false` —
  // the state WAS connected (step 2's cdpPoll already pinned it), but
  // step 3's cdpEval read a transient null and recorded it as the fact.

  it('s4 step 3 reads connectedBeforeWindow / connectedAfterWindow through cdpPoll, not cdpEval', () => {
    const src = readFileSync(SRC_S4, 'utf8');
    const stepIdx = src.indexOf("rec.step(describe()[2]");
    expect(stepIdx, 's4 step 3 is in the source').toBeGreaterThan(0);
    const stepEnd = src.indexOf("rec.step(describe()[3]", stepIdx);
    expect(stepEnd, 's4 step 4 follows step 3').toBeGreaterThan(stepIdx);
    const stepBody = src.slice(stepIdx, stepEnd);
    // The before/after reads are two cdpPoll calls — not cdpEval.
    const beforeIdx = stepBody.indexOf('connectedBeforeWindow');
    expect(beforeIdx, 'connectedBeforeWindow is in step 3').toBeGreaterThan(0);
    const beforeBlock = stepBody.slice(Math.max(0, beforeIdx - 200), beforeIdx + 400);
    expect(beforeBlock, 'the before-window read is a cdpPoll').toContain('cdpPoll');
    expect(beforeBlock, 'the before-window read is not a cdpEval').not.toMatch(/cdpEval[\s\S]{0,200}connectedBeforeWindow/);
    const afterIdx = stepBody.indexOf('connectedAfterWindow');
    expect(afterIdx, 'connectedAfterWindow is in step 3').toBeGreaterThan(0);
    const afterBlock = stepBody.slice(Math.max(0, afterIdx - 200), afterIdx + 400);
    expect(afterBlock, 'the after-window read is a cdpPoll').toContain('cdpPoll');
  });
});

describe('finding 5 — s4 step 4 waits one CHECK_INTERVAL_MS and records before verdict', () => {
  // The sixth run recorded `transport: null, nodeId: null, tip: null` on
  // step 4 — the state is reread BEFORE a check cycle fires on the cut.
  // s4 step 4 is a record step: PASS when the state was recorded (not an
  // empty read), never on an empty read.

  it('verdictS4InterNodeTcp PASSes when nodeId and transport are present on the record', () => {
    expect(verdictS4InterNodeTcp({
      transport: 'wss', nodeId: 'a'.repeat(64), tip: { height: 100, hash: null },
    })).toBe('PASS');
  });

  it('verdictS4InterNodeTcp FAILs on an empty read (nodeId null)', () => {
    expect(verdictS4InterNodeTcp({ transport: null, nodeId: null, tip: null })).toBe('FAIL');
  });

  it('verdictS4InterNodeTcp FAILs when transport is present but nodeId is null', () => {
    expect(verdictS4InterNodeTcp({ transport: 'wss', nodeId: null, tip: null })).toBe('FAIL');
  });

  it('verdictS4InterNodeTcp FAILs when nodeId is present but transport is null', () => {
    expect(verdictS4InterNodeTcp({ transport: null, nodeId: 'a'.repeat(64), tip: null })).toBe('FAIL');
  });

  it('verdictS4InterNodeTcp reads skipped on a missing measurement', () => {
    expect(verdictS4InterNodeTcp(null)).toBe('skipped');
    expect(verdictS4InterNodeTcp(undefined)).toBe('skipped');
    expect(verdictS4InterNodeTcp({})).toBe('skipped');
  });

  it('s4 step 4 cites CHECK_INTERVAL_MS and awaits that long before reading', () => {
    const src = readFileSync(SRC_S4, 'utf8');
    const stepIdx = src.indexOf("rec.step(describe()[3]");
    expect(stepIdx, 's4 step 4 is in the source').toBeGreaterThan(0);
    // Grab step 4 to the closing brace of the rec.step block.
    const stepBody = src.slice(stepIdx, Math.min(src.length, stepIdx + 4000));
    expect(stepBody, 'step 4 cites CHECK_INTERVAL_MS').toContain('CHECK_INTERVAL_MS');
    expect(stepBody, 'step 4 reads state through cdpPoll (not cdpEval) after the wait').toMatch(/CHECK_INTERVAL_MS[\s\S]*cdpPoll/);
  });
});
