#!/usr/bin/env node
// The `m` bench (prompts/m-bench-nipopow.md): what NiPoPoW's security parameter costs and what it buys, for
// @dagsocial/nipopow — a proof's bytes, its decode/verifyProof/compareProofs time in Node and in a browser (the
// cost), and how often a proof of less work wins a comparison against an honest one (what it buys), at
// m = 6, 12, 24, 48, k = 20 (CONSTANTS → Client defaults).
//
// The anchor. BENCH_RETARGET below is this script's own retarget, never test/helpers.ts' DEVNET_RETARGET
// (anchorBits 3072, ~4096 expected hash attempts a block — too slow to mine 20 000-100 000 headers here).
// anchorBits = 256 is one bit: blockWork(256) = 2^256 / (2^255) = 2 — about every other hash a block
// (VALIDATION_INTERFACE → orderingPowTarget, blockWork). mineHeaders' on-schedule stamps (createdAt exactly
// ANCHOR_TIME + idealMs·(height−1), test/helpers.ts) make asertTargetBits' delta exactly 0 at every height,
// whatever idealMs is (VALIDATION_INTERFACE → asertTargetBits): so every header of every chain this script
// mines carries exactly anchorBits. floorBits/ceilingBits only bracket the anchor so the clamp never fires.
//
// Main's weakest claim 1 — "a proof's shape does not depend on the anchor, only on the chain's length and m".
// A header mined at its own target registers level ≥ μ with probability 1/2^μ (VALIDATION_INTERFACE → level),
// so a chain mined AT the anchor (every header's own target IS anchorBits, as above) should show
// count(level ≥ μ) ≈ N / 2^μ for every μ — a formula with no anchor-specific term. printLevelHistogram checks
// it directly: a match supports the claim (any anchor mined this way gives the same shape), a mismatch refutes
// it.
//
// Independent trials, without editing test/helpers.ts (out of this executor's scope, packages/nipopow/scripts/
// only). buildMinedChainFresh is a pure function of its opts: no clock, no seed, no randomness anywhere in the
// walk, so two calls with the same count and retarget are byte-for-byte identical, not independent samples —
// and two chains mined at DIFFERENT idealMs can't be compared under one shared verifyProof/compareProofs
// profile (a suffix tail's target is recomputed from profile.retarget, which must be the retarget that actually
// mined it — NIPOPOW_INTERFACE → verifyProof, rule 3). So every chain the rates section mines shares the one
// BENCH_RETARGET, and independence instead comes from `forceLevels` (test/helpers.ts's own lever for
// constructing a specific chain, here repurposed as a seed): makeIndexer gives every chain it builds a unique
// (height, level) pair to force — a bijection over a small range — so every chain this script mines for the
// rates section diverges from every other one: within a trial (the honest side and the other side force
// different heights) and across trials (no two calls ever share a pair). `height` stays inside a range sized
// off the total chains a run needs, so the shared prefix (genesis, plus whatever a chain shares with an earlier
// one up to the smaller of their two forced heights) never grows past a small, fixed fraction of H — printed
// below. bestArg only counts headers above the LCA (NIPOPOW_INTERFACE → compareProofs), so that shared prefix
// scores nothing in any comparison; it is excluded by construction, not trusted to be negligible.
//
// H for the rates section (RATES_H). The deciding level (NIPOPOW_INTERFACE → compareProofs, "How often a proof
// of less work wins") holds a count of about m to 2m by definition, at every H — H does not change that count,
// only how many levels comfortably clear it. count(level ≥ μ) ≈ H/2^μ; for several levels above μ = 0 to clear
// m = 48 (the largest m here) with room, H should be several multiples of 48 · 2^(a few). RATES_H = 20 000
// gives count(level≥8) ≈ 78, well above 48 with 8 levels of headroom below it. Main's weakest claim 2 (the
// noise is m's, not H's) is tested directly: one ratio run twice, at RATES_H and 2×RATES_H.
//
// The browser bundle. tsup (a declared nipopow devDependency, esbuild underneath) bundles
// bench-worker-entry.mjs — which only imports bench-core.mjs, which only imports ../dist/index.js — into one
// IIFE with noExternal so @dagsocial/types and @dagsocial/validation (both already nipopow dependencies) are
// inlined too; nothing new is added to package.json. The browser harness (headless on a throwaway profile the
// script creates and deletes, a dedicated worker, the browser's process group stopped at the end) copies
// packages/consensus/scripts/bench-leaf-replay.mjs's pattern — read, not imported: nipopow and consensus never
// import each other's scripts.
//
// usage: node packages/nipopow/scripts/bench-proof-m.mjs [runs] [--blocks N] [--browser chromium|firefox|waterfox]
//        [--rates trials]   (runs defaults to 3; blocks defaults to 20 000)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as tsupBuild } from 'tsup';

