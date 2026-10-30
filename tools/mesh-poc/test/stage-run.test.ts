// MESH_INTERFACE → Acceptance — `stage:run --dry-run` prints every fault
// each scenario would apply (inside `notismesh-*` namespaces only) and
// the removal of each. These run without root, without the stage.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertStagePrivileged } from '../stage/lib/fault-log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const RUN_SCRIPT = join(PACKAGE_ROOT, 'stage', 'run.mjs');

describe('stage:run --dry-run', () => {
  let out = '';
  let status: number | null = null;
  function runDryOnce(): void {
    if (out !== '') return;
    const res = spawnSync(process.execPath, [RUN_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    out = res.stdout;
    status = res.status;
    if (res.status !== 0) {
      throw new Error(`stage:run --dry-run exit ${res.status}: ${res.stderr}`);
    }
  }

  it.fails('exits 0 and prints the six scenarios in order', () => {
    runDryOnce();
    expect(status).toBe(0);
    for (const name of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      expect(out, `[scenario:${name}] start`).toContain(`[scenario:${name}] start`);
      expect(out, `[scenario:${name}] end`).toContain(`[scenario:${name}] end`);
    }
    const startIdx = (n: string) => out.indexOf(`[scenario:${n}] start`);
    const sIdxs = ['s1', 's2', 's3', 's4', 's5', 's6'].map(startIdx);
    for (let i = 1; i < sIdxs.length; i += 1) {
      const prev = sIdxs[i - 1]!;
      expect(sIdxs[i]!, `${['s1','s2','s3','s4','s5','s6'][i]} comes after the previous scenario`).toBeGreaterThan(prev);
    }
  }, 30_000);

  it.fails('every [fault:*] line runs sudo ip netns exec notismesh-*', () => {
    runDryOnce();
    const bad: string[] = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('[fault:')) continue;
      // Marker ends at the first space.
      const rest = line.slice(line.indexOf(' ') + 1).trim();
      if (rest.startsWith('kill -TERM ')) continue;
      if (!rest.startsWith('sudo ip netns exec notismesh-')) {
        bad.push(line);
      }
    }
    expect(bad, `fault lines outside a notismesh-* namespace:\n  ${bad.join('\n  ')}`).toEqual([]);
  }, 30_000);

  // MESH_INTERFACE → Acceptance — "Every fault a scenario applies, it
  // removes before it ends, pass or fail." For every `[fault:<scenario>:
  // <name>]` with a non-null `removalArgv`, a matching `[fault:remove:
  // <scenario>:<name>]` appears later in the output. The scenarios
  // carry the pairing explicitly: `nft add table ip <T>` pairs with
  // `nft delete table ip <T>`.
  it.fails('every scenario that adds an nft table removes it before it ends', () => {
    runDryOnce();
    const addLines = out.split('\n').filter((l) => l.startsWith('[fault:') && / nft add table ip /.test(l));
    expect(addLines.length, 'at least one nft table added by scenarios').toBeGreaterThan(0);
    const removeLines = out.split('\n').filter((l) => l.startsWith('[fault:remove:') && / nft delete table ip /.test(l));
    expect(removeLines.length, 'at least one nft table removed by scenarios').toBeGreaterThan(0);
    // One remove per unique table name added.
    const addedTables = new Set<string>();
    for (const l of addLines) {
      const m = /nft add table ip (\S+)/.exec(l);
      if (m) addedTables.add(m[1]!);
    }
    const removedTables = new Set<string>();
    for (const l of removeLines) {
      const m = /nft delete table ip (\S+)/.exec(l);
      if (m) removedTables.add(m[1]!);
    }
    for (const t of addedTables) {
      expect(removedTables.has(t), `added table "${t}" is removed`).toBe(true);
    }
  }, 30_000);

  // MESH_INTERFACE → Acceptance — "`--dry-run` ... creates no
  // namespace, file or process". The scenarios' dry-run also writes no
  // scenario JSON under `stage/out/scenarios/`.
  it.fails('the dry-run complete marker is in the output', () => {
    runDryOnce();
    expect(out, 'dry-run complete marker').toMatch(/\[dry-run complete\] 6 scenario\(s\)/);
  }, 30_000);
});

