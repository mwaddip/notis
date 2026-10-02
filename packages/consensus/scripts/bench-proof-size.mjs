#!/usr/bin/env node
// Measures a block's proof against the tree it is made over (CONSENSUS_INTERFACE → Cost; CONSENSUS_INTERFACE → The
// block proof) and the strict replay's time, for trees of 10^4, 10^5, 10^6 and 3*10^6 leaves. The block's shape is the
// first row of the replay table by its counts — 3 156 one-signer credit sends: 9 468 lookups and 18 936 writes — the
// lookups recorded as the node records them (`performLookupWithNeighbors`), then the writes, then `generateProof()`.
// Each tree holds box records under `boxKey` and owner-index entries under `creditOfKey`, built through this package's
// own key and record builders (`@dagsocial/types`), so the keys and values are the real widths. Each size names leaves:
// `size / 2` boxes, each with its index entry, so the heading and the body agree. An odd size is refused.
//
// Per tree the script prints the proof's bytes, bytes per operation, the prover's time for the set, and the strict
// replay's time — a `StrictBatchAVLVerifier` over the pre-state digest and the proof, the same lookups and writes
// performed on it, the digest it reaches compared with the prover's, `isFullyConsumed()` required — the median of 5.
// A replay that does not reach the prover's digest or is not fully consumed sets the exit code.
//
// The script reads this package's build and `@dagsocial/types`' key and record builders: `pnpm -r build` first, on
// Node 22.18 or later. Runs on one CPU; a 10^6-leaf tree costs the order of a GB of RAM to hold and several minutes to
// seed, and 3*10^6 the order of 15 minutes.
//
// usage: node packages/consensus/scripts/bench-proof-size.mjs [sizes]  (sizes defaults to `20000,200000,2000000,6000000`)
import { createHash, randomBytes } from 'node:crypto';
import { BatchAVLProver, StrictBatchAVLVerifier } from '@ergots/avltree';
import {
  INDEX_MARKER,
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordBytes,
  bytesToHex,
  creditOfKey,
} from '@dagsocial/types';

const DEFAULT_SIZES = [2e4, 2e5, 2e6, 6e6];
const sizes = (process.argv[2] ?? DEFAULT_SIZES.join(','))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (sizes.length === 0) {
  console.error('usage: bench-proof-size.mjs [sizes]');
  process.exit(2);
}

const TREE_CFG = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

// A credit transfer's counts (CONSENSUS_INTERFACE → Cost, replay table first row).
const TXS = 3156;
const LOOKUPS_PER_TX = 3;
const WRITES_PER_TX = 6;
const TOTAL_LOOKUPS = TXS * LOOKUPS_PER_TX;
const TOTAL_WRITES = TXS * WRITES_PER_TX;

/** A 32-byte owner derived from an index, so a run is deterministic in `size`. */
const ownerOf = (i) => {
  const h = createHash('blake2b512').update(`dagsocial/bench-proof-size/owner/${i}`).digest();
  return new Uint8Array(h.subarray(0, 32));
};

/** A 32-byte box id from fresh randomness — ids are not derived from content in the bench, since the tree only sees them under keys. */
const freshBoxId = () => new Uint8Array(randomBytes(32));

