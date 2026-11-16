import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertDistFresh, NODE_LOADS } from '../src/dist-freshness.js';
import { runMiner, type MinerHandle } from '../src/miner.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

interface SpawnedNode {
  readonly process: ChildProcess;
  readonly apiPort: number;
  readonly apiBindAddress: string;
  readonly apiUrl: string;
  readonly apiLine: string;
  readonly adminLine: string | null;
  readonly tmpDir: string;
  readonly logs: string[];
  stop(): Promise<void>;
}

// Environment variables the spawned node reads from the developer shell
// without the test's say-so (PATH to resolve `node`'s dynamic libraries,
// HOME for the OS's fallback temp root, and the temp-dir variables). Every
// other variable the test sets by name, so a shell carrying MESH_* or
// WEB_SHELL_PATH cannot change what the node under test sees.
const SPAWN_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
];

function allowlistedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of SPAWN_ENV_ALLOWLIST) {
    const v = process.env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

async function spawnDevnetNode(opts: { miningSecret: string }): Promise<SpawnedNode> {
  assertDistFresh(NODE_LOADS, REPO_ROOT);
  const tmpDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-miner-'));
  const dbPath = join(tmpDir, 'db.sqlite');
  const env: NodeJS.ProcessEnv = {
    ...allowlistedEnv(),
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'miner',
    BOOTSTRAP_PEERS: '',
    PORT: '0',
    ADMIN_PORT: '0',
    LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
    DB_PATH: dbPath,
    MINING_SECRET: opts.miningSecret,
  };
  const nodeBin = resolve(REPO_ROOT, 'packages/node/dist/index.js');
  const cp = spawn(process.execPath, [nodeBin], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  const logs: string[] = [];
  let apiPort: number | null = null;
  let apiBindAddress: string | null = null;
  let apiLine = '';
  let adminLine: string | null = null;
  let readyResolve: () => void = () => {};
  const readyPromise = new Promise<void>((r) => {
    readyResolve = r;
  });

  const parseLine = (line: string): void => {
    logs.push(line);
    if (line.startsWith('Admin listener on') && adminLine === null) {
      adminLine = line;
    }
    try {
      const evt = JSON.parse(line) as { event?: string; port?: number; bind_address?: string };
      if (evt.event === 'api_listening' && typeof evt.port === 'number') {
        apiPort = evt.port;
        apiBindAddress = evt.bind_address ?? '127.0.0.1';
        apiLine = line;
        readyResolve();
      }
    } catch {
      // not JSON — pass
    }
  };

  cp.stdout!.setEncoding('utf8');
  cp.stdout!.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) parseLine(line);
  });
  cp.stderr!.setEncoding('utf8');
  cp.stderr!.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) logs.push('[stderr] ' + line);
  });

  const guard = setTimeout(() => readyResolve(), 30_000);
  await readyPromise;
  clearTimeout(guard);

  if (apiPort === null || apiBindAddress === null) {
    cp.kill('SIGKILL');
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`node did not emit api_listening within 30s; logs:\n${logs.join('\n')}`);
  }

  const stop = async (): Promise<void> => {
    if (cp.exitCode !== null) {
      rmSync(tmpDir, { recursive: true, force: true });
      return;
    }
    const exited = new Promise<void>((resolve) => cp.once('exit', () => resolve()));
    cp.kill('SIGTERM');
    const killGuard = setTimeout(() => cp.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(killGuard);
    rmSync(tmpDir, { recursive: true, force: true });
  };

  // The listen host may be `::` (IPv6 all-addresses); the node accepts
  // loopback on both families, so the client always dials 127.0.0.1.
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  return { process: cp, apiPort, apiBindAddress, apiUrl, apiLine, adminLine, tmpDir, logs, stop };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface FakeNode {
  readonly url: string;
  stop(): Promise<void>;
}

interface CountingProxy {
  readonly url: string;
  submissionCount(): number;
  stop(): Promise<void>;
}

async function startCountingProxy(targetUrl: string): Promise<CountingProxy> {
  let count = 0;
  const server: HttpServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const forwarded = await fetch(`${targetUrl}${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body:
        req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    if (req.method === 'POST' && req.url?.startsWith('/mining/submit')) {
      count++;
    }
    res.statusCode = forwarded.status;
    forwarded.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'content-encoding') return;
      res.setHeader(k, v);
    });
    const data = Buffer.from(await forwarded.arrayBuffer());
    res.end(data);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const bound = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${bound.port}`,
    submissionCount: () => count,
    stop: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startFakeNode(handlers: {
  template?: (req: IncomingMessage, res: ServerResponse) => void;
  submit?: (req: IncomingMessage, res: ServerResponse) => void;
  current?: (req: IncomingMessage, res: ServerResponse) => void;
}): Promise<FakeNode> {
  const s: HttpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/mining/template')) {
      if (handlers.template) return handlers.template(req, res);
    }
    if (req.method === 'POST' && req.url?.startsWith('/mining/submit')) {
      if (handlers.submit) return handlers.submit(req, res);
    }
    if (req.method === 'GET' && req.url?.startsWith('/blocks/current')) {
      if (handlers.current) return handlers.current(req, res);
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve()),
  );
  const bound = s.address() as { port: number };
  return {
    url: `http://127.0.0.1:${bound.port}`,
    stop: () => {
      // Force every open connection closed so a request held open by one
      // of the handlers (e.g. a "never answers" case) does not keep the
      // afterEach waiting on `.close`.
      s.closeAllConnections();
      return new Promise<void>((resolve) => s.close(() => resolve()));
    },
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

describe('miner', () => {
  let node: SpawnedNode | null = null;
  let fake: FakeNode | null = null;
  let handle: MinerHandle | null = null;

  afterEach(async () => {
    // Close the fake's connections first — a miner fetch held by an
    // unresponsive handler would keep `handle.joined` from settling.
    if (fake) {
      await fake.stop();
      fake = null;
    }
    if (handle) {
      await handle.stop();
      await handle.joined.catch(() => {});
      handle = null;
    }
    if (node) {
      await node.stop();
      node = null;
    }
  });

  it('reads the API port off the node\'s own line (PORT=0)', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    expect(node.apiPort).toBeGreaterThan(0);
    const evt = JSON.parse(node.apiLine) as { event: string; port: number };
    expect(evt.event).toBe('api_listening');
    expect(evt.port).toBe(node.apiPort);
    // The admin line is logged with the configured adminPort — under PORT=0
    // that reads as the literal 0, so the admin port is NOT readable from
    // the process's own line. Record the line for a reader.
    if (node.adminLine !== null) {
      expect(node.adminLine).toMatch(/Admin listener on /);
    }
  }, 60_000);

  it('mines at the configured cadence, judged on the node\'s heights', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    const intervalMs = 400;
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret,
      intervalMs,
      controlPort: 0,
    });
    const windowMs = intervalMs * 6;
    const samples: number[] = [];
    const start = Date.now();
    while (Date.now() - start < windowMs) {
      const tip = await fetchJson<{ height: number }>(
        `${node.apiUrl}/blocks/current`,
      );
      samples.push(tip.height);
      await sleep(intervalMs);
    }
    const final = samples.at(-1) ?? 0;
    // The cadence should produce roughly one block per interval. The first
    // interval is spent polling for the first template, so the floor is
    // intervals - 2 and the ceiling is intervals + 2.
    expect(final).toBeGreaterThanOrEqual(3);
    expect(final).toBeLessThanOrEqual(10);
  }, 60_000);

  it('mines to the asked height, answers with it, and resumes the cadence', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    const intervalMs = 2_000;
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret,
      intervalMs,
      controlPort: 0,
    });
    const target = 5;
    const beforeMineTo = Date.now();
    const reached = await postJson<{ height: number }>(
      `http://127.0.0.1:${handle.controlPort}/mine-to`,
      { height: target },
    );
    const mineToMs = Date.now() - beforeMineTo;
    expect(reached.height).toBeGreaterThanOrEqual(target);
    // At 2 s cadence, racing to height 5 takes well under one interval.
    expect(mineToMs).toBeLessThan(intervalMs);
    // The cadence resumes from the end of the mine-to — no block arrives
    // within the first ~half of one interval.
    await sleep(intervalMs / 4);
    const stillAt = await fetchJson<{ height: number }>(
      `${node.apiUrl}/blocks/current`,
    );
    expect(stillAt.height).toBe(reached.height);
  }, 60_000);

  it('resumes the cadence one interval after the mine-to answers, judged on node heights', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    const intervalMs = 2_000;
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret,
      intervalMs,
      controlPort: 0,
    });
    // Wait for the natural cadence to produce one block, then a bit more
    // so that mine-to arrives roughly half an interval after it. Under the
    // real impl, the cadence resets from the moment mine-to ends and the
    // next block lands ≈ one interval later. Without the reset, the next
    // cadence tick is anchored to the pre-mine-to block, so it lands too
    // soon after the mine-to answer.
    const apiUrl = node.apiUrl;
    const waitForFirstCadenceBlock = async (): Promise<void> => {
      const deadline = Date.now() + intervalMs * 2;
      while (Date.now() < deadline) {
        const tip = await fetchJson<{ height: number }>(
          `${apiUrl}/blocks/current`,
        );
        if (tip.height >= 1) return;
        await sleep(100);
      }
      throw new Error('no cadence block within 2 intervals');
    };
    await waitForFirstCadenceBlock();
    await sleep(intervalMs * 0.5);
    const reached = await postJson<{ height: number }>(
      `http://127.0.0.1:${handle.controlPort}/mine-to`,
      { height: 5 },
    );
    const answerAt = Date.now();
    const resumeHeight = reached.height + 1;
    const deadline = answerAt + intervalMs * 2;
    let observedAt: number | null = null;
    while (Date.now() < deadline) {
      const tip = await fetchJson<{ height: number }>(
        `${node.apiUrl}/blocks/current`,
      );
      if (tip.height >= resumeHeight) {
        observedAt = Date.now();
        break;
      }
      await sleep(50);
    }
    expect(observedAt).not.toBeNull();
    const elapsed = observedAt! - answerAt;
    expect(elapsed).toBeGreaterThanOrEqual(intervalMs * 0.8);
    expect(elapsed).toBeLessThanOrEqual(intervalMs * 1.5);
  }, 60_000);

  it('answers the lower request below the higher target, no later than the higher', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret,
      intervalMs: 2_000,
      controlPort: 0,
    });
    // Two requests in flight at once. The miner mines toward max(h1, h2);
    // each answers when the tip reaches its OWN height, so the lower
    // request answers at a height below the higher's target and before
    // (or no later than) the higher request answers.
    let aAt: number | null = null;
    let bAt: number | null = null;
    const aP = postJson<{ height: number }>(
      `http://127.0.0.1:${handle.controlPort}/mine-to`,
      { height: 3 },
    ).then((r) => {
      aAt = Date.now();
      return r;
    });
    const bP = postJson<{ height: number }>(
      `http://127.0.0.1:${handle.controlPort}/mine-to`,
      { height: 5 },
    ).then((r) => {
      bAt = Date.now();
      return r;
    });
    const [a, b] = await Promise.all([aP, bP]);
    expect(a.height).toBeGreaterThanOrEqual(3);
    expect(a.height).toBeLessThan(5);
    expect(b.height).toBeGreaterThanOrEqual(5);
    expect(aAt).not.toBeNull();
    expect(bAt).not.toBeNull();
    expect(aAt! <= bAt!).toBe(true);
  }, 60_000);

  for (const [label, bodyText] of [
    ['height is 0', '{"height":0}'],
    ['height is 1.5', '{"height":1.5}'],
    ['height is 1e309 (Infinity)', '{"height":1e309}'],
    ['height is "5" (a string)', '{"height":"5"}'],
    ['height is missing', '{}'],
  ] as const) {
    it(`refuses a mine-to whose ${label} with a 400`, async () => {
      const miningSecret = randomBytes(16).toString('hex');
      node = await spawnDevnetNode({ miningSecret });
      handle = await runMiner({
        nodeApiUrl: node.apiUrl,
        miningSecret,
        intervalMs: 2_000,
        controlPort: 0,
      });
      const res = await fetch(`http://127.0.0.1:${handle.controlPort}/mine-to`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      });
      expect(res.status).toBe(400);
    }, 30_000);
  }

  it('answers a body that is not JSON with a 400', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret,
      intervalMs: 2_000,
      controlPort: 0,
    });
    const res = await fetch(`http://127.0.0.1:${handle.controlPort}/mine-to`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
  }, 30_000);

  it('the CLI refuses when this member\'s dist is older than its src', () => {
    // Set tools/test-state/dist/index.js's mtime back an hour, so the
    // recursive src/ walk reads newer. The refusal names the package
    // and exits 2. The dist mtime is restored in `finally`.
    const packageRoot = resolve(REPO_ROOT, 'tools/test-state');
    const distIndex = join(packageRoot, 'dist/index.js');
    const distStat = statSync(distIndex);
    const originalMtimeSec = distStat.mtimeMs / 1000;
    const originalAtimeSec = distStat.atimeMs / 1000;
    const olderSec = originalMtimeSec - 3600;
    try {
      utimesSync(distIndex, originalAtimeSec, olderSec);
      const result = spawnSync(
        process.execPath,
        [join(packageRoot, 'dist/cli.js'), 'fingerprint', REPO_ROOT],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/Stale dist/);
      expect(result.stderr).toMatch(/tools\/test-state/);
    } finally {
      utimesSync(distIndex, originalAtimeSec, originalMtimeSec);
    }
  });

  it('submits exactly one block per height gained', async () => {
    // A counting proxy in front of the node observes every POST to
    // /mining/submit. Over a mine-to of N blocks, the miner submits N
    // times; a loop that double-submits would count 2N.
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    const proxy = await startCountingProxy(node.apiUrl);
    try {
      handle = await runMiner({
        nodeApiUrl: proxy.url,
        miningSecret,
        intervalMs: 300,
        controlPort: 0,
      });
      const target = 5;
      await postJson<{ height: number }>(
        `http://127.0.0.1:${handle.controlPort}/mine-to`,
        { height: target },
      );
      // A small window to let any extra submit flush through the proxy.
      await sleep(100);
      expect(proxy.submissionCount()).toBe(target);
    } finally {
      await proxy.stop();
    }
  }, 30_000);

  it('the CLI miner exits 0 on SIGTERM during template polling', async () => {
    // A fake answering /mining/template by holding the response forever —
    // every miner fetch is a long-running request, so SIGTERM reliably
    // arrives while the miner is inside that fetch. A stop is an end,
    // not a refusal; the CLI exits 0.
    fake = await startFakeNode({
      template: () => {
        // never ends the response
      },
    });
    const secretDir = mkdtempSync(join(tmpdir(), 'dagsocial-test-state-sigterm-'));
    const secretPath = join(secretDir, 'mining-secret');
    writeFileSync(secretPath, randomBytes(16).toString('hex'));
    const cliBin = resolve(REPO_ROOT, 'tools/test-state/dist/cli.js');
    const cp = spawn(
      process.execPath,
      [
        cliBin,
        'miner',
        '--node-api',
        fake.url,
        '--mining-secret-path',
        secretPath,
        '--interval-ms',
        '100',
        '--control-port',
        '0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      let ready = false;
      cp.stdout!.setEncoding('utf8');
      cp.stdout!.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          try {
            const evt = JSON.parse(line) as { event?: string };
            if (evt.event === 'miner_ready') ready = true;
          } catch {
            // non-JSON lines are ignored
          }
        }
      });
      const readyDeadline = Date.now() + 10_000;
      while (!ready && Date.now() < readyDeadline) {
        await sleep(50);
      }
      expect(ready).toBe(true);
      // Let the loop pass the first cadence tick and enter the long
      // template fetch; SIGTERM lands while that fetch is in flight.
      await sleep(500);
      const exitP = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        cp.once('exit', (code, signal) => resolve({ code, signal }));
      });
      cp.kill('SIGTERM');
      const result = await exitP;
      expect(result.code).toBe(0);
    } finally {
      if (cp.exitCode === null) cp.kill('SIGKILL');
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops the miner naming the call when a template hangs past the deadline', async () => {
    // The fake accepts /mining/template and never answers. Under the
    // call deadline (set short here), the miner's fetch aborts and the
    // loop throws naming the call.
    fake = await startFakeNode({
      template: () => {
        // never ends the response; the miner's AbortController fires.
      },
    });
    handle = await runMiner({
      nodeApiUrl: fake.url,
      miningSecret: 'any',
      intervalMs: 500,
      controlPort: 0,
      callDeadlineMs: 500,
    });
    let joinedError: Error | null = null;
    try {
      await handle.joined;
    } catch (err) {
      joinedError = err as Error;
    }
    expect(joinedError).not.toBeNull();
    expect(joinedError!.message).toMatch(
      /GET \/mining\/template did not answer within 500 ms/,
    );
    await handle.stop();
    handle = null;
  }, 15_000);

  it('a pending mine-to answers 500 with the refusal message when the miner stops', async () => {
    // Fake answering /mining/template 200 at an easy target and
    // /mining/submit 409; /blocks/current reports height 0 so the loop
    // enters mineOne. A /mine-to request is in flight when the miner
    // stops on the 409; it reads the refusal's message, not a dropped
    // connection.
    fake = await startFakeNode({
      template: (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            header: { height: 1, powTargetBits: 1024 },
            powPreimage: '00'.repeat(32),
          }),
        );
      },
      submit: (_req, res) => {
        res.statusCode = 409;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":"already-committed"}');
      },
      current: (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end('{"height":0,"hash":null}');
      },
    });
    handle = await runMiner({
      nodeApiUrl: fake.url,
      miningSecret: 'any',
      intervalMs: 500,
      controlPort: 0,
    });
    const response = await fetch(
      `http://127.0.0.1:${handle.controlPort}/mine-to`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ height: 10 }),
      },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/POST \/mining\/submit returned 409/);
    expect(body.error).toMatch(/already-committed/);
    await handle.joined.catch(() => {});
    handle = null;
  }, 30_000);

  it('stops the miner when submit answers 409, naming the status', async () => {
    // A local fake node answering `/mining/template` 200 at an easy target
    // and `/mining/submit` 409. The miner's answer to the node's answer is
    // what the case holds, so a fake is the right entry.
    fake = await startFakeNode({
      template: (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        // powTargetBits = 1024 (4 bits) — solved in ~16 tries on average.
        res.end(
          JSON.stringify({
            header: { height: 1, powTargetBits: 1024 },
            powPreimage: '00'.repeat(32),
          }),
        );
      },
      submit: (_req, res) => {
        res.statusCode = 409;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"error":"already-committed"}');
      },
    });
    handle = await runMiner({
      nodeApiUrl: fake.url,
      miningSecret: 'any',
      intervalMs: 500,
      controlPort: 0,
    });
    let joinedError: Error | null = null;
    try {
      await handle.joined;
    } catch (err) {
      joinedError = err as Error;
    }
    expect(joinedError).not.toBeNull();
    expect(joinedError!.message).toMatch(/POST \/mining\/submit returned 409/);
    expect(joinedError!.message).toMatch(/already-committed/);
    await handle.stop();
    handle = null;
  }, 30_000);

  it('stops the miner naming a refusal other than 404', async () => {
    const miningSecret = randomBytes(16).toString('hex');
    node = await spawnDevnetNode({ miningSecret });
    // Wrong secret — the node answers 401 Unauthorized.
    handle = await runMiner({
      nodeApiUrl: node.apiUrl,
      miningSecret: 'this-is-not-the-secret',
      intervalMs: 500,
      controlPort: 0,
    });
    // The loop reads /mining/template, gets 401, throws, joined rejects.
    let joinedError: Error | null = null;
    try {
      await handle.joined;
    } catch (err) {
      joinedError = err as Error;
    }
    expect(joinedError).not.toBeNull();
    expect(joinedError!.message).toMatch(/GET \/mining\/template returned 401/);
    expect(joinedError!.message).toMatch(/Unauthorized/);
    // Stop the handle to clean up server/sockets. joined already rejected.
    await handle.stop();
    // Don't try to stop again in afterEach.
    handle = null;
  }, 60_000);
});
