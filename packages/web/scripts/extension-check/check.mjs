#!/usr/bin/env node
// EXTENSION_CHECK_INTERFACE → The command — one command runs a check.
// Side by side by default (every selected block at once after the first
// `up`), one at a time in the table's order with `--serial`. The source
// tree is the working tree by default; `--rev` builds a detached worktree
// of that rev at `<out>/wt` with `pnpm install --prefer-offline
// --frozen-lockfile` and removes it however the check ends. The builds
// run once (EXTENSION_CHECK_INTERFACE → Builds): the workspace, one web
// build, one extension build; each block writes its own values into its
// own copy of each build, the harness's own pass. Each block runs on a
// stack `tools/test-state/dist/cli.js up base` brings up on every port 0
// (EXTENSION_CHECK_INTERFACE → Addresses, → The stack a block runs on).
//
// Whatever ends a check stops everything it started (→ The command): a
// pass, a failure, a refusal or a signal. Every harness runs under the
// handle this check spawned it with — never a kill or a wait keyed on a
// name — and each stack's `down` reads the processes from its run
// directory's `processes.log` (TEST_STATE_INTERFACE → Loading a state).

import { spawn, spawnSync } from 'node:child_process';
import { createServer as netCreate } from 'node:net';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// EXTENSION_CHECK_INTERFACE → Blocks — the eight; `--blocks` takes names
// from this set.
const BLOCKS = ['writes', 'links', 'tip', 'figures', 'names', 'waiting', 'light', 'mesh'];
const KNOWN = new Set(['blocks', 'serial', 'rev', 'out']);

// The check lives at `<repo>/packages/web/scripts/extension-check/check.mjs`;
// the working tree is the repo root above it. The script's own location is
// how the default source tree is found (EXTENSION_CHECK_INTERFACE → The
// command).
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = resolve(HERE, '..', '..', '..', '..');

function refuse(msg) {
  console.error(msg);
  process.exit(2);
}

// --- arg parsing ---
const argv = process.argv.slice(2);
let BLOCKS_ARG = null;
let SERIAL = false;
let REV = null;
let OUT_ARG = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) refuse(`check: unexpected positional argument: ${a}`);
  const n = a.slice(2);
  if (n === 'serial') { SERIAL = true; continue; }
  if (!KNOWN.has(n)) refuse(`check: --${n} is not an option — one of: --blocks, --serial, --rev, --out`);
  const v = argv[++i];
  if (v === undefined) refuse(`check: --${n} needs a value`);
  if (n === 'blocks') BLOCKS_ARG = v;
  else if (n === 'rev') REV = v;
  else if (n === 'out') OUT_ARG = v;
}

// --blocks: comma-separated names from the table; absent means every block.
// `--serial` runs them in the table's order; side by side keeps the order
// the user gave, deduped.
let SELECTED;
if (BLOCKS_ARG === null) {
  SELECTED = BLOCKS.slice();
} else {
  SELECTED = BLOCKS_ARG.split(',').map((s) => s.trim());
  for (const b of SELECTED) {
    if (!BLOCKS.includes(b)) refuse(`check: --blocks: ${JSON.stringify(b)} is not one of: ${BLOCKS.join(', ')}`);
  }
  if (SELECTED.length === 0) refuse(`check: --blocks: empty list`);
}
if (SERIAL) SELECTED = BLOCKS.filter((b) => SELECTED.includes(b));
else SELECTED = [...new Set(SELECTED)];

// <out>: --out when given, else a new directory under the system's
// temporary directory (EXTENSION_CHECK_INTERFACE → The command).
const OUT = OUT_ARG !== null ? resolve(OUT_ARG) : mkdtempSync(join(tmpdir(), 'notis-check-'));
mkdirSync(OUT, { recursive: true });

