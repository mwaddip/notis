// The wallet's data shapes — the transaction layer under every write
// (WEB_INTERFACE → The wallet). Types only, shared by the builders and the ledger.

/** A box the client may spend: the id the node reported and its value. A
 *  `/karma` row carries no `createdAtBlock`, which is why the read order matters
 *  (WEB_INTERFACE → The wallet). */
export interface SpendableBox {
  boxId: string;
  value: bigint;
}

/** A predicted change box: the id the node will assign it, its value, and the
 *  height it was declared at — held so a later transaction can chain onto it and
 *  so a landed post's change is recognised in `/karma`. */
export interface ChangeRef {
  boxId: string;
  value: bigint;
  createdAtBlock: number;
}

export type EntryKind = 'post' | 'like' | 'grant';

/** One of the client's own pending transactions (WEB_INTERFACE → The wallet). For
 *  a post, `postId` is the node's own id from the 200 body; for a like, the target;
 *  for a faucet grant, the key the grant was asked for — there is no post, and the
 *  entry carries `inputs: []` and no `change`, so it is inert in the spendable view
 *  (WEB_INTERFACE → The faucet step). */
export interface PendingEntry {
  txId: string;
  kind: EntryKind;
  postId: string;
  inputs: string[];
  change?: ChangeRef;
  expiresAtHeight: number;
  submittedAtHeight: number;
}

/** What reconcile decides for one entry against the node's answer. */
export type EntryOutcome = 'landed' | 'expired' | 'pending';
