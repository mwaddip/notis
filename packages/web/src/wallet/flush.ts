// Flushing waiting writes to a node — WEB_INTERFACE → The wallet → "Waiting
// writes go out at the first answer": once the client's verified tip has
// named a chain, a ledger's waiting writes go out in seq order, one at a
// time, by the write rule; the first answer of any status is each one's. A
// send that again reaches no node leaves it, and those after it, waiting.
// WEB_INTERFACE → The wallet → "A refusal ends what it strands": a refused
// waiting write and every later one on its ledger that spends its change —
// or the change of one so ended — comes off the store and the ledger
// (→ "Nothing retries a rejection"); a waiting write of another chain ends
// the same way.

import { isRejection } from '../api/write';
import type {
  WriteClient, Rejection,
  PostSubmitResult, LikeSubmitResult, VouchSubmitResult, InviteSubmitResult,
  WithdrawSubmitResult, ClaimSubmitResult, SendSubmitResult,
} from '../api/write';
import type { PendingLedger } from './ledger';
import type { PendingEntry } from './types';
import type { WaitingLedger, WaitingStore, WaitingWrite } from './waiting';

/** The three endings of a waiting write in a flush (WEB_INTERFACE → The
 *  wallet → "Waiting writes go out at the first answer", → "A refusal ends
 *  what it strands"). `sent` carries the ledger entry the release answers;
 *  `refused` carries the rejection — the node's, or the client's own on an
 *  id mismatch; `unsent` names whether the chain changed or an earlier write
 *  on the same ledger was stranded. */
export type FlushOutcome =
  | { write: WaitingWrite; outcome: 'sent'; entry: PendingEntry }
  | { write: WaitingWrite; outcome: 'refused'; rejection: Rejection }
  | { write: WaitingWrite; outcome: 'unsent'; cause: 'behind-refused' | 'chain' };

/** The seams a flush needs. `chain()` is the chain the verified tip names,
 *  null before one has (WEB_INTERFACE → The wallet → "The view and every
 *  waiting write carry the chain's name"); `tip()` is the highest tip the
 *  client has read, or null — a 2xx's expiry is bounded from it where it is
 *  a number, from the write's build height otherwise (WEB_INTERFACE → The
 *  wallet → "A pending entry's expiry is the client's, and a node's answer
 *  can only bring it sooner"). */
export interface FlushDeps {
  store: WaitingStore;
  ledger: PendingLedger;
  write: Pick<WriteClient, 'submitPost' | 'submitLike' | 'submitVouch' | 'submitInvite' | 'submitWithdraw' | 'submitClaim' | 'submitSend'>;
  chain(): string | null;
  tip(): number | null;
}

type AnyAnswer =
  | PostSubmitResult | LikeSubmitResult | VouchSubmitResult | InviteSubmitResult
  | WithdrawSubmitResult | ClaimSubmitResult | SendSubmitResult | Rejection;

/** Walk one ledger's waiting writes in seq order and send each by its kind.
 *  The whole walk runs inside the store's lock, so no page builds while
 *  another sends (WEB_INTERFACE → The wallet → "The waiting store keeps every
 *  waiting write as a record of its own"). With no chain named — a tip never
 *  verified — the answer is the empty list; nothing sent, nothing removed. */
export async function flushWaiting(deps: FlushDeps, ledger: WaitingLedger): Promise<FlushOutcome[]> {
  const chain = deps.chain();
  if (chain === null) return [];
  return deps.store.withLock(async () => {
    const outcomes: FlushOutcome[] = [];
    const stranded = new Set<string>();
    const writes = deps.store.list().filter((w) => w.ledger === ledger);
    for (const w of writes) {
      // A write of another chain ends unsent (WEB_INTERFACE → The wallet →
      // "A refusal ends what it strands").
      if (w.chain !== chain) {
        if (w.change !== null) stranded.add(w.change.boxId);
        endWriteUnsent(deps, w, 'chain', outcomes);
        continue;
      }
      // A write spending a stranded change ends unsent — "every later waiting
      // write on its ledger that spends its change — or the change of one so
      // ended" (WEB_INTERFACE → The wallet → "A refusal ends what it strands").
      if (w.spent.some((id) => stranded.has(id))) {
        if (w.change !== null) stranded.add(w.change.boxId);
        endWriteUnsent(deps, w, 'behind-refused', outcomes);
        continue;
      }
      const answer = await sendByKind(deps.write, w);
      // A send with no answer stops the walk — this write and every later one
      // stay waiting, untouched (WEB_INTERFACE → The wallet → "Waiting writes
      // go out at the first answer").
      if (isRejection(answer) && answer.noAnswer === true) return outcomes;
      if (isRejection(answer)) {
        if (w.change !== null) stranded.add(w.change.boxId);
        endWriteRefused(deps, w, answer, outcomes);
        continue;
      }
      // A 2xx whose transaction id differs from the waiting one's — or, for a
      // post, whose postId differs — is a client rejection, as on any send
      // (WEB_INTERFACE → The wallet → "Waiting writes go out at the first
      // answer", → "Nothing retries a rejection").
      if (answer.txId !== w.txId) {
        if (w.change !== null) stranded.add(w.change.boxId);
        endWriteRefused(deps, w, { status: 0, message: 'the node computed a different transaction id' }, outcomes);
        continue;
      }
      if (w.kind === 'post') {
        const post = answer as PostSubmitResult;
        if (post.postId !== w.postId) {
          if (w.change !== null) stranded.add(w.change.boxId);
          endWriteRefused(deps, w, { status: 0, message: 'the node computed a different post id' }, outcomes);
          continue;
        }
      }
      // 2xx: the entry stops waiting, and its expiry runs from the tip the
      // client read at the answer (WEB_INTERFACE → The wallet → "Waiting
      // writes go out at the first answer", → "A pending entry's expiry is
      // the client's, and a node's answer can only bring it sooner"). The
      // write folds into the store's base and the view stays unchanged.
      const t = deps.tip();
      const sentAt = t !== null ? t : w.builtAtHeight;
      const answered = (answer as { expiresAtHeight: unknown }).expiresAtHeight;
      const released = deps.ledger.release(w.txId, answered, sentAt);
      deps.store.absorb(w.txId);
      if (released !== null) outcomes.push({ write: w, outcome: 'sent', entry: released });
    }
    return outcomes;
  });
}

function endWriteUnsent(deps: FlushDeps, w: WaitingWrite, cause: 'behind-refused' | 'chain', outcomes: FlushOutcome[]): void {
  deps.store.remove(w.txId);
  deps.ledger.remove(w.txId);
  outcomes.push({ write: w, outcome: 'unsent', cause });
}

function endWriteRefused(deps: FlushDeps, w: WaitingWrite, rejection: Rejection, outcomes: FlushOutcome[]): void {
  deps.store.remove(w.txId);
  deps.ledger.remove(w.txId);
  outcomes.push({ write: w, outcome: 'refused', rejection });
}

async function sendByKind(write: FlushDeps['write'], w: WaitingWrite): Promise<AnyAnswer> {
  switch (w.kind) {
    case 'post':
      return write.submitPost(w.tx, w.content ?? '');
    case 'withdraw':
      return write.submitWithdraw(w.postId, w.tx);
    case 'like':
      return write.submitLike(w.tx);
    case 'vouch':
      return write.submitVouch(w.tx);
    case 'invite':
      return write.submitInvite(w.tx);
    case 'claim':
      return write.submitClaim(w.tx);
    case 'send':
      return write.submitSend(w.tx);
  }
}
