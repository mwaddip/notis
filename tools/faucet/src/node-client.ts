import type { BoxRef } from './tx.js';

/**
 * The node's HTTP surface, and the only file that knows its URL shape.
 *
 * ⚠ **Values cross as decimal strings** — `GET /karma/:userId` answers
 * `{ userId, total, boxes: [{ boxId, value }] }` with `value` a string, so every
 * one is parsed to `bigint` here and nothing downstream sees the wire form.
 */
export interface NodeClient {
  currentHeight(): Promise<number>;
  karmaBoxes(pubKeyHex: string): Promise<BoxRef[]>;
  creditBoxes(pubKeyHex: string): Promise<BoxRef[]>;
  submitInvite(tx: Record<string, unknown>): Promise<void>;
  submitTransfer(tx: Record<string, unknown>): Promise<void>;
}

interface WireBox {
  boxId: string;
  value: string;
  lockedUntilBlock?: number;
}

export class HttpNodeClient implements NodeClient {
  constructor(private readonly base: string) {}

  async currentHeight(): Promise<number> {
    const res = await fetch(`${this.base}/status`);
    if (!res.ok) throw new NodeError(res.status, await failure(res));
    const data = (await res.json()) as { blockHeight?: number };
    if (typeof data.blockHeight !== 'number') throw new NodeError(502, 'node status carried no height');
    return data.blockHeight;
  }

  async karmaBoxes(pubKeyHex: string): Promise<BoxRef[]> {
    return (await this.boxes(`${this.base}/karma/${pubKeyHex}`))
      .map(toRef);
  }

  /**
   * ⛔ **A box carrying `lockedUntilBlock` is skipped**, whatever its height.
   * The protocol locks a coinbase credit for `creditMinerRewardDelay` blocks,
   * and the faucet does not spend what the protocol intends to be locked. This
   * is the faucet's own restraint, not an anticipation of a refusal.
   */
  async creditBoxes(pubKeyHex: string): Promise<BoxRef[]> {
    return (await this.boxes(`${this.base}/credits/${pubKeyHex}`))
      .filter((b) => b.lockedUntilBlock === undefined)
      .map(toRef);
  }

  /**
   * ⚠ **A JSON 404 is an EMPTY box set, not a failure.** The node answers 404
   * when the queried identity holds no box of that type, which for the faucet's
   * own key means it has run dry. A 404 that is not the node's — a proxy
   * serving nothing at `NODE_URL` — carries no JSON body and is raised, so a
   * mistyped base path does not read as an empty faucet.
   */
  private async boxes(url: string): Promise<WireBox[]> {
    const res = await fetch(url);
    if (res.status === 404 && isJson(res)) return [];
    if (!res.ok) throw new NodeError(res.status, await failure(res));
    const data = (await res.json()) as { boxes?: WireBox[] };
    return data.boxes ?? [];
  }

  submitInvite(tx: Record<string, unknown>): Promise<void> {
    return this.post(`${this.base}/invites`, { tx });
  }

  submitTransfer(tx: Record<string, unknown>): Promise<void> {
    return this.post(`${this.base}/credits/transfer`, { tx });
  }

  private async post(url: string, body: unknown): Promise<void> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new NodeError(res.status, await failure(res));
  }
}

const toRef = (b: WireBox): BoxRef => ({ boxId: b.boxId, value: BigInt(b.value) });

const isJson = (res: Response): boolean =>
  (res.headers.get('content-type') ?? '').includes('application/json');

/** The node states an intentional rejection as `{ error }`; anything else is relayed as it came. */
async function failure(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (isJson(res)) {
    try {
      const body = JSON.parse(text) as { error?: unknown; reason?: unknown };
      const stated = body.reason ?? body.error;
      if (typeof stated === 'string') return stated;
    } catch {
      // Not the shape it declared; the raw body below says more than a guess.
    }
  }
  return text || `the node answered ${res.status}`;
}

/** The node's verdict, relayed rather than reinterpreted. */
export class NodeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'NodeError';
  }
}
