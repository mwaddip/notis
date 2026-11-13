// MINING_INTERFACE → Consolidation. The cases spawn `scripts/miner.mjs` under
// plain Node (no vitest alias, no workspace resolver) against a stub node on
// `127.0.0.1:0`, and read what the script writes on the wire. The script
// imports `../dist/miner-consolidate.js` from its own install, so the suite
// needs `packages/node/dist/miner-consolidate.js` built — the first case
// asserts it is there, and a missing file is a case's own failure, never a
// skip (CI builds every member before any job tests).

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bytesToHex,
  computeTxId,
  PAGE_LIMIT_MAX,
  profileFor,
  protocolVersionAt,
} from '@dagsocial/types';
import type { CreditBox } from '@dagsocial/types';
import { verifyEd25519 } from '@dagsocial/validation';
import { jsonToTx } from '../../src/routes/json-to-tx.js';

const MINER = resolve(__dirname, '..', '..', 'scripts', 'miner.mjs');
const CONSOLIDATE_DIST = resolve(__dirname, '..', '..', 'dist', 'miner-consolidate.js');

interface StubBox {
  readonly boxId: string;
  readonly value: bigint;
  readonly lockedUntilBlock?: number;
}

interface StubState {
  // Each template a request answers, in the order the test queues them.
  // When the queue runs out the server keeps answering the tail's shape.
  readonly templates: Array<{ height: number; powPreimage: string; powTargetBits: number }>;
  readonly tip: number;
  readonly protocolVersion: number;
  readonly boxes: readonly StubBox[];
  // The stream of every request the server saw (every method + URL + body).
  readonly calls: Array<{ method: string; url: string; body: string }>;
  // Every POST /credits/transfer body parsed back out (its `tx`).
  readonly postedTxs: Array<Record<string, unknown>>;
}

interface Harness {
  port: number;
  state: StubState;
  shutdown: () => Promise<void>;
  waitForTemplate: (deadlineMs: number) => Promise<void>;
  waitForNthTemplate: (n: number, deadlineMs: number) => Promise<void>;
  waitForPost: (deadlineMs: number) => Promise<void>;
}

