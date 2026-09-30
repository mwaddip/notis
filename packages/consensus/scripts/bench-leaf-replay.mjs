#!/usr/bin/env node
// Times a leaf's replay of a block from its parent's digest and its proof alone (CONSENSUS_INTERFACE → The tree
// session; CONSENSUS_INTERFACE → The block proof) over bodies sized to the block's budget (CONSENSUS_INTERFACE → The
// block's cost), in Node or in a browser:
//
//   ordinary   — 10 one-signer credit sends;
//   one-signer — one-signer credit sends, as many as MAX_BLOCK_COST admits;
//   packed     — credit payments of as many signers as MAX_TX_BYTES holds, MAX_BLOCK_COST / W_SIG signers in all: the
//                signatures' term alone at the budget, the largest batch the body check runs;
//   read-heavy — vouches, each from a member holding KARMA_BOXES_PER_VOUCHER karma boxes its vouch's balance read
//                walks, as many as MAX_BLOCK_COST admits.
//
// Each body is built over its own stub state and proven on a prover seeded with the same state: its reads recorded,
// then its writes. A replay decodes the proof and anchors it at the parent's digest, runs `applyBlock` over
// `treeStateView(verifierSession(v))`, derives `treeWritesOf` over the same view, performs the writes on the verifier
// and compares the digest they reach with the prover's; apart from the replay, the body's signature batch runs alone,
// and its time is taken out of `applyBlock`'s. Per body the script prints the proof's bytes, the view's
// `lookupCount()`, the writes, the signatures and the cost at the provisional weights — the packed body's over the
// budget, its tree operations costing on top of its signatures — and the medians of the runs' times: the proof's
// decode, the signature batch, the rest of `applyBlock`, and the writes with the digest. A replay that throws, or
// that counts a signature, a lookup or a write otherwise than the prover did, sets the exit code.
//
// With `--browser`, the replay is built for a browser with the bundle test's build and served with the bodies from
// 127.0.0.1; the named browser runs it headless, on a throwaway profile, in a dedicated worker that POSTs each body's
// runs back; the script prints them as the Node table, then stops the browser's process group and deletes the
// profile. The script reads this package's build and the test tree's TypeScript helpers: `pnpm -r build` first, on
// Node 22.18 or later.
//
// usage: node packages/consensus/scripts/bench-leaf-replay.mjs [runs] [--browser chromium|firefox|waterfox]
//        (runs defaults to 3)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BLOCK_COST, bytesToHex, decodeOrderingBlock, encodeOrderingBlock } from '@dagsocial/types';
import { blockCost } from '../dist/index.js';
import { PACKAGE_DIR, buildIife, entrySource } from '../test/browser-bundle.ts';
import {
  BUDGET_SIGNATURES,
  HEIGHT,
  KARMA_BOXES_PER_VOUCHER,
  KINDS,
  atBudget,
  built,
  ctx,
  packedShape,
  proven,
  readHeavy,
} from './bench-bodies.mjs';
import { batchOf, encodeContext, replay } from './leaf-replay.mjs';

const geckoArgs = (profile, url) => ['--headless', '-no-remote', '-profile', profile, url];
/** Each browser, launched headless on `profile`, a directory the script creates and deletes, never the user's. */
const BROWSERS = {
  chromium: {
    bin: join(homedir(), '.cache/ms-playwright/chromium-1228/chrome-linux64/chrome'),
    args: (profile, url) =>
      ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url],
  },
  firefox: { bin: '/usr/bin/firefox', args: geckoArgs },
  waterfox: { bin: '/usr/local/bin/waterfox', args: geckoArgs },
};

