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
// `@dagsocial/validation` — VALIDATION_INTERFACE → orderingPowTarget → Mirrors.
//
// It expands a header target, so the half it mirrors is `orderingPowTarget`, in
// units of 1/256 of a bit.
// ---------------------------------------------------------------------------

function encodeLE64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

/**
 * `2^(-f/256)` factored by the bits of `f`, as `floor(2^320 · 2^(-(2^j)/256))`.
 * A square-root chain: `[7]` is `1/√2` and each lower index is the square root
 * of the one above it.
 *
 * VALIDATION_INTERFACE → orderingPowTarget → What is not consensus: these are an
 * implementation choice, not a consensus constant. The rule is the predicate;
 * any factors reproducing it agree.
 */
const ORDERING_TARGET_FACTORS = [
  0xff4ecb59511ec8a5301ba217ef18dd7c2f409857956d475fdb171474700cd72f09abbd9586cb942fn,
  0xfe9e115c7b8f884badd25995e79d2f096934ec56be0d25443a7522ed803a527baa2398a03fbdc508n,
  0xfd3e0c0cf486c174853f3a5931e0ee03061b7bb285a607919d2285b6754edd613ab745a256540c03n,
  0xfa83b2db722a033a7c25bb14315d7fcc8006fe21a95d14dc4844b29bf4af18e84b0207166ee1375en,
  0xf5257d152486cc2c7b9d0c7aed980fc36f510308677709f5bdd80329364aa29fd22dd036f1906094n,
  0xeac0c6e7dd24392ed02d75b3706e54fac4faace043b7f91c17d8d1e8ca31880ab338fcd2ac2ffbc8n,
  0xd744fccad69d6af439a68bb9902d3fde1d733af522058b16b5c13ada0e778299efb01fda334bca9an,
  0xb504f333f9de6484597d89b3754abe9f1d6f60ba893ba84ced17ac85833399154afc83043ab8a2c3n,
];

/** The scale the factors above are written at. */
const ORDERING_TARGET_PRECISION = 320n;

/**
 * The inclusive maximum acceptable ordering-block digest for `scaledBits`,
 * big-endian, 32 bytes. `null` outside `[0, 65536]`.
 *
 * VALIDATION_INTERFACE → orderingPowTarget. `scaledBits` is in units of 1/256
 * of a bit, so the target is `R - 1` for the unique `R` with
 * `R^256 ≤ 2^(65536 - scaledBits) < (R+1)^256`.
 */
function orderingPowTarget(scaledBits) {
  if (!Number.isSafeInteger(scaledBits) || scaledBits < 0 || scaledBits > 65536) return null;
  const whole = scaledBits >> 8;
  const fraction = scaledBits & 255;
  let mantissa = 1n << ORDERING_TARGET_PRECISION;
  for (let j = 0; j < 8; j++) {
    if ((fraction >> j) & 1) {
      mantissa = (mantissa * ORDERING_TARGET_FACTORS[j]) >> ORDERING_TARGET_PRECISION;
    }
  }
  let value = ((mantissa << BigInt(256 - whole)) >> ORDERING_TARGET_PRECISION) - 1n;
  const target = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    target[i] = Number(value & 0xffn);
    value >>= 8n;
  }
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
 * only on `scaledBits`, and deriving it per nonce would allocate once per hash.
 *
 * `scaledBits` arrives off a mining template, so a value no digest can satisfy
 * is reachable. It raises rather than spinning: the caller's retry loop logs it
 * and repolls.
 */
function requireTarget(scaledBits) {
  const target = orderingPowTarget(scaledBits);
  if (target === null) {
    throw new Error(`Unsatisfiable powTargetBits from template: ${scaledBits}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Throttled mining — async so we can yield the event loop between work windows
// ---------------------------------------------------------------------------

/**
 * Grind for `powPreimage` until a nonce meets the target, or until the node has
 * moved past `height` — in which case the answer is `null` and the caller
 * repolls.
 *
 * The duty window is the only path, at every `MINER_PCT`: it is where the
 * staleness recheck lives, so a full-tilt miner has to yield too. At
 * `MINER_PCT` 0 or 100 the window is all work and the sleep is zero.
 */
async function throttledSolvePoW(powPreimage, targetBits, height, isStale) {
  const target = requireTarget(targetBits);
  const workMs = MINER_PCT === 0 ? DUTY_WINDOW_MS : DUTY_WINDOW_MS * MINER_PCT / 100;
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

    // The node reconstructs the submitted header from *its* current template,
    // so a solution for a preimage it has discarded is worthless however long
    // it took to find. Those hashes are not lost progress — they are trials
    // whose winning answer buys nothing. Checking once per work window bounds
    // the waste by detection latency rather than by solve time, so it holds at
    // any difficulty.
    if (await isStale(height)) return null;

    // Yield event loop — other processes get the CPU during sleepMs
    if (sleepMs > 0) await sleep(sleepMs);
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

/**
 * True once the node's template has moved past `height`.
 *
 * `header.height` discriminates because the node holds one template per height,
 * rebuilt on tip movement alone (MINING_INTERFACE → Template and submit). A
 * design that reintroduced same-height rebuilds would void in-flight work
 * without moving the height, and this probe would need a real template
 * identity rather than the height.
 */
async function templateMovedPast(height) {
  try {
    const tpl = await fetchTemplate();
    return tpl !== null && tpl.header.height !== height;
  } catch {
    // A transient fetch failure is not evidence the tip moved, and abandoning
    // on it would turn a flaky link into a miner that never finishes a block.
    return false;
  }
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

      log(`Mining block ${header.height} at ${powTargetBits / 256} bits...`);
      const start = Date.now();

      const nonce = await throttledSolvePoW(
        preimageBuf, powTargetBits, header.height, templateMovedPast,
      );
      if (nonce === null) {
        log(`Tip moved past height=${header.height}, abandoning and repolling`);
        continue;
      }

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
