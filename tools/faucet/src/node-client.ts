import {
  fetchJson,
  isRecord,
  capped,
  STATUS_READ_BYTES,
  LISTING_PAGE_READ_BYTES,
  WRITE_ANSWER_READ_BYTES,
  REQUEST_TIMEOUT_MS,
  isHex64Lower,
  isNonNegSafeInt,
  isBoxValue,
} from '@dagsocial/node-reads';
import type { HttpFetch, NodeResult } from '@dagsocial/node-reads';
import type { BoxRef } from './tx.js';

export type { HttpFetch };

/** One `/status` read: the tip, and the era a client signs (NODE_INTERFACE → Status). */
export interface NodeStatus {
  readonly blockHeight: number;
  readonly protocolVersion: number;
}

/**
 * The node's HTTP surface, and the only file that knows its URL shape.
 *
 * ⚠ **Values cross as decimal strings** — `GET /karma/:userId` answers
 * `{ userId, total, boxes: [{ boxId, value }] }` with `value` a string, so every
 * one is parsed to `bigint` here and nothing downstream sees the wire form.
 */
export interface NodeClient {
  status(): Promise<NodeStatus>;
  karmaBoxes(pubKeyHex: string): Promise<BoxRef[]>;
  creditBoxes(pubKeyHex: string): Promise<BoxRef[]>;
  submitInvite(tx: Record<string, unknown>): Promise<{ expiresAtHeight: number }>;
  submitTransfer(tx: Record<string, unknown>): Promise<{ expiresAtHeight: number }>;
}

interface WireBox {
  boxId: string;
  value: string;
  lockedUntilBlock?: number;
  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"
  income?: true;
}

export class HttpNodeClient implements NodeClient {
  constructor(private readonly base: string, private readonly httpFetch: HttpFetch) {}

  /**
   * The tip and the era, from one `/status` read.
   *
   * The faucet is a client, and a client signs the era the node reports rather
   * than a constant of its own build (WEB_INTERFACE → Invariants); `/status`
   * serves `protocolVersion` — the era at `blockHeight + 1` — beside the height
   * for exactly that. A status missing either field is refused: a default would
   * sign the wrong era.
   */
  async status(): Promise<NodeStatus> {
    const r = await fetchJson<unknown>(this.httpFetch, `${this.base}/status`, STATUS_READ_BYTES);
    const data = this.unpack(r, '/status');
    if (!isRecord(data)) throw new NodeError(502, 'the /status answer is not an object');
    const { blockHeight, protocolVersion } = data;
    if (!isNonNegSafeInt(blockHeight)) throw new NodeError(502, 'node status carried no height');
    if (!isNonNegSafeInt(protocolVersion)) {
      throw new NodeError(502, 'node status carried no protocol version');
    }
    return { blockHeight, protocolVersion };
  }

  async karmaBoxes(pubKeyHex: string): Promise<BoxRef[]> {
    const boxes = await this.boxes(`${this.base}/karma/${pubKeyHex}`);
    // NODE_INTERFACE → Karma transition rules → "An identity holds at most two
    // karma boxes" — one unmarked and one marked, so a karma listing holding
    // more than one own box or more than one income box is not its route's.
    let own = 0;
    let income = 0;
    for (const b of boxes) {
      if (b.income === true) income++;
      else own++;
    }
    if (own > 1) throw new NodeError(502, `karma listing carries ${own} own boxes`);
    if (income > 1) throw new NodeError(502, `karma listing carries ${income} income boxes`);
    return boxes.map(toKarmaRef);
  }

  /**
   * ⛔ **A box carrying `lockedUntilBlock` is skipped**, whatever its height.
   * The protocol locks a coinbase credit for `creditMinerRewardDelay` blocks,
   * and the faucet does not spend what the protocol intends to be locked. This
   * is the faucet's own restraint, not an anticipation of a refusal.
   */
  async creditBoxes(pubKeyHex: string): Promise<BoxRef[]> {
    const boxes = await this.boxes(`${this.base}/credits/${pubKeyHex}`);
    return boxes.filter((b) => b.lockedUntilBlock === undefined).map(toCreditRef);
  }

  /**
   * NODE_INTERFACE → HTTP API: an identity with no unspent box answers the
   * empty page — `boxes: []`, `boxCount 0`, `total "0"` — so the array
   * passes through and the caller sees an empty set.
   */
  private async boxes(url: string): Promise<WireBox[]> {
    const r = await fetchJson<unknown>(this.httpFetch, url, LISTING_PAGE_READ_BYTES);
    const data = this.unpack(r, 'listing');
    if (!isRecord(data)) throw new NodeError(502, 'the listing answer is not an object');
    const raw = data['boxes'];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new NodeError(502, 'the listing boxes field is not an array');
    const out: WireBox[] = [];
    for (const b of raw) {
      // WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
      // its own fields": each field is held to its type.
      if (!isRecord(b)) throw new NodeError(502, 'a listing row is not an object');
      if (!isHex64Lower(b['boxId'])) throw new NodeError(502, 'a listing row has no 64-hex box id');
      if (!isBoxValue(b['value'])) throw new NodeError(502, 'a listing row has a box value out of its domain');
      const lock = b['lockedUntilBlock'];
      if (lock !== undefined && !isNonNegSafeInt(lock)) {
        throw new NodeError(502, 'a listing row has a bad lockedUntilBlock');
      }
      const incomeMark = b['income'];
      if (incomeMark !== undefined && incomeMark !== true) {
        throw new NodeError(502, `karma box income mark is ${String(incomeMark)}, expected true or absent`);
      }
      const wire: WireBox = { boxId: b['boxId'] as string, value: b['value'] as string };
      if (incomeMark === true) wire.income = true;
      if (lock !== undefined) wire.lockedUntilBlock = lock as number;
      out.push(wire);
    }
    return out;
  }