async function startStub(options: {
  boxes?: readonly StubBox[];
  templates: StubState['templates'];
  tip?: number;
}): Promise<Harness> {
  const state: StubState = {
    templates: [...options.templates],
    tip: options.tip ?? 1000,
    protocolVersion: protocolVersionAt(profileFor('testnet').protocolVersionSchedule, (options.tip ?? 1000) + 1)!,
    boxes: options.boxes ?? [],
    calls: [],
    postedTxs: [],
  };
  // The template the server answers from the queue head, served once and
  // then held — `templateMovedPast` and the main loop both pull from here.
  let templateIdx = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      state.calls.push({ method: req.method ?? 'GET', url, body });
      const u = new URL(url, 'http://stub');
      if (u.pathname === '/mining/template') {
        const t = state.templates[Math.min(templateIdx, state.templates.length - 1)];
        if (!t) {
          res.statusCode = 404;
          res.end();
          return;
        }
        // Advance the queue once per answered template; the last stays.
        if (templateIdx + 1 < state.templates.length) templateIdx++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          header: {
            height: t.height,
            powTargetBits: t.powTargetBits,
            protocolVersion: state.protocolVersion,
          },
          powPreimage: t.powPreimage,
        }));
        return;
      }
      if (u.pathname === '/mining/submit') {
        res.statusCode = 201;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ blockHash: '00'.repeat(32), height: state.tip + 1 }));
        return;
      }
      if (u.pathname === '/status') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          networkType: 'testnet',
          blockHeight: state.tip,
          protocolVersion: state.protocolVersion,
        }));
        return;
      }
      if (u.pathname === '/credits/transfer' && req.method === 'POST') {
        try {
          const parsed = JSON.parse(body) as { tx: Record<string, unknown> };
          state.postedTxs.push(parsed.tx);
        } catch { /* record raw body only */ }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'pending', txId: '00'.repeat(32), expiresAtHeight: state.tip + 60 }));
        return;
      }
      if (u.pathname.startsWith('/credits/')) {
        // One-page listing; a bigger stock would need pagination, but the
        // cases here fit in one `PAGE_LIMIT_MAX` page.
        const limit = Math.min(Number(u.searchParams.get('limit') ?? String(PAGE_LIMIT_MAX)), PAGE_LIMIT_MAX);
        const page = state.boxes.slice(0, limit);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          userId: u.pathname.slice('/credits/'.length),
          total: state.boxes.reduce((s, b) => s + b.value, 0n).toString(),
          boxes: page.map((b) => ({
            boxId: b.boxId,
            value: b.value.toString(),
            ...(b.lockedUntilBlock !== undefined ? { lockedUntilBlock: b.lockedUntilBlock } : {}),
          })),
          boxCount: state.boxes.length,
          next: null,
        }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(0, '127.0.0.1', () => resolveStart());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  const port = addr.port;

  const waitFor = (predicate: () => boolean, deadlineMs: number): Promise<void> =>
    new Promise((resolveWait, rejectWait) => {
      const start = Date.now();
      const check = (): void => {
        if (predicate()) { resolveWait(); return; }
        if (Date.now() - start > deadlineMs) {
          rejectWait(new Error(`wait exceeded ${deadlineMs} ms`));
          return;
        }
        // Wait on the next request to arrive, not on a clock alone. A
        // 50 ms tick caps the delay a last-request check sees.
        setTimeout(check, 50);
      };
      check();
    });

  return {
    port,
    state,
    waitForTemplate: (ms) =>
      waitFor(() => state.calls.some((c) => c.url.startsWith('/mining/template')), ms),
    waitForNthTemplate: (n, ms) =>
      waitFor(() => state.calls.filter((c) => c.url.startsWith('/mining/template')).length >= n, ms),
    waitForPost: (ms) =>
      waitFor(() => state.postedTxs.length > 0, ms),
    shutdown: () => new Promise<void>((resolveShut) => server.close(() => resolveShut())),
  };
}

function makeKey(): { publicKeyHex: string; secretKeyHex: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  return {
    publicKeyHex: pubDer.subarray(-32).toString('hex'),
    secretKeyHex: privDer.toString('hex'),
  };
}

function makeBoxes(n: number, value: bigint): StubBox[] {
  const out: StubBox[] = [];
  for (let i = 0; i < n; i++) out.push({ boxId: bytesToHex(randomBytes(32)), value });
  // The node's order: value DESC, id ASC at equal value.
  out.sort((a, b) => (a.value === b.value ? a.boxId.localeCompare(b.boxId) : b.value > a.value ? 1 : -1));
  return out;
}

/** A target every digest meets — scaledBits 0 answers 2^256 − 1 (all bytes
 *  0xFF), so the search ends at nonce 0. */
const TRIVIAL_POW_TARGET_BITS = 0;

interface ChildBag {
  readonly children: ChildProcess[];
  readonly dirs: string[];
}
const bag: ChildBag = { children: [], dirs: [] };

afterEach(() => {
  for (const c of bag.children) {
    if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) {
      // A child is signalled by its own PID alone — `kill()` on the child
      // sends to the PID `spawn` captured.
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  bag.children.length = 0;
  for (const d of bag.dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
  bag.dirs.length = 0;
});

function spawnMiner(opts: {
  minerScript?: string;
  port: number;
  env?: Record<string, string>;
}): ChildProcess {
  const child = spawn(
    process.execPath,
    [opts.minerScript ?? MINER],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        NODE_URL: `http://127.0.0.1:${opts.port}`,
        MINING_SECRET: 'cases-secret',
        MINER_PCT: '100',
        ...(opts.env ?? {}),
      },
    },
  );
  bag.children.push(child);
  return child;
}