// --rev: a detached worktree of `<rev>` at `<out>/wt`; removed however
// the check ends. The working tree when absent.
let SRC = DEFAULT_SRC;
let WORKTREE_PATH = null;
let WORKTREE_REMOVED = false;
if (REV !== null) {
  const probe = spawnSync('git', ['-C', DEFAULT_SRC, 'rev-parse', '--verify', REV], { encoding: 'utf8' });
  if (probe.status !== 0) refuse(`check: --rev ${JSON.stringify(REV)} does not resolve in ${DEFAULT_SRC}: ${(probe.stderr || '').trim()}`);
  WORKTREE_PATH = join(OUT, 'wt');
  const add = spawnSync('git', ['-C', DEFAULT_SRC, 'worktree', 'add', '--detach', WORKTREE_PATH, REV], { stdio: 'inherit' });
  if (add.status !== 0) refuse(`check: git worktree add --detach ${WORKTREE_PATH} ${REV} failed`);
  SRC = WORKTREE_PATH;
  const install = spawnSync('pnpm', ['install', '--prefer-offline', '--frozen-lockfile'], { cwd: SRC, stdio: 'inherit' });
  if (install.status !== 0) {
    await removeWorktree();
    refuse(`check: pnpm install in ${SRC} failed`);
  }
}

// The check's public origin — the one address → Addresses leaves to the
// build. The port is asked of the operating system (bind 0 on 127.0.0.1,
// read back, close) at build time; the extension's background and bridge
// carry the origin as built, and `links` serves there. A port another
// process takes between this read and `links`'s own `startWebServer` bind
// fails that block's hosted-page steps, which the harness records as the
// block's FAIL and the summary names.
const PUBLIC_PORT = await new Promise((res, rej) => {
  const s = netCreate();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => {
    const addr = s.address();
    s.close((err) => {
      if (err) rej(err);
      else if (typeof addr === 'object' && addr !== null && typeof addr.port === 'number') res(addr.port);
      else rej(new Error(`unexpected address ${JSON.stringify(addr)}`));
    });
  });
});
const PUBLIC_ORIGIN = `http://localhost:${PUBLIC_PORT}/web/`;

console.log(`check: out=${OUT}`);
console.log(`check: src=${SRC}${REV !== null ? ` (rev=${REV})` : ''}`);
console.log(`check: public=${PUBLIC_ORIGIN}`);
console.log(`check: blocks=${SELECTED.join(',')} (${SERIAL ? 'serial' : 'side-by-side'})`);

// --- teardown state ---
// Every harness the check launched runs under its own `child` handle —
// each block's `SIGTERM` is sent to the handle, and the wait is on the
// `exited` promise the spawn registers.
const liveHarnesses = new Map(); // block -> { child, exited }
// Each stack's run directory the check started an `up` into; `down`
// reads `processes.log` from the directory (TEST_STATE_INTERFACE →
// Loading a state).
const liveRunDirs = new Set();

let signalEnding = false;
async function endOnSignal(signal) {
  if (signalEnding) process.exit(130);
  signalEnding = true;
  console.error(`check: ${signal} received, tearing down`);
  for (const [, rec] of liveHarnesses) { try { rec.child.kill('SIGTERM'); } catch {} }
  for (const [, rec] of liveHarnesses) { try { await rec.exited; } catch {} }
  for (const d of liveRunDirs) { try { await runDown(d); } catch {} }
  if (WORKTREE_PATH !== null && !WORKTREE_REMOVED) { try { await removeWorktree(); } catch {} }
  process.exit(130);
}
process.on('SIGINT', endOnSignal);
process.on('SIGTERM', endOnSignal);

async function removeWorktree() {
  if (WORKTREE_PATH === null || WORKTREE_REMOVED) return;
  WORKTREE_REMOVED = true;
  await new Promise((r) => {
    const c = spawn('git', ['-C', DEFAULT_SRC, 'worktree', 'remove', '--force', WORKTREE_PATH], { stdio: 'inherit' });
    c.on('exit', () => r());
  });
}

// --- build pass, once ---
// EXTENSION_CHECK_INTERFACE → Builds — the workspace, one web build, one
// extension build; each block writes its own values into its own copies.
// A failed build refuses the check (exit 2) naming its log.
async function runBuild(label, command, args, cwd, env = {}) {
  const logPath = join(OUT, `${label}.log`);
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  await new Promise((r) => log.end(() => r()));
  if (code !== 0) {
    const msg = `check: ${label} build failed (exit ${code}); log: ${logPath}`;
    if (WORKTREE_PATH !== null && !WORKTREE_REMOVED) await removeWorktree();
    console.error(msg);
    process.exit(2);
  }
}

