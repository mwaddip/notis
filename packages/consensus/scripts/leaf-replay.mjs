// A leaf's replay of a block from its parent's digest and its proof alone (CONSENSUS_INTERFACE → The tree session;
// CONSENSUS_INTERFACE → The block proof), timed. The same functions run under Node and, built for a browser with the
// bundle test's build, in a browser's dedicated worker: this module imports nothing Node and reads no Node global.
import { applyBlock, treeStateView, treeWritesOf, verifierSession } from '@dagsocial/consensus';
import { bytesToHex, decodeOrderingBlock, decodeTx, hexToBytes } from '@dagsocial/types';
import { verifyEd25519Batch } from '@dagsocial/validation';
import { StrictBatchAVLVerifier } from '@ergots/avltree';
import { TREE_CONFIG } from '../test/block-proof.ts';

/**
 * The batch the body check verifies (CONSENSUS_INTERFACE → Applying a block): each entry of each user transaction's
 * signature map — every body entry but the last, the settlement — in body order and, within a transaction, in its
 * map's decoded order, as the signature, the declared id's 32 bytes and the key.
 */
export function batchOf(block) {
  const { utxoTxIds, utxoTxs } = block.utxoTxTree;
  const entries = [];
  for (let i = 0; i < utxoTxs.length - 1; i++) {
    const message = hexToBytes(utxoTxIds[i]);
    for (const [key, signature] of Object.entries(decodeTx(utxoTxs[i]).signatures)) {
      entries.push({ signature, message, publicKey: hexToBytes(key) });
    }
  }
  return entries;
}

/**
 * One replay of `block` as a leaf runs it, from `parentDigest` and `proof` alone, timed in milliseconds: the proof
 * decoded and anchored at the parent's digest (`decode`); `applyBlock` over `treeStateView(verifierSession(v))`
 * (`applyBlock`); `treeWritesOf` over the same view, the writes performed on the verifier and the digest they reach
 * compared with `digest`, lowercase hex (`writes`). Apart from the replay, the body's signature batch runs alone
 * (`batch`): the part of `applyBlock`'s time its signatures take. It answers the times and the cost's counts. A proof
 * that does not anchor, a refusal, a write the proof refuses, another digest and a batch that does not verify each
 * throw, naming it.
 */
export function replay(block, parentDigest, proof, digest, ctx, batch) {
  const start = performance.now();
  const verifier = new StrictBatchAVLVerifier(parentDigest, proof, TREE_CONFIG);
  const anchored = verifier.digest() !== null;
  const decoded = performance.now();
  if (!anchored) throw new Error(`the proof does not anchor at the parent's digest: ${verifier.getLastFailReason()}`);
  const view = treeStateView(verifierSession(verifier));
  const result = applyBlock(view, block, ctx);
  const applied = performance.now();
  if (!result.ok) throw new Error(`the block is refused: ${result.reason}`);
  const writes = treeWritesOf(result.effects, block.header.height, view);
  for (const write of writes) {
    if (!verifier.performOneOperation(write).success) {
      throw new Error(`the proof refuses ${write.tag} of ${bytesToHex(write.key)}: ${verifier.getLastFailReason()}`);
    }
  }
  const reached = bytesToHex(verifier.digest());
  const written = performance.now();
  if (reached !== digest) throw new Error(`the replay reaches ${reached}, not ${digest}`);
  // CONSENSUS_INTERFACE → The tree session → "A block replays from its proof
  // only on all of these" — asked once, after the last write and the digest.
  if (!verifier.isFullyConsumed()) {
    throw new Error('the proof carries bytes the replay did not consume');
  }
  const batchStart = performance.now();
  const verified = verifyEd25519Batch(batch);
  const batchEnd = performance.now();
  if (!verified) throw new Error("the body's signature batch does not verify");
  return {
    decode: decoded - start,
    applyBlock: applied - decoded,
    writes: written - applied,
    batch: batchEnd - batchStart,
    signatures: result.effects.signatures,
    lookups: view.lookupCount(),
    writeCount: writes.length,
  };
}

const BIGINT = '$bigint';

/** The context as JSON, each bigint as `{ "$bigint": decimal }`. */
export const encodeContext = (ctx) =>
  JSON.stringify(ctx, (_key, value) => (typeof value === 'bigint' ? { [BIGINT]: value.toString() } : value));

/** The inverse of `encodeContext`. */
const decodeContext = (text) =>
  JSON.parse(text, (_key, value) =>
    value !== null && typeof value === 'object' && Object.keys(value).length === 1 && typeof value[BIGINT] === 'string'
      ? BigInt(value[BIGINT])
      : value);

/**
 * A browser worker's run: its browser POSTed to `/start`, then every body `/manifest.json` names — its block, its
 * proof, its parent's digest and the digest its writes reach — replayed `runs` times over the manifest's context, each
 * body's runs POSTed to `/result` as it finishes, and `/done`; a throw is POSTed to `/error`, naming it.
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
    const ctx = decodeContext(manifest.ctx);
    for (const body of manifest.bodies) {
      const block = decodeOrderingBlock(new Uint8Array(await (await get(body.block)).arrayBuffer()));
      const proof = new Uint8Array(await (await get(body.proof)).arrayBuffer());
      const parentDigest = hexToBytes(body.parentDigest);
      const batch = batchOf(block);
      const runs = [];
      for (let run = 0; run < manifest.runs; run++) {
        runs.push(replay(block, parentDigest, proof, body.digest, ctx, batch));
      }
      await post('/result', { name: body.name, runs });
    }
    await post('/done', {});
  } catch (error) {
    await post('/error', { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
}
