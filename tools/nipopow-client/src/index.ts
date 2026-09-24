import { parseConfig, ConfigError } from './config.js';
import { resolveTip } from './tip.js';
import { fetchListing, proveFigures } from './boxes.js';
import { textLines } from './text.js';
import type { Config } from './config.js';
import type { TipResult } from './tip.js';
import type { Anchor, FiguresResult, LedgerSums } from './boxes.js';
import type { Run } from './text.js';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  const tipResult = await resolveTip(
    config.nodeUrls,
    config.m,
    config.k,
    config.profile,
    Date.now,
    globalThis.fetch,
  );

  const verifiedCount = tipResult.nodes.filter(n => n.verified).length;

  if (verifiedCount === 0) {
    output(config, tipResult, null);
    process.exit(2);
  }

  if (verifiedCount < 2 && !config.allowSingle) {
    output(config, tipResult, null);
    process.exit(2);
  }

  if (tipResult.splits.length > 0) {
    output(config, tipResult, null);
    process.exit(2);
  }

  let run: Run | null = null;
  let exitCode = 0;

  if (config.user && tipResult.winner && tipResult.suffixHead && tipResult.tip) {
    const anchor: Anchor = { tip: tipResult.tip, suffixHead: tipResult.suffixHead };
    const listingResult = await fetchListing(
      tipResult.winner.url,
      config.user,
      globalThis.fetch,
    );
    if (!listingResult.ok) {
      run = {
        figures: {
          boxes: [],
          record: { status: 'no-proof', verdict: `listing failed: ${listingResult.reason}` },
          karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, effective: null },
          credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n },
          heightAfter: null,
          failed: true,
        },
        listing: null,
      };
      exitCode = 1;
    } else {
      const figures = await proveFigures(
        tipResult.winner.url,
        config.user,
        listingResult.listing,
        anchor,
        config.profile,
        globalThis.fetch,
      );
      run = { figures, listing: listingResult.listing };
      if (figures.failed) exitCode = 1;
    }
  }

  output(config, tipResult, run);
  process.exit(exitCode);
}

function output(config: Config, tip: TipResult, run: Run | null): void {
  if (config.json) {
    outputJson(tip, run);
  } else {
    process.stdout.write(textLines(tip, run).join('\n') + '\n');
  }
}

function outputJson(tip: TipResult, run: Run | null): void {
  const obj: Record<string, unknown> = {
    tip: tip.tip ? headerSummary(tip.tip) : null,
    suffixHead: tip.suffixHead ? {
      ...headerSummary(tip.suffixHead.header),
      stateRoot: tip.suffixHead.header.stateRoot,
    } : null,
    nodes: tip.nodes.map(n => ({
      url: n.url,
      verified: n.verified,
      refuseReason: n.refuseReason,
    })),
    splits: tip.splits,
  };
  if (run) {
    const { figures, listing } = run;
    obj.boxes = figures.boxes.map(b => ({
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
    obj.credits = ledgerSumsJson(figures.credits);
    obj.record = recordJson(figures.record);
    obj.heightAfter = figures.heightAfter;
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function karmaJson(
  sums: LedgerSums & { effective: bigint | null },
  listingHeight: number | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = ledgerSumsJson(sums);
  out['effective'] = sums.effective === null ? null : sums.effective.toString();
  if (listingHeight !== null) out['height'] = listingHeight;
  return out;
}

function ledgerSumsJson(sums: LedgerSums): Record<string, unknown> {
  return {
    proven: sums.proven.toString(),
    young: sums.young.toString(),
    unchecked: sums.unchecked.toString(),
    absent: sums.absent.toString(),
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

main().catch(e => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
