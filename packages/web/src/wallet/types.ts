// The wallet's data shapes — the transaction layer under every write
// (WEB_INTERFACE → The wallet). Types only, shared by the builders and the ledger.

/** A box the client may spend: the id the node reported and its value. A
 *  `/karma` row carries no `createdAtBlock`, which is why the read order matters
 *  (WEB_INTERFACE → The wallet). The mark follows a `/karma` row through the
 *  parse: `true` on the owner's income box, absent on their own box
 *  (TYPES_INTERFACE → KarmaBox). A credit box carries no mark — the mark is
 *  the settlement's to make, and a karma output of a user transaction never
 *  carries it. */
export interface SpendableBox {
  boxId: string;
  value: bigint;
  income?: true;
}

/** The change box a builder predicts for its transaction: the id the node will
 *  assign it, its value, and the height the transaction declares it at. The
 *  builders' output type for a karma spend holds one; the ledger holds no
 *  input and no change (WEB_INTERFACE → The wallet → "An entry holds no input
 *  and no change"). */
export interface ChangeRef {
  boxId: string;
  value: bigint;
  createdAtBlock: number;
}

export type EntryKind = 'post' | 'like' | 'grant' | 'creditGrant' | 'vouch' | 'unvouch' | 'invite' | 'withdraw' | 'claim' | 'burn' | 'send';

/** A pending send's recipient and payment shape — the resolved key, the bare
 *  name the reader typed (as `UsernameResult.name` gives it; the `@` is the
 *  written form and is never stored — `WEB_INTERFACE → The identity display`),
 *  the amount, and the payment box's id. Persisted with `amount` as a decimal
 *  string, so the flight and the confirm can read the number back after a
 *  reload (WEB_INTERFACE → The wallet window → "The `send` row"). */
export interface SendRef {
  toHex: string;
  toName: string | null;
  amount: bigint;
  boxId: string;
}

/** One of the client's own pending transactions (WEB_INTERFACE → The wallet).
 *  `postId` is the entry's subject: for a post the node's own id from the 200
 *  body; for a like the target post; for a vouch and an unvouch the target key;
 *  for an invite the invitee key; for a withdrawal the post it empties; for a
 *  faucet karma grant the key the grant was asked for; for a faucet credits
 *  grant the box id the faucet named. A send's `postId` is the recipient's key.
 *  An entry holds no input and no change (WEB_INTERFACE → The wallet → "An
 *  entry holds no input and no change"): the spendable views are the node's
 *  pending view, so the ledger chooses no input and gates no spend.
 *  `submittedAtHeight` is the height the transaction was built at — for a
 *  faucet grant the highest tip the client had read when it asked — and
 *  `expiresAtHeight` is the ledger's: that height plus `MEMPOOL_EXPIRY_BLOCKS`,
 *  or the answered height when that is a block height below it (WEB_INTERFACE →
 *  The wallet → "A pending entry's expiry is the client's, and a node's answer
 *  can only bring it sooner"). */
export interface PendingEntry {
  txId: string;
  kind: EntryKind;
  postId: string;
  send?: SendRef;
  expiresAtHeight: number;
  submittedAtHeight: number;
}

/** An entry on its way into the ledger, its `expiresAtHeight` as an answer
 *  carried it or as storage held it, whatever its shape — the ledger bounds it
 *  where the entry enters. */
export type UnboundedEntry = Omit<PendingEntry, 'expiresAtHeight'> & { expiresAtHeight: unknown };

/** What reconcile decides for one entry against the node's answer. */
export type EntryOutcome = 'landed' | 'expired' | 'pending';