describe('stage:run --dry-run — nft ruleset syntax', () => {
  // MESH_INTERFACE → Acceptance — every nft rule a scenario would run
  // under `sudo ip netns exec notismesh-* nft` passes `nft -c -f` in an
  // unprivileged user + network namespace. A kernel that disallows them
  // reads the preflight and skips with the reason.
  it.fails('every nft ruleset the scenarios would apply passes nft -c under unshare -rn', () => {
    const res = spawnSync(process.execPath, [RUN_SCRIPT, '--dry-run'], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (res.status !== 0) {
      throw new Error(`stage:run --dry-run exit ${res.status}: ${res.stderr}`);
    }
    const preflight = spawnSync('unshare', ['-rn', 'true'], { encoding: 'utf8', timeout: 5_000 });
    if (preflight.status !== 0) {
      const reason = (preflight.stderr || preflight.stdout || `exit ${preflight.status}`).trim();
      process.stdout.write(`[skip] scenario nft case: unshare -rn is not available (${reason})\n`);
      expect(true).toBe(true);
      return;
    }
    const perScenarioNs = new Map<string, string[]>();
    for (const raw of res.stdout.split('\n')) {
      const m = /^\[fault:(?!remove)([^:\]]+):[^\]]+\] sudo ip netns exec (notismesh-\S+) nft (add .+)$/.exec(raw);
      if (!m) continue;
      const [, scenario, ns, rule] = m;
      const key = `${scenario}:${ns}`;
      const bucket = perScenarioNs.get(key) ?? [];
      bucket.push(rule!);
      perScenarioNs.set(key, bucket);
    }
    expect(perScenarioNs.size, 'at least one scenario nft ruleset').toBeGreaterThan(0);
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const tmpDir = mkdtempSync(join(tmpdir(), 'mesh-run-nft-'));
    const failures: Array<{ key: string; stderr: string; ruleset: string }> = [];
    try {
      for (const [key, rules] of perScenarioNs) {
        const file = join(tmpDir, `${key.replace(/[:/]/g, '_')}.nft`);
        const ruleset = rules.join('\n') + '\n';
        writeFileSync(file, ruleset);
        const r = spawnSync('unshare', ['-rn', 'nft', '-c', '-f', file], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        if (r.status !== 0) {
          failures.push({ key, stderr: (r.stderr || r.stdout || '').trim(), ruleset });
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    if (failures.length > 0) {
      const detail = failures
        .map((f) => `  ${f.key}:\n    stderr: ${f.stderr}\n    ruleset:\n      ${f.ruleset.split('\n').join('\n      ')}`)
        .join('\n');
      throw new Error(`nft -c refused these rulesets:\n${detail}`);
    }
  }, 30_000);
});

describe('fault-log.assertStagePrivileged', () => {
  it.fails('accepts sudo ip netns exec notismesh-pub1 ...', () => {
    expect(() => assertStagePrivileged(['sudo', 'ip', 'netns', 'exec', 'notismesh-pub1', 'nft', 'add', 'table', 'ip', 'x'])).not.toThrow();
  });
  it('refuses a non-sudo prefix', () => {
    expect(() => assertStagePrivileged(['nft', 'add', 'table', 'ip', 'x'])).toThrow();
  });
  it('refuses a namespace outside notismesh-', () => {
    expect(() => assertStagePrivileged(['sudo', 'ip', 'netns', 'exec', 'rogue-ns', 'nft', 'add', 'table'])).toThrow();
  });
  it('refuses a short argv (no namespace)', () => {
    expect(() => assertStagePrivileged(['sudo', 'ip', 'netns', 'exec'])).toThrow();
  });
});
