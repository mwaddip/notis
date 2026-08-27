import { getDb } from './db.js';
import { getBox } from './utxo.js';
import type { VouchBox } from '@dagsocial/types';

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

// NODE_INTERFACE → Vouches
const VOUCH_TARGET_WHERE =
  `box_type = 'vouch' AND spent_at_block IS NULL AND json_extract(extra_data, '$.targetId') = ?`;
export function getVouchesForTargetPage(
  targetId: Uint8Array,
  page: { limit: number; offset: number },
): { rows: VouchBox[]; count: number } {
  const db = getDb();
  const hex = pubkeyToHex(targetId);
  const ids = db
    .prepare(
      `SELECT id FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE} ORDER BY id LIMIT ? OFFSET ?`,
    )
    .all(hex, page.limit, page.offset) as Array<{ id: string }>;
  const rows = ids
    .map((r) => getBox(r.id))
    .filter((b): b is VouchBox => b !== null && b.boxType === 'vouch');
  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM utxo_boxes WHERE ${VOUCH_TARGET_WHERE}`)
    .get(hex) as { cnt: number };
  return { rows, count: countRow.cnt };
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