import { NETWORK_PROFILES, bytesToHex } from '@dagsocial/types';
import { level as headerLevel } from '@dagsocial/validation';
import { compareProofs, encodeNipopowProof, proveWithReader } from '../dist/index.js';
import { DEVNET_MAX_FUTURE_DRIFT_MS, buildMinedChainFresh, makeReader } from '../test/helpers.ts';
import { timedRun } from './bench-core.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = 'usage: bench-proof-m.mjs [runs] [--blocks N] [--browser chromium|firefox|waterfox] [--rates trials]';
const argv = process.argv.slice(2);
const FLAGS = ['--blocks', '--browser', '--rates'];
const flagValues = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.includes(a)) flagValues[a] = argv[++i];
  else positional.push(a);
}
const RUNS = Number(positional[0] ?? 3);
const BLOCKS = Number(flagValues['--blocks'] ?? 20_000);
const BROWSER = flagValues['--browser'] ?? null;
const RATES_TRIALS = flagValues['--rates'] !== undefined ? Number(flagValues['--rates']) : null;
const BROWSERS_KNOWN = ['chromium', 'firefox', 'waterfox'];
const valid =
  Number.isInteger(RUNS) && RUNS >= 1 &&
  Number.isInteger(BLOCKS) && BLOCKS >= 1 &&
  positional.length <= 1 &&
  (BROWSER === null || BROWSERS_KNOWN.includes(BROWSER)) &&
  (RATES_TRIALS === null || (Number.isInteger(RATES_TRIALS) && RATES_TRIALS >= 1));
if (!valid) {
  console.error(USAGE);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const M_VALUES = [6, 12, 24, 48];
const K = 20; // CONSTANTS → Client defaults
const RATES_H = 20_000;
const RATIOS = [3 / 4, 1 / 2, 1 / 4];

const BENCH_RETARGET = {
  anchorBits: 256,
  idealMs: 60_000,
  halflifeMs: 17_280_000,
  floorBits: 128,
  ceilingBits: 512,
};

const load = () => loadavg().map((x) => x.toFixed(2)).join(', ');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** verifyProof/compareProofs' profile for a chain mined at `retarget`: unpinned genesis (verifyProof's rule 2
 * only checks a non-empty genesisId), nowMs exactly the chain's own tip so its clock check passes with no slack
 * borrowed from real time (VALIDATION_INTERFACE → verifyCreatedAtBound; NIPOPOW_INTERFACE → verifyProof, rule 3). */
function profileFor(chain, retarget) {
  const tip = chain.headers[chain.headers.length - 1];
  return {
    retarget,
    maxFutureDriftMs: DEVNET_MAX_FUTURE_DRIFT_MS,
    nowMs: tip.createdAt,
    genesisId: '',
    protocolVersionSchedule: NETWORK_PROFILES.devnet.protocolVersionSchedule,
  };
}

// ---------------------------------------------------------------------------
// Section 1 — the cost
// ---------------------------------------------------------------------------

/** Counts of headers (excludes genesis, whose level is Infinity — VALIDATION_INTERFACE → level) with
 * level ≥ μ, for μ = 0 up to where the expected count N/2^μ drops under one — main's weakest claim 1's check. */
function levelHistogram(chain, anchorBits) {
  const levels = chain.headers.slice(1).map((h) => headerLevel(h, anchorBits));
  const n = levels.length;
  const rows = [];
  for (let mu = 0; ; mu++) {
    const expected = n / 2 ** mu;
    const count = levels.filter((l) => l !== null && l >= mu).length;
    rows.push({ mu, count, expected });
    if (expected < 0.5) break;
  }
  return { n, rows };
}

