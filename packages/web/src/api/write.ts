// The write client — WEB_INTERFACE → "The write client is its own module beside
// the read client". It POSTs a signed transaction the wallet built and serialised,
// and returns either the 2xx body or one normalised Rejection. Nothing retries: a
// rejection is handed back for the caller to act on (WEB_INTERFACE → "Nothing
// retries").

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
 *  the rest. `expiresAtHeight` is checked in the flow: a 2xx without it cannot be
 *  tracked (WEB_INTERFACE → The withdraw control). */
export interface WithdrawSubmitResult {
  status: string; // 'submitted'
  txId: string;
  postId: string;
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
  r: PostSubmitResult | LikeSubmitResult | VouchSubmitResult | InviteSubmitResult | WithdrawSubmitResult | Rejection,
): r is Rejection {
  return 'message' in r;
}

export class WriteClient {
  // The origin is read fresh on every call, like the read client's — the settings
  // window can repoint it, and same-origin is the default (an empty base).
  constructor(private origin: () => string) {}

  submitPost(tx: Record<string, unknown>, content: string): Promise<PostSubmitResult | Rejection> {
    return this.send<PostSubmitResult>('POST', '/posts', { tx, content });
  }

  submitLike(tx: Record<string, unknown>): Promise<LikeSubmitResult | Rejection> {
    return this.send<LikeSubmitResult>('POST', '/likes', { tx });
  }

  submitVouch(tx: Record<string, unknown>): Promise<VouchSubmitResult | Rejection> {
    return this.send<VouchSubmitResult>('POST', '/vouches', { tx });
  }

  /** The one non-`POST` write: `DELETE /vouches/:targetId` with a JSON `{ tx }`
   *  body, the same body the node's route decodes as a cast does
   *  (WEB_INTERFACE → Writes). */
  submitUnvouch(targetHex: string, tx: Record<string, unknown>): Promise<VouchSubmitResult | Rejection> {
    return this.send<VouchSubmitResult>('DELETE', `/vouches/${encodeURIComponent(targetHex)}`, { tx });
  }

  submitInvite(tx: Record<string, unknown>): Promise<InviteSubmitResult | Rejection> {
    return this.send<InviteSubmitResult>('POST', '/invites', { tx });
  }

  /** The sixth write: `POST /posts/:id/withdraw` with a JSON `{ tx }` body
   *  (WEB_INTERFACE → Writes). */
  submitWithdraw(postId: string, tx: Record<string, unknown>): Promise<WithdrawSubmitResult | Rejection> {
    return this.send<WithdrawSubmitResult>('POST', `/posts/${encodeURIComponent(postId)}/withdraw`, { tx });
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T | Rejection> {
    const res = await fetch(this.origin().replace(/\/$/, '') + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return (await res.json()) as T;
    return normalizeRejection(res);
  }
}

/**
 * Both of the node's rejection body shapes normalised into one Rejection. The
 * status is the HTTP status; the message is `reason` when present (the
 * status+reason shape) and the string `error` otherwise (the message shape,
 * which 503 `mempool full` and 500 use even on the post and like routes). A body
 * that is not JSON — a bare 413, say — keeps the status text.
 */
export async function normalizeRejection(res: Response): Promise<Rejection> {
  let message = res.statusText || `HTTP ${res.status}`;
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (typeof b.reason === 'string') message = b.reason;
      else if (typeof b.error === 'string') message = b.error;
    }
  } catch {
    // No JSON body — the status text stands.
  }
  return { status: res.status, message };
}
