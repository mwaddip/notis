import { getDb } from './db.js';
import { getBox } from './utxo.js';
import type { VouchBox } from '@dagsocial/types';
import type { PageKeyset, PageResult } from './index.js';

function pubkeyToHex(pk: Uint8Array): string {
  return Buffer.from(pk).toString('hex');
}

export function getVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): VouchBox | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?
         AND json_extract(extra_data, '$.targetId') = ?`,
    )
    .get(pubkeyToHex(voucherId), pubkeyToHex(targetId)) as
    | { id: string } | undefined;
  if (!row) return null;
  return getBox(row.id) as VouchBox | null;
}

// NODE_INTERFACE → Vouches → getVouchesForTargetPage
const VOUCH_TARGET_WHERE =
  `box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ?`;
export function getVouchesForTargetPage(
  targetId: Uint8Array,
  page: PageKeyset<string>,
): PageResult<VouchBox, string> {
  const db = getDb();
  const hex = pubkeyToHex(targetId);
  const afterClause = page.after ? ` AND id > ?` : '';
  const params: unknown[] = [hex];
  if (page.after) params.push(page.after);
  params.push(page.limit + 1);

  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}${afterClause} ORDER BY id LIMIT ?`,
    )
    .safeIntegers()
    .all(...params) as Array<Record<string, unknown>>;

  const hasMore = rows.length > page.limit;
  const resultRows = hasMore ? rows.slice(0, page.limit) : rows;
  const vouches = resultRows
    .map((r) => getBox(r.id as string))
    .filter((b): b is VouchBox => b !== null && b.boxType === 'vouch');
  const last = resultRows[resultRows.length - 1];
  const next: string | null = hasMore && last ? last.id as string : null;

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}`)
    .get(hex) as { cnt: number };

  return { rows: vouches, next, count: countRow.cnt };
}

export function getVouchesByVoucher(voucherId: Uint8Array): VouchBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?`,
    )
    .all(pubkeyToHex(voucherId)) as Array<{ id: string }>;
  return rows
    .map((r) => getBox(r.id))
    .filter((b): b is VouchBox => b !== null && b.boxType === 'vouch');
}

/**
 * Does this identity hold an active VouchBox for *any* target? One vouch at a
 * time is an invariant (ARCHITECTURE → Vouch boxes; audit L-4). The predicate
 * is identity-scoped, so a voucher cannot hold concurrent VouchBoxes by
 * targeting different identities.
 */
export function hasAnyActiveVouch(voucherId: Uint8Array): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?
       LIMIT 1`,
    )
    .get(pubkeyToHex(voucherId));
  return row !== undefined;
}
