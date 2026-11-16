// TEST_STATE_INTERFACE → Generation. The generator builds a state once on a
// fresh devnet stack through the product's own write paths: it starts A, the
// faucet and the miner; mines to the state's starting height; runs the
// state's write scripts in order; reads the manifest's figures from A;
// stops the processes by their pids; and writes the state into the cache.
import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadNodeKey } from '@dagsocial/net';
import { NETWORK_PROFILES } from '@dagsocial/types';
import { allowlistedEnv } from './env.js';
import { writeState, type Manifest } from './cache.js';
import { computeFingerprint } from './fingerprint.js';
import { runMiner, type MinerHandle } from './miner.js';

// The devnet faucet key is public by design (`ARCHITECTURE → Genesis`). It
// rides the generator so the faucet it spawns signs with the pair the
// `NETWORK_PROFILES.devnet.faucetPublicKey` names. The one helper the
// generator and the loader share, so both check the key against the
// `@dagsocial/types` profile on every load.
const DEVNET_FAUCET_PKCS8_HEX =
  '302e020100300506032b6570042204204504541a393fe199a143e47fbf10cb32ef7ef349eecd2f0997a310487b03abf4';

export function devnetFaucet(): { publicKeyHex: string; secretKeyHex: string } {
  const der = Buffer.from(DEVNET_FAUCET_PKCS8_HEX, 'hex');
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(priv).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyHex = pubDer.subarray(-32).toString('hex');
  const expected = NETWORK_PROFILES.devnet.faucetPublicKey;
  if (publicKeyHex !== expected) {
    throw new Error(
      `devnet faucet key mismatch: derived ${publicKeyHex}, ` +
        `NETWORK_PROFILES.devnet.faucetPublicKey = ${expected}`,
    );
  }
  return { publicKeyHex, secretKeyHex: DEVNET_FAUCET_PKCS8_HEX };
}

// NET_INTERFACE → The node key. The notisId is the 32-byte Ed25519 public
// key `loadNodeKey` reads from the file's seed. The caller passes a path
// that is known to exist (a missing file is a failure above) so `loadNodeKey` never
// writes a fresh key here — it only reads what the node wrote.
export async function notisIdFromKeyFile(path: string): Promise<string> {
  const keyPair = await loadNodeKey(path);
  return Buffer.from(keyPair.publicKey).toString('hex');
}

// NET_INTERFACE → The node key. The `[net] listening on` line carries
// `/ip4/<ip>/tcp/<port>/p2p/<peerId>`; the peerId is libp2p's identity
// multihash over the key.
export function nodePeerIdFromListenLine(line: string): { port: number; peerId: string } | null {
  // Example:
  //   [net] listening on: /ip4/127.0.0.1/tcp/41011/p2p/12D3KooWSi2667…
  const m = /\/ip4\/[0-9.]+\/tcp\/([0-9]+)\/p2p\/([A-Za-z0-9]+)/.exec(line);
  if (!m) return null;
  return { port: Number(m[1]), peerId: m[2]! };
}

export interface StateDef {
  readonly name: string;
  readonly startingHeight: number;
  readonly promotions: readonly string[]; // identity labels to promote
  readonly claim: { readonly identity: string; readonly name: string } | null;
}

export const BASE: StateDef = {
  name: 'base',
  startingHeight: 60,
  promotions: ['R', 'S', 'R2', 'R3'],
  claim: { identity: 'S', name: 'Sk5send' },
};

// A small devnet state the suite uses: a chain mined to height 5, one
// identity (R) promoted to member on the earned path, and no name
// claim. Every manifest field a `base` load reads is also written for
// `minimal`, so the suite exercises the generator's full shape without
// the four promotions and the claim `base` carries.
export const MINIMAL: StateDef = {
  name: 'minimal',
  startingHeight: 5,
  promotions: ['R'],
  claim: null,
};

export const STATE_DEFS = new Map<string, StateDef>([
  [BASE.name, BASE],
  [MINIMAL.name, MINIMAL],
]);

