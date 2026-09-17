import { formatCredits } from '../model/credits';
import type { SignSummary } from './protocol';

// The prompt's three lines, derived from a SignSummary. Pure — no chrome,
// no storage — so the prompt page imports them and a test drives them directly.
// WEB_INTERFACE → The extension → "The prompt reads as three lines: what, how
// much, to whom" — plus a fee line only when the transaction carries a `fee`
// box, and the verified content is added on the render side (a post's body
// arrives verified by `computeContentHash`, WEB_INTERFACE → The extension →
// "The summary the prompt shows is derived from the transaction").

/** One target line — a label ('to:', 'for:', 'post:', or empty for a name) and
 *  a value carried whole. WEB_INTERFACE → The extension → "the key or id whole,
 *  in mono, wrapped". */
export type PromptTarget = { label: string; value: string };

/** Line 1 — what the transaction is. WEB_INTERFACE → The extension → "The
 *  first names the transaction". */
export function whatFor(s: SignSummary): string {
  switch (s.kind) {
    case 'thread': return 'Notis post';
    case 'reply': return 'Notis reply';
    case 'like': return 'Notis like';
    case 'withdraw': return 'Notis withdrawal';
    case 'vouch': return 'Notis vouch';
    case 'unvouch': return 'Notis unvouch';
    case 'invite': return 'Notis invite';
    case 'claim': return 'Notis name';
    case 'burn': return 'Notis burn';
    case 'other': return 'Notis rep transaction';
    case 'credits': return 'Notis transfer';
  }
}

/** Line 2 — the amount. A transfer reads $NOTIS (the sum of its payments, on
 *  the face, never base units — WEB_INTERFACE → The extension → "A credits
 *  amount on the prompt is $NOTIS, never base units"). A karma-side kind that
 *  carries a spendRep reads `<N> rep`. A withdrawal, a claim and an unvouch
 *  read nothing — the reader chose no value on them. */
export function amountFor(s: SignSummary): string | null {
  if (s.kind === 'credits') {
    let total = 0n;
    for (const send of s.sends) total += BigInt(send.value);
    return `${formatCredits(total)} $NOTIS`;
  }
  if (s.kind === 'withdraw' || s.kind === 'claim' || s.kind === 'unvouch') return null;
  return `${s.spendRep} rep`;
}

/** Line 3 — the target. `to:` for a transfer (one line per payment) and an
 *  invite, `for:` for a vouch, `post:` for a like and a withdrawal, an
 *  unlabelled name for a claim; null for an unvouch (the vouch box is an
 *  input, ids only), for a burn (the name box is an input) and for the kinds
 *  that name nothing — a thread, a reply, a rep transaction. WEB_INTERFACE →
 *  The extension → "An unvouch names no target and a burn no name". */
export function targetFor(s: SignSummary): PromptTarget[] | null {
  switch (s.kind) {
    case 'credits': return s.sends.map((send) => ({ label: 'to:', value: send.ownerHex }));
    case 'invite': return [{ label: 'to:', value: s.inviteeHex }];
    case 'vouch': return [{ label: 'for:', value: s.targetHex }];
    case 'like': return [{ label: 'post:', value: s.targetHex }];
    case 'withdraw': return [{ label: 'post:', value: s.postId }];
    case 'claim': return [{ label: '', value: s.name }];
    case 'thread':
    case 'reply':
    case 'unvouch':
    case 'burn':
    case 'other':
      return null;
  }
}

/** The fee line — only when the transaction outputs a `fee` box. A send this
 *  client builds carries none (WEB_INTERFACE → The wallet), so the line is
 *  absent for it, and present for a transaction that outputs `fee`. */
export function feeFor(s: SignSummary): string | null {
  if (s.kind !== 'credits') return null;
  if (s.feeValue === '0') return null;
  return `fee ${formatCredits(BigInt(s.feeValue))} $NOTIS`;
}
