// TEST_STATE_INTERFACE → Loading a state. `up` brings a stack up on a copy
// of a cached state and returns with every process detached; `down` stops
// exactly the processes `up` started, from any process.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { allowlistedEnv } from './env.js';
import { readState } from './cache.js';
import { CLOCK_OFFSET_PRELOAD } from './index.js';
import { computeClockOffsetMs, nodeOptionsForPreload } from './clock-offset.js';
import { computeFingerprint } from './fingerprint.js';
import {
  devnetFaucet,
  generate,
  nodePeerIdFromListenLine,
  notisIdFromKeyFile,
  pathsFor,
} from './generator.js';

// The CLI's own path — this member's `dist/cli.js` from either src or dist.
const MINER_CLI_PATH = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

interface ProcessRecord {
  readonly label: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly startedMs: number;
}

export interface UpPorts {
  readonly http: number;
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
  readonly intervalMs?: number;
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Poll a log file for a line that matches. The log is written by a detached
// subprocess through its own stdout/stderr FDs, so this reader never races
// with a Node stream — it reads bytes past the last position every 50 ms.
export async function waitForLineInFile(
  path: string,
  match: (line: string) => boolean,
  deadlineMs: number,
  label: string,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  let offset = 0;
  let buf = '';
  while (Date.now() < deadline) {
    try {
      const st = statSync(path);
      if (st.size > offset) {
        const fd = openSync(path, 'r');
        try {
          const chunk = Buffer.alloc(st.size - offset);
          readSync(fd, chunk, 0, chunk.length, offset);
          offset = st.size;
          buf += chunk.toString('utf8');
        } finally {
          closeSync(fd);
        }
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (match(line)) return line;
        }
      }
    } catch {
      // path may not exist yet
    }
    await sleep(50);
  }
  throw new Error(`${label} did not emit its line within ${deadlineMs} ms; see ${path}`);
}

// Open a log file for append and return its FD. The FD is duplicated by
// `spawn`, so this caller closes it before the loader returns.
function openLogFd(path: string): number {
  // Create the file if it does not exist; append otherwise.
  return openSync(path, 'a');
}

function recordProcess(
  records: ProcessRecord[],
  label: string,
  pid: number,
  argv: readonly string[],
): void {
  records.push({ label, pid, argv, startedMs: Date.now() });
}