const WEB_DIST = join(OUT, 'web-dist');
const EXT_ZIPS = join(OUT, 'ext-zips');
const EXT_DIR = join(OUT, 'ext');

mkdirSync(WEB_DIST, { recursive: true });
mkdirSync(EXT_ZIPS, { recursive: true });

await runBuild('workspace-build', 'pnpm', ['-r', 'build'], SRC);
await runBuild(
  'web-build',
  'npx',
  ['vite', 'build', '--outDir', WEB_DIST],
  join(SRC, 'packages', 'web'),
  {
    VITE_WEB_BASE: '/web/',
    // Any loopback origin — the web build is handed to the hosted-page
    // steps, which point the client at the stack's node through the
    // shell's `notis-api`; the build-time `VITE_API_BASE` stands only
    // where no run writes over it.
    VITE_API_BASE: 'http://127.0.0.1/',
    VITE_FAUCET_BASE: '',
    VITE_NODES: '[]',
    VITE_PUBLIC: '',
    VITE_PUBLIC_ORIGIN: '',
  },
);
await runBuild(
  'extension-build',
  'bash',
  [join(SRC, 'packages', 'web', 'scripts', 'build-extension.sh')],
  SRC,
  {
    NOTIS_EXTENSION_OUT: EXT_ZIPS,
    VITE_NETWORK: 'devnet',
    VITE_NODES: '[]',
    VITE_FAUCET_BASE: 'http://127.0.0.1/faucet',
    VITE_PUBLIC: PUBLIC_ORIGIN,
    VITE_PUBLIC_ORIGIN: '',
  },
);

// The Chrome zip is unpacked to <out>/ext. `build-extension.sh` names its
// zips `notis-extension-<ver>-chrome.zip` and `-firefox.zip`; the check
// reads whichever chrome zip landed and refuses when none did.
{
  rmSync(EXT_DIR, { force: true, recursive: true });
  mkdirSync(EXT_DIR, { recursive: true });
  const zips = readdirSync(EXT_ZIPS).filter((f) => f.endsWith('-chrome.zip'));
  if (zips.length !== 1) {
    if (WORKTREE_PATH !== null && !WORKTREE_REMOVED) await removeWorktree();
    refuse(`check: expected one -chrome.zip in ${EXT_ZIPS}, got: ${JSON.stringify(zips)}`);
  }
  const chromeZip = join(EXT_ZIPS, zips[0]);
  const r = spawnSync('unzip', ['-q', chromeZip, '-d', EXT_DIR], { stdio: 'inherit' });
  if (r.status !== 0) {
    if (WORKTREE_PATH !== null && !WORKTREE_REMOVED) await removeWorktree();
    refuse(`check: unzip ${chromeZip} → ${EXT_DIR} failed`);
  }
}

// --- per-block paths ---
const NODE_DIST = join(SRC, 'packages', 'node', 'dist', 'index.js');
const MINER_SCRIPT = join(SRC, 'packages', 'node', 'scripts', 'miner.mjs');
const TEST_STATE_CLI = join(SRC, 'tools', 'test-state', 'dist', 'cli.js');
const HARNESS_SCRIPT = join(SRC, 'packages', 'web', 'scripts', 'extension-check', 'run.mjs');

// Block-specific lifecycle requirements, from run.mjs's own refusals:
// `--node-dist` and `--node-p2p` for the five blocks that spawn a second
// node; `--miner` for the three that start a miner; `--public` and
// `--web-dist` for the five with a hosted-page step; `--s-key` for names.
const NEEDS_NODE_DIST = new Set(['tip', 'figures', 'names', 'light', 'mesh']);
const NEEDS_MINER = new Set(['tip', 'light', 'mesh']);
const NEEDS_PUBLIC = new Set(['links', 'tip', 'figures', 'names', 'light']);

