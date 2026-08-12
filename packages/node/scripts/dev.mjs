#!/usr/bin/env node
// One command, one throwaway chain: a devnet miner node plus the external miner
// that drives it. Cadence comes from MINER_PCT, not from difficulty — devnet's
// target stays trivially solvable because the node test suite mines against it.
// MINING_INTERFACE → Miner Script.
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const secret = randomBytes(32).toString('hex');
const dbPath = join(mkdtempSync(join(tmpdir(), 'dagsocial-dev-')), 'dev.db');

// The secret travels in the child's env, never on a command line (visible in
// `ps`) and never in a unit file (world-readable).
const node = spawn(process.execPath, ['packages/node/dist/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, NETWORK_TYPE: 'devnet', NODE_ROLE: 'miner',
         PORT: '3000', DB_PATH: dbPath, MINING_SECRET: secret,
         LISTEN_ADDRS: '/ip4/127.0.0.1/tcp/0' },
});

// The miner races the node's startup and logs a fetch failure or two before it
// listens. That is its own backoff doing its job.
const miner = spawn(process.execPath, ['packages/node/scripts/miner.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_URL: 'http://localhost:3000',
         MINING_SECRET: secret, MINER_PCT: '1' },
});

// Either child leaving ends the pair: a node with no miner produces nothing,
// and a miner with no node polls nothing. Half a dev loop looks like a quiet
// one, so it exits instead.
const stop = () => { miner.kill('SIGTERM'); node.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
node.on('exit', (code) => { miner.kill('SIGTERM'); process.exit(code ?? 0); });
miner.on('exit', (code) => { node.kill('SIGTERM'); process.exit(code ?? 0); });
