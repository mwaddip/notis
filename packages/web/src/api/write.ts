// The write client — WEB_INTERFACE → "The write client is its own module beside
// the read client". It POSTs a signed transaction the wallet built and serialised,
// and returns either the 2xx body — rebuilt from its own fields by a reader of
// the route — or one normalised Rejection. Every request carries the deadline's
// signal and every answer is read under the route's cap through
// `@dagsocial/node-reads`' `readCappedJson` (WEB_INTERFACE → Reading a node's
// answer → "Every answer is read under its route's cap, and every request runs
// under one deadline"). A rejection is never retried; a send with no answer
// goes, the same bytes, to the next base in the client's order, and the first
// response of any status is the send's (WEB_INTERFACE → The wallet → "Nothing
// retries a rejection"). Every base failing reads as today's transport failure,
// `timedOut` the last attempt's.

import {
  readCappedJson, isRecord, isAuthorName,
  WRITE_ANSWER_READ_BYTES, REQUEST_TIMEOUT_MS,
  type HttpFetch,
} from '@dagsocial/node-reads';
import { isHex64 } from '@dagsocial/types';
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
 *  both (WEB_INTERFACE → Writes). A transport failure — `status: 0` — carries
 *  `timedOut: true` when the deadline ended it, as `fetchJson` carries it on a
 *  read (WEB_INTERFACE → Reading a node's answer → "A failure the deadline
 *  ended says so"). `noAnswer: true` marks the send `send` returns once the
 *  loop is exhausted — the empty-order `no node to send to` and the last
 *  attempt's transport failure — and no other result
 *  (WEB_INTERFACE → The wallet → "A write no node answers waits"). */
export interface Rejection {
  status: number;
  message: string;
  timedOut?: true;
  noAnswer?: true;
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
  if (!isHex64(postId)) return null;
  if (!isHex64(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  return { postId, txId, status, expiresAtHeight };
}

function readBoundedResult(data: unknown): LikeSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight } = data;
  if (!isHex64(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  return { txId, status, expiresAtHeight };
}

function readInviteResult(data: unknown): InviteSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, bondBoxId } = data;
  if (!isHex64(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (!isHex64(bondBoxId)) return null;
  return { txId, status, expiresAtHeight, bondBoxId };
}

function readWithdrawResult(data: unknown): WithdrawSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, postId } = data;
  if (!isHex64(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (!isHex64(postId)) return null;
  return { txId, status, expiresAtHeight, postId };
}

function readClaimResult(data: unknown): ClaimSubmitResult | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, name } = data;
  if (!isHex64(txId)) return null;
  if (typeof status !== 'string') return null;
  if (typeof expiresAtHeight !== 'number') return null;
  if (name === null || !isAuthorName(name)) return null;
  return { txId, status, expiresAtHeight, name };
}

export class WriteClient {
  // The bases are read fresh on every send, never captured — the extension
  // hands the client's node order, the web build its one node's base
  // (WEB_INTERFACE → The extension → "A write goes to one node and, with no
  // answer, to the next"). The `fetch` the client runs every request through
  // is the caller's, taken once.
  private readonly bases: () => string[];
  private readonly httpFetch: HttpFetch;
  constructor(opts: { bases: () => string[]; fetch: HttpFetch }) {
    this.bases = opts.bases;
    this.httpFetch = opts.fetch;
  }

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
    // `bases()` is read once per send, and the same body bytes go to each base
    // in turn (WEB_INTERFACE → The extension → "A write goes to one node and,
    // with no answer, to the next"). An empty list answers the transport
    // failure with no request, and every base failing answers today's transport
    // failure carrying the last attempt's message and `timedOut` (WEB_INTERFACE
    // → Reading a node's answer → "A failure the deadline ended says so").
    const bases = this.bases();
    const bodyBytes = JSON.stringify(body);
    let last: Rejection = { status: 0, message: 'no node to send to' };
    for (const base of bases) {
      let res: Response;
      try {
        res = await this.httpFetch(trimBase(base) + path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: bodyBytes,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        last = transportFailureFrom(e);
        continue;
      }
      const read = await readCappedJson<unknown>(res, WRITE_ANSWER_READ_BYTES);
      if (!read.ok && read.status === 0) {
        // The deadline ended the body stream, or the body stream rejected
        // mid-read — the attempt ended with no complete answer.
        last = { status: 0, message: read.body, ...(read.timedOut ? { timedOut: true as const } : {}) };
        continue;
      }
      // The first response of any status is the send's answer: read as today.
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
    // The loop is exhausted — the empty-order `no node to send to` or every
    // attempt a transport failure — and the send reads as *no answer*
    // (WEB_INTERFACE → The wallet → "A write no node answers waits").
    return { ...last, noAnswer: true };
  }
}

// The deadline fires with a `TimeoutError`, which `fetchJson` recognises off
// the `.name` (WEB_INTERFACE → Reading a node's answer → "A failure the
// deadline ended says so"); any other rejection is a plain transport failure.
function transportFailureFrom(e: unknown): Rejection {
  const message = e instanceof Error ? e.message : String(e);
  const timedOut = typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError';
  return timedOut ? { status: 0, message, timedOut: true } : { status: 0, message };
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
