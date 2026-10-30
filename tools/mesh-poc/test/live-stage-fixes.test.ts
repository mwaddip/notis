// MESH_INTERFACE → Discovery / Acceptance — the seven defects main
// surfaced on the live stage at `bec3efbf`. Each case is red against
// the pre-fix code and green under the fix.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { buildPageConfig } from '../stage/lib/config.mjs';
import { readTopology } from '../stage/lib/topology.mjs';
import {
  verdictS1DnsSilent,
  verdictS4Renewal,
} from '../stage/lib/verdicts.mjs';
import { messageOf } from '../src/client/mesh-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const TOPOLOGY_PATH = join(PACKAGE_ROOT, 'stage', 'topology.json');
const UP_SCRIPT = join(PACKAGE_ROOT, 'stage', 'up.mjs');
const RUN_SCRIPT = join(PACKAGE_ROOT, 'stage', 'run.mjs');

describe('fix 1 — config.json carries a /certhash/ on every WebRTC-direct address', () => {
  it('exec-mode: a public anchor whose realMultiaddrs lack /certhash/ fails fast', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const notisIds: Record<string, string> = {
      pub1: 'a'.repeat(64),
      pub2: 'b'.repeat(64),
    };
    // Exec-mode: if a public anchor's mesh node did not print a /certhash/
    // WebRTC-direct multiaddr, the browser gater refuses to dial. The
    // builder has to raise rather than silently emit a non-certhash
    // address.
    const realMultiaddrs = {
      pub1: ['/ip4/11.100.0.11/udp/4001/webrtc-direct/p2p/PA'], // no /certhash/
      pub2: ['/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/uEiA/p2p/PB'],
    };
    expect(() => buildPageConfig(topology, notisIds, realMultiaddrs)).toThrow(/certhash/i);
  });
  it('dry-run output (opt-in) has a /certhash/ placeholder on every /webrtc-direct/ address', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const notisIds: Record<string, string> = {
      pub1: 'a'.repeat(64),
      pub2: 'b'.repeat(64),
    };
    // Dry-run opt-in: the placeholder is only valid under `{ dryRun: true }`.
    const config = buildPageConfig(topology, notisIds, undefined, { dryRun: true });
    for (const anchor of config.anchors) {
      for (const addr of anchor.addrs) {
        if (addr.includes('/webrtc-direct/')) {
          expect(addr, `/webrtc-direct/ addr has /certhash/: ${addr}`).toContain('/certhash/');
        }
      }
    }
  });
  it('exec-mode without realMultiaddrs throws (no placeholder fallback)', () => {
    // Live-stage failure main caught: the dry-run placeholder leaked
    // into real config.json. The builder must never fall back to a
    // placeholder when `dryRun` is not passed.
    const topology = readTopology(TOPOLOGY_PATH);
    const notisIds: Record<string, string> = {
      pub1: 'a'.repeat(64),
      pub2: 'b'.repeat(64),
    };
    expect(() => buildPageConfig(topology, notisIds)).toThrow();
  });
  it('exec-mode: every WebRTC-direct address in output equals one a node printed', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const notisIds: Record<string, string> = {
      pub1: 'a'.repeat(64),
      pub2: 'b'.repeat(64),
    };
    const printed = {
      pub1: [
        '/ip4/11.100.0.11/udp/4001/webrtc-direct/certhash/uEiAREAL1/p2p/PA',
        '/ip4/11.100.0.11/tcp/443/tls/ws/p2p/PA',
      ],
      pub2: [
        '/ip4/11.100.0.12/udp/4001/webrtc-direct/certhash/uEiAREAL2/p2p/PB',
      ],
    };
    const config = buildPageConfig(topology, notisIds, printed);
    for (const anchor of config.anchors) {
      for (const addr of anchor.addrs) {
        if (!addr.includes('/webrtc-direct/')) continue;
        const emittedByNode = Object.values(printed).some((list) => list.includes(addr));
        expect(emittedByNode, `addr ${addr} must equal one a node printed`).toBe(true);
      }
    }
  });
});

