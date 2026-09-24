import { type Rejection, normalizeRejection } from './write';

// The faucet client — WEB_INTERFACE → The faucet step. One POST to the faucet's
// own service (NODE_INTERFACE → Faucet), beside the write client so the read
// client stays GET-only. The faucet's { error } bodies normalise to the same
// Rejection { status, message } the write client uses; nothing retries.

const HEX64 = /^[0-9a-f]{64}$/;

/** The faucet's 202 karma grant — the invite is pooled and settles by
 *  expiresAtHeight. */
export interface FaucetGrant {
  txId: string;
  status: string; // 'pending'
  expiresAtHeight: number;
}

/** The faucet's 202 credits grant — the transfer's expiry and the box id the
 *  faucet named, so the ledger can recognise the grant among boxes the key may
 *  already hold (NODE_INTERFACE → Faucet). */
export interface CreditGrant {
  txId: string;
  status: string; // 'pending'
  expiresAtHeight: number;
  boxId: string;
}

/** The step the faucet was asked to take — a rejection carries the step so
 *  `faucetLine` can pick the correct 400 sentence (credits repeat, karma is
 *  once per key). */
export type FaucetStep = 'karma' | 'credits';

export class FaucetClient {
  // The base is read fresh on every call, like the read and write clients — the
  // faucet preference row can repoint it. Its own paths are <base>/karma and
  // <base>/credits.
  constructor(private base: () => string) {}

  /** Ask the faucet to invite a key to karma — the request carries only the public
   *  key, so a locked identity can ask (WEB_INTERFACE → The faucet step). A 202
   *  without a numeric expiresAtHeight is refused client-side: the faucet relays
   *  the field (NODE_INTERFACE → Faucet), so an answer without it is not the
   *  route's, and a grant reserves nothing of the reader's, so refusing one
   *  releases nothing. The height a 202 carries is bounded in the ledger as every
   *  entry's is (WEB_INTERFACE → The faucet step → "A 202 without
   *  `expiresAtHeight` is refused"). */
  async askKarma(pubkey: string): Promise<FaucetGrant | Rejection> {
    const res = await fetch(this.base().replace(/\/$/, '') + '/karma', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey }),
    });
    if (!res.ok) return normalizeRejection(res);
    const body = (await res.json()) as Partial<FaucetGrant>;
    if (typeof body.txId !== 'string' || !HEX64.test(body.txId)) {
      // Without a real transaction id the grant entry would record "undefined";
      // an honest client-side refusal instead (WEB_INTERFACE → The faucet step).
      return { status: 0, message: 'the faucet did not name the transaction it made.' };
    }
    if (typeof body.expiresAtHeight !== 'number') {
      return { status: 0, message: 'the faucet did not say when its invite expires.' };
    }
    return {
      txId: body.txId,
      status: String(body.status ?? 'pending'),
      expiresAtHeight: body.expiresAtHeight,
    };
  }

  /** Ask the faucet to send this key $NOTIS — a repeatable grant, unlike karma's
   *  once-per-key invite (WEB_INTERFACE → The faucet step). The 202 must carry
   *  a numeric `expiresAtHeight` and a 64-hex `boxId`, the id naming the box the
   *  grant creates; missing either is a client-side refusal, for the reason the
   *  rep step's refusal gives. */
  async askCredits(pubkey: string): Promise<CreditGrant | Rejection> {
    const res = await fetch(this.base().replace(/\/$/, '') + '/credits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey }),
    });
    if (!res.ok) return normalizeRejection(res);
    const body = (await res.json()) as Partial<CreditGrant>;
    if (typeof body.txId !== 'string' || !HEX64.test(body.txId)) {
      return { status: 0, message: 'the faucet did not name the transaction it made.' };
    }
    if (typeof body.expiresAtHeight !== 'number') {
      return { status: 0, message: 'the faucet did not say when its transfer expires.' };
    }
    if (typeof body.boxId !== 'string' || !HEX64.test(body.boxId)) {
      return { status: 0, message: 'the faucet did not name the box it made.' };
    }
    return {
      txId: body.txId,
      status: String(body.status ?? 'pending'),
      expiresAtHeight: body.expiresAtHeight,
      boxId: body.boxId,
    };
  }
}

/** A faucet rejection as one sentence in the voice register (WEB_INTERFACE → The
 *  faucet step, HOUSE_STYLE → Voice). A client-side refusal (status 0) is already
 *  a sentence; a relayed status maps to its known answer; anything else is the
 *  faucet's own message, lowercased. The step decides the 400 line: karma is
 *  once per key, credits repeat, so the once-per-key sentence is wrong there
 *  (NODE_INTERFACE → Faucet). */
export function faucetLine(r: Rejection, step: FaucetStep = 'karma'): string {
  switch (r.status) {
    case 0:
      return r.message;
    case 400:
      return step === 'credits'
        ? 'the faucet refused that key: ' + r.message
        : 'this key already had its faucet grant.';
    case 429:
      return 'the faucet is busy right now. try again in a while.';
    case 503:
      return 'the faucet is empty right now.';
    default:
      return 'the faucet said: ' + r.message.toLowerCase();
  }
}
