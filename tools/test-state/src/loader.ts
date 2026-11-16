// TEST_STATE_INTERFACE → Loading a state. `up` brings a stack up on a copy
// of a cached state; `down` stops exactly the processes `up` started.
import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { allowlistedEnv } from './env.js';
import { readState, type Manifest } from './cache.js';
import { CLOCK_OFFSET_PRELOAD } from './index.js';
import { computeClockOffsetMs, nodeOptionsForPreload } from './clock-offset.js';
import { computeFingerprint } from './fingerprint.js';
import { generate, pathsFor } from './generator.js';
import { runMiner, type MinerHandle } from './miner.js';

// The run's processes.log records one JSON object per line: the pid, the
// full argv, and the start time. `down` reads this file and signals each
// pid in turn.
interface ProcessRecord {
  readonly label: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly startedMs: number;
}

export interface UpPorts {
  readonly http: number; // A's api port (0 for OS-assigned)
  readonly admin: number;
  readonly p2p: number;
  readonly faucet: number;
  readonly miner: number;
}

export interface UpOptions {
  readonly stateName: string;
  readonly runDir: string;
  readonly repoRoot: string;
  readonly cacheRoot: string;
  readonly ports: UpPorts;
  readonly intervalMs?: number; // default 6_000
}

export interface UpResult {
  readonly name: string;
  readonly fingerprint: string;
  readonly runDir: string;
  readonly clockOffsetMs: number;
  readonly preloadPath: string;
  readonly nodeHttp: string;
  readonly nodeAdmin: string;
  readonly nodeP2p: string;
  readonly notisId: string | null;
  readonly peerId: string | null;
  readonly faucetOrigin: string;
  readonly minerControlOrigin: string;
  readonly identities: ReadonlyArray<{
    readonly label: string;
    readonly keyFilePath: string;
    readonly pubKeyHex: string;
    readonly memberSinceBlock: number | null;
    readonly postIds: readonly string[];
  }>;
  readonly tip: { readonly height: number; readonly hash: string; readonly createdAt: number };
}

async function waitForLine(
  cp: ChildProcess,
  match: (line: string) => boolean,
  deadlineMs: number,
  label: string,
  logBuffer: string[],
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const guard = setTimeout(() => {
      reject(new Error(`${label} did not emit its line within ${deadlineMs} ms\n${logBuffer.join('\n')}`));
    }, deadlineMs);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of s.split('\n')) {
        if (!line) continue;
        if (match(line)) {
          clearTimeout(guard);
          cp.stdout?.off('data', onData);
          resolve(line);
          return;
        }
      }
    };
    cp.stdout?.on('data', onData);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function devnetFaucetIdentity(): { publicKeyHex: string; secretKeyHex: string } {
  const DEVNET_FAUCET_PKCS8_HEX =
    '302e020100300506032b6570042204204504541a393fe199a143e47fbf10cb32ef7ef349eecd2f0997a310487b03abf4';
  const der = Buffer.from(DEVNET_FAUCET_PKCS8_HEX, 'hex');
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    publicKeyHex: pubDer.subarray(-32).toString('hex'),
    secretKeyHex: DEVNET_FAUCET_PKCS8_HEX,
  };
}

