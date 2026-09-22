// The line the balance and rep rows say beneath the figure — a pure function
// over the tool's FiguresResult and the App's own tipVerdict. The row's own
// listing sits behind `boxCount` (an empty listing is silence, the faucet step
// stands) and `shown` (the figure the row renders — the balance's spendable
// sum, the rep row's `effective`); the anchor's `suffixHead` height sits in
// `suffixHeight` for the *proven at block N* clause; `height` is the live tip,
// the same the wallet's balance line reads, and decides which proven credit
// boxes are spendable at the row's height.
//
// The seven rows are the contract's, the first that holds — WEB_INTERFACE →
// The extension → "The verified figures", → The wallet window → "The `balance`
// row", → The profile window → "The `rep` row is the `effective` number
// alone". The voice is copied from the contract, never rephrased; a node is
// never named.
//
// The line's shape mirrors `tipVerdict` (`src/model/tip-verdict.ts`): one pure
// function, total by itself, no exception thrown.

import type { FiguresResult, FigureBox } from '@dagsocial/nipopow-client';
import type { TipVerdict } from './tip-verdict';
import { formatCredits } from './credits';

export type FiguresLine = { text: string; weight: 'muted' | 'clay' } | null;

export interface FiguresLineInput {
  ledger: 'credits' | 'karma';
  /** undefined: the build has no verifier — nothing is rendered beneath the
   *  figure (row 1). null: a run has not returned yet (row 3'). */
  verdict: TipVerdict | null | undefined;
  /** null: no run has returned yet — row 3 or 3'. Otherwise the result the
   *  App holds beside `anchor`. */
  result: FiguresResult | null;
  /** The figure the row renders — the balance row's spendable sum in base
   *  units, the rep row's `effective` number. Row 6 fires when the proven
   *  figure equals this. */
  shown: bigint;
  /** The anchor's suffixHead.header.height — the height the row's proven
   *  figure was proven at, named in *proven at block N*. Null under rows that
   *  never mention it. */
  suffixHeight: number | null;
  /** The row's own listing count — an empty listing is row 2, silence. For
   *  the wallet row this is `credits.boxCount`; for the rep row,
   *  `karma.boxCount`. */
  boxCount: number;
  /** The live tip height — the same the balance line's spendable filter reads
   *  (WEB_INTERFACE → The wallet). The credits proven figure is computed at
   *  this height, so an unchanged state reproduces the row's own number. */
  height: number;
}