function writeRecords(runDir: string, records: readonly ProcessRecord[]): void {
  writeFileSync(
    join(runDir, 'processes.log'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

// Signal each recorded pid (reverse order) only while /proc/<pid>/cmdline
// matches the recorded argv. SIGTERM, then SIGKILL after 10 s. From any
// process: no in-memory handle needed.
async function stopRecords(records: readonly ProcessRecord[]): Promise<void> {
  for (const record of [...records].reverse()) {
    await signalWhileArgvMatches(record);
  }
}

export async function up(options: UpOptions): Promise<UpResult> {
  const { stateName, runDir, repoRoot, cacheRoot, ports } = options;
  const intervalMs = options.intervalMs ?? 6_000;
  if (existsSync(runDir)) {
    const entries = readdirSync(runDir);
    if (entries.length > 0) {
      throw new Error(`run directory ${runDir} is not empty`);
    }
  } else {
    mkdirSync(runDir, { recursive: true });
  }

  const fingerprint = computeFingerprint(repoRoot);
  let cached = readState(cacheRoot, fingerprint, stateName);
  if (!cached) {
    await generate(stateName, { repoRoot, cacheRoot, intervalMs: 500 });
    cached = readState(cacheRoot, fingerprint, stateName);
    if (!cached) {
      throw new Error(`generation of ${stateName} did not land in the cache`);
    }
  }
  const manifest = cached.manifest as unknown as {
    readonly tip: { readonly height: number; readonly hash: string; readonly createdAt: number };
    readonly notisId?: string | null;
    readonly peerId?: string | null;
    readonly identities?: ReadonlyArray<{
      readonly label: string;
      readonly pubKeyHex: string;
      readonly memberSinceBlock: number | null;
      readonly postIds: readonly string[];
    }>;
  };

  // 2. Copy state into run directory. `.mesh` is a directory on a mesh
  //    node, so the copy walks it.
  for (const entry of readdirSync(cached.dir)) {
    cpSync(join(cached.dir, entry), join(runDir, entry), { recursive: true });
  }
  const dbPath = join(runDir, 'dagsocial.db');
  const nodeKeyPath = join(runDir, 'dagsocial.key');

  // 3. The clock offset places the run one second after the state's tip.
  const offsetMs = computeClockOffsetMs(manifest.tip.createdAt, Date.now());
  writeFileSync(join(runDir, 'offset-ms'), String(offsetMs));

  // 4. Fresh mining secret, mode 600.
  const miningSecret = randomBytes(16).toString('hex');
  const miningSecretPath = join(runDir, 'mining-secret');
  writeFileSync(miningSecretPath, miningSecret, { mode: 0o600 });
  chmodSync(miningSecretPath, 0o600);

  const paths = pathsFor(repoRoot);
  const preloadOption = nodeOptionsForPreload(CLOCK_OFFSET_PRELOAD);

  const records: ProcessRecord[] = [];
  // L2: if any part of the startup fails, stop every process already
  // recorded before re-throwing.
  try {
    // 5. Spawn A.
    const nodeLog = join(runDir, 'node.log');
    const nodeStdout = openLogFd(nodeLog);
    const nodeStderr = openLogFd(nodeLog);
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
    const nodeArgv = [process.execPath, paths.nodeBin];
    const nodeCp = spawn(nodeArgv[0]!, nodeArgv.slice(1), {
      cwd: runDir,
      env: nodeEnv,
      detached: true,
      stdio: ['ignore', nodeStdout, nodeStderr],
    });
    closeSync(nodeStdout);
    closeSync(nodeStderr);
    nodeCp.unref();
    recordProcess(records, 'node', nodeCp.pid!, nodeArgv);

    // 6. Read A's API, admin and p2p lines off its log.
    let apiPort: number | null = null;
    let adminPort: number | null = null;
    let peerIdFromLine: string | null = null;
    let p2pPort: number | null = null;
    await waitForLineInFile(
      nodeLog,
      (line) => {
        try {
          const ev = JSON.parse(line) as { event?: string; port?: number };
          if (ev.event === 'api_listening' && typeof ev.port === 'number') {
            apiPort = ev.port;
          }
        } catch {
          // non-JSON
        }
        const adm = /^Admin listener on [^:]+:([0-9]+)$/.exec(line);
        if (adm) adminPort = Number(adm[1]);
        if (line.startsWith('[net] listening on:')) {
          const parsed = nodePeerIdFromListenLine(line);
          if (parsed) {
            p2pPort = parsed.port;
            peerIdFromLine = parsed.peerId;
          }
        }
        return apiPort !== null && adminPort !== null;
      },
      60_000,
      'node (api + admin)',
    );
    const nodeHttp = `http://127.0.0.1:${apiPort!}`;
    const nodeAdmin = `http://127.0.0.1:${adminPort!}`;
    const nodeP2p = p2pPort !== null ? `/ip4/127.0.0.1/tcp/${p2pPort}` : '';

    const status = await fetchJson<{ networkType?: string }>(`${nodeHttp}/status`);
    if (status.networkType !== 'devnet') {
      throw new Error(`up refuses a ${status.networkType ?? 'unknown'} node`);
    }

    // 7. Spawn the faucet.
    const faucetConfiguredPort =
      ports.faucet === 0 ? await pickFreePort() : ports.faucet;
    const fid = devnetFaucet();
    const faucetKeyPath = join(runDir, 'faucet.key');
    writeFileSync(faucetKeyPath, fid.secretKeyHex, { mode: 0o600 });
    chmodSync(faucetKeyPath, 0o600);
    const faucetLog = join(runDir, 'faucet.log');
    const faucetStdout = openLogFd(faucetLog);
    const faucetStderr = openLogFd(faucetLog);
    const faucetEnv: NodeJS.ProcessEnv = {
      ...allowlistedEnv(),
      NODE_OPTIONS: preloadOption,
      DAGSOCIAL_CLOCK_OFFSET_MS: String(offsetMs),
      NETWORK_TYPE: 'devnet',
      NODE_URL: nodeHttp,
      PORT: String(faucetConfiguredPort),
      FAUCET_PUBLIC_KEY: fid.publicKeyHex,
      FAUCET_KEY_PATH: faucetKeyPath,
      FAUCET_BOND_AMOUNT: '250',
      FAUCET_CREDIT_AMOUNT: '10000000000',
    };
    const faucetArgv = [process.execPath, paths.faucetBin];
    const faucetCp = spawn(faucetArgv[0]!, faucetArgv.slice(1), {
      cwd: runDir,
      env: faucetEnv,
      detached: true,
      stdio: ['ignore', faucetStdout, faucetStderr],
    });
    closeSync(faucetStdout);
    closeSync(faucetStderr);
    faucetCp.unref();
    recordProcess(records, 'faucet', faucetCp.pid!, faucetArgv);

    let faucetPort: number | null = null;
    await waitForLineInFile(
      faucetLog,
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
    );

    // 8. Spawn the miner as `dist/cli.js miner`.
    const minerLog = join(runDir, 'miner.log');
    const minerStdout = openLogFd(minerLog);
    const minerStderr = openLogFd(minerLog);
    const minerArgs = [
      MINER_CLI_PATH,
      'miner',
      '--node-api',
      nodeHttp,
      '--mining-secret-path',
      miningSecretPath,
      '--interval-ms',
      String(intervalMs),
      '--control-port',
      String(ports.miner),
    ];
    const minerEnv: NodeJS.ProcessEnv = {
      ...allowlistedEnv(),
      NODE_OPTIONS: preloadOption,
      DAGSOCIAL_CLOCK_OFFSET_MS: String(offsetMs),
    };
    const minerArgv = [process.execPath, ...minerArgs];
    const minerCp = spawn(minerArgv[0]!, minerArgv.slice(1), {
      cwd: runDir,
      env: minerEnv,
      detached: true,
      stdio: ['ignore', minerStdout, minerStderr],
    });
    closeSync(minerStdout);
    closeSync(minerStderr);
    minerCp.unref();
    recordProcess(records, 'miner', minerCp.pid!, minerArgv);

    let minerControlPort: number | null = null;
    await waitForLineInFile(
      minerLog,
      (line) => {
        try {
          const ev = JSON.parse(line) as { event?: string; controlPort?: number };
          if (ev.event === 'miner_ready' && typeof ev.controlPort === 'number') {
            minerControlPort = ev.controlPort;
            return true;
          }
        } catch {
          // non-JSON
        }
        return false;
      },
      30_000,
      'miner',
    );

    writeRecords(runDir, records);

    const notisId = await notisIdFromKeyFile(nodeKeyPath);
    const result: UpResult = {
      name: stateName,
      fingerprint,
      runDir,
      clockOffsetMs: offsetMs,
      preloadPath: CLOCK_OFFSET_PRELOAD,
      nodeHttp,
      nodeAdmin,
      nodeP2p,
      notisId,
      peerId: peerIdFromLine,
      faucetOrigin: `http://127.0.0.1:${faucetPort!}`,
      minerControlOrigin: `http://127.0.0.1:${minerControlPort!}`,
      identities: (manifest.identities ?? []).map((i) => ({
        label: i.label,
        keyFilePath: join(runDir, `${i.label}.key`),
        pubKeyHex: i.pubKeyHex,
        memberSinceBlock: i.memberSinceBlock,
        postIds: i.postIds,
      })),
      tip: manifest.tip,
    };
    return result;
  } catch (err) {
    // L2: tear down anything we already started.
    try {
      await stopRecords(records);
    } catch {
      // keep the original error
    }
    throw err;
  }
}

export async function down(runDir: string): Promise<void> {
  const recordsPath = join(runDir, 'processes.log');
  if (!existsSync(recordsPath)) return;
  const records = readFileSync(recordsPath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ProcessRecord);
  await stopRecords(records);
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
  if (!live) return;
  if (live.length === 0) return;
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

// Pick a free loopback port by binding to 0 and closing.
export async function pickFreePort(host = '127.0.0.1'): Promise<number> {
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
