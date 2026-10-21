// The write client — WEB_INTERFACE → "The write client is its own module beside
// the read client". It POSTs a signed transaction the wallet built and serialised,
// and returns either the 2xx body — rebuilt from its own fields by a reader of
// the route — or one normalised Rejection. Every request carries the deadline's
// signal and every answer is read under the route's cap through
// `@dagsocial/node-reads`' `readCappedJson` (WEB_INTERFACE → Reading a node's
// answer → "Every answer is read under its route's cap, and every request runs
// under one deadline"). Nothing retries: a rejection is handed back for the
// caller to act on (WEB_INTERFACE → "Nothing retries").

import {
  readCappedJson, isHex64Lower, isRecord, isAuthorName,
  WRITE_ANSWER_READ_BYTES, REQUEST_TIMEOUT_MS,
} from '@dagsocial/node-reads';
import { trimBase } from '../base';

/** `POST /posts` 2xx — the node's own postId is authoritative, never derived here. */
export interface PostSubmitResult {
  postId: string;
  status: string; // 'pending'
  expiresAtHeight: number;
  txId: string;
}

/** `POST /likes` 2xx — a like has no postId; its target is the caller's. */
export interface LikeSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
}

/** `POST /vouches` and `DELETE /vouches/:targetId` 2xx — bounded like a like's.
 *  The node's unvouch reply also carries `karmaReturnsAtBlock`; the client reads
 *  the release from the cooldown arm, so it is not modelled here. */
export interface VouchSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
}

/** `POST /invites` 2xx — the bond box's id beside the bounded fields. */
export interface InviteSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
  bondBoxId: string;
}

/** `POST /posts/:id/withdraw` 2xx — the post the withdrawal empties, bounded like
 *  the rest. A 2xx is recorded with or without `expiresAtHeight`, and the entry's
 *  expiry is the ledger's, which the answered height can only bring sooner
 *  (WEB_INTERFACE → The wallet → "A pending entry's expiry is the client's, and a
 *  node's answer can only bring it sooner"). */
export interface WithdrawSubmitResult {
  status: string; // 'submitted'
  txId: string;
  postId: string;
  expiresAtHeight: number;
}

/** `POST /usernames` 2xx — a claim's bounded fields and the name the node
 *  accepted (WEB_INTERFACE → Writes). */
export interface ClaimSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
  name: string;
}

/** `POST /usernames/:name/burn` 2xx — bounded fields only, no name in the body
 *  (WEB_INTERFACE → Writes). */
export interface BurnSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
}

/** `POST /credits/transfer` 2xx — a signed credit-transfer transaction; the
 *  three bounded fields, like every other write's (WEB_INTERFACE → Writes). */
export interface SendSubmitResult {
  status: string; // 'pending'
  txId: string;
  expiresAtHeight: number;
}

/** One shape for both of the node's rejection bodies: the HTTP status and the
 *  message, normalised from `{ error: <status>, reason }` and `{ error: <message> }`
 *  both (WEB_INTERFACE → Writes). */
export interface Rejection {
  status: number;
  message: string;
}

/** A success body carries no `message`; a rejection always does. */
export function isRejection(
  r: PostSubmitResult | LikeSubmitResult | VouchSubmitResult | InviteSubmitResult | WithdrawSubmitResult | ClaimSubmitResult | BurnSubmitResult | SendSubmitResult | Rejection,
): r is Rejection {
  return 'message' in r;
}

// A client-side refusal: WEB_INTERFACE → The wallet → "A pending entry's expiry
// is the client's, and a node's answer can only bring it sooner" — a 2xx whose
// fields the flow reads are not their types, or a body over the cap, or one that
// does not parse, ends the flight as a transport failure does.
function clientRefusal(message: string): Rejection {
  return { status: 0, message };
}

// Field readers: a flow reads `body.txId` on every write and compares it with
// the built id; the post flow reads `body.postId` as the node's own id
// (WEB_INTERFACE → "A pending entry's expiry is the client's, and a node's
// answer can only bring it sooner"). A fresh DTO holds the fields the route
// serves, nothing a node adds carried.

