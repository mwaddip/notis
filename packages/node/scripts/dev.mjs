#!/usr/bin/env node
// One command, one throwaway devnet: a mesh of nodes and the miners that drive
// them. Node 1 is the bootstrap and every other node dials it. All state lands
// in a fresh temp directory and every child dies with this process.
//
//   node packages/node/scripts/dev.mjs [--nodes N] [--miners M]
//
//   --nodes N   (default 1) exercises gossip, header-first sync, peer discovery
//               and fork resolution — the things one node cannot show. Nodes
//               2..N get one miner each.
//   --miners M  (default 1) puts M miners on node 1. Several miners competing
//               for a single template is what drives the abandon path
//               (MINING_INTERFACE → Miner Script, step 3); miners on separate
//               nodes race through gossip instead, which measures propagation.
//
// MINER_PCT is not a cadence control: the duty cycle sleeps *between* work
// windows and a devnet solve finishes inside the first one, so blocks land as
// fast as the node rebuilds a template — several per second (MINING_INTERFACE →
// Miner Script). Devnet's target cannot rise, because the node test suite mines
// against it, so a fast dev loop is what this script is.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';

const USAGE = 'Usage: node packages/node/scripts/dev.mjs [--nodes N] [--miners M]';

function parseArgs(argv) {
  const opts = { nodes: 1, miners: 1 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--nodes': 'nodes', '--miners': 'miners' }[argv[i]];
    if (!key) fail(`Unknown argument: ${argv[i]}\n${USAGE}`);
    const value = Number(argv[i + 1]);
    if (!Number.isInteger(value) || value < 1) {
      fail(`${argv[i]} takes a positive integer, got: ${argv[i + 1] ?? '(nothing)'}`);
    }
    opts[key] = value;
  }
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const { nodes, miners } = parseArgs(process.argv.slice(2));

// Ten ports per node. The admin listener sits one above the HTTP port by
// default, so a stride of 1 would hand node 2 the HTTP port node 1 is already
// serving admin on.
const httpPort = (n) => 3000 + (n - 1) * 10;
const adminPort = (n) => httpPort(n) + 1;
const p2pPort = (n) => httpPort(n) + 2;

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const nodeEntry = join(scriptDir, '..', 'dist', 'index.js');
const minerEntry = join(scriptDir, 'miner.mjs');
if (!existsSync(nodeEntry)) fail(`No build at ${nodeEntry} — run \`pnpm -r build\` first.`);

// One secret for the whole run, in child env only — a command-line argument is
// readable by every user on the box through `ps`. It authorises the mining API
// over loopback and crosses no network, so a single throwaway value serves
// every node and miner here.
const secret = randomBytes(32).toString('hex');
const runDir = mkdtempSync(join(tmpdir(), 'dagsocial-dev-'));

// The miner reports these three outcomes to its own stdout and nowhere else —
// an abandoned preimage never reaches a node — so counting them means reading
// its log lines. The markers are miner.mjs's own strings; they move together or
// the counts go quiet.
const MINER_OUTCOMES = {
  accepted: 'Block accepted:',
  abandoned: 'abandoning and repolling',
  rejected: 'Block rejected',
};

const children = [];
const tally = new Map();
let stopping = false;

function start(label, entry, env) {
  const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'pipe', 'pipe'], env });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => onLine(label, line));
  }
  child.on('exit', (code) => stopAll(`${label} exited`, code ?? 0));
}

function onLine(label, line) {
  console.log(`[${label}] ${line}`);
  const counts = tally.get(label);
  if (!counts) return;
  for (const [outcome, marker] of Object.entries(MINER_OUTCOMES)) {
    if (line.includes(marker)) counts[outcome]++;
  }
}

function startNode(n) {
  start(`node${n}`, nodeEntry, {
    ...process.env,
    NETWORK_TYPE: 'devnet',
    NODE_ROLE: 'miner',
    PORT: String(httpPort(n)),
    ADMIN_PORT: String(adminPort(n)),
    DB_PATH: join(runDir, `node-${n}.db`),
    MINING_SECRET: secret,
    LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${p2pPort(n)}`,
    BOOTSTRAP_PEERS: n === 1 ? '' : `/ip4/127.0.0.1/tcp/${p2pPort(1)}`,
  });
}

function startMiner(n, index) {
  const label = `node${n}/miner${index}`;
  tally.set(label, { accepted: 0, abandoned: 0, rejected: 0 });
  start(label, minerEntry, {
    ...process.env,
    NODE_URL: `http://127.0.0.1:${httpPort(n)}`,
    MINING_SECRET: secret,
    MINER_PCT: '1',
  });
}

/**
 * Resolves once node `n` answers on HTTP, false if it never does.
 *
 * A peer dials the bootstrap once at startup and then only on the outbound
 * manager's 30s tick, so a peer that comes up first sits unmeshed for half a
 * minute. `/status` answering is the readiness the mesh depends on. A fetch that
 * throws is the node not listening yet — the loop's budget is what turns that
 * into an error.
 */
async function waitForHttp(n) {
  const url = `http://127.0.0.1:${httpPort(n)}/status`;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping) stopAll(`node${n} never answered ${url}`, 1);
  return false;
}

// Either half leaving ends the run: a node with no miner produces nothing, a
// miner with no node polls nothing, and one peer of a mesh silently gone is a
// mesh that no longer tests what it was started for. Half a dev loop looks like
// a quiet one, so it exits instead.
function stopAll(reason, code) {
  if (stopping) return;
  stopping = true;
  console.log(`[dev] ${reason} — stopping`);
  for (const child of children) child.kill('SIGTERM');
  printOutcomes();
  process.exitCode = code;
}

function printOutcomes() {
  const total = { accepted: 0, abandoned: 0, rejected: 0 };
  console.log('[dev] miner outcomes:');
  for (const [label, counts] of tally) {
    console.log(`[dev]   ${label}: ${format(counts)}`);
    for (const outcome of Object.keys(total)) total[outcome] += counts[outcome];
  }
  if (tally.size > 1) console.log(`[dev]   total: ${format(total)}`);
}

const format = (c) => `accepted=${c.accepted} abandoned=${c.abandoned} rejected=${c.rejected}`;

process.on('SIGINT', () => stopAll('SIGINT', 0));
process.on('SIGTERM', () => stopAll('SIGTERM', 0));

console.log(`[dev] devnet: ${nodes} node(s), state under ${runDir}`);
for (let n = 1; n <= nodes; n++) {
  const dials = n === 1 ? 'bootstrap' : `dials node1 on :${p2pPort(1)}`;
  const count = n === 1 ? miners : 1;
  console.log(`[dev]   node${n} http://127.0.0.1:${httpPort(n)} p2p :${p2pPort(n)} — ${dials}, ${count} miner(s)`);
}

// Node 1 has to be listening before a peer dials it, and every node has to be
// listening before a miner polls it, so startup is a sequence rather than a
// burst.
for (let n = 1; n <= nodes && !stopping; n++) {
  startNode(n);
  await waitForHttp(n);
}
for (let n = 1; n <= nodes && !stopping; n++) {
  for (let index = 1; index <= (n === 1 ? miners : 1); index++) startMiner(n, index);
}