export interface GeneratorPaths {
  readonly nodeBin: string; // packages/node/dist/index.js
  readonly faucetBin: string; // tools/faucet/dist/index.js
  readonly promoteScript: string; // packages/web/scripts/promote.mjs
  readonly claimNameScript: string; // packages/web/scripts/extension-check/claim-name.mjs
}

// Derive every path from the repo root. The generator reads a repoRoot and
// addresses each script by its path under it.
export function pathsFor(repoRoot: string): GeneratorPaths {
  return {
    nodeBin: resolve(repoRoot, 'packages/node/dist/index.js'),
    faucetBin: resolve(repoRoot, 'tools/faucet/dist/index.js'),
    promoteScript: resolve(repoRoot, 'packages/web/scripts/promote.mjs'),
    claimNameScript: resolve(repoRoot, 'packages/web/scripts/extension-check/claim-name.mjs'),
  };
}

export interface GenerateOptions {
  readonly repoRoot: string;
  readonly cacheRoot: string;
  readonly intervalMs?: number; // the generator's cadence, default 1_500 ms
}

// A one-line process record for the run's processes.log.
interface ProcessRecord {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly started: number;
}

async function waitForLine(
  cp: ChildProcess,
  match: (line: string) => boolean,
  deadlineMs: number,
  label: string,
): Promise<string> {
  const buf: string[] = [];
  return new Promise<string>((resolve, reject) => {
    const guard = setTimeout(() => {
      reject(new Error(`${label} did not emit its line within ${deadlineMs} ms\n${buf.join('\n')}`));
    }, deadlineMs);
    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of s.split('\n')) {
        if (!line) continue;
        buf.push(line);
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

// A spawned child's exit event with the fact (`code`, `signal`) the handler
// receives. Captured AT SPAWN, so a child that dies before the first
// `endProcess` call has its exit already resolved: a child killed by a
// signal has a null `exitCode`, and an `exit` listener added after the
// event never fires.
interface TrackedProcess {
  readonly cp: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export function trackSpawn(cp: ChildProcess): TrackedProcess {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      cp.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  return { cp, exited };
}

export async function endProcess(
  tracked: TrackedProcess,
  deadlineMs = 10_000,
): Promise<void> {
  try {
    tracked.cp.kill('SIGTERM');
  } catch {
    // dead already — harmless
  }
  const timer = setTimeout(() => {
    try {
      tracked.cp.kill('SIGKILL');
    } catch {
      // dead already — harmless
    }
  }, deadlineMs);
  try {
    await tracked.exited;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Write each chunk the child emits on stdout and stderr to `logPath` as it
// arrives, so a work directory kept on a failure reads A's output up to the
// moment the failure fired. The fd closes on `close`, not `exit`: a child's
// stdio streams can still deliver data after `exit`, and those late chunks
// are exactly the last lines a crashing node prints. `waitForLine` still
// attaches its own `data` listener for the readiness line; Node emits each
// chunk to every listener.
export function streamChildToLog(cp: ChildProcess, logPath: string): void {
  const fd = openSync(logPath, 'a');
  cp.stdout?.setEncoding('utf8');
  cp.stdout?.on('data', (chunk: string | Buffer) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    writeSync(fd, bytes);
  });
  cp.stderr?.setEncoding('utf8');
  cp.stderr?.on('data', (chunk: string | Buffer) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    writeSync(fd, Buffer.from('[stderr] ' + s, 'utf8'));
  });
  cp.once('close', () => closeSync(fd));
}

interface PromoteOutput {
  readonly label: string;
  readonly pubKeyHex: string;
  readonly privKeyBase64: string;
}

// Run promote.mjs for one identity label; capture its final key pair from
// stdout and drop its text into a file whose name the caller passes.
async function runPromote(
  args: {
    readonly repoRoot: string;
    readonly promoteScript: string;
    readonly apiBase: string;
    readonly faucetBase: string;
    readonly label: string;
  },
  logPath: string,
): Promise<PromoteOutput> {
  const env = {
    ...allowlistedEnv(),
  };
  const cp = spawn(
    process.execPath,
    [args.promoteScript, args.apiBase, args.faucetBase],
    { cwd: args.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  cp.stdout!.setEncoding('utf8');
  cp.stdout!.on('data', (chunk: string) => {
    out += chunk;
  });
  cp.stderr!.setEncoding('utf8');
  cp.stderr!.on('data', (chunk: string) => {
    err += chunk;
  });
  const exit = await new Promise<number | null>((resolve) =>
    cp.once('exit', (code) => resolve(code)),
  );
  // Log every line that is not a SECRET line; the SECRET lines are read
  // once into memory and written to the identity's own mode-600 file.
  const lines = out.split('\n');
  writeFileSync(
    logPath,
    lines.filter((l) => !l.startsWith('R_SECRET') && !l.startsWith('SECRET')).join('\n'),
  );
  if (exit !== 0) {
    throw new Error(
      `promote.mjs for ${args.label} exited ${exit}\nstderr:\n${err}\nstdout:\n${lines.filter((l) => !/SECRET/.test(l)).join('\n')}`,
    );
  }
  let pubKeyHex: string | null = null;
  let secretHex: string | null = null;
  for (const line of lines) {
    const pub = /^R_PUBLIC=([0-9a-f]{64})$/.exec(line);
    if (pub) pubKeyHex = pub[1]!;
    const sec = /^R_SECRET_PKCS8_HEX=([0-9a-f]+)$/.exec(line);
    if (sec) secretHex = sec[1]!;
  }
  if (!pubKeyHex || !secretHex) {
    throw new Error(`promote.mjs for ${args.label} did not print R_PUBLIC and R_SECRET_PKCS8_HEX`);
  }
  // The identity's key file is `{ pubKeyHex, privKeyBase64 }` — the
  // base64 of the 48-byte PKCS8 DER promote.mjs prints as hex.
  const privKeyBase64 = Buffer.from(secretHex, 'hex').toString('base64');
  return { label: args.label, pubKeyHex, privKeyBase64 };
}

async function runClaimName(
  args: {
    readonly repoRoot: string;
    readonly claimNameScript: string;
    readonly apiBase: string;
    readonly keyFile: string;
    readonly name: string;
  },
  logPath: string,
): Promise<{ boxId: string; claimedAtBlock: number }> {
  const env = { ...allowlistedEnv() };
  const cp = spawn(
    process.execPath,
    [args.claimNameScript, args.apiBase, args.keyFile, args.name],
    { cwd: args.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  let err = '';
  cp.stdout!.setEncoding('utf8');
  cp.stdout!.on('data', (chunk: string) => {
    out += chunk;
  });
  cp.stderr!.setEncoding('utf8');
  cp.stderr!.on('data', (chunk: string) => {
    err += chunk;
  });
  const exit = await new Promise<number | null>((resolve) =>
    cp.once('exit', (code) => resolve(code)),
  );
  writeFileSync(logPath, out);
  if (exit !== 0) {
    throw new Error(
      `claim-name.mjs for ${args.name} exited ${exit}\nstderr:\n${err}\nstdout:\n${out}`,
    );
  }
  let boxId: string | null = null;
  let height: number | null = null;
  for (const line of out.split('\n')) {
    const b = /^S_NAME_BOX=([0-9a-f]+)$/.exec(line);
    if (b) boxId = b[1]!;
    const h = /^S_CLAIMED_AT=([0-9]+)$/.exec(line);
    if (h) height = Number(h[1]);
  }
  if (!boxId || height === null) {
    throw new Error(`claim-name.mjs for ${args.name} did not print S_NAME_BOX and S_CLAIMED_AT`);
  }
  return { boxId, claimedAtBlock: height };
}

export interface GenerateResult {
  readonly manifest: Manifest;
  readonly fingerprint: string;
  readonly cachePath: string;
}

export async function generate(
  stateName: string,
  options: GenerateOptions,
): Promise<GenerateResult> {
  const def = STATE_DEFS.get(stateName);
  if (!def) throw new Error(`Unknown state: ${stateName}`);
  const fingerprint = computeFingerprint(options.repoRoot);
  const paths = pathsFor(options.repoRoot);
  const intervalMs = options.intervalMs ?? 1_500;

  const workDir = mkdtempSync(join(tmpdir(), `dagsocial-test-state-gen-${def.name}-`));
  try {
    const dbPath = join(workDir, 'dagsocial.db');
    const nodeKeyPath = join(workDir, 'dagsocial.key');
    const miningSecret = randomBytes(16).toString('hex');
    const miningSecretPath = join(workDir, 'mining-secret');
    writeFileSync(miningSecretPath, miningSecret, { mode: 0o600 });
    chmodSync(miningSecretPath, 0o600);

    const faucetKey = devnetFaucet();
    const faucetKeyPath = join(workDir, 'faucet.key');
    writeFileSync(faucetKeyPath, faucetKey.secretKeyHex, { mode: 0o600 });
    chmodSync(faucetKeyPath, 0o600);

    // 1. Spawn A (devnet, miner, no bootstrap, PORT/ADMIN_PORT/listen=0).
    const nodeLog = join(workDir, 'node.log');
    const nodeEnv: NodeJS.ProcessEnv = {
      ...allowlistedEnv(),
      NETWORK_TYPE: 'devnet',
      NODE_ROLE: 'miner',
      BOOTSTRAP_PEERS: '',
      PORT: '0',
      ADMIN_PORT: '0',
      LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0',
      DB_PATH: dbPath,
      NODE_KEY_PATH: nodeKeyPath,
      MINING_SECRET: miningSecret,
    };
    const nodeCp = spawn(process.execPath, [paths.nodeBin], {
      cwd: workDir,
      env: nodeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nodeTracked = trackSpawn(nodeCp);
    const processRecords: ProcessRecord[] = [
      { pid: nodeCp.pid!, argv: [process.execPath, paths.nodeBin], started: Date.now() },
    ];
    streamChildToLog(nodeCp, nodeLog);

    let apiPort: number | null = null;
    let adminPort: number | null = null;
    let peerIdFromLine: string | null = null;
    // api_listening is the JSON event; the admin line prints after fix
    // eef0eee3; the `[net] listening on:` line carries the libp2p peer id.
    await waitForLine(
      nodeCp,
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
          if (parsed) peerIdFromLine = parsed.peerId;
        }
        return apiPort !== null && adminPort !== null && peerIdFromLine !== null;
      },
      60_000,
      'node (api + admin + p2p)',
    );

    const apiBase = `http://127.0.0.1:${apiPort!}`;

    try {
      // Refuse a node that is not devnet.
      const status = (await fetchJson<{ networkType?: string }>(`${apiBase}/status`));
      if (status.networkType !== 'devnet') {
        throw new Error(`generator refuses a ${status.networkType ?? 'unknown'} node`);
      }

      // 2. Spawn the faucet pointing at A. The faucet refuses PORT=0, so a
      //    free loopback port is taken from the OS and passed as PORT.
      const { pickFreePort } = await import('./loader.js');
      const faucetBoundPort = await pickFreePort();
      const faucetLog = join(workDir, 'faucet.log');
      const faucetEnv: NodeJS.ProcessEnv = {
        ...allowlistedEnv(),
        NETWORK_TYPE: 'devnet',
        NODE_URL: apiBase,
        PORT: String(faucetBoundPort),
        FAUCET_PUBLIC_KEY: faucetKey.publicKeyHex,
        FAUCET_KEY_PATH: faucetKeyPath,
        FAUCET_BOND_AMOUNT: '250',
        FAUCET_CREDIT_AMOUNT: '10000000000',
      };
      const faucetCp = spawn(process.execPath, [paths.faucetBin], {
        cwd: workDir,
        env: faucetEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const faucetTracked = trackSpawn(faucetCp);
      processRecords.push({ pid: faucetCp.pid!, argv: [process.execPath, paths.faucetBin], started: Date.now() });
      streamChildToLog(faucetCp, faucetLog);

      // The faucet prints: `faucet listening on <port> as <key> against devnet at <url>`.
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
      );
      const faucetBase = `http://127.0.0.1:${faucetPort!}`;

      try {
        // 3. Start the miner in-process at the generator's cadence.
        const miner: MinerHandle = await runMiner({
          nodeApiUrl: apiBase,
          miningSecret,
          intervalMs,
          controlPort: 0,
        });

        try {
          // 4. Mine to the starting height.
          const reachStartingHeight = await fetch(
            `http://127.0.0.1:${miner.controlPort}/mine-to`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ height: def.startingHeight }),
            },
          );
          if (!reachStartingHeight.ok) {
            throw new Error(
              `mine-to ${def.startingHeight} returned ${reachStartingHeight.status}: ` +
                (await reachStartingHeight.text()),
            );
          }

          // 5. Run each promotion. The key file is `{ pubKeyHex, privKeyBase64 }`.
          const identities: Array<{
            label: string;
            pubKeyHex: string;
            keyFile: string;
            memberSinceBlock?: number;
          }> = [];
          for (const label of def.promotions) {
            const log = join(workDir, `promote-${label}.log`);
            const promoted = await runPromote(
              {
                repoRoot: options.repoRoot,
                promoteScript: paths.promoteScript,
                apiBase,
                faucetBase,
                label,
              },
              log,
            );
            const keyFile = join(workDir, `${label}.key`);
            writeFileSync(
              keyFile,
              JSON.stringify({
                pubKeyHex: promoted.pubKeyHex,
                privKeyBase64: promoted.privKeyBase64,
              }),
              { mode: 0o600 },
            );
            chmodSync(keyFile, 0o600);
            identities.push({ label, pubKeyHex: promoted.pubKeyHex, keyFile });
          }

          // 6. Run the claim, if any.
          let claimed: { boxId: string; claimedAtBlock: number; name: string } | null = null;
          if (def.claim) {
            const { identity: claimLabel, name: claimName } = def.claim;
            const ident = identities.find((i) => i.label === claimLabel);
            if (!ident) {
              throw new Error(`claim identity ${claimLabel} not among promoted`);
            }
            const log = join(workDir, `claim-${claimLabel}.log`);
            const result = await runClaimName(
              {
                repoRoot: options.repoRoot,
                claimNameScript: paths.claimNameScript,
                apiBase,
                keyFile: ident.keyFile,
                name: claimName,
              },
              log,
            );
            claimed = { ...result, name: claimName };
          }

          // 7. Read the manifest's figures from A.
          const tip = await fetchJson<{ height: number; hash: string }>(
            `${apiBase}/blocks/current`,
          );
          const tipBlock = await fetchJson<{ header: { createdAt: number } }>(
            `${apiBase}/blocks/${tip.height}`,
          );
          const identityRows = [];
          for (const ident of identities) {
            const karma = await fetchJson<{
              memberSinceBlock?: number | null;
              member?: boolean;
            }>(`${apiBase}/karma/${ident.pubKeyHex}`);
            // NODE_INTERFACE → Posts. `GET /posts?author=` answers
            // `{ posts, next, pending, pendingCount }`; `posts` is the
            // confirmed rows.
            const authored = await fetchJson<{
              posts?: ReadonlyArray<{ id: string }>;
            }>(`${apiBase}/posts?author=${ident.pubKeyHex}&limit=50`);
            identityRows.push({
              label: ident.label,
              pubKeyHex: ident.pubKeyHex,
              memberSinceBlock: karma.memberSinceBlock ?? null,
              postIds: (authored.posts ?? []).map((p) => p.id),
            });
          }

          // notisId is the node key's public half (`loadNodeKey`'s
          // seed-derived publicKey); peerId is libp2p's identity from the
          // `[net] listening on` line. `/status` carries neither.
          const notisId = await notisIdFromKeyFile(nodeKeyPath);
          if (peerIdFromLine === null) {
            throw new Error('node did not print a `[net] listening on` line with a peerId');
          }
          const manifest: Manifest = {
            name: def.name,
            fingerprint,
            tip: {
              height: tip.height,
              hash: tip.hash,
              createdAt: tipBlock.header.createdAt,
            },
            notisId,
            peerId: peerIdFromLine,
            identities: identityRows,
            claim: claimed,
          };
          writeFileSync(
            join(workDir, 'manifest.json'),
            JSON.stringify(manifest),
          );

          // Write process records.
          writeFileSync(
            join(workDir, 'processes.log'),
            processRecords.map((r) => JSON.stringify(r)).join('\n') + '\n',
          );

          // 8. Stop miner, faucet, A. `endProcess` awaits the exit event,
          //    so no further wait is needed — A's SIGTERM handler closes
          //    the store before exit, and a `-wal` or `-shm` beside the
          //    store after A's clean exit fails the generation, naming
          //    the file.
          await miner.stop();
          await miner.joined.catch(() => {});
          await endProcess(faucetTracked);
          await endProcess(nodeTracked);

          if (!existsSync(dbPath)) {
            throw new Error(`generator: the store ${dbPath} is missing after A exited`);
          }
          if (!existsSync(nodeKeyPath)) {
            throw new Error(`generator: the node key ${nodeKeyPath} is missing after A exited`);
          }
          for (const suffix of ['-wal', '-shm']) {
            const leftover = dbPath + suffix;
            if (existsSync(leftover)) {
              throw new Error(
                `generator: ${leftover} is beside the store after A's clean stop`,
              );
            }
          }

          // 9. Write to the cache. The state's files: the store, the node
          //    key, the mesh state (where one exists), each identity key,
          //    the manifest. `.mesh` is a directory on a mesh node.
          const stageDir = mkdtempSync(join(tmpdir(), `dagsocial-test-state-stage-${def.name}-`));
          try {
            cpSync(dbPath, join(stageDir, 'dagsocial.db'));
            cpSync(nodeKeyPath, join(stageDir, 'dagsocial.key'));
            const meshPath = dbPath.replace(/\.db$/, '.mesh');
            if (existsSync(meshPath)) {
              cpSync(meshPath, join(stageDir, 'dagsocial.mesh'), { recursive: true });
            }
            for (const ident of identities) {
              cpSync(ident.keyFile, join(stageDir, `${ident.label}.key`));
              chmodSync(join(stageDir, `${ident.label}.key`), 0o600);
            }
            writeFileSync(join(stageDir, 'manifest.json'), JSON.stringify(manifest));

            const cached = writeState(options.cacheRoot, fingerprint, def.name, stageDir);
            // Remove the staging copy on success; keep it (and the generator's work directory
            // beside it) only when the generation threw.
            rmSync(stageDir, { recursive: true, force: true });
            rmSync(workDir, { recursive: true, force: true });
            return { manifest, fingerprint, cachePath: cached.dir };
          } finally {
            if (existsSync(stageDir)) {
              rmSync(stageDir, { recursive: true, force: true });
            }
          }
        } finally {
          // Miner stop may already have been called; guard.
          try {
            await miner.stop();
          } catch {
            // ignore
          }
        }
      } finally {
        await endProcess(faucetTracked);
      }
    } finally {
      await endProcess(nodeTracked);
    }
  } catch (err) {
    // On failure keep the generator's work directory and name it. A's log,
    // the pool (`<workDir>/dagsocial.db` through `sqlite3 -readonly`)
    // and the scripts' logs sit under it for a reader to inspect.
    const message = (err as Error).message ?? String(err);
    throw new Error(
      `generation of ${def.name} failed; work directory kept at ${workDir}\n${message}`,
    );
  }
}