function printLevelHistogram(histogram, anchorBits) {
  console.log(`\nlevel histogram over ${histogram.n} headers (excludes genesis), anchor bits ${anchorBits}`);
  console.log(`${'μ'.padStart(3)} ${'count(level≥μ)'.padStart(15)} ${'N/2^μ'.padStart(10)}`);
  for (const { mu, count, expected } of histogram.rows) {
    console.log(`${String(mu).padStart(3)} ${String(count).padStart(15)} ${expected.toFixed(1).padStart(10)}`);
  }
  const big = histogram.rows.filter((r) => r.expected >= 5);
  const maxRelDev = Math.max(...big.map((r) => Math.abs(r.count - r.expected) / r.expected));
  console.log(
    `claim 1 — max relative deviation over rows with N/2^μ ≥ 5: ${(maxRelDev * 100).toFixed(1)}% ` +
    `(${big.length} rows; the formula has no anchor-specific term, so a close match holds for any anchor mined this way)`,
  );
}

function printCostHeader(runtime, runs) {
  console.log(`\nproof cost in ${runtime} · medians of ${runs} run${runs === 1 ? '' : 's'}, milliseconds · load average ${load()}`);
  console.log(
    `${'m'.padStart(3)} ${'k'.padStart(3)} ${'prefix'.padStart(7)} ${'suffix'.padStart(7)} ` +
    `${'proof B'.padStart(9)} ${'body B'.padStart(9)} ${'decode'.padStart(9)} ${'verify'.padStart(9)} ` +
    `${'compare'.padStart(9)} ${'sum'.padStart(9)}`,
  );
}

function printCostRow(p, runs) {
  const ms = (pick) => median(runs.map(pick)).toFixed(3).padStart(9);
  console.log(
    `${String(p.m).padStart(3)} ${String(K).padStart(3)} ${String(p.prefix).padStart(7)} ${String(p.suffix).padStart(7)} ` +
    `${String(p.bytes.length).padStart(9)} ${String(p.bodyBytes).padStart(9)} ` +
    `${ms((r) => r.decode)} ${ms((r) => r.verify)} ${ms((r) => r.compare)} ${ms((r) => r.sum)}`,
  );
}

function buildProofs(chain) {
  const reader = makeReader(chain);
  return M_VALUES.map((m) => {
    const proof = proveWithReader(reader, { m, k: K });
    const bytes = encodeNipopowProof(proof);
    const bodyBytes = Buffer.byteLength(JSON.stringify({ proof: bytesToHex(bytes) }), 'utf8');
    return { m, prefix: proof.prefix.length, suffix: 1 + proof.suffixTail.length, bytes, bodyBytes };
  });
}

async function costSection() {
  const t0 = performance.now();
  const chain = buildMinedChainFresh({ count: BLOCKS, retarget: BENCH_RETARGET });
  console.log(
    `node ${process.version} · ${BLOCKS} headers mined in ${((performance.now() - t0) / 1000).toFixed(1)} s · ` +
    `load average ${load()}`,
  );

  printLevelHistogram(levelHistogram(chain, BENCH_RETARGET.anchorBits), BENCH_RETARGET.anchorBits);

  const profile = profileFor(chain, BENCH_RETARGET);
  const proofs = buildProofs(chain);

  printCostHeader(`node ${process.version}`, RUNS);
  const nodeMedianVerify = new Map();
  for (const p of proofs) {
    const runs = Array.from({ length: RUNS }, () => timedRun(p.bytes, p.m, profile));
    printCostRow(p, runs);
    nodeMedianVerify.set(p.m, median(runs.map((r) => r.verify)));
  }
  const v24 = nodeMedianVerify.get(24);
  const v48 = nodeMedianVerify.get(48);
  console.log(
    `claim 3 — node verify(m=48)/verify(m=24) = ${(v48 / v24).toFixed(2)} (linear in the proof's headers ⇒ about 2)`,
  );

  if (BROWSER !== null) await browserCostRun(BROWSER, proofs, profile);
}

// ---------------------------------------------------------------------------
// The browser harness — pattern copied from packages/consensus/scripts/bench-leaf-replay.mjs, not imported
// ---------------------------------------------------------------------------

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

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>nipopow proof bench</title>
<script>
  const worker = new Worker('/bench.js');
  worker.onerror = (event) =>
    fetch('/error', { method: 'POST', body: JSON.stringify({ error: 'the worker failed: ' + event.message }) });
