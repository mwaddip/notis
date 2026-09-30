// Shared between Node and a browser worker (bundled for the browser by bench-proof-m.mjs's buildWorkerBundle,
// via bench-worker-entry.mjs): one timed run of decode, verifyProof and compareProofs, and the browser worker's
// driver. Imports only `../dist/index.js` — no Node built-in, no Node global, no module-level state a result
// depends on — so the identical code executes under Node and, bundled for a browser, inside a dedicated worker
// (NIPOPOW_INTERFACE → verifyProof, compareProofs).
import { decodeNipopowProof, verifyProof, compareProofs } from '../dist/index.js';

/**
 * One timed run over `bytes` (an `encodeNipopowProof` encoding) at `m`, under `profile`: decode, verifyProof on
 * the decode, an untimed second decode of the same bytes, and compareProofs of the two decodes against one
 * another. A proof compared against its own second decode always scores a tie — this stands in for "one run
 * compares two nodes' proofs of one chain" (prompts/m-bench-nipopow.md → "What to build", 1) without a second
 * chain to mine. Each of the three phases is timed alone, plus their sum — none reused from another phase's
 * work, so decode is not counted again inside verify or compare, matching what compareProofs actually does
 * (NIPOPOW_INTERFACE → compareProofs: it runs verifyProof on each side itself, so its own timing includes two
 * more verifications on top of the standalone one below). Throws, naming it, on any unexpected verdict — a
 * broken run must never enter the medians silently.
 */
export function timedRun(bytes, m, profile) {
  const t0 = performance.now();
  const decodedA = decodeNipopowProof(bytes);
  const t1 = performance.now();
  const verified = verifyProof(decodedA, profile);
  const t2 = performance.now();
  if (!verified.ok) {
    const at = verified.index !== undefined ? ` at index ${verified.index}` : '';
    throw new Error(`verifyProof refused its own proof: ${verified.reason}${at}`);
  }
  const decodedB = decodeNipopowProof(bytes);
  const t3 = performance.now();
  const compared = compareProofs(decodedA, decodedB, m, profile);
  const t4 = performance.now();
  if (compared.verdict !== 'tie') {
    throw new Error(`comparing a proof against its own second decode gave '${compared.verdict}', not 'tie'`);
  }
  const decode = t1 - t0;
  const verify = t2 - t1;
  const compare = t4 - t3;
  return { decode, verify, compare, sum: decode + verify + compare };
}

/**
 * A browser worker's run: POSTed `/start` with its user agent and cross-origin-isolation, then `/manifest.json`'s
 * `perM` entries each fetched (its proof bytes) and timed `manifest.runs` times over `manifest.profile`, POSTed
 * to `/result` as each finishes, then `/done`; a throw is POSTed to `/error`, naming it. Mirrors
 * `packages/consensus/scripts/leaf-replay.mjs`'s `workerRun` — the pattern copied, not imported: this package
 * never imports another package's scripts.
 */
export async function workerRun() {
  const post = (path, value) => fetch(path, { method: 'POST', body: JSON.stringify(value) });
  const get = async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response;
  };
  try {
    await post('/start', { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated });
    const manifest = await (await get('/manifest.json')).json();
    for (const entry of manifest.perM) {
      const bytes = new Uint8Array(await (await get(entry.proofPath)).arrayBuffer());
      const runs = [];
      for (let i = 0; i < manifest.runs; i++) runs.push(timedRun(bytes, entry.m, manifest.profile));
      await post('/result', { m: entry.m, runs });
    }
    await post('/done', {});
  } catch (error) {
    await post('/error', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
}
