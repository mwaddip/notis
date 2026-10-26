import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import {
  HTTP_CHECK_INTERVAL_MS,
  HTTP_CONNECTIONS_MAX,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  isHex64,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import { buildInviteTx } from './invite.js';
import { buildCreditTransferTx } from './transfer.js';
import { RateLimiter } from './rate-limit.js';
import { NodeError } from './node-client.js';
import { BadRequestError, InsufficientFundsError } from './tx.js';
import type { NodeClient } from './node-client.js';
import type { FaucetConfig } from './config.js';

/**
 * The most bytes of JSON body a route reads: `{ pubkey }` is 77, rounded up to a
 * power of two (`CONSTANTS → HTTP server bounds`).
 */
export const FAUCET_BODY_MAX_BYTES = 128;

/**
 * Two endpoints, because a karma grant is repeatable once and a credit transfer
 * is unlimited: an invite may not name a key that already holds an identity
 * record (NODE_INTERFACE → Karma transition rules), while the same key may
 * receive credits any number of times. Folding both into one call would spend a
 * tester's single invite to give them credits they could have had again.
 *
 * ⛔ **No grant ledger.** Once-per-identity is consensus state; the node's
 * refusal is the whole record, and it is relayed with its own status.
 */
export function createApp(cfg: FaucetConfig, client: NodeClient): express.Express {
  const app = express();
  // nginx runs on loopback in front and appends the caller to X-Forwarded-For,
  // so with loopback trusted `req.ip` is that appended hop. A client controls
  // the hops it sends but not the one nginx adds, so it cannot prepend a value
  // to spend a rate-limit key other than its own.
  app.set('trust proxy', 'loopback');
  // NODE_INTERFACE → Faucet → "The service's server keeps the public server's headers, deadlines and connection bound"
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // NODE_INTERFACE → HTTP API → "The node reads no compressed request body":
  // `inflate: false` refuses any `Content-Encoding` before a decompression
  // stream is created, as the node's parser does.
  app.use(express.json({ limit: FAUCET_BODY_MAX_BYTES, inflate: false }));

  const karmaLimit = new RateLimiter(cfg.rateLimitPerHour);
  const creditLimit = new RateLimiter(cfg.rateLimitPerHour);

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint." Each endpoint holds a tail; a
  // request's work waits for the previous one's answer before reading /status.
  // The two endpoints spend different ledgers and wait for each other in
  // nothing. A refusal before the node is reached (a malformed key, the rate
  // limit) does not enter the line.
  let karmaTail: Promise<unknown> = Promise.resolve();
  let creditTail: Promise<unknown> = Promise.resolve();

  const ip = (req: express.Request): string => rateLimitKey(req.ip ?? 'unknown');

  /** The requested key, or `null` once the request has been answered. */
  const requested = (req: express.Request, res: express.Response): string | null => {
    const pubkey = String((req.body as { pubkey?: unknown } | undefined)?.pubkey ?? '')
      .toLowerCase();
    if (!isHex64(pubkey)) {
      res.status(400).json({ error: 'pubkey must be 64 hex characters, an Ed25519 public key' });
      return null;
    }
    return pubkey;
  };

  const limited = (limiter: RateLimiter, req: express.Request, res: express.Response): boolean => {
    if (limiter.allow(ip(req), Date.now())) return false;
    res.status(429).json({ error: 'rate limit reached — try again later' });
    return true;
  };

  app.post('/faucet/karma', async (req, res) => {
    const pubkey = requested(req, res);
    if (pubkey === null || limited(karmaLimit, req, res)) return;
    const myTurn = karmaTail.then(() => handleKarma(cfg, client, res, pubkey));
    karmaTail = myTurn.catch(() => undefined);
    await myTurn;
  });

  app.post('/faucet/credits', async (req, res) => {
    const pubkey = requested(req, res);
    if (pubkey === null || limited(creditLimit, req, res)) return;
    const myTurn = creditTail.then(() => handleCredit(cfg, client, res, pubkey));
    creditTail = myTurn.catch(() => undefined);
    await myTurn;
  });

  // A malformed JSON body reaches here from `express.json()`; without this it
  // becomes a 500 for what is a client's mistake.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    relay(res, err);
  });

  return app;
}

/**
 * Creates the HTTP server over `app`, listens on `port` and returns it.
 *
 * NODE_INTERFACE → Faucet → "The service's server keeps the public server's headers, deadlines and connection bound"
 * (`CONSTANTS → HTTP server bounds`). `timeout` stays `0`: a request waits its
 * turn in its endpoint's line with no byte moving, which an idle deadline would end.
 */
export function listenFaucet(app: express.Express, port: number): Server {
  const server = createServer({
    headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
    requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
    connectionsCheckingInterval: HTTP_CHECK_INTERVAL_MS,
  }, app);
  server.maxConnections = HTTP_CONNECTIONS_MAX;
  return server.listen(port);
}

