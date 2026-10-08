import type { PoPowHeader } from '@dagsocial/nipopow';
import type { FiguresResult, HoldingsRead, LedgerSums, Listing } from './boxes.js';
import type { PostCommandResult } from './cli.js';
import { capped } from './http.js';
import type { TipResult } from './tip.js';

export interface Run {
  figures: FiguresResult;
  listing: Listing | null;
}

/**
 * The post subcommand's text output, one entry per line
 * (WEB_INTERFACE → The extension → "The post check"). Node text reaches a
 * line only inside a verdict or an id, each named through `capped`.
 */
export function postCommandLines(post: PostCommandResult): string[] {
  const lines: string[] = [`post ${capped(post.id)}: ${post.nodeUrl}`];
  if (post.fetchFailure !== null) {
    lines.push(`  unanswered — ${capped(post.fetchFailure)}`);
    return lines;
  }
  const check = post.check;
  if (check === null) {
    lines.push('  unanswered — no row returned');
    return lines;
  }
  if (check.status === 'bound') {
    lines.push(`  bound — author ${check.author}, parent ${check.parent ?? 'none'}`);
  } else if (check.status === 'unbound') {
    lines.push(`  unbound (${check.reason}) — ${capped(check.verdict)}`);
  } else if (check.status === 'nothing-to-bind') {
    lines.push('  nothing-to-bind — the row is withdrawn');
  } else {
    lines.push('  unserved — the node holds no bytes for this post');
  }
  return lines;
}

/**
 * The command line's text output, one entry per line — a function of the run
 * that runs nothing at import. Node text reaches a line only inside a verdict,
 * a refusal or a box id, each named through `capped`.
 */
export function textLines(tip: TipResult, run: Run | null): string[] {
  const lines: string[] = [];

  if (tip.tip) {
    lines.push(`tip: height ${tip.tip.height}`);
  } else {
    lines.push('tip: none — no verified proof');
  }
  if (tip.suffixHead) {
    const sh = tip.suffixHead as PoPowHeader;
    lines.push(`suffixHead: height ${sh.header.height}, stateRoot ${sh.header.stateRoot}`);
  }

  for (const n of tip.nodes) {
    if (n.verified) {
      const isBest = n === tip.winner;
      lines.push(`  ${n.url}: verified${isBest ? ' (best)' : ''}`);
    } else {
      lines.push(`  ${n.url}: refused — ${n.refuseReason}`);
    }
  }

  for (const s of tip.splits) {
    lines.push(`SPLIT: nodes ${s.indexA} and ${s.indexB} are incomparable (${s.reason})`);
  }

  if (run) {
    const { figures, listing } = run;
    lines.push('');
    if (figures.boxes.length === 0) {
      lines.push('no boxes');
    } else {
      for (const b of figures.boxes) {
        // `unlisted`, `undecided` and `young` carry the proven box's value,
        // as `proven` does (WEB_INTERFACE → The extension → "The verified
        // figures").
        const hasProvenValue = b.status === 'proven'
          || b.status === 'young'
          || b.status === 'unlisted'
          || b.status === 'undecided';
        const valueSuffix = hasProvenValue ? ` value=${b.value}` : '';
        lines.push(`  ${b.boxClass} ${capped(b.boxId)}: ${b.verdict}${valueSuffix}`);
      }
      lines.push(`karma total (face value at suffixHead): ${figures.karma.proven}`);
      lines.push(`credit total (face value at suffixHead): ${figures.credits.proven}`);
    }

    if (figures.record.status === 'proven') {
      const r = figures.record.record;
      lines.push(
        `identity record: proven — lastActivityBlock=${r.lastActivityBlock} lastDecayBlock=${r.lastDecayBlock}` +
        ` invitedAtBlock=${r.invitedAtBlock} lifetimeLikesReceived=${r.lifetimeLikesReceived}` +
        ` memberSinceBlock=${r.memberSinceBlock} memberBar=${r.memberBar}` +
        ` memberVouches=${r.memberVouches} memberLikes=${r.memberLikes}` +
        ` invitesUsed=${r.invitesUsed}`,
      );
    } else if (figures.record.status === 'absent') {
      lines.push('identity record: absent');
    } else {
      lines.push(`identity record: ${figures.record.status} — ${figures.record.verdict}`);
    }

    // WEB_INTERFACE → The extension → "The verified figures" — each ledger
    // whose read is not `read` has its status named here, so a failure under
    // an empty listing — where no box stands to carry it — is said.
    for (const line of holdingsLines('karma', figures.karma)) lines.push(line);
    for (const line of holdingsLines('credit', figures.credits)) lines.push(line);

    if (figures.karma.effective !== null && listing !== null) {
      lines.push(`effective karma at height ${listing.karma.height}: ${figures.karma.effective}`);
    }

    for (const line of nonZeroTailSums('karma', figures.karma)) lines.push(line);
    for (const line of nonZeroTailSums('credit', figures.credits)) lines.push(line);

    lines.push(`heightAfter: ${figures.heightAfter === null ? 'unavailable' : figures.heightAfter}`);
  }

  return lines;
}

// WEB_INTERFACE → The extension → "The verified figures" — a ledger whose
// read is not `read` says so, with the failure's verdict capped. `read` and
// `not-read` are silent — the latter is the state of a ledger the caller
// handed as `null`, which no line names here.
function holdingsLines(
  label: 'karma' | 'credit',
  side: { holdings: HoldingsRead; holdingsVerdict: string | null },
): string[] {
  if (side.holdings === 'read' || side.holdings === 'not-read') return [];
  const verdict = side.holdingsVerdict === null ? '' : ` — ${capped(side.holdingsVerdict)}`;
  return [`${label} holdings: ${side.holdings}${verdict}`];
}

// The tail sums are young / unchecked / absent / unlisted / undecided —
// proven is already the row's total, printed above. `unlisted` and
// `undecided` sum apart from the four (WEB_INTERFACE → The extension → "The
// verified figures"). Silence on a zero is the row's rule.
function nonZeroTailSums(label: 'karma' | 'credit', sums: LedgerSums): string[] {
  const out: string[] = [];
  if (sums.young !== 0n) out.push(`${label} young: ${sums.young}`);
  if (sums.unchecked !== 0n) out.push(`${label} unchecked: ${sums.unchecked}`);
  if (sums.absent !== 0n) out.push(`${label} absent: ${sums.absent}`);
  if (sums.unlisted !== 0n) out.push(`${label} unlisted: ${sums.unlisted}`);
  if (sums.undecided !== 0n) out.push(`${label} undecided: ${sums.undecided}`);
  return out;
}