</script>
`;

/** Every response is cross-origin isolated, so the worker's clock runs at the browser's finest resolution, and never cached. */
const HTTP_HEADERS = {
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
        response.writeHead(204, HTTP_HEADERS).end();
        onPost(path, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
      return;
    }
    const file = files.get(path);
    if (file === undefined) {
      response.writeHead(404, HTTP_HEADERS).end();
      return;
    }
    response
      .writeHead(200, { ...HTTP_HEADERS, 'Content-Type': file.type, 'Content-Length': file.bytes.length })
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

/** bench-worker-entry.mjs, bundled for a browser: an IIFE with @dagsocial/types and @dagsocial/validation
 * inlined (noExternal), built to a throwaway directory this function deletes once it has read the one file out. */
async function buildWorkerBundle() {
  const entry = fileURLToPath(new URL('./bench-worker-entry.mjs', import.meta.url));
  const outDir = mkdtempSync(join(tmpdir(), 'nipopow-bench-build-'));
  try {
    await tsupBuild({
      entry: [entry],
      outDir,
      format: ['iife'],
      platform: 'browser',
      target: 'es2022',
      bundle: true,
      noExternal: [/^@dagsocial\//],
      dts: false,
      sourcemap: false,
      clean: true,
      silent: true,
      minify: false,
      splitting: false,
    });
    return readFileSync(join(outDir, 'bench-worker-entry.global.js'), 'utf8');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** How long a browser has for every run of every m. */
const BROWSER_LIMIT_MS = (10 + 5 * RUNS) * 60_000;

async function browserCostRun(name, proofs, profile) {
  const { bin, args: argsFor } = BROWSERS[name];
  const workerCode = await buildWorkerBundle();
  const files = new Map([
    ['/', { type: 'text/html; charset=utf-8', bytes: Buffer.from(PAGE) }],
    ['/bench.js', { type: 'text/javascript; charset=utf-8', bytes: Buffer.from(workerCode) }],
    ['/manifest.json', {
      type: 'application/json',
      bytes: Buffer.from(JSON.stringify({
        runs: RUNS,
        profile,
        perM: proofs.map((p) => ({ m: p.m, proofPath: `/proof/${p.m}` })),
      })),
    }],
    ...proofs.map((p) => [`/proof/${p.m}`, { type: 'application/octet-stream', bytes: Buffer.from(p.bytes) }]),
  ]);

  const profileDir = mkdtempSync(join(tmpdir(), `notis-bench-nipopow-${name}-`));
  let child = null;
  let server = null;
  let timer = null;
  const abandon = () => {
    if (child?.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
    rmSync(profileDir, { recursive: true, force: true });
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
      serve(files, (path, value) => {
        if (path === '/start') {
          printCostHeader(`${name} — ${value.userAgent}${value.crossOriginIsolated ? ', cross-origin isolated' : ''}`, RUNS);
        } else if (path === '/result') {
          const p = proofs.find((x) => x.m === value.m);
          printCostRow(p, value.runs);
        } else if (path === '/done') {
          resolve();
        } else if (path === '/error') {
          reject(new Error(`${name}: ${value.error}`));
        }
      }).then((listening) => {
        server = listening;
        const url = `http://127.0.0.1:${server.address().port}/`;
        child = spawn(bin, argsFor(profileDir, url), { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
    rmSync(profileDir, { recursive: true, force: true });
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', abandon);
  }
}

// ---------------------------------------------------------------------------
// Section 2 — what it buys
// ---------------------------------------------------------------------------

const FORCE_LEVEL_RANGE = 8; // levels 1..8 — solveForLevel's cost stays ≤ 2^9 = 512 attempts, always trivial

/** Independent chains for the rates section — see the header comment's "Independent trials". */
function makeIndexer(totalChainsNeeded) {
  const heightRange = Math.max(50, Math.ceil(totalChainsNeeded / FORCE_LEVEL_RANGE));
  let index = -1;
  return {
    heightRange,
    next(count) {
      index += 1;
      if (index >= heightRange * FORCE_LEVEL_RANGE) {
        throw new Error(`ran out of unique (height, level) pairs at chain ${index} of ${heightRange * FORCE_LEVEL_RANGE}`);
      }
      const height = 2 + (index % heightRange);
      const forcedLevel = 1 + (Math.floor(index / heightRange) % FORCE_LEVEL_RANGE);
      if (height >= count) {
        throw new Error(`forced height ${height} reaches chain length ${count} — raise RATES_H or lower trials`);
      }
      return buildMinedChainFresh({ count, retarget: BENCH_RETARGET, forceLevels: new Map([[height, forcedLevel]]) });
    },
  };
}

const WILSON_Z = 1.959963984540054; // Φ⁻¹(0.975) — the two-sided 95% z-score

