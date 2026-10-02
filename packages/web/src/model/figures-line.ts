// The line the balance and rep rows say beneath the figure — a pure function
// over the tool's FiguresResult and the App's own tipVerdict. The row's own
// listing sits behind `boxCount` and `shown` (the figure the row renders — the
// balance's spendable sum, the rep row's `effective`); the anchor's
// `suffixHead` height sits in `suffixHeight` for the *proven at block N*
// clause; `height` is the live tip, the same the wallet's balance line reads,
// and decides which proven credit boxes are spendable at the row's height.
//
// The rows are the contract's, the first that holds — WEB_INTERFACE →
// The extension → "The verified figures", → The wallet window → "The `balance`
// row", → The profile window → "The `rep` row is the `effective` number
// alone". The voice is copied from the contract, never rephrased; a node is
// never named.
//
// An empty listing (`boxCount === 0`) takes the same lines any listing takes:
// WEB_INTERFACE → The extension → "The verified figures" — "An empty listing
// takes these lines as any listing does". Under one, only the ledger's own
// facts speak — `holdings`, `unlisted`, `undecided`, and for rep the record
// and the valuation. A listed box a held result still carries belongs to a
// listing that has passed: rows 4 and 5 do not read it, and no sum of it
// is printed.
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
   *  figure (row 1). null: a run has not returned yet (row 2). */
  verdict: TipVerdict | null | undefined;
  /** null: no run has returned yet — row 2. Otherwise the result the
   *  App holds beside `anchor`. */
  result: FiguresResult | null;
  /** The figure the row renders — the balance row's spendable sum in base
   *  units, the rep row's `effective` number. Row 7 fires when the proven
   *  figure equals this. */
  shown: bigint;
  /** The anchor's suffixHead.header.height — the height the row's proven
   *  figure was proven at, named in *proven at block N*. Null under rows that
   *  never mention it. */
  suffixHeight: number | null;
  /** The row's own listing count — an empty listing reads the ledger's own
   *  facts under rows 3, 4 and 5 and reads silence under row 7. For the
   *  wallet row this is `credits.boxCount`; for the rep row,
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
  // web: nothing beneath the figure.
  if (verdict === undefined) return null;

  // Row 2 — no result stands. Under `thin`/`refused` the row says the chain
  // is not verified (the corner says why); otherwise (no verdict yet, or
  // `verified` with no result back) silence — the first seconds of a page
  // load earn no code of their own.
  if (result === null) {
    if (verdict !== null && (verdict.kind === 'thin' || verdict.kind === 'refused')) {
      return { text: 'not checked — the chain is not verified', weight: 'muted' };
    }
    return null;
  }

  // The listed boxes of the row's ledger — a box whose status is not
  // `unlisted` or `undecided` (both are the run's own, not from the listing).
  const cls: 'credit' | 'karma' = ledger === 'credits' ? 'credit' : 'karma';
  const listedBoxes = result.boxes.filter(
    (b) => b.boxClass === cls && b.status !== 'unlisted' && b.status !== 'undecided',
  );
  const sums = ledger === 'credits' ? result.credits : result.karma;
  const record = result.record;
  const holdings = sums.holdings;

  // Row 3 — the ledger's holdings read was not made (`not-read`), or the
  // listing has grown since the run (`boxCount > 0` and the result holds no
  // listed box of the ledger): muted *not checked yet*, never a figure of
  // 0 proven.
  if (holdings === 'not-read' || (boxCount > 0 && listedBoxes.length === 0)) {
    return { text: 'not checked yet', weight: 'muted' };
  }

  // Under an empty listing the listed boxes a held result still carries are
  // from a listing that has passed — rows 4 and 5 do not read them and print
  // no sum of them. Only the ledger's own facts speak: `holdings`,
  // `unlisted`, `undecided`, and for rep the record and the valuation.
  const hasListing = boxCount > 0;
  const listedUnproven = hasListing && listedBoxes.some((b) => b.status === 'unproven');
  const listedNoProofBoxes = hasListing
    ? listedBoxes.filter((b) => b.status === 'no-proof')
    : [];
  const absentNamed = hasListing ? sums.absent > 0n : false;
  const unlistedNamed = sums.unlisted > 0n;
  const undecidedNamed = sums.undecided > 0n;
  const holdingsUnproven = holdings === 'unproven';
  const holdingsStale = holdings === 'stale';
  const holdingsNoProof = holdings === 'no-proof';
  const recordUnproven = ledger === 'karma' && record.status === 'unproven';
  const recordNoProof = ledger === 'karma' && record.status === 'no-proof';
  // Beside a proven or absent record the tool values the rep figure at the
  // listing's height; a null valuation there is one it could not make
  // (WEB_INTERFACE → The extension → "A run is total").
  const valuationUnproven = ledger === 'karma'
    && result.karma.effective === null
    && (record.status === 'proven' || record.status === 'absent');

  // Row 4 — the full rule: clay, and the figure clay. The text, the first
  // that holds: the node lists N (absent) · the chain holds N (unlisted) ·
  // this node's proof … did not verify.
  if (
    listedUnproven
    || absentNamed
    || unlistedNamed
    || holdingsUnproven
    || recordUnproven
    || valuationUnproven
  ) {
    if (absentNamed) {
      const amount = ledger === 'credits'
        ? `${formatCredits(sums.absent)} $NOTIS`
        : `${sums.absent.toString()} rep`;
      return { text: `the node lists ${amount} the chain does not hold`, weight: 'clay' };
    }
    if (unlistedNamed) {
      const amount = ledger === 'credits'
        ? `${formatCredits(sums.unlisted)} $NOTIS`
        : `${sums.unlisted.toString()} rep`;
      return { text: `the chain holds ${amount} the node does not list`, weight: 'clay' };
    }
    const text = ledger === 'credits'
      ? "this node's proof of the balance did not verify"
      : "this node's proof of your rep did not verify";
    return { text, weight: 'clay' };
  }

  // Row 5 — muted: the node served no proof. N is the sum of the ledger's
  // listed no-proof boxes above zero, otherwise the ledger's own name
  // (for the balance / for your rep).
  if (listedNoProofBoxes.length > 0 || holdingsNoProof || recordNoProof) {
    const noProofSum = sumValues(listedNoProofBoxes);
    if (noProofSum > 0n) {
      const amount = ledger === 'credits'
        ? `${formatCredits(noProofSum)} $NOTIS`
        : `${noProofSum.toString()} rep`;
      return { text: `the node served no proof for ${amount}`, weight: 'muted' };
    }
    const text = ledger === 'credits'
      ? 'the node served no proof for the balance'
      : 'the node served no proof for your rep';
    return { text, weight: 'muted' };
  }

  // Row 6 — muted *not checked yet* when a box is `undecided` or the
  // ledger's read is `stale` (WEB_INTERFACE → The extension → "The verified
  // figures" — "muted *not checked yet* when a box is `undecided` or the
  // ledger's read is `stale`"). An empty listing fires this too where the
  // run holds an `undecided` box of the ledger — the chain holds what the
  // listing did not name, and the run cannot say whether a block spent it.
  if (holdingsStale || undecidedNamed) {
    return { text: 'not checked yet', weight: 'muted' };
  }

  // Row 7's empty-listing arm — the run read the ranges and no box is
  // `unlisted` or `undecided`: an empty listing is silence here (the faucet
  // step and the words standing read as they do without a verifier). The
  // listed-box arm sits below, where `everyProven` and `proven === shown`
  // decide.
  if (boxCount === 0) return null;

  // The proven figure P.
  // For credits: the balance line's rule over the proven credit boxes at the
  // row's height — a proven box with `lockedUntilBlock` above `height` is not
  // spendable, so it is left out. (`spendableCreditBoxes` in
  // src/wallet/reads.ts is the same predicate; the shape differs so the rule
  // is written out.)
  // For karma: `result.karma.effective`, non-null here — rows 4 and 5 took
  // every null valuation, beside an unproven or no-proof record and beside a
  // proven or absent one.
  let proven: bigint;
  if (ledger === 'credits') {
    proven = 0n;
    for (const b of listedBoxes) {
      if (b.status !== 'proven') continue;
      if (b.lockedUntilBlock !== null && b.lockedUntilBlock > height) continue;
      proven += b.value;
    }
  } else {
    proven = result.karma.effective ?? 0n;
  }

  // Row 7's listed-box arm — every listed box proved and the proven figure
  // equals the row's own number: silence is the green.
  const everyProven = listedBoxes.length > 0 && listedBoxes.every((b) => b.status === 'proven');
  if (everyProven && proven === shown) return null;

  // Row 8 — otherwise: *P proven at block H*, with the `young` and
  // `unchecked` clauses only when their sums are above zero, joined by ` · `.
  // When neither clause fires and the figure differs from `shown`,
  // *P proven at block H* alone — the rep-after-decay case, where the
  // record's clocks moved.
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

function sumValues(boxes: readonly FigureBox[]): bigint {
  let s = 0n;
  for (const b of boxes) s += b.value;
  return s;
}
