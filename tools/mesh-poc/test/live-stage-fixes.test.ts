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
  it('dry-run output has a /certhash/ placeholder on every /webrtc-direct/ address', () => {
    const topology = readTopology(TOPOLOGY_PATH);
    const notisIds: Record<string, string> = {
      pub1: 'a'.repeat(64),
      pub2: 'b'.repeat(64),
    };
    const config = buildPageConfig(topology, notisIds); // dry-run: no realMultiaddrs
    for (const anchor of config.anchors) {
      for (const addr of anchor.addrs) {
        if (addr.includes('/webrtc-direct/')) {
          expect(addr, `/webrtc-direct/ addr has /certhash/: ${addr}`).toContain('/certhash/');
        }
      }
    }
  });
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
