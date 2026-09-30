#!/usr/bin/env node
// Times `applyBlock` over bodies at and past the block's budget (CONSENSUS_INTERFACE → The block's cost), each built
// over a stub `StateView`:
//
//   one-signer  — one-signer credit sends, each spending one whole credit, as many as MAX_BLOCK_COST admits;
//   packed      — credit payments of as many signers as MAX_TX_BYTES holds, MAX_BLOCK_COST / W_SIG signers in all:
//                 the signatures' term alone at the budget, the largest batch the body check runs;
//   corrupted   — the packed body with the signature its last input requires corrupted;
//   over-budget — the packed payments filled to MAX_BLOCK_BODY_BYTES, whose signatures alone cost over the budget;
//   oversigned  — one-input credit sends, each signed by its input's owner and by as many keys no input requires as
//                 MAX_TX_BYTES holds, filled to MAX_BLOCK_BODY_BYTES as the over-budget body is.
//
// The first two bodies pass every rule `applyBlock` runs, and each prints its cost as a node and a leaf count it over
// the tree: the one-signer body's within the budget, the packed body's over it — the whole cost is checked by
// `applyBlock`'s caller once the writes are derived, and `applyBlock` checks the signatures' term alone. Each of the
// last three carries one defect and lists the reasons that name it — the body check's, `validateTx`'s own, or the
// cost's — and prints its signatures' term. Each run prints its verdict, and a verdict other than the one its body is
// built for sets the exit code. Keys come from fixed seeds, so every run builds the same bodies. The script reads this
// package's build, `@dagsocial/types`' codecs and constants and the test tree's proof helpers — so it times the tree it
// is built from: `pnpm -r build` first, on Node 22.18 or later.
//
// usage: node packages/consensus/scripts/bench-apply-block.mjs [runs]    (runs defaults to 3)
import { MAX_BLOCK_BODY_BYTES, MAX_BLOCK_COST, MAX_TX_BYTES, W_SIG } from '@dagsocial/types';
import { applyBlock, blockCost } from '../dist/index.js';
import {
  BUDGET_SIGNATURES,
  HEIGHT,
  KINDS,
  atBudget,
  built,
  corrupted,
  ctx,
  filledShape,
  overBudget,
  packedShape,
  proven,
} from './bench-bodies.mjs';

const RUNS = Number(process.argv[2] ?? 3);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error('usage: bench-apply-block.mjs [runs]');
  process.exit(2);
}

const setupStart = performance.now();
const oneSigner = atBudget((n) => built('one-signer', KINDS.ordinary, new Array(n).fill(1)), 0);
const packed = built('packed', KINDS.packed, packedShape(KINDS.packed, BUDGET_SIGNATURES));
const bodies = [
  { ...oneSigner.body, cost: oneSigner.proven.cost },
  { ...packed, cost: proven(packed).cost },
  corrupted(packed),
  overBudget(built('over-budget', KINDS.packed, filledShape(KINDS.packed))),
  built('oversigned', KINDS.oversigned, filledShape(KINDS.oversigned)),
];

/** A valid body's cost as its tree counts it; a refused body's signatures' term. */
const costOf = (b) =>
  b.cost
    ? `cost ${blockCost(b.cost)} of ${MAX_BLOCK_COST}: ${b.cost.signatures} signatures, ` +
      `${b.cost.lookups} lookups, ${b.cost.writes} writes`
    : `its signatures alone cost ${b.signatures * W_SIG} of ${MAX_BLOCK_COST}`;

console.log(
  `node ${process.version} · testnet profile · height ${HEIGHT} · ` +
  `bodies built in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`,
);
for (const b of bodies) {
  console.log(
    `${b.name.padEnd(11)} ${b.txs} transactions, ${b.signatures} signatures; body ${b.bytes} of ` +
    `${MAX_BLOCK_BODY_BYTES} bytes with a ${b.settlement}-byte settlement; heaviest transaction ` +
    `${b.heaviest} of ${MAX_TX_BYTES}; ${costOf(b)}`,
  );
}
for (const b of bodies) {
  for (let run = 1; run <= RUNS; run++) {
    const start = performance.now();
    const result = applyBlock(b.view, b.block, ctx);
    const seconds = (performance.now() - start) / 1000;
    const expected = b.refusals === null ? result.ok : !result.ok && b.refusals.includes(result.reason);
    if (!expected) process.exitCode = 1;
    console.log(
      `${b.name.padEnd(11)} run ${run}: ${seconds.toFixed(3)} s, ` +
      `${((seconds * 1e6) / b.signatures).toFixed(1)} µs a signature — ` +
      (result.ok ? 'ok: true' : `ok: false — ${result.reason}`) +
      (expected ? '' : ' — not the verdict this body is built for'),
    );
  }
}
