// The run from a `Config` to a result the caller writes, and the JSON
// shape the command line writes under `--json`. `runCli` drives the tip
// resolution, the listing fetch and the figures proof, and sets the exit
// code; `toJson` is the `--json` object. `src/index.ts` is the entry that
// parses argv and prints.

import { resolveTip } from './tip.js';
import { fetchListing, proveFigures } from './boxes.js';
import { checkPosts } from './posts.js';
import type { PostCheck } from './posts.js';
import type { Config } from './config.js';
import type { TipResult } from './tip.js';
import type { Anchor, FiguresResult, LedgerSums } from './boxes.js';
import type { Run } from './text.js';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { HttpFetch } from './http.js';
import { capped, fetchJson } from './http.js';

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
  post: PostCommandResult | null;
  exitCode: 0 | 1 | 2;
}

/**
 * The result of the `post <id>` subcommand (WEB_INTERFACE → The extension →
 * "The post check"): the row the node served, the check's verdict, and —
 * when the node's answer was not an object the check could run on — the
 * fetch's own failure. The command line exits 0 for a bound row, a withdrawn
 * row and an unserved row (the node holds no bytes, which is no claim about
 * the post's text), and 1 for an unbound row or an unanswered read.
 */
export interface PostCommandResult {
  id: string;
  nodeUrl: string;
  check: PostCheck | null;
  fetchFailure: string | null;
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
  if (config.post !== null) {
    const postResult = await runPost(config.post, config.nodeUrls[0]!, httpFetch);
    return {
      tip: { winner: null, winnerIndex: -1, nodes: [], tip: null, suffixHead: null, splits: [] },
      run: null,
      post: postResult,
      exitCode: postExitCode(postResult),
    };
  }

  const tipResult = await resolveTip(
    config.nodeUrls,
    config.m,
    config.k,
    config.profile,
    now,
    httpFetch,
  );

  const verifiedCount = tipResult.nodes.filter((n) => n.verified).length;

  if (verifiedCount === 0) return { tip: tipResult, run: null, post: null, exitCode: 2 };
  if (verifiedCount < 2 && !config.allowSingle) return { tip: tipResult, run: null, post: null, exitCode: 2 };
  if (tipResult.splits.length > 0) return { tip: tipResult, run: null, post: null, exitCode: 2 };

  if (!config.user || !tipResult.winner || !tipResult.suffixHead || !tipResult.tip) {
    return { tip: tipResult, run: null, post: null, exitCode: 0 };
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
      post: null,
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
    post: null,
    exitCode: figures.failed ? 1 : 0,
  };
}

/**
 * The post subcommand (`post <id>`): one GET /posts/<id>?tx=1 against the
 * first configured node, run through checkPosts. The check reads no state
 * (WEB_INTERFACE → The extension → "The post check"), so no tip resolution
 * precedes it.
 */
async function runPost(id: string, nodeUrl: string, httpFetch: HttpFetch): Promise<PostCommandResult> {
  const res = await fetchJson<unknown>(httpFetch, `${nodeUrl}/posts/${id}?tx=1`);
  if (!res.ok) {
    return {
      id,
      nodeUrl,
      check: null,
      fetchFailure: res.status === 0
        ? `transport failure: ${capped(res.body)}`
        : `HTTP ${res.status}: ${capped(res.body)}`,
    };
  }
  const [check] = checkPosts([res.data]);
  return { id, nodeUrl, check: check ?? null, fetchFailure: null };
}

function postExitCode(result: PostCommandResult): 0 | 1 {
  if (result.fetchFailure !== null) return 1;
  const check = result.check;
  if (check === null) return 1;
  if (check.status === 'bound' || check.status === 'nothing-to-bind' || check.status === 'unserved') return 0;
  return 1;
}

/**
 * The CLI's `--json` object. Every field the command line writes under
 * `--json` is here, including `karma`, `credits`, `boxes` and the ledger
 * sums.
 */
export function toJson(result: CliResult): Record<string, unknown> {
  const { tip, run, post } = result;
  if (post !== null) {
    const check = post.check;
    const checkJson: Record<string, unknown> =
      check === null
        ? { status: 'unanswered' }
        : check.status === 'bound'
        ? { status: 'bound', id: check.id, author: check.author, parent: check.parent }
        : check.status === 'unbound'
        ? { status: 'unbound', reason: check.reason, verdict: check.verdict }
        : { status: check.status };
    return {
      post: {
        id: post.id,
        nodeUrl: post.nodeUrl,
        check: checkJson,
        fetchFailure: post.fetchFailure,
      },
    };
  }
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
