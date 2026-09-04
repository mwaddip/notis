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

/** One shape for both of the node's rejection bodies: the HTTP status and the
 *  message, normalised from `{ error: <status>, reason }` and `{ error: <message> }`
 *  both (WEB_INTERFACE → Writes). */
export interface Rejection {
  status: number;
  message: string;
}

/** A success body carries no `message`; a rejection always does. */
export function isRejection(r: PostSubmitResult | LikeSubmitResult | Rejection): r is Rejection {
  return 'message' in r;
}

export class WriteClient {
  // The origin is read fresh on every call, like the read client's — the settings
  // window can repoint it, and same-origin is the default (an empty base).
  constructor(private origin: () => string) {}

  submitPost(tx: Record<string, unknown>, content: string): Promise<PostSubmitResult | Rejection> {
    return this.post<PostSubmitResult>('/posts', { tx, content });
  }

  submitLike(tx: Record<string, unknown>): Promise<LikeSubmitResult | Rejection> {
    return this.post<LikeSubmitResult>('/likes', { tx });
  }

  private async post<T>(path: string, body: unknown): Promise<T | Rejection> {
    const res = await fetch(this.origin().replace(/\/$/, '') + path, {
      method: 'POST',
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
