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

export type EntryKind = 'post' | 'like' | 'grant' | 'vouch' | 'unvouch' | 'invite' | 'withdraw';

/** One of the client's own pending transactions (WEB_INTERFACE → The wallet).
 *  `postId` is the entry's subject: for a post the node's own id from the 200
 *  body; for a like the target post; for a vouch and an unvouch the target key;
 *  for an invite the invitee key; for a withdrawal the post it empties; for a
 *  faucet grant the key the grant was asked for — a grant has no post and carries
 *  `inputs: []` and no `change`, so it is inert in the spendable view
 *  (WEB_INTERFACE → The faucet step). An unvouch's one input is a `vouch` box, not
 *  a karma box, so the spendable view ignores it, and it has no change. A
 *  withdrawal's one karma input is spent and its equal-value output is the
 *  entry's `change`, so the spendable view stays whole while it is pending
 *  (WEB_INTERFACE → The withdraw control). */
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
