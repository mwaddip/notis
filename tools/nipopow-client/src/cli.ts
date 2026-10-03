// The run from a `Config` to a result the caller writes, and the JSON
// shape the command line writes under `--json`. `runCli` drives the tip
// resolution, the listing fetch and the figures proof, and sets the exit
// code; `toJson` is the `--json` object. `src/index.ts` is the entry that
// parses argv and prints.

import { resolveTip } from './tip.js';
import { fetchListing, proveFigures } from './boxes.js';
import type { Config } from './config.js';
import type { TipResult } from './tip.js';
import type { Anchor, FiguresResult, LedgerSums } from './boxes.js';
import type { Run } from './text.js';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { HttpFetch } from './http.js';

const EMPTY_SUMS = { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, undecided: 0n } as const;

/**
 * The command line's result — a tip read, an optional figures run and the
 * exit code the entry writes. `exitCode` is 2 for an unusable tip (none
 * verified, under two verified without `--allow-single`, a split), 1 for
 * a figures run that `failed`, 0 otherwise.
 */
export interface CliResult {
  tip: TipResult;
  run: Run | null;
  exitCode: 0 | 1 | 2;
}

/**
 * One run of the command line's composition, taking a parsed `Config` and the
 * two environment seams. `fetch` and `now` are the caller's — the entry hands
 * `globalThis.fetch` and `Date.now`, a test hands its own.
 */
export async function runCli(
  config: Config,
  httpFetch: HttpFetch,
  now: () => number,
): Promise<CliResult> {
  const tipResult = await resolveTip(
    config.nodeUrls,
    config.m,
    config.k,
    config.profile,
    now,
    httpFetch,
  );

  const verifiedCount = tipResult.nodes.filter((n) => n.verified).length;

  if (verifiedCount === 0) return { tip: tipResult, run: null, exitCode: 2 };
  if (verifiedCount < 2 && !config.allowSingle) return { tip: tipResult, run: null, exitCode: 2 };
  if (tipResult.splits.length > 0) return { tip: tipResult, run: null, exitCode: 2 };

  if (!config.user || !tipResult.winner || !tipResult.suffixHead || !tipResult.tip) {
    return { tip: tipResult, run: null, exitCode: 0 };
  }

  const anchor: Anchor = { tip: tipResult.tip, suffixHead: tipResult.suffixHead };
  const listingResult = await fetchListing(tipResult.winner.url, config.user, httpFetch);
  if (!listingResult.ok) {
    return {
      tip: tipResult,
      run: {
        figures: {
          boxes: [],
          record: { status: 'no-proof', verdict: `listing failed: ${listingResult.reason}` },
          karma: { ...EMPTY_SUMS, effective: null, holdings: 'not-read', holdingsVerdict: null },
          credits: { ...EMPTY_SUMS, holdings: 'not-read', holdingsVerdict: null },
          heightAfter: null,
          failed: true,
        },
        listing: null,
      },
      exitCode: 1,
    };
  }
  const figures = await proveFigures(
    tipResult.winner.url,
    config.user,
    listingResult.listing,
    anchor,
    config.profile,
    httpFetch,
  );
  return {
    tip: tipResult,
    run: { figures, listing: listingResult.listing },
    exitCode: figures.failed ? 1 : 0,
  };
}

/**
 * The CLI's `--json` object. Every field the command line writes under
 * `--json` is here, including `karma`, `credits`, `boxes` and the ledger
 * sums.
 */
export function toJson(result: CliResult): Record<string, unknown> {
  const { tip, run } = result;
  const obj: Record<string, unknown> = {
    tip: tip.tip ? headerSummary(tip.tip) : null,
    suffixHead: tip.suffixHead
      ? { ...headerSummary(tip.suffixHead.header), stateRoot: tip.suffixHead.header.stateRoot }
      : null,
    nodes: tip.nodes.map((n) => ({
      url: n.url,
      verified: n.verified,
      refuseReason: n.refuseReason,
    })),
    splits: tip.splits,
  };
  if (run) {
    const { figures, listing } = run;
    obj.boxes = figures.boxes.map((b) => ({
      boxId: b.boxId,
      class: b.boxClass,
      value: b.value.toString(),
      lockedUntilBlock: b.lockedUntilBlock,
      status: b.status,
      verdict: b.verdict,
    }));
    obj.karmaTotal = figures.karma.proven.toString();
    obj.creditTotal = figures.credits.proven.toString();
    obj.karma = karmaJson(figures.karma, listing?.karma.height ?? null);
    obj.credits = {
      ...ledgerSumsJson(figures.credits),
      holdings: figures.credits.holdings,
      holdingsVerdict: figures.credits.holdingsVerdict,
    };
    obj.record = recordJson(figures.record);
    obj.heightAfter = figures.heightAfter;
  }
  return obj;
}

function karmaJson(
  sums: FiguresResult['karma'],
  listingHeight: number | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = ledgerSumsJson(sums);
  out['effective'] = sums.effective === null ? null : sums.effective.toString();
  out['holdings'] = sums.holdings;
  out['holdingsVerdict'] = sums.holdingsVerdict;
  if (listingHeight !== null) out['height'] = listingHeight;
  return out;
}

function ledgerSumsJson(sums: LedgerSums): Record<string, unknown> {
  return {
    proven: sums.proven.toString(),
    young: sums.young.toString(),
    unchecked: sums.unchecked.toString(),
    absent: sums.absent.toString(),
    unlisted: sums.unlisted.toString(),
    undecided: sums.undecided.toString(),
  };
}

function recordJson(record: FiguresResult['record']): Record<string, unknown> {
  if (record.status === 'proven') {
    return {
      status: 'proven',
      lastActivityBlock: record.record.lastActivityBlock,
      lastDecayBlock: record.record.lastDecayBlock,
      invitedAtBlock: record.record.invitedAtBlock,
      lifetimeLikesReceived: record.record.lifetimeLikesReceived.toString(),
      memberSinceBlock: record.record.memberSinceBlock,
      memberBar: record.record.memberBar,
      memberVouches: record.record.memberVouches,
      memberLikes: record.record.memberLikes.toString(),
      invitesUsed: record.record.invitesUsed,
    };
  }
  if (record.status === 'absent') return { status: 'absent' };
  return { status: record.status, verdict: record.verdict };
}

function headerSummary(h: BlockHeader): { height: number; hash: string } {
  return { height: h.height, hash: blockHash(h) ?? 'unhashable' };
}
