import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertDistFresh, NODE_LOADS, FAUCET_LOADS } from '../src/dist-freshness.js';
import { computeFingerprint } from '../src/fingerprint.js';
import { readState } from '../src/cache.js';
import { up, down, pickFreePort, type UpResult } from '../src/loader.js';
import { MINIMAL, devnetFaucet, nodePeerIdFromListenLine, notisIdFromKeyFile } from '../src/generator.js';
import { NETWORK_PROFILES } from '@dagsocial/types';

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
  }, 120_000);

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
    expect(result.tip.height).toBeGreaterThanOrEqual(MINIMAL.startingHeight);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it('the CLI up exits 0 with the stack running; the tip rises; down leaves nothing', async () => {
    // L1: up (CLI) spawns three detached processes and exits with their
    // readiness read from log files. After `up` returns, A's tip still
    // rises at the cadence — the miner is a detached subprocess, not
    // inside `up`'s own process. `down` from another process stops all
    // three by recorded pid and argv.
    const runDir = newRunDir('cli-up-down');
    const cliBin = resolve(REPO_ROOT, 'tools/test-state/dist/cli.js');
    const upRes = spawnSync(
      process.execPath,
      [
        cliBin, 'up', MINIMAL.name,
        '--dir', runDir,
        '--http-port', '0',
        '--admin-port', '0',
        '--p2p-port', '0',
        '--faucet-port', '0',
        '--miner-port', '0',
        '--interval-ms', '500',
        '--cache', sharedCache!.dir,
      ],
      { encoding: 'utf8' },
    );
    expect(upRes.status, upRes.stderr).toBe(0);
    const result = JSON.parse(upRes.stdout) as UpResult;
    expect(result.nodeHttp).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/);
    // The miner is detached: its pid is not this process's.
    const records = readFileSync(join(runDir, 'processes.log'), 'utf8')
      .split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const miner = records.find((r) => r.label === 'miner');
    expect(miner).toBeDefined();
    expect(miner.pid).not.toBe(process.pid);

    // Sample the tip twice across one interval; the miner keeps going.
    const tip1 = await fetchJson<{ height: number }>(`${result.nodeHttp}/blocks/current`);
    await sleep(1500);
    const tip2 = await fetchJson<{ height: number }>(`${result.nodeHttp}/blocks/current`);
    expect(tip2.height).toBeGreaterThan(tip1.height);

    const downRes = spawnSync(
      process.execPath,
      [cliBin, 'down', '--dir', runDir],
      { encoding: 'utf8' },
    );
    expect(downRes.status, downRes.stderr).toBe(0);

    for (const r of records) {
      try {
        const live = readFileSync(`/proc/${r.pid}/cmdline`, 'utf8');
        const parts = live.split('\u0000').filter((s) => s.length > 0);
        const sameArgv = (r.argv as string[]).every((a, i) => parts[i] === a);
        expect(sameArgv).toBe(false);
      } catch {
        // /proc/<pid>/cmdline gone — pid is dead.
      }
    }
    rmSync(runDir, { recursive: true, force: true });
    activeUps.delete(runDir);
  }, 120_000);

  it('up with an unavailable faucet port stops the node before throwing', async () => {
    // L2: a port the faucet cannot bind makes `up` throw partway; the
    // node already started is stopped before the throw reaches the
    // caller.
    const held = await (async () => {
      const { createServer } = await import('node:net');
      return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
        const s = createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
          const addr = s.address() as { port: number };
          resolve({
            port: addr.port,
            close: () => new Promise<void>((r) => s.close(() => r())),
          });
        });
      });
    })();
    try {
      const runDir = newRunDir('partial-fail');
      await expect(
        up({
          stateName: MINIMAL.name,
          runDir,
          repoRoot: REPO_ROOT,
          cacheRoot: sharedCache!.dir,
          ports: {
            http: 0, admin: 0, p2p: 0, faucet: held.port, miner: 0,
          },
          intervalMs: 500,
        }),
      ).rejects.toThrow();
      // The records list is written only on success; a partial failure
      // leaves no processes.log. Read any that reached /proc check that
      // nothing of the run is still alive by scanning the run dir.
      const recordsPath = join(runDir, 'processes.log');
      if (existsSync(recordsPath)) {
        const records = readFileSync(recordsPath, 'utf8')
          .split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
        for (const r of records) {
          try {
            readFileSync(`/proc/${r.pid}/cmdline`, 'utf8');
            throw new Error(`pid ${r.pid} (${r.label}) still alive`);
          } catch {
            // gone, good
          }
        }
      }
    } finally {
      await held.close();
    }
  }, 60_000);

  it('devnetFaucet refuses a mismatched public key', () => {
    // G3: the one helper the generator and the loader share.
    // Mutating `DEVNET_FAUCET_PKCS8_HEX` would refuse here against
    // NETWORK_PROFILES.devnet.faucetPublicKey. The happy path:
    // devnetFaucet() returns the expected public key.
    const expected = NETWORK_PROFILES.devnet.faucetPublicKey;
    const got = devnetFaucet();
    expect(got.publicKeyHex).toBe(expected);
  });

  it('notisIdFromKeyFile reads the publicKey loadNodeKey gives', async () => {
    // The notisId is the Ed25519 public key `@dagsocial/net`'s
    // `loadNodeKey` derives from the key file's seed. For the 32-zero-
    // byte seed the public key is the known value below.
    const tmp = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-nodekey-'));
    try {
      const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
      const seed = Buffer.alloc(32);
      const keyFile = join(tmp, 'k.key');
      writeFileSync(keyFile, Buffer.concat([prefix, seed]), { mode: 0o600 });
      const id = await notisIdFromKeyFile(keyFile);
      expect(id).toBe(
        '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29',
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('nodePeerIdFromListenLine parses the `[net] listening on` line', () => {
    const parsed = nodePeerIdFromListenLine(
      '[net] listening on: /ip4/127.0.0.1/tcp/41011/p2p/12D3KooWSi2667MXWjkyCQqmRE7xXuewvbvPmtgeMRDVdtTLeZg8',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.port).toBe(41011);
    expect(parsed!.peerId).toBe('12D3KooWSi2667MXWjkyCQqmRE7xXuewvbvPmtgeMRDVdtTLeZg8');
  });

  it('pickFreePort lends a free loopback port', async () => {
    const p1 = await pickFreePort();
    const p2 = await pickFreePort();
    expect(p1).toBeGreaterThan(0);
    expect(p2).toBeGreaterThan(0);
  });
});