export async function up(options: UpOptions): Promise<UpResult> {
  const { stateName, runDir, repoRoot, cacheRoot, ports } = options;
  const intervalMs = options.intervalMs ?? 6_000;
  // A run directory belongs to one run. Refuse an existing non-empty one.
  if (existsSync(runDir)) {
    const entries = readdirSync(runDir);
    if (entries.length > 0) {
      throw new Error(`run directory ${runDir} is not empty`);
    }
  } else {
    mkdirSync(runDir, { recursive: true });
  }

  // 1. Fingerprint and cache check; generate on a miss. The generator's
  //    cadence is its own; the run's `intervalMs` is for the loader's
  //    miner. A short generation interval keeps the suite fast.
  const fingerprint = computeFingerprint(repoRoot);
  let cached = readState(cacheRoot, fingerprint, stateName);
  if (!cached) {
    await generate(stateName, { repoRoot, cacheRoot, intervalMs: 500 });
    cached = readState(cacheRoot, fingerprint, stateName);
    if (!cached) {
      throw new Error(`generation of ${stateName} did not land in the cache`);
    }
  }
  const manifest = cached.manifest as Manifest & {
    tip: { height: number; hash: string; createdAt: number };
    notisId?: string | null;
    peerId?: string | null;
    identities?: ReadonlyArray<{
      label: string;
      pubKeyHex: string;
      memberSinceBlock: number | null;
      postIds: readonly string[];
    }>;
  };

  // 2. Copy state into run directory.
  for (const entry of readdirSync(cached.dir)) {
    cpSync(join(cached.dir, entry), join(runDir, entry));
  }
  const dbPath = join(runDir, 'dagsocial.db');
  const nodeKeyPath = join(runDir, 'dagsocial.key');

  // 3. Compute the clock offset. The generator ran at offset 0, so the
  //    chain's stamps are the moments it ran; the offset at load places
  //    the run one second after the tip.
  const offsetMs = computeClockOffsetMs(manifest.tip.createdAt, Date.now());

  // 4. Write a fresh mining secret, 600.
  const miningSecret = randomBytes(16).toString('hex');
  const miningSecretPath = join(runDir, 'mining-secret');
  writeFileSync(miningSecretPath, miningSecret, { mode: 0o600 });
  chmodSync(miningSecretPath, 0o600);

  // 5. Spawn A.
  const paths = pathsFor(repoRoot);
  const preloadOption = nodeOptionsForPreload(CLOCK_OFFSET_PRELOAD);
  const processRecords: ProcessRecord[] = [];
  const nodeLogPath = join(runDir, 'node.log');
  const nodeLogChunks: string[] = [];
  const nodeEnv: NodeJS.ProcessEnv = {
    ...allowlistedEnv(),
    NODE_OPTIONS: preloadOption,
    DAGSOCIAL_CLOCK_OFFSET_MS: String(offsetMs),
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'miner',
    BOOTSTRAP_PEERS: '',
    PORT: String(ports.http),
    ADMIN_PORT: String(ports.admin),
    LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${ports.p2p}`,
    DB_PATH: dbPath,
    NODE_KEY_PATH: nodeKeyPath,
    MINING_SECRET: miningSecret,
  };
  const nodeCp = spawn(process.execPath, [paths.nodeBin], {
    cwd: runDir,
    env: nodeEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processRecords.push({
    label: 'node',
    pid: nodeCp.pid!,
    argv: [process.execPath, paths.nodeBin],
    startedMs: Date.now(),
  });
  nodeCp.stdout!.setEncoding('utf8');
  nodeCp.stdout!.on('data', (c: string) => {
    nodeLogChunks.push(c);
    writeFileSync(nodeLogPath, nodeLogChunks.join(''));
  });
  nodeCp.stderr!.setEncoding('utf8');
  nodeCp.stderr!.on('data', (c: string) => {
    nodeLogChunks.push('[stderr] ' + c);
    writeFileSync(nodeLogPath, nodeLogChunks.join(''));
  });

  let apiPort: number | null = null;
  let apiBind: string = '127.0.0.1';
  let adminPort: number | null = null;
  let p2pPort: number | null = null;
  await waitForLine(
    nodeCp,
    (line) => {
      try {
        const ev = JSON.parse(line) as { event?: string; port?: number; bind_address?: string };
        if (ev.event === 'api_listening' && typeof ev.port === 'number') {
          apiPort = ev.port;
          apiBind = ev.bind_address ?? apiBind;
        }
      } catch {
        // non-JSON
      }
      const adm = /^Admin listener on [^:]+:([0-9]+)$/.exec(line);
      if (adm) adminPort = Number(adm[1]);
      const p2p = /\/ip4\/[0-9.]+\/tcp\/([0-9]+)/.exec(line);
      if (p2p && line.startsWith('[net] listening on:')) p2pPort = Number(p2p[1]);
      return apiPort !== null && adminPort !== null;
    },
    60_000,
    'node (api + admin)',
    nodeLogChunks,
  );
  const nodeHttp = `http://127.0.0.1:${apiPort!}`;
  const nodeAdmin = `http://127.0.0.1:${adminPort!}`;
  const nodeP2p = p2pPort !== null ? `/ip4/127.0.0.1/tcp/${p2pPort}` : '';

  // Refuse a node that is not devnet.
  const status = await fetchJson<{ networkType?: string; notisId?: string; peerId?: string }>(
    `${nodeHttp}/status`,
  );
  if (status.networkType !== 'devnet') {
    nodeCp.kill('SIGTERM');
    throw new Error(`up refuses a ${status.networkType ?? 'unknown'} node`);
  }

  // 6. Spawn the faucet. The faucet refuses PORT=0 and prints only the
  //    configured value on start; under 0 the loader picks a free port
  //    from the OS and passes it as the faucet's PORT.
  const faucetConfiguredPort =
    ports.faucet === 0 ? await pickFreePort() : ports.faucet;
  const faucetKey = devnetFaucetIdentity();
  const faucetKeyPath = join(runDir, 'faucet.key');
  writeFileSync(faucetKeyPath, faucetKey.secretKeyHex, { mode: 0o600 });
  chmodSync(faucetKeyPath, 0o600);
  const faucetLogPath = join(runDir, 'faucet.log');
  const faucetLogChunks: string[] = [];
  const faucetEnv: NodeJS.ProcessEnv = {
    ...allowlistedEnv(),
    NODE_OPTIONS: preloadOption,
    DAGSOCIAL_CLOCK_OFFSET_MS: String(offsetMs),
    NETWORK_TYPE: 'devnet',
    NODE_URL: nodeHttp,
    PORT: String(faucetConfiguredPort),
    FAUCET_PUBLIC_KEY: faucetKey.publicKeyHex,
    FAUCET_KEY_PATH: faucetKeyPath,
    FAUCET_BOND_AMOUNT: '250',
    FAUCET_CREDIT_AMOUNT: '10000000000',
  };
  const faucetCp = spawn(process.execPath, [paths.faucetBin], {
    cwd: runDir,
    env: faucetEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processRecords.push({
    label: 'faucet',
    pid: faucetCp.pid!,
    argv: [process.execPath, paths.faucetBin],
    startedMs: Date.now(),
  });
  faucetCp.stdout!.setEncoding('utf8');
  faucetCp.stdout!.on('data', (c: string) => {
    faucetLogChunks.push(c);
    writeFileSync(faucetLogPath, faucetLogChunks.join(''));
  });
  faucetCp.stderr!.setEncoding('utf8');
  faucetCp.stderr!.on('data', (c: string) => {
    faucetLogChunks.push('[stderr] ' + c);
    writeFileSync(faucetLogPath, faucetLogChunks.join(''));
  });
  let faucetPort: number | null = null;
  await waitForLine(
    faucetCp,
    (line) => {
      const m = /^faucet listening on ([0-9]+) /.exec(line);
      if (m) {
        faucetPort = Number(m[1]);
        return true;
      }
      return false;
    },
    30_000,
    'faucet',
    faucetLogChunks,
  );

  // 7. Spawn the miner.
  const miner = await runMiner({
    nodeApiUrl: nodeHttp,
    miningSecret,
    intervalMs,
    controlPort: ports.miner,
  });
  // The miner lives in-process; record a pseudo "pid" so `down` knows about it.
  processRecords.push({
    label: 'miner',
    pid: process.pid,
    argv: [process.execPath, '<in-process miner>'],
    startedMs: Date.now(),
  });

  // 8. Print process records.
  writeFileSync(
    join(runDir, 'processes.log'),
    processRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  writeFileSync(join(runDir, 'offset-ms'), String(offsetMs));
  writeFileSync(join(runDir, 'mining-secret.path'), miningSecretPath);

  const result: UpResult = {
    name: stateName,
    fingerprint,
    runDir,
    clockOffsetMs: offsetMs,
    preloadPath: CLOCK_OFFSET_PRELOAD,
    nodeHttp,
    nodeAdmin,
    nodeP2p,
    notisId: status.notisId ?? manifest.notisId ?? null,
    peerId: status.peerId ?? manifest.peerId ?? null,
    faucetOrigin: `http://127.0.0.1:${faucetPort!}`,
    minerControlOrigin: `http://127.0.0.1:${miner.controlPort}`,
    identities: (manifest.identities ?? []).map((i) => ({
      label: i.label,
      keyFilePath: join(runDir, `${i.label}.key`),
      pubKeyHex: i.pubKeyHex,
      memberSinceBlock: i.memberSinceBlock,
      postIds: i.postIds,
    })),
    tip: manifest.tip,
  };

  // Record the in-process miner handle under a known key so the module-level
  // Down of this process can call stop on it.
  liveHandles.set(runDir, { minerHandle: miner, nodeCp, faucetCp });

  return result;
}

// In-process handles the loader keeps so `down` can ask the miner to stop
// cleanly and send SIGTERM to the node and faucet processes it owns.
interface LiveHandles {
  readonly minerHandle: MinerHandle;
  readonly nodeCp: ChildProcess;
  readonly faucetCp: ChildProcess;
}
const liveHandles = new Map<string, LiveHandles>();

// `down` reads the recorded pids and signals each while `/proc/<pid>/cmdline`
// still reads the recorded argv — on another argv the pid has been reused.
// SIGTERM, then SIGKILL after 10 s.
export async function down(runDir: string): Promise<void> {
  const recordsPath = join(runDir, 'processes.log');
  if (!existsSync(recordsPath)) return;
  const records = readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ProcessRecord);

  // Stop the miner first (in-process handle) if `up` ran in this process.
  const live = liveHandles.get(runDir);
  if (live) {
    await live.minerHandle.stop();
    await live.minerHandle.joined.catch(() => {});
  }

  // Signal faucet and node (reverse of up order).
  for (const record of [...records].reverse()) {
    if (record.label === 'miner' && live) continue; // handled above
    await signalWhileArgvMatches(record);
  }

  liveHandles.delete(runDir);
}

function cmdlineArgv(pid: number): readonly string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\u0000').filter((s) => s.length > 0);
    return parts;
  } catch {
    return null;
  }
}

async function signalWhileArgvMatches(record: ProcessRecord): Promise<void> {
  const live = cmdlineArgv(record.pid);
  if (!live) return; // already gone
  if (live.length === 0) return;
  // Match conservatively: the recorded argv's node binary must appear in the
  // live argv. A pid reused with a different argv is not touched.
  const match = record.argv.every((a, i) => live[i] === a);
  if (!match) return;
  try {
    process.kill(record.pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const still = cmdlineArgv(record.pid);
    if (!still) return;
    await sleep(100);
  }
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch {
    // ignore
  }
}

// Probe a TCP port on 127.0.0.1 for a quick aliveness check.
export async function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = createConnection({ port, host });
    s.once('connect', () => {
      s.end();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

// Ask the OS for a free loopback port by binding to 0 and reading it back.
// The faucet refuses PORT=0 (`tools/faucet/src/config.ts`) and prints only
// the configured port on start, so under PORT=0 nothing names the bound
// port on its own line (reported under claim 2). A loader that needs a
// free faucet port takes one from the OS this way.
export async function pickFreePort(host = '127.0.0.1'): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, host, () => {
      const addr = s.address();
      if (addr === null || typeof addr === 'string') {
        s.close();
        reject(new Error('no bound port'));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}
