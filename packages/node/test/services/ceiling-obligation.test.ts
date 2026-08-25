import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * NODE_INTERFACE → Validity ceiling — the obligation test.
 *
 * Every non-comment line inside `checkTransitions` that mentions
 * `currentBlockHeight` is listed here. A new mention fails this test until
 * its author declares whether it caps height from above (and therefore owes a
 * `ceilingOf` arm) or not.
 *
 * No regex decides what counts as relevant — a comparison operator adjacent
 * to the identifier is the exact filter that missed the `effectiveKarma` call
 * at line 488, where height flows indirectly through a decay computation
 * into a balance threshold. The inventory carries every mention; the
 * `capsHeight` field carries the judgment.
 */

interface HeightMention {
  /** A substring that uniquely identifies the source line within checkTransitions. */
  key: string;
  /** Whether this mention caps height from above — true owes a ceilingOf arm. */
  capsHeight: boolean;
  /** Which ceilingOf arm covers it, or why none is needed. */
  note: string;
}

const INVENTORY: HeightMention[] = [
  {
    key: 'currentBlockHeight: number,',
    capsHeight: false,
    note: 'parameter declaration',
  },
  {
    key: 'voucherFace, voucherRecord, currentBlockHeight, deps.decayCfg,',
    capsHeight: false,
    note:
      'effectiveKarma decays with height (decay.ts:105-121), and the vouch ' +
      'arm then tests voucherBalance < VOUCH_MIN_BALANCE — validity IS ' +
      'height-dependent here, but it turns on the voucher\'s karma STATE ' +
      'rather than the transaction\'s bytes, so no bytes-only ceiling can ' +
      'express it and the pool cannot know it',
  },
  {
    key: 'vouchOut.createdAtBlock < currentBlockHeight - VOUCH_CAST_HEIGHT_WINDOW',
    capsHeight: true,
    note: 'vouch cast ceiling: createdAtBlock + VOUCH_CAST_HEIGHT_WINDOW',
  },
  {
    key: '`${VOUCH_CAST_HEIGHT_WINDOW} blocks behind height ${currentBlockHeight}`',
    capsHeight: false,
    note: 'error message template literal for the vouch window check',
  },
  {
    key: 'c.createdAtBlock === currentBlockHeight',
    capsHeight: true,
    note: 'rent successor ceiling: the credit outputs declared createdAtBlock',
  },
  {
    key: '`height ${currentBlockHeight}`',
    capsHeight: false,
    note: 'error message template literal for the rent successor check',
  },
];

describe('ceiling obligation', () => {
  it('every currentBlockHeight mention in checkTransitions is inventoried', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/services/utxo-engine.ts'),
      'utf-8',
    );
    const lines = src.split('\n');

    // Find checkTransitions boundaries. The signature spans several lines
    // and the return type contains braces (`{ valid: boolean; … }`), so
    // start counting from the BODY's opening brace.
    const startIdx = lines.findIndex((l) => l.startsWith('function checkTransitions('));
    expect(startIdx).toBeGreaterThan(-1);

    let bodyOpenIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
      if (lines[i]!.trimEnd().endsWith(') {') || lines[i]!.trimEnd().endsWith('} {')) {
        bodyOpenIdx = i;
        break;
      }
    }
    expect(bodyOpenIdx).toBeGreaterThan(-1);

    let braceDepth = 1;
    let endIdx = -1;
    for (let i = bodyOpenIdx + 1; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      if (braceDepth === 0) {
        endIdx = i;
        break;
      }
    }
    expect(endIdx).toBeGreaterThan(bodyOpenIdx);

    const body = lines.slice(startIdx, endIdx + 1);

    // Every non-comment line mentioning currentBlockHeight.
    const mentions: Array<{ lineNo: number; text: string }> = [];
    for (let i = 0; i < body.length; i++) {
      const line = body[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      if (line.includes('currentBlockHeight')) {
        mentions.push({ lineNo: startIdx + i + 1, text: trimmed });
      }
    }

    // Every mention must appear in the inventory.
    const uninventoried: string[] = [];
    for (const m of mentions) {
      const matched = INVENTORY.some((entry) => m.text.includes(entry.key));
      if (!matched) {
        uninventoried.push(`Line ${m.lineNo}: ${m.text}`);
      }
    }
    expect(
      uninventoried,
      `Uninventoried currentBlockHeight mention(s) in checkTransitions — ` +
        `add to INVENTORY with capsHeight and note:\n` +
        uninventoried.join('\n'),
    ).toHaveLength(0);

    // Every inventory entry must still match a mention in the source.
    const staleEntries: string[] = [];
    for (const entry of INVENTORY) {
      const matched = mentions.some((m) => m.text.includes(entry.key));
      if (!matched) {
        staleEntries.push(entry.key);
      }
    }
    expect(
      staleEntries,
      `Stale INVENTORY entries — the mention no longer exists in ` +
        `checkTransitions:\n` + staleEntries.join('\n'),
    ).toHaveLength(0);

    // Every capsHeight=true entry must have a matching ceilingOf arm.
    const ceilingOfStart = lines.findIndex((l) => l.includes('export function ceilingOf('));
    expect(ceilingOfStart).toBeGreaterThan(-1);

    let ceilingBraceDepth = 0;
    let ceilingEnd = -1;
    for (let i = ceilingOfStart; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') ceilingBraceDepth++;
        if (ch === '}') ceilingBraceDepth--;
      }
      if (ceilingBraceDepth === 0 && i > ceilingOfStart) {
        ceilingEnd = i;
        break;
      }
    }
    expect(ceilingEnd).toBeGreaterThan(ceilingOfStart);

    const ceilingBody = lines.slice(ceilingOfStart, ceilingEnd + 1).join('\n');

    const capsHeightEntries = INVENTORY.filter((e) => e.capsHeight);
    expect(
      capsHeightEntries.length,
      'At least one mention must cap height',
    ).toBeGreaterThan(0);

    expect(ceilingBody).toContain('VOUCH_CAST_HEIGHT_WINDOW');
    expect(ceilingBody).toContain('createdAtBlock');
    expect(ceilingBody).toContain('isCreditSideTx');
  });
});