describe('fix — a public mesh node announces its listen addresses at once', () => {
  // libp2p 3.5's `AddressManager.getAddresses()` filters by `verified`;
  // `TransportAddresses.get()` sets `verified: !isPrivate(ma)` on first
  // read (`node_modules/.../libp2p/src/address-manager/transport-addresses.ts`
  // lines 32-47). A public IP therefore reads unverified until AutoNAT
  // or an observed-address path calls `confirm(ma)` — so pub1 with a
  // public listen address announces NOTHING at start. The public API
  // that bypasses this: pass `addresses.announce: [...]`. The
  // `getAddressesWithMetadata` branch at
  // `node_modules/.../libp2p/src/address-manager/index.ts` lines 391-408
  // reads: when the announce list is non-empty, every announce entry
  // reads as verified AND every transport listener's
  // `updateAnnounceAddrs(announceMultiaddrs)` runs. WebRTC-direct's
  // listener (`node_modules/.../@libp2p/webrtc/src/private-to-public/
  // listener.ts` lines 246-276) walks the announce list and splices
  // its `/certhash/` into every `/webrtc-direct/` multiaddr. So the
  // right fix is: for a `public` mesh node, default `announce` to
  // `listen`; the certhash lands onto the announced WebRTC-direct
  // address at once.
  it('effectiveAnnounce for a public role with no explicit announce reads as the listen list', async () => {
    const { effectiveAnnounce } = await import('../src/node/mesh-node.js');
    expect(effectiveAnnounce({
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct', '/ip4/11.100.0.11/tcp/4002'],
    })).toEqual(['/ip4/11.100.0.11/udp/4001/webrtc-direct', '/ip4/11.100.0.11/tcp/4002']);
  });
  it('effectiveAnnounce honours an explicit announce (public role)', async () => {
    const { effectiveAnnounce } = await import('../src/node/mesh-node.js');
    expect(effectiveAnnounce({
      role: 'public',
      listen: ['/ip4/11.100.0.11/udp/4001/webrtc-direct'],
      announce: ['/ip4/other/udp/0/webrtc-direct'],
    })).toEqual(['/ip4/other/udp/0/webrtc-direct']);
  });
  it('effectiveAnnounce for a private role defaults to undefined (relay reservations announce themselves)', async () => {
    const { effectiveAnnounce } = await import('../src/node/mesh-node.js');
    expect(effectiveAnnounce({
      role: 'private',
      listen: ['/ip4/10.101.0.11/udp/4001/webrtc-direct'],
    })).toBeUndefined();
  });
  it('startMeshNode on a public role with no announce has a non-empty multiaddrs() at start with /certhash/', async () => {
    // Loopback is PRIVATE per `isPrivate`, so it reads verified via the
    // transport-address path too — this smoke test asserts the overall
    // shape without catching the specific bug (that fires on a public
    // range listen). The three pure cases above assert the real fix.
    const { startMeshNode } = await import('../src/node/mesh-node.js');
    const { generateKeyPair } = await import('@dagsocial/types');
    const { nodeKeyFromKeyPair } = await import('../src/identity.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const stateDir = mkdtempSync(join(tmpdir(), 'mesh-publ-'));
    try {
      const key = nodeKeyFromKeyPair(generateKeyPair());
      const node = await startMeshNode({
        key, network: 'devnet', role: 'public',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        bootstrap: [],
        stateDir,
        upstream: 'http://127.0.0.1:9/does-not-matter',
      });
      try {
        const addrs = node.multiaddrs();
        expect(addrs.length, 'public node announces at least one address at start').toBeGreaterThan(0);
        const webrtc = addrs.filter((a) => a.includes('/webrtc-direct/'));
        expect(webrtc.length, 'webrtc-direct announced').toBeGreaterThan(0);
        for (const a of webrtc) {
          expect(a, `/certhash/ on ${a}`).toContain('/certhash/');
        }
      } finally {
        await node.stop();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('fix 1 — isTipShape reads `{height, hash}` the way readBlockCurrent does', () => {
  it('isTipShape accepts the node\'s own answer `{height, hash}` with a 64-hex hash', async () => {
  
    const { isTipShape } = await import('../src/client/mesh-client.js');
    // The node's /blocks/current answers `{ height, hash }` where hash is
    // 64 lowercase hex. The web client's reader is the reference:
    // packages/web/src/api/readers.ts `readBlockCurrent`.
    expect(isTipShape({ height: 1192, hash: '4e2eeb1d' + 'ab'.repeat(28) })).toBe(true);
  });
  it('isTipShape accepts the genesis marker `{height: 0, hash: null}`', async () => {

    const { isTipShape } = await import('../src/client/mesh-client.js');
    expect(isTipShape({ height: 0, hash: null })).toBe(true);
  });
  it('isTipShape rejects `{height, id}` (the old shape that blacklisted every honest node)', async () => {

    const { isTipShape } = await import('../src/client/mesh-client.js');
    expect(isTipShape({ height: 1, id: 'ab'.repeat(32) })).toBe(false);
  });
  it('isTipShape rejects a non-hex hash', async () => {

    const { isTipShape } = await import('../src/client/mesh-client.js');
    expect(isTipShape({ height: 1, hash: 'not-hex' })).toBe(false);
    expect(isTipShape({ height: 1, hash: 'AB'.repeat(32) })).toBe(false);
  });
  it('isTipShape rejects a negative or non-integer height', async () => {

    const { isTipShape } = await import('../src/client/mesh-client.js');
    expect(isTipShape({ height: -1, hash: 'ab'.repeat(32) })).toBe(false);
    expect(isTipShape({ height: 1.5, hash: 'ab'.repeat(32) })).toBe(false);
  });
});

describe('fix 2 — up writes every mesh host\'s multiaddrs; buildHostileSeeds reads them', () => {
  it('buildHostileSeeds uses the printed multiaddrs when identities.json carries them', async () => {
    const { buildHostileSeeds } = await import('../stage/lib/config-variants.mjs');
    const identities = {
      'hostile-malformed': {
        notisId: 'c'.repeat(64),
        meshRole: 'private',
        multiaddrs: ['/ip4/11.100.0.31/tcp/4002/p2p/HMPEER'],
      },
    };
    const topology = {
      hosts: {
        'hostile-malformed': {
          role: 'hostile', addr: '11.100.0.31',
          mesh: { role: 'private', tcpPort: 4002 },
          node: { p2pPort: 9100 },
        },
      },
    };
    const seeds = buildHostileSeeds(identities, topology, { peerIdStringOf: () => 'FALLBACK' });
    expect(seeds.length).toBe(1);
    // When identities.multiaddrs is set, the printed address is used (not
    // the fallback peerIdStringOf path).
    expect(seeds[0]!.addrs[0]).toBe('/ip4/11.100.0.31/tcp/4002/p2p/HMPEER');
  });
  it('buildHostileSeeds falls back to the topology path when a host has no printed multiaddrs', async () => {
    const { buildHostileSeeds } = await import('../stage/lib/config-variants.mjs');
    const identities = {
      'hostile-malformed': { notisId: 'c'.repeat(64), meshRole: 'private' /* no multiaddrs */ },
    };
    const topology = {
      hosts: {
        'hostile-malformed': { role: 'hostile', addr: '11.100.0.31', mesh: { role: 'private', tcpPort: 4002 } },
      },
    };
    const seeds = buildHostileSeeds(identities, topology, { peerIdStringOf: (id: string) => `peer-${id.slice(0, 4)}` });
    expect(seeds.length).toBe(1);
    expect(seeds[0]!.addrs[0]).toBe('/ip4/11.100.0.31/tcp/4002/p2p/peer-cccc');
  });
});

describe('PEER_DIAL_MIN_MS — the dial deadline floor from the contract', () => {
  it("mesh-client cites PEER_DIAL_MIN_MS, not the literal 20_000, for the whole-peer dial deadline", () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'mesh-client.ts'), 'utf8');
    // The literal has to be gone: a `20_000` number inside the dial
    // path is the kind of edit that drifts from the contract.
    expect(src, 'the mesh-client body does not carry a 20_000 literal').not.toMatch(/Math\.max\([^)]*,\s*20_?000\s*\)/);
    // PEER_DIAL_MIN_MS is imported and used.
    expect(src, 'PEER_DIAL_MIN_MS is imported').toMatch(/import\s+\{[^}]*\bPEER_DIAL_MIN_MS\b[^}]*\}\s+from\s+['"]\.\.\/protocols\.js['"]/);
    expect(src, 'PEER_DIAL_MIN_MS is used in the dial-deadline computation').toMatch(/Math\.max\([^)]*PEER_DIAL_MIN_MS[^)]*\)/);
  });
  it("PEER_DIAL_MIN_MS is exported from protocols.ts at 20_000", async () => {
    const { PEER_DIAL_MIN_MS } = await import('../src/protocols.js');
    expect(PEER_DIAL_MIN_MS).toBe(20_000);
  });
  it('a one-address dial\'s deadline is PEER_DIAL_MIN_MS (not DIAL_TIMEOUT_MS alone)', async () => {
    const { PEER_DIAL_MIN_MS, DIAL_TIMEOUT_MS } = await import('../src/protocols.js');
    // The deadline for N addresses is `max(N * DIAL_TIMEOUT_MS, PEER_DIAL_MIN_MS)`.
    // With N=1, DIAL_TIMEOUT_MS=3_000 is below PEER_DIAL_MIN_MS=20_000, so
    // the floor binds and the dial gets 20 s. Pure arithmetic — the shape
    // of the deadline formula is what this case pins.
    const dialDeadline = Math.max(1 * DIAL_TIMEOUT_MS, PEER_DIAL_MIN_MS);
    expect(dialDeadline, 'one-address dial deadline').toBe(PEER_DIAL_MIN_MS);
  });
});

describe('fix 3 — dialByAddresses passes the whole address list to one libp2p.dial call', () => {
  // libp2p 3.5's dial queue (`libp2p/src/connection-manager/dial-queue.ts`
  // lines 157-188) joins a NEW dial for the same peer to a PENDING dial;
  // the hung WebRTC-direct dial survives our 3 s abort and the WSS dial
  // joins it and times out WITH it. The fix: one `libp2p.dial(ma[])`
  // call with every address — libp2p's own happy-eyeballs runs each,
  // its ADDRESS_DIAL_TIMEOUT=6 s binds each one internally, and our
  // whole-peer signal binds the operation.
  it('dialByAddresses passes an array of multiaddrs to libp2p.dial (one call for all addrs)', () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'src', 'client', 'mesh-client.ts'), 'utf8');
    // Source-grep: the function must call `.dial(` with an array of
    // multiaddrs (one call total, not one per address).
    const body = /private async dialByAddresses[\s\S]*?\n  \}\n/.exec(src);
    expect(body, 'dialByAddresses body found').not.toBeNull();
    const text = body![0];
    // Count dial calls in the body — must be exactly 1.
    const dialCalls = text.match(/this\.libp2p\.dial\s*\(/g) ?? [];
    expect(dialCalls.length, `exactly one this.libp2p.dial call; got ${dialCalls.length}`).toBe(1);
    // The call takes an ARRAY of multiaddrs (a variable, an array
    // literal, or a `.map(...)` result).
    expect(text, 'libp2p.dial called with an array of multiaddrs').toMatch(/this\.libp2p\.dial\s*\(\s*(?:multiaddrs|\[|[A-Za-z_$][\w$]*\.map\()/);
  });
});

describe('fix 5 — s3 reads #state through cdpPoll, the way s1 does', () => {
  it('s3 does not call pollUntil(checkState) with a cdpEval-based checkState', () => {
    const src = readFileSync(join(PACKAGE_ROOT, 'stage', 'scenarios', 's3-node-goes-away.mjs'), 'utf8');
    // The failing pattern: `pollUntil(checkState, ...)` where checkState
    // calls `cdpEval`. The fix uses `cdpPoll` (one target held open
    // across polls, same as s1).
    expect(src, 's3 does not pollUntil(checkState)').not.toMatch(/pollUntil\s*\(\s*checkState/);
  });
});

describe('fix 6 — s1 brackets /blocks/current between two direct reads (race, not mismatch)', () => {
  it('verdictS1Probe passes when probe equals EITHER directBefore or directAfter', async () => {
    const { verdictS1Probe } = await import('../stage/lib/verdicts.mjs');
    // Tip moved between probe and the first direct read; the probe
    // matches the SECOND (post-probe) direct read.
    expect(verdictS1Probe({
      probePath: '/blocks/current',
      probe: { sha256: 'bb'.repeat(32), bytes: 88 },
      directBefore: { sha256: 'aa'.repeat(32), bytes: 88 },
      directAfter: { sha256: 'bb'.repeat(32), bytes: 88 },
    })).toBe('PASS');
  });
  it('verdictS1Probe passes when probe equals the pre-probe direct read', async () => {
    const { verdictS1Probe } = await import('../stage/lib/verdicts.mjs');
    expect(verdictS1Probe({
      probePath: '/blocks/current',
      probe: { sha256: 'aa'.repeat(32), bytes: 88 },
      directBefore: { sha256: 'aa'.repeat(32), bytes: 88 },
      directAfter: { sha256: 'bb'.repeat(32), bytes: 88 },
    })).toBe('PASS');
  });
});

describe('fix 7 — lastFailures keeps one entry per address', () => {
  it('NodeList.failure(id, kind, msg, addr) records lastFailures[addr]', async () => {
    const { NodeList } = await import('../src/client/node-list.js');
    const id = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    let now = 100;
    const list = new NodeList(
      [{ notisId: id, addrs: ['/ip4/1.1.1.1/tcp/1/p2p/P1', '/ip4/2.2.2.2/tcp/2/p2p/P2'] }],
      other,
      () => now,
    );
    now = 200;
    (list as unknown as { failure: (id: string, k: string, m: string, a: string) => void }).failure(
      id, 'timeout', 'TimeoutError: /ip4/1.1.1.1', '/ip4/1.1.1.1/tcp/1/p2p/P1',
    );
    now = 300;
    (list as unknown as { failure: (id: string, k: string, m: string, a: string) => void }).failure(
      id, 'transport', 'DialDeniedError: /ip4/2.2.2.2', '/ip4/2.2.2.2/tcp/2/p2p/P2',
    );
    const e = list.entry(id)! as unknown as { lastFailures?: Record<string, { message: string }>; lastFailure: unknown };
    expect(e.lastFailures, 'lastFailures is a map by address').toBeDefined();
    expect(e.lastFailures!['/ip4/1.1.1.1/tcp/1/p2p/P1']!.message).toContain('TimeoutError');
    expect(e.lastFailures!['/ip4/2.2.2.2/tcp/2/p2p/P2']!.message).toContain('DialDeniedError');
    expect(e.lastFailure).not.toBeNull();
  });
  it('a success clears lastFailures entirely', async () => {
    const { NodeList } = await import('../src/client/node-list.js');
    const id = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const list = new NodeList(
      [{ notisId: id, addrs: ['/ip4/1.1.1.1/tcp/1/p2p/P1'] }],
      other,
      () => 100,
    );
    (list as unknown as { failure: (id: string, k: string, m: string, a: string) => void }).failure(
      id, 'timeout', 'TimeoutError', '/ip4/1.1.1.1/tcp/1/p2p/P1',
    );
    expect((list.entry(id)! as unknown as { lastFailures?: Record<string, unknown> }).lastFailures?.['/ip4/1.1.1.1/tcp/1/p2p/P1']).toBeDefined();
    list.success(id);
    expect((list.entry(id)! as unknown as { lastFailures?: Record<string, unknown> }).lastFailures ?? {}).toEqual({});
  });
});

describe('fix cert — certutil trust is C,, (not ,,) and up verifies it', () => {
  it("up --dry-run installs pebble-root with trust 'C,,' (CA for SSL servers)", () => {
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(0);
    const addLine = res.stdout.split('\n').find((l) => /\bcertutil\b/.test(l) && / -A /.test(l) && l.includes('pebble-root'));
    expect(addLine, 'certutil -A line is in the dry-run').toBeDefined();
    // `,,` means no trust; a CA trusted for TLS servers is `C,,`.
    expect(addLine, 'certutil -A uses -t C,,').toMatch(/-t\s+C,,/);
    expect(addLine, "certutil -A does not use -t ',,' (no trust)").not.toMatch(/-t\s+'?,,'?(?:\s|$)/);
  }, 30_000);
  it("up --dry-run reads the LIST form of certutil -L (no -n) and anchors the grep to the pebble-root row", () => {
    // Main measured in a scratch NSS db: `certutil -L -d <db> -n <nick>`
    // prints the trust in WORDS ("Certificate Trust Flags: / SSL Flags:
    // / Valid CA"), never `C,,`. Only the LIST form
    // `certutil -L -d <db>` (no -n) prints the table row
    // `pebble-root   C,,`. The verify grep has to read THAT form and
    // anchor the match to our nickname (so another row's `C,,` cannot
    // satisfy it).
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(0);
    // Among all certutil -L lines, the verify step is the one that is
    // NOT scoped by -n (the list form), AND whose grep anchors to the
    // nickname beside C,,.
    const certutilLs = res.stdout.split('\n').filter((l) => /\bcertutil\b/.test(l) && / -L /.test(l));
    const listFormLines = certutilLs.filter((l) => !/ -n /.test(l));
    expect(listFormLines.length, 'certutil -L (list form, no -n) is in the dry-run').toBeGreaterThan(0);
    const verifyLine = listFormLines.find((l) => /pebble-root/.test(l) && /C,,/.test(l));
    expect(verifyLine, 'the list-form grep names pebble-root AND C,,').toBeDefined();
    // The grep must anchor the match to the `pebble-root` row — a
    // generic `grep -q 'C,,'` would be satisfied by any other row
    // whose trust column happens to be `C,,`.
    expect(verifyLine!, 'anchored to pebble-root row').toMatch(/pebble-root[^|&]*C,,|C,,[^|&]*pebble-root/);
  }, 30_000);
});

describe('fix 2 — Chromium host-resolver-rules excludes the stage public range', () => {
  it("stage:up --dry-run's Chromium line carries EXCLUDE for the internet-subnet range", () => {
    const res = spawnSync(process.execPath, [UP_SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(0);
    const line = res.stdout.split('\n').find((l) => l.startsWith('[spawn:chromium]'));
    expect(line, 'chromium spawn line').toBeDefined();
    // The flag must EXCLUDE the public subnet (topology.internet.subnet is
    // 11.100.0.0/24, so EXCLUDE 11.100.0.* reaches every public addr).
    expect(line, 'EXCLUDE 11.100.0.*').toMatch(/EXCLUDE 11\.100\.0\.\*/);
    // And still EXCLUDE localhost (the page's own origin).
    expect(line).toContain('EXCLUDE localhost');
  }, 30_000);
});

describe('fix 3 — messageOf describes an Event (not "[object Event]")', () => {
  it('a DOM Event reads as `Event: <type>`', () => {
    // happy-dom provides globalThis.Event in test env, but we build a plain
    // Event-shaped object so the test does not depend on an environment.
    const ev = { type: 'error', bubbles: false };
    expect(messageOf(ev)).toContain('error');
    expect(messageOf(ev)).not.toContain('[object Event]');
  });
  it('an ErrorEvent reads its `message` field', () => {
    const ev = { type: 'error', message: 'WebSocket closed before the handshake' };
    expect(messageOf(ev)).toContain('WebSocket closed before the handshake');
  });
  it('an Error reads name + message as before', () => {
    const e = new TypeError('bad arg');
    const m = messageOf(e);
    expect(m).toContain('TypeError');
    expect(m).toContain('bad arg');
  });
  it('null / undefined read as empty string', () => {
    expect(messageOf(null)).toBe('');
    expect(messageOf(undefined)).toBe('');
  });
});

describe('fix 4 — faults are single `nft`, not doubled, and pass unshare -rn nft -c', () => {
  it('scenarios do not call nftApply with an argv slice that still carries the "nft" token', () => {
    // The exec-mode bug main saw: `nftApply(ns, argvThatStartsWithNft)` ran
    // `sudo ip netns exec <ns> nft nft add ...`, which nft refused as a
    // syntax error. The fix: scenarios slice past the `nft` token
    // (`argv.slice(6)` or extract the subcommand) before handing to
    // nftApply. Source grep over s4 and s6 is the quickest check — a
    // dynamic test would need to spawn under sudo.
    for (const name of ['s4-transport-cut.mjs', 's6-hostile.mjs']) {
      const src = readFileSync(join(PACKAGE_ROOT, 'stage', 'scenarios', name), 'utf8');
      // Any `nftApply(..., <something>.slice(5))` is the doubling bug: the
      // 5-th token of a `sudo ip netns exec <ns> nft ...` argv IS `nft`,
      // and nftApply prepends its own.
      expect(src, `${name} does not slice(5) into nftApply`).not.toMatch(/nftApply\([^,]+,\s*[A-Za-z]+\.slice\(5\)/);
    }
  });

  it('every scenario nft ruleset passes unshare -rn nft -c -f', () => {
    const res = spawnSync(process.execPath, [RUN_SCRIPT, '--dry-run'], { encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(0);
    const preflight = spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8', timeout: 5_000 });
    if (preflight.status !== 0) {
      process.stdout.write(`[skip] scenario nft ruleset case: unshare -rn is not available\n`);
      return;
    }
    const perKey = new Map<string, string[]>();
    for (const raw of res.stdout.split('\n')) {
      const m = /^\[fault:(?!remove)([^:\]]+):[^\]]+\] sudo ip netns exec (notismesh-\S+) nft (add .+)$/.exec(raw);
      if (!m) continue;
      const [, scenario, ns, rule] = m;
      const key = `${scenario}:${ns}`;
      const bucket = perKey.get(key) ?? [];
      bucket.push(rule!);
      perKey.set(key, bucket);
    }
    expect(perKey.size, 'at least one scenario nft ruleset').toBeGreaterThan(0);
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'mesh-fix4-nft-'));
    const failures: Array<{ key: string; stderr: string; ruleset: string }> = [];
    try {
      for (const [key, rules] of perKey) {
        const file = join(tmpDir, `${key.replace(/[:/]/g, '_')}.nft`);
        const ruleset = rules.join('\n') + '\n';
        writeFileSync(file, ruleset);
        const r = spawnSync('unshare', ['-rn', 'nft', '-c', '-f', file], { encoding: 'utf8', timeout: 10_000 });
        if (r.status !== 0) {
          failures.push({ key, stderr: (r.stderr || r.stdout || '').trim(), ruleset });
        }
      }
    } finally { rmSync(tmpDir, { recursive: true, force: true }); }
    if (failures.length > 0) {
      const detail = failures.map((f) => `  ${f.key}:\n    ${f.stderr}\n    ruleset:\n      ${f.ruleset.split('\n').join('\n      ')}`).join('\n');
      throw new Error(`unshare -rn nft -c -f refused:\n${detail}`);
    }
  }, 30_000);
});

describe('fix 5 — vacuous PASS: a verdict is PASS only on positive evidence', () => {
  it("verdictS1DnsSilent: no DNS and no counter movement is NOT PASS unless the page connected", () => {
    // The brief: "s1's DNS step: only when the page reached a node inside
    // the window, else `skipped`". But a verdict given a measurement
    // without a `connected` field must not read PASS — require positive
    // evidence that the page connected during the window.
    const vacuous = { dnsLines: 0, nftCounterPackets: 0 }; // no `connected`
    expect(verdictS1DnsSilent(vacuous), 'no connected evidence → not PASS').not.toBe('PASS');
    const positive = { dnsLines: 0, nftCounterPackets: 0, connected: true };
    expect(verdictS1DnsSilent(positive), 'positive evidence → PASS').toBe('PASS');
  });
  it("verdictS4Renewal: 'no lastLeft names a failure' is NOT PASS when the page never connected", () => {
    // Vacuous: a page that never connected has no lastLeft to name a
    // failure, so probeSuccessAcrossRenewal reads true. The verdict must
    // see positive evidence of connection across the window.
    const vacuous = { renewalSeen: true, probeSuccessAcrossRenewal: true, lastLeftFailure: false };
    expect(verdictS4Renewal(vacuous), 'no connected evidence → not PASS').not.toBe('PASS');
    const positive = {
      renewalSeen: true,
      probeSuccessAcrossRenewal: true,
      lastLeftFailure: false,
      connectedBeforeWindow: true,
      connectedAfterWindow: true,
    };
    expect(verdictS4Renewal(positive), 'positive evidence → PASS').toBe('PASS');
  });
});

describe('fix 6 — restart writes new pid to pids.json; down waits for signalled pids', () => {
  it('restartFromEntry rewrites pids.json entry when a pidsPath is supplied', async () => {
    const { mkdtempSync, writeFileSync, readFileSync: rfs, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { restartFromEntry } = await import('../stage/lib/measure.mjs');
    const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'mesh-fix6-'));
    try {
      const logPath = join(dir, 'child.log');
      const pidsPath = join(dir, 'pids.json');
      const oldPid = 999999; // not a real pid
      const entry = {
        pid: oldPid, description: 'test:thing', logPath,
        argv: ['sh', '-c', 'sleep 1'], env: {},
      };
      writeFileSync(pidsPath, JSON.stringify({ pids: [entry], namespaces: [] }, null, 2));
      const newPid = restartFromEntry(entry, { pidsPath });
      expect(newPid).toBeGreaterThan(0);
      expect(newPid).not.toBe(oldPid);
      const written = JSON.parse(rfs(pidsPath, 'utf8'));
      expect(written.pids[0].pid).toBe(newPid);
      expect(written.pids[0].description).toBe('test:thing');
      // Reap
      await new Promise((r) => setTimeout(r, 1200));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      void tmpdir;
    }
  });
  it("down.mjs's dry-run names a wait-and-SIGKILL path for each PID", async () => {
    const DOWN_SCRIPT = join(PACKAGE_ROOT, 'stage', 'down.mjs');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'mesh-fix6-down-'));
    try {
      // Fabricate a pids.json a down --dry-run would read.
      const outDir = join(PACKAGE_ROOT, 'stage', 'out');
      // Can't easily inject outDir in down.mjs; this test asserts the
      // CODE path exists by grepping down.mjs for the SIGKILL fallback.
      const src = readFileSync(DOWN_SCRIPT, 'utf8');
      expect(src, 'down.mjs waits for a PID with SIGKILL fallback').toMatch(/SIGKILL/);
      // The wait loop reads a PID's status before signalling it again;
      // isAliveFor (or similar) exists.
      expect(src, 'down.mjs waits for a signalled PID to exit').toMatch(/isAliveFor|process\.kill\(.*,\s*0\s*\)/);
      void outDir;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
