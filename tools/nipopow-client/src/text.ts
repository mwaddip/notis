import type { PoPowHeader } from '@dagsocial/nipopow';
import type { FiguresResult, LedgerSums, Listing } from './boxes.js';
import { capped } from './http.js';
import type { TipResult } from './tip.js';

export interface Run {
  figures: FiguresResult;
  listing: Listing | null;
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
        const valueSuffix = b.status === 'proven' || b.status === 'young' ? ` value=${b.value}` : '';
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

    if (figures.karma.effective !== null && listing !== null) {
      lines.push(`effective karma at height ${listing.karma.height}: ${figures.karma.effective}`);
    }

    for (const line of nonZeroTailSums('karma', figures.karma)) lines.push(line);
    for (const line of nonZeroTailSums('credit', figures.credits)) lines.push(line);

    lines.push(`heightAfter: ${figures.heightAfter === null ? 'unavailable' : figures.heightAfter}`);
  }

  return lines;
}

// The tail sums are young / unchecked / absent — proven is already the row's
// total, printed above. Silence on a zero is the row's rule.
function nonZeroTailSums(label: 'karma' | 'credit', sums: LedgerSums): string[] {
  const out: string[] = [];
  if (sums.young !== 0n) out.push(`${label} young: ${sums.young}`);
  if (sums.unchecked !== 0n) out.push(`${label} unchecked: ${sums.unchecked}`);
  if (sums.absent !== 0n) out.push(`${label} absent: ${sums.absent}`);
  return out;
}