function readPostResult(data: unknown): PostSubmitResult | null {
  if (!isRecord(data)) return null;
  const { postId, txId, status, expiresAtHeight } = data;
  if (!isHex64Lower(postId)) return null;
  if (!isHex64Lower(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  return { postId, txId, status, expiresAtHeight };
}

function readBoundedResult(data: unknown): LikeSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight } = data;
  if (!isHex64Lower(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  return { txId, status, expiresAtHeight };
}

function readInviteResult(data: unknown): InviteSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, bondBoxId } = data;
  if (!isHex64Lower(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (!isHex64Lower(bondBoxId)) return null;
  return { txId, status, expiresAtHeight, bondBoxId };
}

function readWithdrawResult(data: unknown): WithdrawSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, postId } = data;
  if (!isHex64Lower(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (!isHex64Lower(postId)) return null;
  return { txId, status, expiresAtHeight, postId };
}

function readClaimResult(data: unknown): ClaimSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, name } = data;
  if (!isHex64Lower(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (name === null || !isAuthorName(name)) return null;
  return { txId, status, expiresAtHeight, name };
}

export class WriteClient {
  // The origin is read fresh on every call, like the read client's — the settings
  // window can repoint it, and same-origin is the default (an empty base).
  constructor(private origin: () => string) {}

  submitPost(tx: Record<string, unknown>, content: string): Promise<PostSubmitResult | Rejection> {
    return this.send('POST', '/posts', { tx, content }, readPostResult);
  }

  submitLike(tx: Record<string, unknown>): Promise<LikeSubmitResult | Rejection> {
    return this.send('POST', '/likes', { tx }, readBoundedResult);
  }

  submitVouch(tx: Record<string, unknown>): Promise<VouchSubmitResult | Rejection> {
    return this.send('POST', '/vouches', { tx }, readBoundedResult);
  }

  /** The one non-`POST` write: `DELETE /vouches/:targetId` with a JSON `{ tx }`
   *  body, the same body the node's route decodes as a cast does
   *  (WEB_INTERFACE → Writes). */
  submitUnvouch(targetHex: string, tx: Record<string, unknown>): Promise<VouchSubmitResult | Rejection> {
    return this.send('DELETE', `/vouches/${encodeURIComponent(targetHex)}`, { tx }, readBoundedResult);
  }

  submitInvite(tx: Record<string, unknown>): Promise<InviteSubmitResult | Rejection> {
    return this.send('POST', '/invites', { tx }, readInviteResult);
  }

  /** The sixth write: `POST /posts/:id/withdraw` with a JSON `{ tx }` body
   *  (WEB_INTERFACE → Writes). */
  submitWithdraw(postId: string, tx: Record<string, unknown>): Promise<WithdrawSubmitResult | Rejection> {
    return this.send('POST', `/posts/${encodeURIComponent(postId)}/withdraw`, { tx }, readWithdrawResult);
  }

  submitClaim(tx: Record<string, unknown>): Promise<ClaimSubmitResult | Rejection> {
    return this.send('POST', '/usernames', { tx }, readClaimResult);
  }

  submitBurn(name: string, tx: Record<string, unknown>): Promise<BurnSubmitResult | Rejection> {
    return this.send('POST', `/usernames/${encodeURIComponent(name)}/burn`, { tx }, readBoundedResult);
  }

  /** The credit transfer's write: a signed transaction posted to
   *  `/credits/transfer` (WEB_INTERFACE → Writes). */
  submitSend(tx: Record<string, unknown>): Promise<SendSubmitResult | Rejection> {
    return this.send('POST', '/credits/transfer', { tx }, readBoundedResult);
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    reader: (data: unknown) => T | null,
  ): Promise<T | Rejection> {
    let res: Response;
    try {
      res = await fetch(trimBase(this.origin()) + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return clientRefusal(e instanceof Error ? e.message : String(e));
    }
    const read = await readCappedJson<unknown>(res, WRITE_ANSWER_READ_BYTES);
    if (!read.ok) {
      if (res.status >= 200 && res.status < 300) {
        // An over-cap 2xx or a 2xx that does not parse ends the flight as a
        // transport failure does (WEB_INTERFACE → Reading a node's answer).
        return clientRefusal(read.body);
      }
      return normalizeRejection(res.status, res.statusText, read.body);
    }
    const rebuilt = reader(read.data);
    if (rebuilt === null) {
      // A 2xx whose fields the flow reads are not their types (WEB_INTERFACE →
      // The wallet → "A pending entry's expiry is the client's, and a node's
      // answer can only bring it sooner").
      return clientRefusal(`the node answered with ${res.status} but its body is not the route's shape.`);
    }
    return rebuilt;
  }
}

/**
 * Both of the node's rejection body shapes normalised into one Rejection. The
 * status is the HTTP status; the message is `reason` when present (the
 * status+reason shape) and the string `error` otherwise (the message shape,
 * which 503 `mempool full` and 500 use even on the post and like routes). A body
 * that is not JSON — a bare 413, say — keeps the status text, as does one over
 * the cap or one that does not parse (both come to this function as a marker
 * string that is not JSON).
 */
export function normalizeRejection(status: number, statusText: string, body: string): Rejection {
  let message = statusText || `HTTP ${status}`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object') {
      const b = parsed as Record<string, unknown>;
      if (typeof b.reason === 'string') message = b.reason;
      else if (typeof b.error === 'string') message = b.error;
    }
  } catch {
    // The body is not JSON — the status text stands.
  }
  return { status, message };
}
