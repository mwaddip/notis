import type { LinksPref } from './links';

// The page↔background wire, WEB_INTERFACE → The extension. Message shapes are
// closed at the type level; unknown messages are refused (`REFUSED_UNKNOWN`),
// the shape of an unrecognised name never being trusted at run time.
// `runtime.sendMessage` returns a promise on both browsers under MV3
// (WEB_INTERFACE → "The messages"), so every answer here is a plain result —
// no callbacks — or `{ error }` on a refusal.

/** The refusal-vocabulary for `sign`, WEB_INTERFACE → "`sign`, in the
 *  background, in order". `busy` names a second prompt while a first is still
 *  open; the others are the three pre-prompt checks. */
export type SignRefusal = 'undecodable' | 'id-mismatch' | 'already-signed' | 'busy';

/** The four things a `sign` message can answer. `pending` never reaches the
 *  wallet — the proxy waits on the record's `result` and translates back to a
 *  wallet-side `SignResult` (WEB_INTERFACE → The wallet). */
export type SignAnswer =
  | { signature: string }
  | { locked: true }
  | { pending: string }
  | { refused: SignRefusal };

/** The prompt record's `result` — filled by `approve` or `decline`, then the
 *  page reads it through `storage.session.onChanged` and calls `ack`. */
export type SignResult = { signature: string } | { declined: true };

/** The transaction-display hint the page may supply. `content` is a post's
 *  body, shown only when `computeContentHash(content) === tx.post.contentHash`
 *  (WEB_INTERFACE → "The summary the prompt shows is derived from the
 *  transaction"). */
export interface SignHint {
  content?: string;
}

/** The prompt record written to `storage.session` under `notis.sign.<id>` — the
 *  background writes it before opening the prompt window; both the initial and
 *  a fresh-after-restart background read it back when the human answers
 *  (WEB_INTERFACE → "`sign`, in the background, in order"). */
export interface SignRecord {
  id: string;            // 32 hex characters — the record's own id, its storage key suffix
  txIdHex: string;       // the 64-hex id the signature will cover
  txBytesHex: string;    // the unsigned tx bytes, hex — decoded by the background, never trusted from the page
  pubKeyHex: string;     // the signer's public key at write time; the prompt's unlock form keys the password manager on it
  summary: SignSummary;  // derived from the transaction, never taken from the page
  hint: SignHint;        // the page's display data, verified before it is shown
  createdAt: number;     // Date.now() at write — telemetry only, never checked
  windowId?: number;     // the id windows.create returned, so onRemoved decides declined
  result?: SignResult;
}

/** What the prompt tells the human. The summary is what the background derived
 *  from the decoded transaction (WEB_INTERFACE → "The summary the prompt shows
 *  is derived from the transaction"). */
export type SignSummary =
  | { kind: 'thread'; spendRep: string }
  | { kind: 'reply'; spendRep: string }
  | { kind: 'like'; targetHex: string; spendRep: string }
  | { kind: 'withdraw'; postId: string }
  | { kind: 'vouch'; targetHex: string; spendRep: string }
  | { kind: 'unvouch' }
  | { kind: 'invite'; inviteeHex: string; spendRep: string }
  | { kind: 'claim'; name: string }
  | { kind: 'burn'; spendRep: string }
  | { kind: 'other'; spendRep: string }
  | { kind: 'credits'; sends: CreditSend[]; feeValue: string };

export interface CreditSend {
  ownerHex: string; // the credit box's `owner`, not the signer's own key
  value: string;    // decimal string, as boxes carry it
}

/** The page-side snapshot the proxy uses. `policy` is the extension's binary
 *  preference; `null` from the background collapses to null here too
 *  (WEB_INTERFACE → "The messages"). */
export interface AppSnapshot {
  pubKeyHex: string;
  locked: boolean;
  backedUp: boolean;
  policy: 'silent' | 'ask';
}

// ---------------------------------------------------------------------------
// The message table — every shape is discriminated by `kind`, the background's
// dispatcher branches on that alone, and an unknown kind is refused.
// ---------------------------------------------------------------------------

export type Message =
  | { kind: 'state' }
  | { kind: 'draft' }
  | { kind: 'discardDraft' }
  | { kind: 'create'; passphrase: string }
  | { kind: 'inspectFile'; text: string }
  | { kind: 'importFile'; text: string; passphrase: string }
  | { kind: 'exportFile'; password: string }
  | { kind: 'unlock'; passphrase: string }
  | { kind: 'lock' }
  | { kind: 'forget' }
  | { kind: 'policy'; karma: 'silent' | 'ask' }
  | { kind: 'links'; opens: LinksPref }
  | { kind: 'takeOpen' }
  | { kind: 'arrived'; id: string }
  | { kind: 'offered'; id: string }
  | { kind: 'sign'; txBytesHex: string; txIdHex: string; hint?: SignHint }
  | { kind: 'ack'; id: string }
  | { kind: 'approve'; id: string }
  | { kind: 'decline'; id: string };

export type MessageKind = Message['kind'];

/** The set of message kinds the dispatcher understands — anything else is
 *  answered with the `REFUSED_UNKNOWN` `{ error }` shape. */
export const KNOWN_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  'state', 'draft', 'discardDraft', 'create', 'inspectFile', 'importFile',
  'exportFile', 'unlock', 'lock', 'forget', 'policy',
  'links', 'takeOpen', 'arrived', 'offered',
  'sign', 'ack', 'approve', 'decline',
]);

/** The refusal shape the background answers when it cannot honour a message —
 *  a plain object with `error`, one field, and a string, so the page's
 *  `runtime.sendMessage`'s resolved value is inspected with `'error' in r`. */
export interface ErrorAnswer {
  error: string;
}

export const REFUSED_UNKNOWN: ErrorAnswer = { error: 'unknown message kind' };

/** A pubKeyHex-only shape — the `state` answer when no identity is loaded is
 *  `null`, but a message answer that carries `{ pubKeyHex }` alone uses this. */
export interface PubKeyAnswer {
  pubKeyHex: string;
}

/** The answer shape per message kind. `state` also answers `null` — that is a
 *  peer alternative to `AppSnapshot`, so callers unwrap `AppSnapshot | null`. */
export type Answer<K extends MessageKind> =
  K extends 'state' ? (AppSnapshot | null)
  : K extends 'draft' | 'create' | 'importFile' ? PubKeyAnswer
  : K extends 'inspectFile' ? { kind: 'clear' | 'encrypted'; pubKeyHex: string }
  : K extends 'exportFile' ? { text: string }
  : K extends 'sign' ? SignAnswer
  : K extends 'takeOpen' ? { ids: string[] }
  : K extends 'discardDraft' | 'unlock' | 'lock' | 'forget' | 'policy' | 'links' | 'arrived' | 'offered' | 'ack' | 'approve' | 'decline' ? 'ok'
  : never;

/** A `Message` guard the dispatcher uses to close over the input. `unknown`
 *  arrives from `runtime.onMessage`, so every field the guard reads is a
 *  probe — a shape that lies about its `kind` is refused as unknown. */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && KNOWN_KINDS.has(kind as MessageKind);
}