/** A credit box's record bytes under provenance (`boxRecordBytes`): the box, a 32-byte txId as hex, and an index. */
function creditRecord(value, owner, createdAtBlock) {
  const txId = bytesToHex(freshBoxId());
  return boxRecordBytes({ boxType: 'credit', value, createdAtBlock, owner }, txId, 0);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** One built tree holding `size` leaves — `size / 2` boxes, each with its index entry (`INDEX_MARKER`). An odd size is refused, as is one too small for the TX set to pick two live boxes per send. */
function seedTree(size) {
  if (size % 2 !== 0) throw new Error(`seedTree(${size}): size names leaves and must be even — a box and its index entry are two leaves`);
  const boxes = size / 2;
  if (boxes < TXS * 2) {
    throw new Error(`seedTree(${size}): the TX set picks ${TXS * 2} live boxes; needs at least ${TXS * 2 * 2} leaves`);
  }
  const prover = new BatchAVLProver(TREE_KEY_LENGTH, null);
  const ownerCount = Math.max(1, Math.floor(boxes / 10));
  const owners = Array.from({ length: ownerCount }, (_, i) => ownerOf(i));
  const ownerOfBox = new Uint32Array(boxes);
  const boxIds = new Array(boxes);
  const t0 = performance.now();
  for (let i = 0; i < boxes; i++) {
    const boxId = freshBoxId();
    const ownerIndex = i % ownerCount;
    ownerOfBox[i] = ownerIndex;
    boxIds[i] = boxId;
    const owner = owners[ownerIndex];
    const value = BigInt(1_000_000 + (i % 1000));
    const record = creditRecord(value, owner, 1);
    if (!prover.performOneOperation({ tag: 'Insert', key: boxKey(boxId), value: record }).success) {
      throw new Error(`seedTree(${size}): the prover refused the box at index ${i}`);
    }
    if (!prover.performOneOperation({ tag: 'Insert', key: creditOfKey(owner, boxId), value: Uint8Array.from(INDEX_MARKER) }).success) {
      throw new Error(`seedTree(${size}): the prover refused the credit index at index ${i}`);
    }
    // Flush the proof cycle every 200 000 operations so memory does not grow without bound while seeding.
    if (i > 0 && i % 100000 === 0) prover.generateProof();
  }
  prover.generateProof();
  const built = (performance.now() - t0) / 1000;
  return { prover, owners, boxIds, ownerOfBox, ownerCount, boxes, built };
}

/**
 * The prover's time for the transfer set, then its proof: per tx, three recorded lookups — the spent box, its credit
 * index entry, and one other live box — then two removes (the spent box and its index entry) and four inserts (two
 * output boxes with their index entries). The lookups go through `performLookupWithNeighbors` and the writes through
 * `performOneOperation`, which is what a block's recording session makes of the rules' reads and `treeWritesOf`'s
 * writes (NODE_INTERFACE → The block proof).
 */
function proveTransfers(tree, size) {
  const { prover, owners, boxIds, ownerOfBox, boxes } = tree;
  const spentIdx = new Set();
  // The set and its complement: pick an unspent box deterministically from a wrapping cursor. The spent cursor and
  // the other cursor both advance by one each pick, so no other-lookup lands on a box an earlier send of this block
  // spent, and the recorded lookup is of a live key.
  let cursor = 0;
  const pickUnspent = () => {
    while (spentIdx.has(cursor)) cursor = (cursor + 1) % boxes;
    const chosen = cursor;
    cursor = (cursor + 1) % boxes;
    return chosen;
  };
  const otherLookupPicks = new Uint32Array(TXS);
  const spentPicks = new Uint32Array(TXS);
  for (let t = 0; t < TXS; t++) {
    const spent = pickUnspent();
    spentIdx.add(spent);
    spentPicks[t] = spent;
    // The other-lookup target: another unspent box, picked through the same cursor so no spent box is read.
    const other = pickUnspent();
    spentIdx.add(other);
    otherLookupPicks[t] = other;
  }
  // Pre-build the writes once — the prover and the strict replay perform the SAME bytes, both for the output ids
  // (fresh random) and for the record (contains a random txId inside `boxRecordBytes`). A re-build would give the
  // replay different bytes to insert, and the verifier would reach a different digest.
  const outIds = Array.from({ length: TXS * 2 }, () => freshBoxId());
  const outRecords = new Array(TXS * 2);
  for (let t = 0; t < TXS; t++) {
    const owner = owners[ownerOfBox[spentPicks[t]]];
    const otherOwner = owners[ownerOfBox[otherLookupPicks[t]]];
    outRecords[t * 2] = creditRecord(BigInt(10 + t), owner, 2);
    outRecords[t * 2 + 1] = creditRecord(BigInt(10 + t + 1), otherOwner, 2);
  }

  let lookups = 0;
  let writes = 0;
  const t0 = performance.now();
  for (let t = 0; t < TXS; t++) {
    const spent = spentPicks[t];
    const boxId = boxIds[spent];
    const owner = owners[ownerOfBox[spent]];
    const otherBox = boxIds[otherLookupPicks[t]];
    const otherOwner = owners[ownerOfBox[otherLookupPicks[t]]];

    // Three recorded lookups: the spent box, its index entry, and one other box.
    prover.performLookupWithNeighbors(boxKey(boxId));
    prover.performLookupWithNeighbors(creditOfKey(owner, boxId));
    prover.performLookupWithNeighbors(boxKey(otherBox));
    lookups += LOOKUPS_PER_TX;

    // Two removes: the spent box and its index entry.
    if (!prover.performOneOperation({ tag: 'Remove', key: boxKey(boxId) }).success) {
      throw new Error(`proveTransfers(${size}): remove refused at tx ${t} for the spent box`);
    }
    if (!prover.performOneOperation({ tag: 'Remove', key: creditOfKey(owner, boxId) }).success) {
      throw new Error(`proveTransfers(${size}): remove refused at tx ${t} for the credit index`);
    }
    writes += 2;

    // Four inserts: two output boxes, each with its credit index entry (a change box to the spender, a payment to a
    // deterministic recipient derived from the other owner's slot).
    for (let o = 0; o < 2; o++) {
      const outId = outIds[t * 2 + o];
      const outOwner = o === 0 ? owner : otherOwner;
      if (!prover.performOneOperation({ tag: 'Insert', key: boxKey(outId), value: outRecords[t * 2 + o] }).success) {
        throw new Error(`proveTransfers(${size}): insert refused at tx ${t} for an output box`);
      }
      if (!prover.performOneOperation({ tag: 'Insert', key: creditOfKey(outOwner, outId), value: Uint8Array.from(INDEX_MARKER) }).success) {
        throw new Error(`proveTransfers(${size}): insert refused at tx ${t} for an output index`);
      }
      writes += 2;
    }
  }
  const proveMs = performance.now() - t0;
  const proof = prover.generateProof();
  if (lookups !== TOTAL_LOOKUPS) throw new Error(`proveTransfers(${size}): recorded ${lookups} lookups, expected ${TOTAL_LOOKUPS}`);
  if (writes !== TOTAL_WRITES) throw new Error(`proveTransfers(${size}): performed ${writes} writes, expected ${TOTAL_WRITES}`);
  return { proof, proveMs, otherLookupPicks, spentPicks, outIds, outRecords };
}

/**
 * One strict replay of the transfer set from the pre-state digest and the proof alone — the writes derived from the
 * same picks the prover made, each `Lookup` and each write performed on the verifier, the digest it reaches compared
 * with the prover's, and `isFullyConsumed()` asked once after the last write. Answers the time in milliseconds.
 */
function replayTransfers({ proof, prePrint, postPrint, picks, boxIds, owners, ownerOfBox }) {
  const t0 = performance.now();
  const verifier = new StrictBatchAVLVerifier(prePrint, proof, TREE_CFG);
  if (verifier.digest() === null) {
    throw new Error(`replayTransfers: the proof does not anchor at the pre-state digest: ${verifier.getLastFailReason()}`);
  }
  for (let t = 0; t < TXS; t++) {
    const spent = picks.spent[t];
    const other = picks.other[t];
    const boxId = boxIds[spent];
    const owner = owners[ownerOfBox[spent]];
    const otherBox = boxIds[other];
    const otherOwner = owners[ownerOfBox[other]];

    // Three recorded lookups through `Lookup` operations, which `StrictBatchAVLVerifier` consumes.
    for (const key of [boxKey(boxId), creditOfKey(owner, boxId), boxKey(otherBox)]) {
      const r = verifier.performOneOperation({ tag: 'Lookup', key });
      if (!r.success) throw new Error(`replayTransfers: lookup refused at tx ${t}: ${verifier.getLastFailReason()}`);
    }
    // Removes and inserts, in the prover's order.
    const removeBox = verifier.performOneOperation({ tag: 'Remove', key: boxKey(boxId) });
    const removeIndex = verifier.performOneOperation({ tag: 'Remove', key: creditOfKey(owner, boxId) });
    if (!removeBox.success || !removeIndex.success) {
      throw new Error(`replayTransfers: a remove refused at tx ${t}: ${verifier.getLastFailReason()}`);
    }
    for (let o = 0; o < 2; o++) {
      const outId = picks.outIds[t * 2 + o];
      const outOwner = o === 0 ? owner : otherOwner;
      const outRecord = picks.outRecords[t * 2 + o];
      const ir1 = verifier.performOneOperation({ tag: 'Insert', key: boxKey(outId), value: outRecord });
      const ir2 = verifier.performOneOperation({ tag: 'Insert', key: creditOfKey(outOwner, outId), value: Uint8Array.from(INDEX_MARKER) });
      if (!ir1.success || !ir2.success) {
        throw new Error(`replayTransfers: an insert refused at tx ${t}: ${verifier.getLastFailReason()}`);
      }
    }
  }
  const reached = verifier.digest();
  const consumed = verifier.isFullyConsumed();
  const ms = performance.now() - t0;
  if (reached === null) throw new Error('replayTransfers: the verifier answers null for its digest');
  if (bytesToHex(reached) !== postPrint) {
    throw new Error(`replayTransfers: reached ${bytesToHex(reached)}, prover reached ${postPrint}`);
  }
  if (!consumed) throw new Error('replayTransfers: isFullyConsumed() is false');
  return ms;
}

// ---------------------------------------------------------------------------
// The run — one row per tree size
// ---------------------------------------------------------------------------

const REPLAY_RUNS = 5;

console.log(`node ${process.version} · ${TXS} one-signer credit sends: ${TOTAL_LOOKUPS} lookups, ${TOTAL_WRITES} writes`);
console.log(
  `${'leaves'.padStart(10)} ${'proof B'.padStart(12)} ${'B/op'.padStart(6)} ` +
  `${'prove ms'.padStart(10)} ${'replay ms'.padStart(10)} ${'build s'.padStart(9)}  verdict`,
);

for (const size of sizes) {
  if (!Number.isInteger(size)) {
    console.error(`skipped non-integer size ${size}`);
    process.exitCode = 2;
    continue;
  }
  // Build the tree once.
  const tree = seedTree(size);
  const prePrint = bytesToHex(tree.prover.digest());

  // One proof is replayed `REPLAY_RUNS` times — a strict replay only consumes the proof and the pre-state digest, so
  // the prover is read once and nothing is rebuilt between runs.
  const run = proveTransfers(tree, size);
  const postPrint = bytesToHex(tree.prover.digest());
  const picks = { spent: run.spentPicks, other: run.otherLookupPicks, outIds: run.outIds, outRecords: run.outRecords };

  const replays = [];
  for (let i = 0; i < REPLAY_RUNS; i++) {
    replays.push(replayTransfers({
      proof: run.proof,
      prePrint: Uint8Array.from(Buffer.from(prePrint, 'hex')),
      postPrint,
      picks,
      boxIds: tree.boxIds,
      owners: tree.owners,
      ownerOfBox: tree.ownerOfBox,
    }));
  }
  const perOp = Math.round(run.proof.length / (TOTAL_LOOKUPS + TOTAL_WRITES));
  console.log(
    `${String(size).padStart(10)} ${String(run.proof.length).padStart(12)} ${String(perOp).padStart(6)} ` +
    `${run.proveMs.toFixed(0).padStart(10)} ${median(replays).toFixed(0).padStart(10)} ` +
    `${tree.built.toFixed(1).padStart(9)}  replayed to its digest, fully consumed`,
  );
  // Drop references so the next size does not hold the previous tree alongside.
  tree.prover = null;
  tree.boxIds = null;
  tree.owners = null;
  tree.ownerOfBox = null;
  if (typeof globalThis.gc === 'function') globalThis.gc();
}