function wilson95(successes, n) {
  if (n === 0) return { p: NaN, lo: NaN, hi: NaN };
  const phat = successes / n;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (WILSON_Z * Math.sqrt(phat * (1 - phat) / n + z2 / (4 * n * n))) / denom;
  return { p: phat, lo: Math.max(0, center - margin), hi: Math.min(1, center + margin) };
}

/** `trials` independent (honestChain, otherChain) pairs at `H` and `ratio`, compared at every m in M_VALUES —
 * `compareProofs(otherProof, honestProof, ...)`, so verdict 'a' means the LESS-work side won. Throws if a pair
 * comes back incomparable: under the shared, never-forced genesis every valid pair must share an ancestor, so
 * that would mean the independence scheme (or this section's use of it) is broken, not a valid outcome to tally. */
function runRateTrials(indexer, H, ratio, trials) {
  const otherCount = Math.max(1, Math.round(H * ratio));
  const tally = new Map(M_VALUES.map((m) => [m, { wins: 0, ties: 0, losses: 0 }]));
  for (let t = 0; t < trials; t++) {
    const honestChain = indexer.next(H);
    const otherChain = indexer.next(otherCount);
    const honestReader = makeReader(honestChain);
    const otherReader = makeReader(otherChain);
    const profile = profileFor(honestChain, BENCH_RETARGET);
    for (const m of M_VALUES) {
      const otherProof = proveWithReader(otherReader, { m, k: K });
      const honestProof = proveWithReader(honestReader, { m, k: K });
      const result = compareProofs(otherProof, honestProof, m, profile);
      if (result.verdict === 'incomparable') {
        throw new Error(`trial ${t} at m=${m}, H=${H}, ratio=${ratio}: proofs incomparable (${result.reason})`);
      }
      const row = tally.get(m);
      if (result.verdict === 'a') row.wins += 1;
      else if (result.verdict === 'b') row.losses += 1;
      else row.ties += 1;
    }
  }
  return { H, otherCount, ratio, trials, tally };
}

function printRateTable(result) {
  console.log(`\nratio ${result.ratio.toFixed(2)} — other side ${result.otherCount} of honest ${result.H} headers, ${result.trials} independent trials`);
  console.log(`${'m'.padStart(3)} ${'wins'.padStart(6)} ${'ties'.padStart(5)} ${'losses'.padStart(7)} ${'win rate'.padStart(9)}  95% Wilson CI`);
  for (const m of M_VALUES) {
    const { wins, ties, losses } = result.tally.get(m);
    const { p, lo, hi } = wilson95(wins, result.trials);
    console.log(
      `${String(m).padStart(3)} ${String(wins).padStart(6)} ${String(ties).padStart(5)} ${String(losses).padStart(7)} ` +
      `${(p * 100).toFixed(2).padStart(8)}%  [${(lo * 100).toFixed(2)}%, ${(hi * 100).toFixed(2)}%]`,
    );
  }
}

function ratesSection(trials) {
  const CLAIM2_H = RATES_H * 2;
  const totalChains = (RATIOS.length + 1) * trials * 2; // the ratio grid, plus claim 2's extra H, each a pair
  const indexer = makeIndexer(totalChains);
  console.log(
    `\nrates section — H=${RATES_H} (claim 2 also runs H=${CLAIM2_H}), k=${K}, ${trials} independent trials a row · ` +
    `forced-height range ${indexer.heightRange} of ${RATES_H} (${((indexer.heightRange / RATES_H) * 100).toFixed(2)}% of H) · ` +
    `load average ${load()}`,
  );

  const results = new Map();
  for (const ratio of RATIOS) {
    const result = runRateTrials(indexer, RATES_H, ratio, trials);
    results.set(ratio, result);
    printRateTable(result);
  }

  const halfAtH = results.get(0.5);
  const halfAt2H = runRateTrials(indexer, CLAIM2_H, 0.5, trials);
  console.log(`\nclaim 2 — ratio 1/2 at H=${RATES_H} and H=${CLAIM2_H} (the noise should track m, not H):`);
  printRateTable(halfAtH);
  printRateTable(halfAt2H);
  for (const m of M_VALUES) {
    const a = wilson95(halfAtH.tally.get(m).wins, trials);
    const b = wilson95(halfAt2H.tally.get(m).wins, trials);
    const overlap = a.lo <= b.hi && b.lo <= a.hi;
    console.log(`  m=${m}: ${overlap ? 'CIs overlap — consistent with claim 2' : 'CIs do NOT overlap — evidence against claim 2'}`);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await costSection();
if (RATES_TRIALS !== null) ratesSection(RATES_TRIALS);