const MAPPED_IPV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/**
 * NODE_INTERFACE → Faucet → "Its rate limit is keyed on the caller's address,
 * an IPv6 caller's by its /64" — the smallest prefix a network routes to one
 * subscriber. An IPv4 address, or one mapped into IPv6, keys as the IPv4
 * address; an IPv6 address keys as its first four 16-bit groups, written one
 * way whatever compressed form arrives. A malformed address keys as itself.
 */
export function rateLimitKey(address: string): string {
  const mapped = MAPPED_IPV4.exec(address);
  if (mapped) return mapped[1]!;
  if (isIPv4(address)) return address;
  if (!isIPv6(address)) return address;
  try {
    return canonicalIPv6Prefix64(address);
  } catch {
    return address;
  }
}

function canonicalIPv6Prefix64(address: string): string {
  const parts = address.split('::');
  const head = parts[0] === '' ? [] : parts[0]!.split(':');
  const tail = parts.length === 1
    ? []
    : parts[1] === ''
      ? []
      : parts[1]!.split(':');
  const missing = 8 - head.length - tail.length;
  if (missing < 0) throw new Error('ipv6 too long');
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (groups.length !== 8) throw new Error('ipv6 group count');
  // Normalize each group to lowercase hex with no leading zeros.
  const first4 = groups.slice(0, 4).map((g) => {
    const n = Number.parseInt(g || '0', 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('ipv6 group range');
    return n.toString(16);
  });
  return first4.join(':');
}

/**
 * NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
 * node's, never one dressed as the other." — for an invite, 503 is one whose
 * `effective` under `pending=1`, less the bond, stands below `KARMA_MINIMUM`
 * (→ Karma transition rules → "Only a post spends the floor").
 */
async function handleKarma(
  cfg: FaucetConfig,
  client: NodeClient,
  res: express.Response,
  pubkey: string,
): Promise<void> {
  try {
    const { blockHeight, protocolVersion } = await client.status();
    const view = await client.karmaView(cfg.publicKeyHex);
    if (view.effective - cfg.bondAmount < KARMA_MINIMUM) {
      res.status(503).json({
        error: `insufficient karma: the view's effective ${view.effective}, less the bond ${cfg.bondAmount}, falls below ${KARMA_MINIMUM}`,
      });
      return;
    }
    const built = buildInviteTx(cfg, view.boxes, pubkey, blockHeight, protocolVersion);
    const { expiresAtHeight } = await client.submitInvite(built.tx);
    res.status(202).json({ txId: built.txId, status: 'pending', expiresAtHeight });
  } catch (err) {
    relay(res, err);
  }
}

async function handleCredit(
  cfg: FaucetConfig,
  client: NodeClient,
  res: express.Response,
  pubkey: string,
): Promise<void> {
  try {
    const { blockHeight, protocolVersion } = await client.status();
    const view = await client.creditView(cfg.publicKeyHex);
    const built = buildCreditTransferTx(cfg, view.boxes, pubkey, blockHeight, protocolVersion);
    // `buildCreditTransferTx` emits the payment at index 0 unconditionally,
    // so `built.payment` is non-null here (transfer.ts).
    if (built.payment === null) throw new Error('transfer built no payment output');
    const { expiresAtHeight } = await client.submitTransfer(built.tx);
    res.status(202).json({
      txId: built.txId,
      status: 'pending',
      expiresAtHeight,
      boxId: built.payment.boxId,
    });
  } catch (err) {
    relay(res, err);
  }
}

/**
 * NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
 * node's, never one dressed as the other" — the verdict is a `NodeError` the
 * client built where the node's answer was read, carrying the status to
 * answer; the service's own states carry theirs here.
 *
 * ⚠ **A drained faucet answers 503, not 400.** It draws down as it invites and
 * does not replenish, so exhaustion is a state of this service — a 400 would
 * tell the caller their request was wrong.
 */
function relay(res: express.Response, err: unknown): void {
  if (err instanceof NodeError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof InsufficientFundsError) {
    res.status(503).json({ error: err.message });
    return;
  }
  if (err instanceof BadRequestError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // `express.json()` rejects a body it cannot parse with a 4xx of its own; the
  // service relays that status with its own error text.
  if (
    typeof err === 'object'
    && err !== null
    && typeof (err as { status?: unknown }).status === 'number'
    && (err as { status: number }).status >= 400
    && (err as { status: number }).status < 500
  ) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'bad request body' });
    return;
  }
  // A fault of the service's own: the error text is not relayed; the error
  // itself is logged server-side.
  console.error('faucet request failed', err);
  res.status(500).json({ error: 'faucet request failed' });
}
