import { MEMPOOL_EXPIRY_BLOCKS } from '@dagsocial/types';
import type { PendingEntry, UnboundedEntry } from './types';

// A pending entry's expiry — WEB_INTERFACE → The wallet → "A pending entry's
// expiry is the client's, and a node's answer can only bring it sooner". Pure:
// the ledger applies it where an entry enters, added or restored from storage,
// and nothing here reads storage or the page.

/** A block height: a safe, non-negative integer. */
export function isBlockHeight(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** The height an entry built at `submittedAtHeight` expires at: that height plus
 *  `MEMPOOL_EXPIRY_BLOCKS`, the lifetime a node gives every transaction it pools
 *  (MEMPOOL_INTERFACE → What takes an entry out of the pool), or the answered
 *  `expiresAtHeight` when that is a block height below it. Any other answer —
 *  none, `null`, a string, a fraction, a negative, a later height — gives the
 *  client's own. Total: it never throws. */
export function boundedExpiry(submittedAtHeight: number, answered: unknown): number {
  const own = submittedAtHeight + MEMPOOL_EXPIRY_BLOCKS;
  return isBlockHeight(answered) && answered < own ? answered : own;
}

/** An entry as the ledger holds it: its `expiresAtHeight` bounded. */
export function heldEntry(entry: UnboundedEntry): PendingEntry {
  return { ...entry, expiresAtHeight: boundedExpiry(entry.submittedAtHeight, entry.expiresAtHeight) };
}
