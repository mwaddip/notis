#!/usr/bin/env node
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Points to the API base path where /mining/template and /mining/submit are reachable.
// When running behind nginx, this must include the /api prefix (e.g. https://node.example/testnet/api).
const NODE_URL = (process.env.NODE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const MINER_PCT = Math.max(0, Math.min(100, parseInt(process.env.MINER_PCT ?? '25', 10)));
const MINING_SECRET = process.env.MINING_SECRET ?? '';
const MINER_PUBKEY = (process.env.MINER_PUBKEY ?? '').trim();
const DUTY_WINDOW_MS = 1000;

// ---------------------------------------------------------------------------
// PoW solver
//
// This script is standalone — `node:crypto` and nothing else, so the machine
// that mines needs no build step (MINING_INTERFACE → Miner Script). It therefore
// carries its own copy of the admission rule instead of importing it, and
// `test/unit/miner-mirror.test.ts` is what holds that copy to
// `@dagsocial/validation` — VALIDATION_INTERFACE → powTarget / meetsPowTarget.
// ---------------------------------------------------------------------------

function encodeLE64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function powTarget(targetBits) {
  if (!Number.isSafeInteger(targetBits) || targetBits < 0 || targetBits > 256) return null;
  const target = new Uint8Array(32).fill(0xff);
  const wholeBytes = targetBits >> 3;
  for (let i = 0; i < wholeBytes; i++) target[i] = 0x00;
  const remainderBits = targetBits & 7;
  if (remainderBits !== 0) target[wholeBytes] = 0xff >> remainderBits;
  return target;
}

function meetsPowTarget(hash, target) {
  for (let i = 0; i < target.length; i++) {
    const h = hash[i];
    const c = target[i];
    if (h === undefined || c === undefined) return false;
    if (h < c) return true;
    if (h > c) return false;
  }
  return true;
}

/**
 * The target a solver iterates against, hoisted out of its loop — it depends
 * only on `targetBits`, and deriving it per nonce would allocate once per hash.
 *
 * `targetBits` arrives off a mining template, so a value no digest can satisfy
 * is reachable. It raises rather than spinning: the caller's retry loop logs it
 * and repolls.
 */
function requireTarget(targetBits) {
  const target = powTarget(targetBits);
  if (target === null) {
    throw new Error(`Unsatisfiable powTargetBits from template: ${targetBits}`);
  }
  return target;
}

function solvePoW(powPreimage, targetBits) {
  const target = requireTarget(targetBits);
  let nonce = 0;
  while (true) {
    const hash = createHash('blake2b512')
      .update(powPreimage)
      .update(encodeLE64(nonce))
      .digest()
      .subarray(0, 32);
    if (meetsPowTarget(hash, target)) return nonce;
    nonce++;
  }
}

// ---------------------------------------------------------------------------
// Throttled mining — async so we can yield the event loop between work windows
// ---------------------------------------------------------------------------

async function throttledSolvePoW(powPreimage, targetBits) {
  if (MINER_PCT === 0) {
    // No throttling — run full tilt synchronously
    return solvePoW(powPreimage, targetBits);
  }

  const target = requireTarget(targetBits);
  const workMs = DUTY_WINDOW_MS * MINER_PCT / 100;
  const sleepMs = DUTY_WINDOW_MS - workMs;
  let nonce = 0;

  while (true) {
    const deadline = Date.now() + workMs;

    // Work window: tight loop until deadline or solution
    while (Date.now() < deadline) {
      const hash = createHash('blake2b512')
        .update(powPreimage)
        .update(encodeLE64(nonce))
        .digest()
        .subarray(0, 32);
      if (meetsPowTarget(hash, target)) return nonce;
      nonce++;
    }

    // Yield event loop — other processes get the CPU during sleepMs
    await sleep(sleepMs);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const headers = {
  'Content-Type': 'application/json',
  ...(MINING_SECRET ? { 'Authorization': `Bearer ${MINING_SECRET}` } : {}),
};

async function fetchTemplate() {
  const url = MINER_PUBKEY
    ? `${NODE_URL}/mining/template?miner=${MINER_PUBKEY}`
    : `${NODE_URL}/mining/template`;
  const res = await fetch(url, { headers });
  if (res.status === 401) {
    throw new Error('Mining API returned 401 — check MINING_SECRET');
  }
  if (res.status === 404) {
    return null; // no template available yet
  }
  if (!res.ok) {
    throw new Error(`Template fetch failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function submitNonce(powNonce, height) {
  const res = await fetch(`${NODE_URL}/mining/submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ powNonce, height }),
  });
  if (res.status === 401) {
    throw new Error('Mining API returned 401 — check MINING_SECRET');
  }
  return res;
}

// ---------------------------------------------------------------------------
// Mining loop
// ---------------------------------------------------------------------------

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  log(`Miner starting — node=${NODE_URL} cpu=${MINER_PCT}%`);

  let backoff = 5000;

  while (true) {
    try {
      const tpl = await fetchTemplate();

      if (!tpl) {
        log('No template available, waiting 5s...');
        await sleep(5000);
        continue;
      }

      const { powPreimage, header } = tpl;
      const powTargetBits = header.powTargetBits;
      const preimageBuf = Buffer.from(powPreimage, 'hex');

      log(`Mining block ${header.height} at ${powTargetBits} bits...`);
      const start = Date.now();

      const nonce = await throttledSolvePoW(preimageBuf, powTargetBits);

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`Found nonce=${nonce} for height=${header.height} in ${elapsed}s`);

      const res = await submitNonce(nonce, header.height);

      if (res.status === 201) {
        const body = await res.json();
        log(`Block accepted: ${body.blockHash} height=${body.height}`);
        backoff = 5000; // reset on success
      } else if (res.status === 422) {
        log('Block rejected (stale or invalid PoW), repolling immediately');
        backoff = 1000;
      } else {
        const waitMs = 5000;
        log(`Unexpected submit response: ${res.status}, retrying in ${waitMs / 1000}s...`);
        await sleep(waitMs);
        backoff = waitMs;
      }
    } catch (err) {
      log(`Error: ${err.message}`);
      backoff = Math.min(backoff * 2, 30000);
      log(`Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();
