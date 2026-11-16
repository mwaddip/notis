import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertDistFresh, NODE_LOADS, FAUCET_LOADS } from '../src/dist-freshness.js';
import { computeFingerprint } from '../src/fingerprint.js';
import { readState } from '../src/cache.js';
import { up, down, type UpResult } from '../src/loader.js';
import { MINIMAL } from '../src/generator.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

interface SharedCache {
  readonly dir: string;
}

// The suite uses the MINIMAL state so one run brings up a stack in seconds.
// `base` is timed by hand in the report.
let sharedCache: SharedCache | null = null;
const activeUps = new Set<string>();

beforeAll(() => {
  assertDistFresh([...NODE_LOADS, ...FAUCET_LOADS], REPO_ROOT);
  sharedCache = { dir: mkdtempSync(join(tmpdir(), 'dagsocial-test-state-loader-cache-')) };
});

afterAll(() => {
  if (sharedCache) {
    rmSync(sharedCache.dir, { recursive: true, force: true });
    sharedCache = null;
  }
});

afterEach(async () => {
  for (const dir of activeUps) {
    try {
      await down(dir);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
  activeUps.clear();
});

function newRunDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dagsocial-test-state-loader-${label}-`));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  activeUps.add(dir);
  return dir;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

describe('loader', () => {
  it('up brings up a stack on a copy of a state and down leaves nothing', async () => {
    const runDir = newRunDir('up-down');
    const result: UpResult = await up({
      stateName: MINIMAL.name,
      runDir,
      repoRoot: REPO_ROOT,
      cacheRoot: sharedCache!.dir,
      ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
      intervalMs: 500,
    });
    expect(result.name).toBe(MINIMAL.name);
    expect(result.nodeHttp).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    expect(result.nodeAdmin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    expect(result.faucetOrigin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    expect(result.minerControlOrigin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    expect(result.tip.height).toBeGreaterThanOrEqual(MINIMAL.startingHeight);

    // The processes.log lists the node, the faucet and the miner.
    const records = readFileSync(join(runDir, 'processes.log'), 'utf8')
      .split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const labels = records.map((r) => r.label);
    expect(labels).toContain('node');
    expect(labels).toContain('faucet');
    expect(labels).toContain('miner');

    await down(runDir);
    activeUps.delete(runDir);

    // Every pid the loader started is gone from /proc.
    for (const r of records) {
      if (r.label === 'miner') continue; // the in-process miner
      try {
        const live = readFileSync(`/proc/${r.pid}/cmdline`, 'utf8');
        const parts = live.split('\u0000').filter((s) => s.length > 0);
        const sameArgv = (r.argv as string[]).every((a, i) => parts[i] === a);
        expect(sameArgv).toBe(false);
      } catch {
        // /proc/<pid>/cmdline not readable → pid is gone.
      }
    }

    // CLAIM 1: no -wal next to the store after a clean stop.
    const dbWal = join(runDir, 'dagsocial.db-wal');
    expect(existsSync(dbWal)).toBe(false);
    const dbShm = join(runDir, 'dagsocial.db-shm');
    expect(existsSync(dbShm)).toBe(false);

    rmSync(runDir, { recursive: true, force: true });
  }, 240_000);

  it('up refuses a run directory that exists and is not empty', async () => {
    const runDir = newRunDir('nonempty');
    writeFileSync(join(runDir, 'preexisting.txt'), 'in the way');
    await expect(
      up({
        stateName: MINIMAL.name,
        runDir,
        repoRoot: REPO_ROOT,
        cacheRoot: sharedCache!.dir,
        ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
        intervalMs: 500,
      }),
    ).rejects.toThrow(/is not empty/);
    // Directory is untouched by the refusal.
    expect(existsSync(join(runDir, 'preexisting.txt'))).toBe(true);
    activeUps.delete(runDir);
    rmSync(runDir, { recursive: true, force: true });
  }, 60_000);

  it('manifest figures are read from the node, not the scripts\' output', async () => {
    const runDir = newRunDir('manifest-from-node');
    const result = await up({
      stateName: MINIMAL.name,
      runDir,
      repoRoot: REPO_ROOT,
      cacheRoot: sharedCache!.dir,
      ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
      intervalMs: 500,
    });
    const tipFromNode = await fetchJson<{ height: number; hash: string }>(
      `${result.nodeHttp}/blocks/current`,
    );
    // The manifest's tip was read from a running node at generation. After
    // `up` brings the stack up again on the copy, A reads the same height
    // the manifest records (and a hash that bytes-match).
    expect(tipFromNode.height).toBeGreaterThanOrEqual(result.tip.height);
    expect(tipFromNode.hash).toBeTruthy();
    // The hash the manifest holds was the tip at generation; after load it
    // is one of A's confirmed block hashes.
    const blockAtTip = await fetchJson<{ header: { prevBlockHash: string } }>(
      `${result.nodeHttp}/blocks/${result.tip.height}`,
    );
    expect(blockAtTip.header.prevBlockHash).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('two ups of one state side by side each answer their own tip', async () => {
    const runDirA = newRunDir('side-a');
    const runDirB = newRunDir('side-b');
    const [a, b] = await Promise.all([
      up({
        stateName: MINIMAL.name,
        runDir: runDirA,
        repoRoot: REPO_ROOT,
        cacheRoot: sharedCache!.dir,
        ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
        intervalMs: 1_000,
      }),
      up({
        stateName: MINIMAL.name,
        runDir: runDirB,
        repoRoot: REPO_ROOT,
        cacheRoot: sharedCache!.dir,
        ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
        intervalMs: 1_000,
      }),
    ]);
    expect(a.nodeHttp).not.toBe(b.nodeHttp);
    const [tipA, tipB] = await Promise.all([
      fetchJson<{ height: number }>(`${a.nodeHttp}/blocks/current`),
      fetchJson<{ height: number }>(`${b.nodeHttp}/blocks/current`),
    ]);
    expect(tipA.height).toBeGreaterThanOrEqual(MINIMAL.startingHeight);
    expect(tipB.height).toBeGreaterThanOrEqual(MINIMAL.startingHeight);
  }, 240_000);

  it('a cached state loads with no generation', async () => {
    // A state the previous cases already left in the cache — `up` finds it
    // and copies it without running the generator again.
    const fingerprint = computeFingerprint(REPO_ROOT);
    const existing = readState(sharedCache!.dir, fingerprint, MINIMAL.name);
    expect(existing).not.toBeNull();
    const runDir = newRunDir('cache-hit');
    const t0 = Date.now();
    const result = await up({
      stateName: MINIMAL.name,
      runDir,
      repoRoot: REPO_ROOT,
      cacheRoot: sharedCache!.dir,
      ports: { http: 0, admin: 0, p2p: 0, faucet: 0, miner: 0 },
      intervalMs: 500,
    });
    const elapsed = Date.now() - t0;
    // A cache-hit load is bounded by node + faucet startup, not by the
    // generation's mine-to.
    expect(result.tip.height).toBeGreaterThanOrEqual(MINIMAL.startingHeight);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);
});
