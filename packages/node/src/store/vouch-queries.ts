import { getDb } from './db.js';
import { getBox, rowToBox } from './utxo.js';
import type { UtxoRow } from './utxo.js';
import type { VouchBox } from '@dagsocial/types';
import type { Page, PageResult } from './index.js';

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

// NODE_INTERFACE → "Every list a view returns is a page"
const VOUCH_TARGET_WHERE =
  `box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ?`;
export function getVouchesForTargetPage(
  targetId: Uint8Array,
  page: Page<string>,
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
    .all(...params) as UtxoRow[];

  const hasMore = rows.length > page.limit;
  const resultRows = hasMore ? rows.slice(0, page.limit) : rows;
  const vouches = resultRows
    .map((r) => rowToBox(r) as VouchBox);
  const last = resultRows[resultRows.length - 1];
  const next: string | null = hasMore && last ? last.id : null;

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}`)
    .get(hex) as { cnt: number };

  return { rows: vouches, next, count: countRow.cnt };
}

/**
 * Unspent vouch boxes whose voucher's identity record fails member() —
 * ascending box id, at most `limit`. The settlement's lapse leg
 * (NODE_INTERFACE → The settlement transaction).
 */
export function getLapsedVouches(limit: number): VouchBox[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.* FROM utxo_boxes u
       JOIN identity_records ir
         ON ir.identity_id = unhex(json_extract(u.extra_data, '$.voucherId'))
       WHERE u.box_type = 'vouch'
         AND u.spent_at_block IS NULL
         AND NOT (ir.member_since_block > 0 AND ir.member_vouches >= ir.member_bar)
       ORDER BY u.id
       LIMIT ?`,
    )
    .safeIntegers()
    .all(limit) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as VouchBox);
}

const VOUCH_VOUCHER_WHERE =
  `box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.voucherId') = ?`;
export function getVouchesForVoucherPage(
  voucherId: Uint8Array,
  page: Page<string>,
): PageResult<VouchBox, string> {
  const db = getDb();
  const hex = pubkeyToHex(voucherId);
  const afterClause = page.after ? ` AND id > ?` : '';
  const params: unknown[] = [hex];
  if (page.after) params.push(page.after);
  params.push(page.limit + 1);

  const rows = db
    .prepare(
      `SELECT * FROM utxo_boxes WHERE ${VOUCH_VOUCHER_WHERE}${afterClause} ORDER BY id LIMIT ?`,
    )
    .safeIntegers()
    .all(...params) as UtxoRow[];

  const hasMore = rows.length > page.limit;
  const resultRows = hasMore ? rows.slice(0, page.limit) : rows;
  const vouches = resultRows.map((r) => rowToBox(r) as VouchBox);
  const last = resultRows[resultRows.length - 1];
  const next: string | null = hasMore && last ? last.id : null;

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_VOUCHER_WHERE}`)
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

