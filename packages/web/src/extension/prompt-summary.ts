import { el } from '../dom';
import { formatCredits } from '../model/credits';
import type { SignSummary } from './protocol';

// The prompt's heading and lines, derived from a SignSummary. Pure — no chrome,
// no storage — so the prompt page imports them and a test drives them directly.
// WEB_INTERFACE → "A credits amount on the prompt is $NOTIS, never base units"
// says the credits heading names the total sent, each line its payment and
// recipient, and a fee line only when the transaction carries a `fee` box.

export function headingFor(s: SignSummary): HTMLElement {
  if (s.kind === 'credits') {
    let total = 0n;
    for (const send of s.sends) total += BigInt(send.value);
    return el('h1', 'ask', `send ${formatCredits(total)} $NOTIS?`);
  }
  const text: Record<Exclude<SignSummary['kind'], 'credits'>, string> = {
    thread: 'sign this thread?',
    reply: 'sign this reply?',
    like: 'sign this like?',
    withdraw: 'sign this withdrawal?',
    vouch: 'sign this vouch?',
    unvouch: 'sign this unvouch?',
    invite: 'sign this invite?',
    claim: 'sign this name?',
    burn: 'burn this name?',
    other: 'sign this rep transaction?',
  };
  return el('h1', 'ask', text[s.kind]);
}

export function linesFor(s: SignSummary, content: string | undefined): string[] {
  const out: string[] = [];
  if (s.kind === 'thread' || s.kind === 'reply' || s.kind === 'like' || s.kind === 'vouch' || s.kind === 'invite' || s.kind === 'burn' || s.kind === 'other') {
    out.push(`${s.spendRep} rep`);
  }
  if (s.kind === 'like') out.push(shortenHex(s.targetHex));
  if (s.kind === 'withdraw') out.push(shortenHex(s.postId));
  if (s.kind === 'vouch') out.push(shortenHex(s.targetHex));
  if (s.kind === 'invite') out.push(shortenHex(s.inviteeHex));
  if (s.kind === 'claim') out.push(s.name);
  if (s.kind === 'credits') {
    for (const send of s.sends) out.push(`${formatCredits(BigInt(send.value))} $NOTIS to ${shortenHex(send.ownerHex)}`);
    // The fee line rides a real `fee` box only — a send this client builds
    // carries none (WEB_INTERFACE → The wallet), so the line is absent for it,
    // and present for a transaction that outputs `fee`.
    if (s.feeValue !== '0') out.push(`fee ${formatCredits(BigInt(s.feeValue))} $NOTIS`);
  }
  if (content && (s.kind === 'thread' || s.kind === 'reply')) out.push(content);
  return out;
}

function shortenHex(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex;
}
