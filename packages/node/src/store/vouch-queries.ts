import { getDb, prepared } from './db.js';
import { rowToBox } from './utxo.js';
import type { UtxoRow } from './utxo.js';
import { bytesToHex } from '@dagsocial/types';
import type { VouchBox } from '@dagsocial/types';
import type { Page, PageResult } from './index.js';

/**
 * Every live vouch box for the (voucher, target) pair, ascending box id — the
 * `StateView` read (CONSENSUS_INTERFACE → StateView).
 */
export function getVouchBoxes(voucherId: Uint8Array, targetId: Uint8Array): VouchBox[] {
  const rows = prepared(getDb(), `SELECT * FROM utxo_boxes
       WHERE box_type = 'vouch' AND spent_at_block IS NULL
         AND json_extract(extra_data, '$.voucherId') = ?
         AND json_extract(extra_data, '$.targetId') = ?
       ORDER BY id`, true)
    .all(bytesToHex(voucherId), bytesToHex(targetId)) as UtxoRow[];
  return rows.map((r) => rowToBox(r) as VouchBox);
}

/** The pair's first live vouch box by id, or null — read for its existence. */
export function getVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
): VouchBox | null {
  return getVouchBoxes(voucherId, targetId)[0] ?? null;
}

// NODE_INTERFACE → "Every list a view returns is a page"
const VOUCH_TARGET_WHERE =
  `box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ?`;

// NODE_INTERFACE → Store Interface, getVouchCountForTarget(targetId) — feeds
// getVouchesForTargetPage's own count, which delegates here so
// VOUCH_TARGET_WHERE's count is computed in one place.
export function getVouchCountForTarget(targetId: Uint8Array): number {
  const row = prepared(getDb(), `SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}`)
    .get(bytesToHex(targetId)) as { cnt: number };
  return row.cnt;
}

export function getVouchesForTargetPage(
  targetId: Uint8Array,
  page: Page<string>,
): PageResult<VouchBox, string> {
  const db = getDb();
  const hex = bytesToHex(targetId);
  const afterClause = page.after ? ` AND id > ?` : '';
  const params: unknown[] = [hex];
  if (page.after) params.push(page.after);
  params.push(page.limit + 1);

  const rows = prepared(db, `SELECT * FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}${afterClause} ORDER BY id LIMIT ?`, true)
    .all(...params) as UtxoRow[];

  const hasMore = rows.length > page.limit;
  const resultRows = hasMore ? rows.slice(0, page.limit) : rows;
  const vouches = resultRows
    .map((r) => rowToBox(r) as VouchBox);
  const last = resultRows[resultRows.length - 1];
  const next: string | null = hasMore && last ? last.id : null;

  return { rows: vouches, next, count: getVouchCountForTarget(targetId) };
}

/**
 * Unspent vouch boxes whose voucher's identity record is a lapsed member —
 * `memberSinceBlock > 0 ∧ memberVouches < memberBar` (CONSENSUS_INTERFACE →
 * What it holds → "Membership is one predicate"), ascending box id, at most
 * `limit`. The settlement's lapse leg (NODE_INTERFACE → The settlement
 * transaction; NODE_INTERFACE → Vouch escrows → `getLapsedVouches`).
 */
export function getLapsedVouches(limit: number): VouchBox[] {
  const db = getDb();
  const rows = prepared(db, `SELECT u.* FROM utxo_boxes u
       JOIN identity_records ir
         ON ir.identity_id = unhex(json_extract(u.extra_data, '$.voucherId'))
       WHERE u.box_type = 'vouch'
         AND u.spent_at_block IS NULL
         AND ir.member_since_block > 0
         AND ir.member_vouches < ir.member_bar
       ORDER BY u.id
       LIMIT ?`, true)
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
  const hex = bytesToHex(voucherId);
  const afterClause = page.after ? ` AND id > ?` : '';
  const params: unknown[] = [hex];
  if (page.after) params.push(page.after);
  params.push(page.limit + 1);

  const rows = prepared(db, `SELECT * FROM utxo_boxes WHERE ${VOUCH_VOUCHER_WHERE}${afterClause} ORDER BY id LIMIT ?`, true)
    .all(...params) as UtxoRow[];

  const hasMore = rows.length > page.limit;
  const resultRows = hasMore ? rows.slice(0, page.limit) : rows;
  const vouches = resultRows.map((r) => rowToBox(r) as VouchBox);
  const last = resultRows[resultRows.length - 1];
  const next: string | null = hasMore && last ? last.id : null;

  const countRow = prepared(db, `SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_VOUCHER_WHERE}`)
    .get(hex) as { cnt: number };

  return { rows: vouches, next, count: countRow.cnt };
}