export function figuresLine(input: FiguresLineInput): FiguresLine {
  const { ledger, verdict, result, shown, suffixHeight, boxCount, height } = input;

  // Row 1 — the build has no verifier, so the row reads as it does on the
  // web: nothing beneath the figure (§4.5).
  if (verdict === undefined) return null;

  // Row 2 — an empty listing is a proof of nothing; the faucet step and
  // *no $NOTIS yet.* stand as they do (§4.5).
  if (boxCount === 0) return null;

  // Rows 3 and 3' — no run has returned yet. Under `thin`/`refused` the row
  // says the chain is not verified (the corner says why); otherwise (no
  // verdict yet, or `verified` with no result back) silence — the first
  // seconds of a page load earn no code of their own (ruling 6).
  if (result === null) {
    if (verdict !== null && (verdict.kind === 'thin' || verdict.kind === 'refused')) {
      return { text: 'not checked — the chain is not verified', weight: 'muted' };
    }
    return null;
  }

  // The rest of the rows read the result's own per-ledger sums and the record's
  // status (which, for karma, feeds into rows 4 and 5 too).
  const sums = ledger === 'credits' ? result.credits : result.karma;
  const cls: 'credit' | 'karma' = ledger === 'credits' ? 'credit' : 'karma';
  const record = result.record;
  const boxes = result.boxes.filter((b) => b.boxClass === cls);
  const unprovenBox = boxes.some((b) => b.status === 'unproven');
  const noProofBox = boxes.some((b) => b.status === 'no-proof');
  const recordUnproven = ledger === 'karma' && record.status === 'unproven';
  const recordNoProof = ledger === 'karma' && record.status === 'no-proof';

  // Row 4 — a box `unproven` or `absent`, or (karma) the record `unproven`.
  // The full rule; the caller reads `weight === 'clay'` and marks the figure
  // clay too (WEB_INTERFACE → The wallet window, → The profile window;
  // HOUSE_STYLE → Gold and clay are not interchangeable).
  if (unprovenBox || sums.absent > 0n || recordUnproven) {
    if (sums.absent > 0n) {
      const amount = ledger === 'credits'
        ? `${formatCredits(sums.absent)} $NOTIS`
        : `${sums.absent.toString()} rep`;
      return { text: `the node lists ${amount} the chain does not hold`, weight: 'clay' };
    }
    const text = ledger === 'credits'
      ? "this node's proof of the balance did not verify"
      : "this node's proof of your rep did not verify";
    return { text, weight: 'clay' };
  }

  // Row 5 — a box `no-proof`, or (karma) the record `no-proof`. N is the sum
  // of the ledger's own no-proof boxes; when only the record is no-proof, no
  // amount is named — the record has no listing-side sum.
  if (noProofBox || recordNoProof) {
    if (noProofBox) {
      const noProofSum = sumOf(boxes, 'no-proof');
      const amount = ledger === 'credits'
        ? `${formatCredits(noProofSum)} $NOTIS`
        : `${noProofSum.toString()} rep`;
      return { text: `the node served no proof for ${amount}`, weight: 'muted' };
    }
    return { text: 'the node served no proof for your rep', weight: 'muted' };
  }

  // The proven figure P.
  // For credits: the balance line's rule over the proven credit boxes at the
  // row's height — a proven box with `lockedUntilBlock` above `height` is not
  // spendable, so it is left out. (`spendableCreditBoxes` in
  // src/wallet/reads.ts is the same predicate; the shape differs so the rule
  // is written out.)
  // For karma: `result.karma.effective`, which the record's proven-or-absent
  // status ensures is non-null here (rows 4/5 decide first).
  let proven: bigint;
  if (ledger === 'credits') {
    proven = 0n;
    for (const b of boxes) {
      if (b.status !== 'proven') continue;
      if (b.lockedUntilBlock !== null && b.lockedUntilBlock > height) continue;
      proven += b.value;
    }
  } else {
    proven = result.karma.effective ?? 0n;
  }

  // Row 6 — every box of the ledger proved and the proven figure equals the
  // row's own number: silence is the green (ruling 3).
  const everyProven = boxes.length > 0 && boxes.every((b) => b.status === 'proven');
  if (everyProven && proven === shown) return null;

  // Row 7 — otherwise: *P proven at block H*, with the `young` and `unchecked`
  // clauses only when their sums are above zero, joined by ` · `. When neither
  // clause fires and the figure differs from `shown`, *P proven at block H*
  // alone — the rep-after-decay case, where the record's clocks moved.
  const p = ledger === 'credits'
    ? `${formatCredits(proven)} $NOTIS`
    : `${proven.toString()} rep`;
  const h = suffixHeight === null ? '' : String(suffixHeight);
  const clauses = [`${p} proven at block ${h}`];
  if (sums.young > 0n) {
    const y = ledger === 'credits'
      ? `${formatCredits(sums.young)} $NOTIS`
      : `${sums.young.toString()} rep`;
    clauses.push(`${y} landed since`);
  }
  if (sums.unchecked > 0n) {
    const u = ledger === 'credits'
      ? `${formatCredits(sums.unchecked)} $NOTIS`
      : `${sums.unchecked.toString()} rep`;
    clauses.push(`${u} not checked yet`);
  }
  return { text: clauses.join(' · '), weight: 'muted' };
}

function sumOf(boxes: readonly FigureBox[], status: FigureBox['status']): bigint {
  let s = 0n;
  for (const b of boxes) if (b.status === status) s += b.value;
  return s;
}
