import { type Rejection, normalizeRejection } from './write';

// The faucet client — WEB_INTERFACE → The faucet step. One POST to the faucet's
// own service (NODE_INTERFACE → Faucet), beside the write client so the read
// client stays GET-only. The faucet's { error } bodies normalise to the same
// Rejection { status, message } the write client uses; nothing retries.

/** The faucet's 202 grant — the invite is pooled and settles by expiresAtHeight. */
export interface FaucetGrant {
  txId: string;
  status: string; // 'pending'
  expiresAtHeight: number;
}

export class FaucetClient {
  // The base is read fresh on every call, like the read and write clients — the
  // faucet preference row can repoint it. Its own path is <base>/karma.
  constructor(private base: () => string) {}

  /** Ask the faucet to invite a key to karma — the request carries only the public
   *  key, so a locked identity can ask (WEB_INTERFACE → The faucet step). A 202
   *  without a numeric expiresAtHeight is refused client-side: a grant with no
   *  expiry would run the poll for ever, which the motion contract forbids. */
  async askKarma(pubkey: string): Promise<FaucetGrant | Rejection> {
    const res = await fetch(this.base().replace(/\/$/, '') + '/karma', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey }),
    });
    if (!res.ok) return normalizeRejection(res);
    const body = (await res.json()) as Partial<FaucetGrant>;
    if (typeof body.expiresAtHeight !== 'number') {
      return { status: 0, message: 'the faucet did not say when its invite expires.' };
    }
    return {
      txId: String(body.txId),
      status: String(body.status ?? 'pending'),
      expiresAtHeight: body.expiresAtHeight,
    };
  }
}

/** A faucet rejection as one sentence in the voice register (WEB_INTERFACE → The
 *  faucet step, HOUSE_STYLE → Voice). A client-side refusal (status 0) is already
 *  a sentence; a relayed status maps to its known answer; anything else is the
 *  faucet's own message, lowercased. */
export function faucetLine(r: Rejection): string {
  switch (r.status) {
    case 0:
      return r.message;
    case 400:
      return 'this key already had its faucet grant.';
    case 429:
      return 'the faucet is busy right now. try again in a while.';
    case 503:
      return 'the faucet is empty right now.';
    default:
      return 'the faucet said: ' + r.message.toLowerCase();
  }
}