// `up base` into the block's run directory, with every port 0. The JSON
// object `up` prints on stdout is parsed here (TEST_STATE_INTERFACE →
// What a caller reads).
async function runUp(block, runDir) {
  mkdirSync(dirname(runDir), { recursive: true });
  const logPath = join(dirname(runDir), 'up.log');
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(
    process.execPath,
    [TEST_STATE_CLI, 'up', 'base',
      '--dir', runDir,
      '--http-port', '0',
      '--admin-port', '0',
      '--p2p-port', '0',
      '--faucet-port', '0',
      '--miner-port', '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
  child.stderr.pipe(log, { end: false });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  await new Promise((r) => log.end(() => r()));
  if (code !== 0) throw new Error(`up base --dir ${runDir} failed (exit ${code}); log: ${logPath}`);
  let parsed;
  try { parsed = JSON.parse(stdout.trim()); } catch (e) { throw new Error(`up base stdout is not JSON: ${e.message}`); }
  liveRunDirs.add(runDir);
  return parsed;
}

async function runDown(runDir) {
  if (!existsSync(runDir)) { liveRunDirs.delete(runDir); return; }
  const logPath = join(dirname(runDir), 'down.log');
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(process.execPath, [TEST_STATE_CLI, 'down', '--dir', runDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  await new Promise((r) => child.on('exit', () => r()));
  await new Promise((r) => log.end(() => r()));
  liveRunDirs.delete(runDir);
}

// Every harness line is stamped `HH:MM:SS UTC` as it arrives and written
// to the block's log.
function attachStampedLog(stream, writable) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const stamp = new Date().toISOString().slice(11, 19);
      writable.write(`${stamp} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      const stamp = new Date().toISOString().slice(11, 19);
      writable.write(`${stamp} ${buf}\n`);
      buf = '';
    }
  });
}

function identityKeyFile(up, label) {
  const row = (up.identities ?? []).find((i) => i.label === label);
  return row ? row.keyFilePath : null;
}

function harnessArgsFor(block, up, runDir, scratch, summaryPath) {
  const args = [
    '--block', block,
    '--extension-dir', EXT_DIR,
    '--scratch', scratch,
    '--node', up.nodeHttp,
    '--faucet', `${up.faucetOrigin}/faucet`,
    '--miner-control', up.minerControlOrigin,
    '--summary', summaryPath,
  ];
  const rKey = identityKeyFile(up, 'R');
  if (rKey !== null) args.push('--r-key', rKey);
  if (block !== 'mesh') args.push('--node-id', up.notisId ?? '');
  if (NEEDS_NODE_DIST.has(block)) args.push('--node-dist', NODE_DIST, '--node-p2p', up.nodeP2p);
  if (NEEDS_MINER.has(block)) args.push('--miner', MINER_SCRIPT);
  if (NEEDS_PUBLIC.has(block)) args.push('--public', PUBLIC_ORIGIN, '--web-dist', WEB_DIST);
  if (block === 'names') {
    const sKey = identityKeyFile(up, 'S');
    if (sKey !== null) args.push('--s-key', sKey);
  }
  return args;
}

async function runHarness(block, up, runDir, scratch, logPath, summaryPath) {
  const args = harnessArgsFor(block, up, runDir, scratch, summaryPath);
  // TMPDIR=/tmp on every harness run — a long TMPDIR runs Chromium's
  // `SingletonSocket` path past the 108-byte UNIX socket limit and the
  // browser never comes up (EXTENSION_CHECK_INTERFACE → The command).
  // CHROME passes through from the check's environment.
  const env = { ...process.env, TMPDIR: '/tmp' };
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(process.execPath, [HARNESS_SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  attachStampedLog(child.stdout, log);
  attachStampedLog(child.stderr, log);
  const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
  liveHarnesses.set(block, { child, exited });
  const { code } = await exited;
  liveHarnesses.delete(block);
  await new Promise((r) => log.end(() => r()));
  let summary = null;
  if (existsSync(summaryPath)) {
    try { summary = JSON.parse(readFileSync(summaryPath, 'utf8')); } catch {}
  }
  return { code, summary };
}

async function prepareBlockDirs(block) {
  const blockDir = join(OUT, block);
  mkdirSync(blockDir, { recursive: true });
  const runDir = join(blockDir, 'run');
  const scratch = join(blockDir, 'scratch');
  mkdirSync(scratch, { recursive: true });
  return {
    block,
    blockDir,
    runDir,
    scratch,
    logPath: join(blockDir, 'harness.log'),
    summaryPath: join(blockDir, 'summary.json'),
  };
}

async function finishBlock(ctx, up, startedAt) {
  let outcome;
  try {
    outcome = await runHarness(ctx.block, up, ctx.runDir, ctx.scratch, ctx.logPath, ctx.summaryPath);
  } finally {
    try { await runDown(ctx.runDir); } catch {}
  }
  return { ...ctx, up, startedAt, wallMs: Date.now() - startedAt, ...outcome };
}

async function runBlockFlow(block) {
  const ctx = await prepareBlockDirs(block);
  const startedAt = Date.now();
  let up;
  try {
    up = await runUp(block, ctx.runDir);
  } catch (e) {
    return { ...ctx, up: null, startedAt, wallMs: Date.now() - startedAt, code: 2, summary: null, upError: String(e?.message ?? e) };
  }
  return finishBlock(ctx, up, startedAt);
}

// --- orchestration ---
// The state is made before any block loads it (EXTENSION_CHECK_INTERFACE
// → The stack a block runs on): the first block's `up` runs alone, so
// `base` is generated once where the cache lacks it; the other blocks'
// `up`s start after that.
const checkStart = Date.now();
const results = [];

if (SERIAL) {
  for (const b of SELECTED) {
    const r = await runBlockFlow(b);
    results.push(r);
    console.log(blockLine(r));
  }
} else {
  const first = SELECTED[0];
  const firstCtx = await prepareBlockDirs(first);
  const firstStartedAt = Date.now();
  let firstUp;
  try {
    firstUp = await runUp(first, firstCtx.runDir);
  } catch (e) {
    const r = { ...firstCtx, up: null, startedAt: firstStartedAt, wallMs: Date.now() - firstStartedAt, code: 2, summary: null, upError: String(e?.message ?? e) };
    results.push(r);
    console.log(blockLine(r));
    for (const b of SELECTED.slice(1)) {
      const rr = await runBlockFlow(b);
      results.push(rr);
      console.log(blockLine(rr));
    }
  }
  if (firstUp) {
    const firstPromise = (async () => {
      const r = await finishBlock(firstCtx, firstUp, firstStartedAt);
      console.log(blockLine(r));
      return r;
    })();
    const restPromises = SELECTED.slice(1).map(async (b) => {
      const r = await runBlockFlow(b);
      console.log(blockLine(r));
      return r;
    });
    const all = await Promise.all([firstPromise, ...restPromises]);
    results.push(...all);
  }
}

// EXTENSION_CHECK_INTERFACE → The command — one line per block as it ends,
// the summary last. The record reads from the harness's own summary
// object (`measured`, `pass`, `fail`, `skipped`); a block whose harness
// never wrote a summary reads with 0 and the harness's exit code.
function blockLine(r) {
  const wallSecs = (r.wallMs / 1000).toFixed(1);
  if (r.summary !== null) {
    const { measured, pass, fail, skipped } = r.summary;
    const notRun = measured - pass - fail - skipped;
    return `[block ${r.block}] ${pass}/${measured} pass, ${fail} fail, ${notRun} not run (${wallSecs}s)`;
  }
  const why = r.upError ?? `harness exit ${r.code}`;
  return `[block ${r.block}] no summary — ${why} (${wallSecs}s)`;
}

const checkWallSecs = ((Date.now() - checkStart) / 1000).toFixed(1);
const anyFail = results.some((r) => r.summary === null || r.summary.fail > 0 || r.summary.pass < r.summary.measured);
let exitCode = anyFail ? 1 : 0;
// A refusal that landed in a block's `up` (exit code 2 from the harness,
// no summary written) is exit 1 for the check, not 2 — a refusal before
// any block ran is exit 2, and every block here ran or tried to.

console.log(`\n=== check summary === ${results.length} block${results.length === 1 ? '' : 's'}, ${checkWallSecs}s, out=${OUT}`);
for (const r of results) console.log('  ' + blockLine(r));

if (WORKTREE_PATH !== null && !WORKTREE_REMOVED) await removeWorktree();

process.exit(exitCode);