const USAGE = 'usage: bench-leaf-replay.mjs [runs] [--browser chromium|firefox|waterfox]';
const args = process.argv.slice(2);
const flag = args.indexOf('--browser');
const browser = flag === -1 ? null : args[flag + 1];
const positional = flag === -1 ? args : [...args.slice(0, flag), ...args.slice(flag + 2)];
const RUNS = Number(positional[0] ?? 3);
const known = browser === null || Object.hasOwn(BROWSERS, browser);
if (!Number.isInteger(RUNS) || RUNS < 1 || positional.length > 1 || !known) {
  console.error(USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The bodies, each proven over its own state
// ---------------------------------------------------------------------------

const setupStart = performance.now();
const provenBody = (body) => ({ body, proven: proven(body) });
const bodies = [
  provenBody(built('ordinary', KINDS.ordinary, new Array(10).fill(1))),
  atBudget((n) => built('one-signer', KINDS.ordinary, new Array(n).fill(1)), 0),
  provenBody(built('packed', KINDS.packed, packedShape(KINDS.packed, BUDGET_SIGNATURES))),
  atBudget(readHeavy, 1),
].map(({ body, proven: { parentDigest, proof, digest, cost } }) => ({
  name: body.name,
  txs: body.txs,
  bytes: body.bytes,
  block: encodeOrderingBlock(body.block),
  parentDigest,
  proof,
  digest: bytesToHex(digest),
  cost,
}));

console.log(
  `node ${process.version} · testnet profile · height ${HEIGHT} · ` +
  `bodies built and proven in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`,
);
for (const b of bodies) {
  console.log(
    `${b.name.padEnd(10)} ${b.txs} transactions, body ${b.bytes} bytes` +
    (b.name === 'read-heavy' ? `, ${KARMA_BOXES_PER_VOUCHER} karma boxes a voucher` : '') +
    `; proof ${b.proof.length} bytes; cost ${blockCost(b.cost)} of ${MAX_BLOCK_COST}: ` +
    `${b.cost.signatures} signatures, ${b.cost.lookups} lookups, ${b.cost.writes} writes`,
  );
}

// ---------------------------------------------------------------------------
// The table — one row a body, its counts and the medians of its runs
// ---------------------------------------------------------------------------

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function printHeader(runtime) {
  console.log(`\nreplay in ${runtime} · medians of ${RUNS} run${RUNS === 1 ? '' : 's'}, milliseconds`);
  console.log(
    `${'body'.padEnd(10)} ${'proof B'.padStart(9)} ${'lookups'.padStart(7)} ${'writes'.padStart(6)} ` +
    `${'sigs'.padStart(5)} ${'cost'.padStart(7)} ${'decode'.padStart(9)} ${'batch'.padStart(9)} ` +
    `${'rest'.padStart(9)} ${'writes'.padStart(9)} ${'total'.padStart(9)}  verdict`,
  );
}

/** The body's row over its runs; runs that count otherwise than the prover set the exit code. */
function printRow(b, runs) {
  const counted = runs.every(
    (r) => r.signatures === b.cost.signatures && r.lookups === b.cost.lookups && r.writeCount === b.cost.writes,
  );
  if (!counted) process.exitCode = 1;
  const ms = (pick) => median(runs.map(pick)).toFixed(1).padStart(9);
  console.log(
    `${b.name.padEnd(10)} ${String(b.proof.length).padStart(9)} ${String(b.cost.lookups).padStart(7)} ` +
    `${String(b.cost.writes).padStart(6)} ${String(b.cost.signatures).padStart(5)} ` +
    `${String(blockCost(b.cost)).padStart(7)} ${ms((r) => r.decode)} ${ms((r) => r.batch)} ` +
    `${ms((r) => r.applyBlock - r.batch)} ${ms((r) => r.writes)} ${ms((r) => r.decode + r.applyBlock + r.writes)}  ` +
    (counted ? 'replayed to its digest' : 'counted otherwise than the prover'),
  );
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

function nodeReplays() {
  printHeader(`node ${process.version}`);
  for (const b of bodies) {
    const block = decodeOrderingBlock(b.block);
    const batch = batchOf(block);
    const runs = Array.from({ length: RUNS }, () => replay(block, b.parentDigest, b.proof, b.digest, ctx, batch));
    printRow(b, runs);
  }
}

// ---------------------------------------------------------------------------
// A browser
// ---------------------------------------------------------------------------

/** The worker's code: `workerRun`, built for a browser with the bundle test's build. */
async function workerBundle() {
  const entry = `${PACKAGE_DIR}leaf-replay-worker.js`;
  const replayModule = fileURLToPath(new URL('./leaf-replay.mjs', import.meta.url));
  const code = `import { workerRun } from ${JSON.stringify(replayModule)};\nworkerRun();\n`;
  return (await buildIife(entry, [entrySource(entry, code)])).code;
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>leaf replay</title>
<script>
  const worker = new Worker('/replay.js');
  worker.onerror = (event) =>
    fetch('/error', { method: 'POST', body: JSON.stringify({ error: 'the worker failed: ' + event.message }) });
</script>
`;

/**
 * Every response is cross-origin isolated, so the worker's clock runs at the browser's finest resolution, and never
 * cached.
 */
const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
};

/** Answers each GET from `files`, and hands each POST's path and JSON body to `onPost`. */
function serve(files, onPost) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'POST') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(204, HEADERS).end();
        onPost(path, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
      return;
    }
    const file = files.get(path);
    if (file === undefined) {
      response.writeHead(404, HEADERS).end();
      return;
    }
    response
      .writeHead(200, { ...HEADERS, 'Content-Type': file.type, 'Content-Length': file.bytes.length })
      .end(file.bytes);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Sends `signal` to the process group `pgid`; false once no process of it is left. */
function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

/** Stops the process group `pgid`: SIGTERM, then SIGKILL, each given five seconds to empty it. */
async function stopGroup(pgid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!signalGroup(pgid, signal)) return;
    for (let waited = 0; waited < 5000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!signalGroup(pgid, 0)) return;
    }
  }
  throw new Error(`process group ${pgid} outlived SIGKILL`);
}

/** How long a browser has for every run of every body. */
const BROWSER_LIMIT_MS = (10 + 5 * RUNS) * 60_000;

async function browserReplays(name) {
  const { bin, args: argsFor } = BROWSERS[name];
  const files = new Map([
    ['/', { type: 'text/html; charset=utf-8', bytes: Buffer.from(PAGE) }],
    ['/replay.js', { type: 'text/javascript; charset=utf-8', bytes: Buffer.from(await workerBundle()) }],
    ['/manifest.json', {
      type: 'application/json',
      bytes: Buffer.from(JSON.stringify({
        runs: RUNS,
        ctx: encodeContext(ctx),
        bodies: bodies.map((b, i) => ({
          name: b.name,
          block: `/body/${i}/block`,
          proof: `/body/${i}/proof`,
          parentDigest: bytesToHex(b.parentDigest),
          digest: b.digest,
        })),
      })),
    }],
    ...bodies.flatMap((b, i) => [
      [`/body/${i}/block`, { type: 'application/octet-stream', bytes: b.block }],
      [`/body/${i}/proof`, { type: 'application/octet-stream', bytes: b.proof }],
    ]),
  ]);

  const profile = mkdtempSync(join(tmpdir(), `notis-bench-${name}-`));
  let child = null;
  let server = null;
  let timer = null;
  // A signal or an exit mid-run stops the browser's group and deletes the profile before the script ends.
  const abandon = () => {
    if (child?.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  const onSignal = (signal) => {
    abandon();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', abandon);
  const stderr = [];
  try {
    await new Promise((resolve, reject) => {
      const byName = new Map(bodies.map((b) => [b.name, b]));
      serve(files, (path, value) => {
        if (path === '/start') {
          printHeader(`${name} — ${value.userAgent}${value.crossOriginIsolated ? ', cross-origin isolated' : ''}`);
        } else if (path === '/result') {
          printRow(byName.get(value.name), value.runs);
        } else if (path === '/done') {
          resolve();
        } else if (path === '/error') {
          reject(new Error(`${name}: ${value.error}`));
        }
      }).then((listening) => {
        server = listening;
        const url = `http://127.0.0.1:${server.address().port}/`;
        child = spawn(bin, argsFor(profile, url), { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', (chunk) => {
          stderr.push(chunk.toString('utf8'));
          if (stderr.length > 40) stderr.shift();
        });
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          reject(new Error(`${name} exited (${signal ?? code}) before its runs came back`)));
        timer = setTimeout(() => reject(new Error(`${name} did not finish in ${BROWSER_LIMIT_MS / 60_000} minutes`)),
          BROWSER_LIMIT_MS);
      }, reject);
    });
  } catch (error) {
    if (stderr.length > 0) console.error(`${name}'s last output:\n${stderr.join('')}`);
    throw error;
  } finally {
    clearTimeout(timer);
    if (child?.pid !== undefined) await stopGroup(child.pid);
    server?.close();
    rmSync(profile, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', abandon);
  }
}

if (browser === null) nodeReplays();
else await browserReplays(browser);
