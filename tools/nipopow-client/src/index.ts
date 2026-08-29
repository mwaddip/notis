import { parseConfig, ConfigError } from './config.js';
import { resolveTip } from './tip.js';
import { proveBoxes } from './boxes.js';
import type { Config } from './config.js';
import type { TipResult } from './tip.js';
import type { BoxesResult } from './boxes.js';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import type { PoPowHeader } from '@dagsocial/nipopow';

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

  let boxesResult: BoxesResult | null = null;
  let exitCode = 0;

  if (config.user && tipResult.winner && tipResult.suffixHead) {
    boxesResult = await proveBoxes(
      tipResult.winner.url,
      config.user,
      tipResult.suffixHead,
      globalThis.fetch,
    );
    if (boxesResult.failed) exitCode = 1;
  }

  output(config, tipResult, boxesResult);
  process.exit(exitCode);
}

function output(config: Config, tip: TipResult, boxes: BoxesResult | null): void {
  if (config.json) {
    outputJson(tip, boxes);
  } else {
    outputText(tip, boxes);
  }
}

function outputJson(tip: TipResult, boxes: BoxesResult | null): void {
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
  if (boxes) {
    obj.boxes = boxes.boxes.map(b => ({
      boxId: b.boxId,
      class: b.boxClass,
      value: b.value.toString(),
      status: b.status,
      verdict: b.verdict,
    }));
    obj.karmaTotal = boxes.karmaTotal.toString();
    obj.creditTotal = boxes.creditTotal.toString();
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function outputText(tip: TipResult, boxes: BoxesResult | null): void {
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

  if (boxes) {
    lines.push('');
    if (boxes.boxes.length === 0) {
      lines.push('no boxes');
    } else {
      for (const b of boxes.boxes) {
        lines.push(`  ${b.boxClass} ${b.boxId}: ${b.verdict}${b.status === 'proven' ? ` value=${b.value}` : ''}`);
      }
      lines.push(`karma total (face value at suffixHead): ${boxes.karmaTotal}`);
      lines.push(`credit total (face value at suffixHead): ${boxes.creditTotal}`);
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

function headerSummary(h: BlockHeader): { height: number; hash: string } {
  return { height: h.height, hash: blockHash(h) ?? 'unhashable' };
}

main().catch(e => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