  /**
   * NODE_INTERFACE → Invites: the 201 body carries `expiresAtHeight`, the
   * mempool entry's expiry, relayed so a caller can bound its wait rather
   * than guess one. A 2xx body with no numeric `expiresAtHeight` is refused
   * — the posture `status()` already takes for a missing field.
   */
  async submitInvite(tx: Record<string, unknown>): Promise<{ expiresAtHeight: number }> {
    return this.write(`${this.base}/invites`, { tx }, 'invite');
  }

  /**
   * NODE_INTERFACE → Credits: the 2xx body carries `expiresAtHeight`, the
   * mempool entry's expiry, relayed so a caller can bound its wait. A 2xx body
   * with no numeric `expiresAtHeight` is refused — the posture `submitInvite`
   * already takes.
   */
  async submitTransfer(tx: Record<string, unknown>): Promise<{ expiresAtHeight: number }> {
    return this.write(`${this.base}/credits/transfer`, { tx }, 'transfer');
  }

  private async write(
    url: string,
    body: unknown,
    what: 'invite' | 'transfer',
  ): Promise<{ expiresAtHeight: number }> {
    // The method, content type and body ride on the `init` fetchJson hands the
    // wrapper, so the deadline and the timeout mark are node-reads' own
    // (WEB_INTERFACE → Reading a node's answer).
    const postFetch: HttpFetch = (u, init) => this.httpFetch(u, {
      ...init,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const r = await fetchJson<unknown>(postFetch, url, WRITE_ANSWER_READ_BYTES);
    const data = this.unpack(r, `${what} response`);
    if (!isRecord(data)) throw new NodeError(502, `${what} response is not an object`);
    const h = data['expiresAtHeight'];
    if (!isNonNegSafeInt(h)) throw new NodeError(502, `${what} response carried no expiresAtHeight`);
    return { expiresAtHeight: h };
  }

  /**
   * NODE_INTERFACE → Faucet → "Every other answer is the service's own or
   * the node's, never one dressed as the other" — the status decided where
   * the node's answer is read: a node's 4xx with its own status and message,
   * a node 5xx or an answer that is not its route's or a transport failure
   * node-reads reports without `timedOut` as 502, and a failed read carrying
   * `timedOut` as 504.
   */
  private unpack<T>(r: NodeResult<T>, routeName: string): T {
    if (r.ok) return r.data;
    // WEB_INTERFACE → Reading a node's answer → "A failure the deadline ended says so"
    if (r.timedOut) {
      throw new NodeError(504, `${routeName} did not answer within ${REQUEST_TIMEOUT_MS} ms`);
    }
    if (r.status === 0) {
      throw new NodeError(502, `${routeName} transport failure: ${capped(r.body)}`);
    }
    if (r.status >= 400 && r.status < 500) {
      throw new NodeError(r.status, decode4xxMessage(r.body));
    }
    // A node 5xx, an over-cap body or an unparseable 2xx — the answer is not
    // its route's, so the service answers 502.
    throw new NodeError(502, `${routeName}: ${capped(r.body)}`);
  }
}

const toCreditRef = (b: WireBox): BoxRef => ({ boxId: b.boxId, value: BigInt(b.value) });

/**
 * A karma box carries the mark that tells an owner's own box from their income
 * box. `income` is `true` on the income box and absent otherwise
 * (TYPES_INTERFACE → KarmaBox); the shape check in `boxes` has already refused
 * anything else, so the ref build here reads two shapes only.
 */
const toKarmaRef = (b: WireBox): BoxRef =>
  b.income === true
    ? { boxId: b.boxId, value: BigInt(b.value), income: true }
    : { boxId: b.boxId, value: BigInt(b.value) };

/**
 * NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
 * node's, never one dressed as the other" — a node 4xx is relayed with its
 * message: `reason`, else `error` when it is a string, else the text through
 * `capped`.
 */
function decode4xxMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const reason = parsed['reason'];
      if (typeof reason === 'string') return reason;
      const error = parsed['error'];
      if (typeof error === 'string') return error;
    }
  } catch {
    // Body is not JSON; the capped text is the whole of what the node said.
  }
  return capped(body);
}

/** The node's verdict, relayed rather than reinterpreted. */
export class NodeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'NodeError';
  }
}