function waitForExit(child: ChildProcess, deadlineMs: number): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveExit, rejectExit) => {
    const stderrBuf: string[] = [];
    const stdoutBuf: string[] = [];
    child.stderr?.on('data', (c: Buffer) => stderrBuf.push(c.toString()));
    child.stdout?.on('data', (c: Buffer) => stdoutBuf.push(c.toString()));
    const timer = setTimeout(() => {
      rejectExit(new Error(`child did not exit within ${deadlineMs} ms`));
    }, deadlineMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveExit({ code, stderr: stderrBuf.join(''), stdout: stdoutBuf.join('') });
    });
  });
}

// -------------------------------------------------------------------------
// Dist readiness — the module the script imports
// -------------------------------------------------------------------------

describe('miner.mjs — consolidation', () => {
  it('needs `dist/miner-consolidate.js` built', () => {
    // CI builds every member before any job tests; a missing file here is
    // the case's own failure, not a skip.
    expect(() => statSync(CONSOLIDATE_DIST), `${CONSOLIDATE_DIST} is missing — pnpm -r build first`).not.toThrow();
  });

  it('with a key file the script posts one consolidation the stub reads back as a transfer from the file to itself, and its template requests name the file\'s key in ?miner=', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miner-script-consolidates-'));
    bag.dirs.push(dir);
    const key = makeKey();
    const keyPath = join(dir, 'miner-key.json');
    writeFileSync(keyPath, JSON.stringify({ publicKey: key.publicKeyHex, secretKeyHex: key.secretKeyHex }));

    const boxes = makeBoxes(100, 1_000_000n);
    const harness = await startStub({
      boxes,
      // A trivial target means the first nonce ends the search; the submit
      // the script runs then loops back to the next template.
      templates: [{ height: 1001, powPreimage: 'aa'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS }],
      tip: 1000,
    });
    try {
      spawnMiner({ port: harness.port, env: { MINER_KEY_PATH: keyPath } });
      await harness.waitForPost(15_000);

      // Every `/mining/template` request carries the file's key.
      const templateCalls = harness.state.calls.filter((c) => c.url.startsWith('/mining/template'));
      expect(templateCalls.length).toBeGreaterThan(0);
      for (const c of templateCalls) {
        expect(c.url).toContain(`miner=${key.publicKeyHex}`);
      }

      // The posted transaction is a consolidation.
      expect(harness.state.postedTxs.length).toBeGreaterThan(0);
      const parsed = jsonToTx(harness.state.postedTxs[0]!, harness.state.protocolVersion);
      expect(parsed.inputs).toEqual(boxes.map((b) => b.boxId));
      expect(parsed.outputs).toHaveLength(1);
      const out = parsed.outputs[0] as CreditBox;
      expect(out.boxType).toBe('credit');
      expect(bytesToHex(out.owner)).toBe(key.publicKeyHex);
      expect(out.value).toBe(boxes.reduce((s, b) => s + b.value, 0n));
      expect(parsed.protocolVersion).toBe(harness.state.protocolVersion);

      // One signature by the key, verifying over the id.
      const idBytes = Buffer.from(computeTxId(parsed), 'hex');
      expect(Object.keys(parsed.signatures)).toEqual([key.publicKeyHex]);
      const sig = parsed.signatures[key.publicKeyHex]!;
      expect(verifyEd25519(sig, idBytes, Buffer.from(key.publicKeyHex, 'hex'))).toBe(true);
    } finally {
      await harness.shutdown();
    }
  }, 30_000);

  it('a bare copy of the script with MINER_KEY_PATH exits non-zero naming dist/miner-consolidate.js, and asks the stub nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miner-script-bare-'));
    bag.dirs.push(dir);
    // Copy the script into a directory with no sibling `../dist/`.
    const bareScript = join(dir, 'miner.mjs');
    const { readFileSync } = await import('node:fs');
    writeFileSync(bareScript, readFileSync(MINER, 'utf8'));

    const key = makeKey();
    const keyPath = join(dir, 'miner-key.json');
    writeFileSync(keyPath, JSON.stringify({ publicKey: key.publicKeyHex, secretKeyHex: key.secretKeyHex }));

    const harness = await startStub({ templates: [], tip: 1000 });
    try {
      const child = spawnMiner({
        minerScript: bareScript,
        port: harness.port,
        env: { MINER_KEY_PATH: keyPath },
      });
      const { code, stdout } = await waitForExit(child, 10_000);
      expect(code).not.toBe(0);
      // The log line names `dist/miner-consolidate.js`, the file that did
      // not load from the bare copy's install.
      expect(stdout).toContain('dist/miner-consolidate.js');
      // Nothing was asked of the stub — the refusal is before the main loop.
      expect(harness.state.calls).toHaveLength(0);
    } finally {
      await harness.shutdown();
    }
  }, 30_000);

  it('MINER_KEY_PATH naming an encrypted envelope exits non-zero with the reader\'s message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miner-script-encrypted-'));
    bag.dirs.push(dir);
    const envelope = {
      version: 1,
      pubKeyHex: 'aa'.repeat(32),
      kdf: { name: 'scrypt', salt: '00'.repeat(16), N: 65536, r: 8, p: 1 },
      cipher: { name: 'chacha20-poly1305', nonce: '00'.repeat(12) },
      ciphertext: '00'.repeat(48),
    };
    const keyPath = join(dir, 'encrypted.json');
    writeFileSync(keyPath, JSON.stringify(envelope));

    const harness = await startStub({ templates: [], tip: 1000 });
    try {
      const child = spawnMiner({ port: harness.port, env: { MINER_KEY_PATH: keyPath } });
      const { code, stdout } = await waitForExit(child, 10_000);
      expect(code).not.toBe(0);
      expect(stdout).toContain(keyPath);
      expect(stdout).toContain('encrypted identity envelope');
    } finally {
      await harness.shutdown();
    }
  }, 30_000);

  it('without MINER_KEY_PATH the script asks /mining/template and nothing of /status or /credits', async () => {
    const harness = await startStub({
      templates: [
        { height: 1001, powPreimage: 'aa'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS },
        { height: 1001, powPreimage: 'aa'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS },
      ],
      tip: 1000,
    });
    try {
      spawnMiner({ port: harness.port });
      // Wait on the stub's own events: at least two template reads. A tick
      // under this branch would have run before the first search, so a
      // second template read lands after a tick's /status would have fired.
      await harness.waitForNthTemplate(2, 15_000);
      const paths = new Set(harness.state.calls.map((c) => new URL(c.url, 'http://x').pathname));
      expect(paths.has('/mining/template')).toBe(true);
      expect(paths.has('/status')).toBe(false);
      expect([...paths].some((p) => p.startsWith('/credits/'))).toBe(false);
    } finally {
      await harness.shutdown();
    }
  }, 30_000);

  it('templates repeating one height run one check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'miner-script-tick-'));
    bag.dirs.push(dir);
    const key = makeKey();
    const keyPath = join(dir, 'miner-key.json');
    writeFileSync(keyPath, JSON.stringify({ publicKey: key.publicKeyHex, secretKeyHex: key.secretKeyHex }));

    // No spendable boxes — a check reads /status and the credits listing
    // but posts nothing. Each check is one /status request; the case
    // counts those.
    const harness = await startStub({
      boxes: [],
      templates: [
        { height: 2000, powPreimage: 'bb'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS },
        { height: 2000, powPreimage: 'bb'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS },
        { height: 2000, powPreimage: 'bb'.repeat(16), powTargetBits: TRIVIAL_POW_TARGET_BITS },
      ],
      tip: 1999,
    });
    try {
      spawnMiner({
        port: harness.port,
        env: { MINER_KEY_PATH: keyPath, MINER_PCT: '0' },
      });
      // Wait on the stub's own events — at least three template reads
      // (so a second tick at the same height would have run a second
      // check if the cadence's due height did not refuse it). Then assert
      // exactly one /status read landed.
      await harness.waitForNthTemplate(3, 15_000);
      const statusReads = harness.state.calls.filter((c) => new URL(c.url, 'http://x').pathname === '/status').length;
      expect(statusReads).toBe(1);
    } finally {
      await harness.shutdown();
    }
  }, 30_000);
});
