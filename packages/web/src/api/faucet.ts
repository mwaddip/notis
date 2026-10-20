import {
  readCappedJson, isHex64Lower, isRecord,
  WRITE_ANSWER_READ_BYTES, REQUEST_TIMEOUT_MS,
} from '@dagsocial/node-reads';
import { type Rejection, normalizeRejection } from './write';

// The faucet client — WEB_INTERFACE → The faucet step. One POST to the faucet's
// own service (NODE_INTERFACE → Faucet), beside the write client so the read
// client stays GET-only. Every request carries the deadline's signal and every
// answer reads under `WRITE_ANSWER_READ_BYTES` through `readCappedJson`
// (WEB_INTERFACE → Reading a node's answer → "Every answer is read under its
// route's cap, and every request runs under one deadline"). The faucet's
// `{ error }` bodies normalise to the same Rejection { status, message } the
// write client uses; nothing retries.

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

function clientRefusal(message: string): Rejection {
  return { status: 0, message };
}

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
    return this.ask<FaucetGrant>('/karma', pubkey, readKarmaGrant);
  }

  /** Ask the faucet to send this key $NOTIS — a repeatable grant, unlike karma's
   *  once-per-key invite (WEB_INTERFACE → The faucet step). The 202 must carry
   *  a numeric `expiresAtHeight` and a 64-hex `boxId`, the id naming the box the
   *  grant creates; missing either is a client-side refusal, for the reason the
   *  rep step's refusal gives. */
  async askCredits(pubkey: string): Promise<CreditGrant | Rejection> {
    return this.ask<CreditGrant>('/credits', pubkey, readCreditGrant);
  }

  private async ask<T>(
    path: string,
    pubkey: string,
    reader: (data: unknown) => { grant: T } | { refusal: string } | null,
  ): Promise<T | Rejection> {
    let res: Response;
    try {
      res = await fetch(this.base().replace(/\/$/, '') + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pubkey }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      return clientRefusal(e instanceof Error ? e.message : String(e));
    }
    const read = await readCappedJson<unknown>(res, WRITE_ANSWER_READ_BYTES);
    if (!read.ok) {
      if (res.status >= 200 && res.status < 300) return clientRefusal(read.body);
      return normalizeRejection(res.status, res.statusText, read.body);
    }
    const rebuilt = reader(read.data);
    if (rebuilt === null) {
      return clientRefusal(`the faucet answered with ${res.status} but its body is not the route's shape.`);
    }
    if ('refusal' in rebuilt) return clientRefusal(rebuilt.refusal);
    return rebuilt.grant;
  }
}

// The faucet's grant readers answer one of three: a well-formed grant, a
// targeted client-side refusal (the sentences `askKarma`/`askCredits` used to
// return inline), or null for anything else (the route's shape is wrong).

function readKarmaGrant(data: unknown): { grant: FaucetGrant } | { refusal: string } | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight } = data;
  if (typeof txId !== 'string' || !isHex64Lower(txId)) {
    return { refusal: 'the faucet did not name the transaction it made.' };
  }
  if (typeof expiresAtHeight !== 'number') {
    return { refusal: 'the faucet did not say when its invite expires.' };
  }
  return { grant: { txId, status: typeof status === 'string' ? status : 'pending', expiresAtHeight } };
}

function readCreditGrant(data: unknown): { grant: CreditGrant } | { refusal: string } | null {
  if (!isRecord(data)) return null;
  const { txId, status, expiresAtHeight, boxId } = data;
  if (typeof txId !== 'string' || !isHex64Lower(txId)) {
    return { refusal: 'the faucet did not name the transaction it made.' };
  }
  if (typeof expiresAtHeight !== 'number') {
    return { refusal: 'the faucet did not say when its transfer expires.' };
  }
  if (typeof boxId !== 'string' || !isHex64Lower(boxId)) {
    return { refusal: 'the faucet did not name the box it made.' };
  }
  return { grant: { txId, status: typeof status === 'string' ? status : 'pending', expiresAtHeight, boxId } };
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
