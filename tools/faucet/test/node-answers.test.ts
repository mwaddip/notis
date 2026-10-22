// NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
// node's, never one dressed as the other." Each case below drives the service
// through supertest and names the status it must answer when the node fails,
// times out, or hands back something that is not its route's.
//
// NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
// one request at a time per endpoint." A request reads /status, then the
// faucet identity's listing of the ledger it spends, then submits — so a case
// stubs the routes it reaches.

import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { HttpNodeClient } from '../src/node-client.js';
import type { HttpFetch } from '../src/node-client.js';
import { baseCfg, K1, C1, pubHex, recipient } from './fixture.js';

const cfg = { ...baseCfg, bondAmount: 250n, creditAmount: 1n, rateLimitPerHour: 5 };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const okStatus = (): Response =>
  json(200, { networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 0 });

const okKarma = (): Response =>
  json(200, { boxes: [{ boxId: K1, value: '1000' }] });

const okCredits = (): Response =>
  json(200, { boxes: [{ boxId: C1, value: '1000' }] });

// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from its
// own fields": each route is held to the shape of its answer. The router here
// stands in for the node's HTTP surface, one entry per path.
type Handler = (init?: RequestInit) => Response | Promise<Response>;

const router = (handlers: Record<string, Handler>): HttpFetch =>
  async (url, init) => {
    const path = new URL(url).pathname;
    // Longest prefix first — `/credits/transfer` takes its own handler before
    // `/credits` would match it as the credit listing.
    const prefixes = Object.keys(handlers).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(`${prefix}/`)) return handlers[prefix]!(init);
    }
    throw new Error(`no handler for ${url}`);
  };

const appWith = (fetchStub: HttpFetch) =>
  createApp(cfg, new HttpNodeClient('http://node', fetchStub));

// WEB_INTERFACE → Reading a node's answer → "A failure the deadline ended says
// so": a case that drives the deadline runs the real fetch against a local
// server that accepts and never writes, under a short AbortSignal of its own
// in place of the one it is handed.
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function listenNeverWrites(): Promise<string> {
  const server = createServer(() => { /* accepts, never writes */ });
  server.on('connection', (s) => sockets.push(s));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
// node's, never one dressed as the other" — a 5xx of the node's answers 502.
describe('a failed node answers 502, a node that did not answer 504', () => {
  it('the node answers /status with 500 — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => json(500, { error: 'database down' }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.body.error).toContain('database down');
    expect(res.status).toBe(502);
  });

  it('the node answers /invites with 503 — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => okKarma(),
      '/invites': () => json(503, { error: 'mempool full' }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.body.error).toContain('mempool full');
    expect(res.status).toBe(502);
  });

  // WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
  // its own fields" — a karma box value is a canonical decimal in [0, 2^63);
  // "x" is not, and the listing is not its route's.
  it('the karma listing carries a box whose value is "x" — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => json(200, { boxes: [{ boxId: K1, value: 'x' }] }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(502);
  });

  // NIPOPOW_INTERFACE → compareProofs — one dead or hostile peer is a non-ok,
  // not fatal; a transport failure that is not the deadline's reads as 502.
  it('the credit listing fetch rejects with a transport failure — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/credits': () => { throw new TypeError('fetch failed'); },
    }));
    const res = await request(app).post('/faucet/credits').send({ pubkey: recipient });
    expect(res.status).toBe(502);
  });

  // WEB_INTERFACE → Reading a node's answer → "A failure the deadline ended
  // says so" — the deadline-ended failure answers 504, every other failure 502.
  it('the deadline ends the /status call — the faucet answers 504', async () => {
    const base = await listenNeverWrites();
    const underShortDeadline: HttpFetch = (url) => fetch(url, { signal: AbortSignal.timeout(100) });
    const app = createApp(cfg, new HttpNodeClient(base, underShortDeadline));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(504);
  });

  // CONSTANTS → Client reads — a write answer one byte over
  // `WRITE_ANSWER_READ_BYTES` reads as a body that will not parse: no honest
  // node sends one, so the answer is not its route's.
  it('a /credits/transfer 200 padded past the write cap — the faucet answers 502', async () => {
    const padding = 'p'.repeat(1200);
    const app = appWith(router({
      '/status': () => okStatus(),
      '/credits': () => okCredits(),
      '/credits/transfer': () => json(200, { status: 'pending', txId: 'ee'.repeat(32), expiresAtHeight: 921, padding }),
    }));
    const res = await request(app).post('/faucet/credits').send({ pubkey: recipient });
    expect(res.status).toBe(502);
  });

  // WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
  // its own fields" — `expiresAtHeight` is a non-negative safe integer; -1 is
  // not, and the answer is not its route's.
  it('/invites answers 201 with expiresAtHeight: -1 — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => okKarma(),
      '/invites': () => json(201, { status: 'pending', txId: 'cc'.repeat(32), expiresAtHeight: -1 }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(502);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two
  // karma boxes" — one unmarked and one marked, so a listing with two unmarked
  // is not its route's.
  it('the karma listing carries two unmarked boxes — the faucet answers 502', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => json(200, {
        boxes: [
          { boxId: K1, value: '1000' },
          { boxId: 'bb'.repeat(32), value: '500' },
        ],
      }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(502);
  });
});

// NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
// node's, never one dressed as the other" — a refusal of the node's is relayed
// with the node's status and message.
describe('the node 4xx is relayed with its status and message', () => {
  it('/invites answers 409 with a reason — the faucet answers 409 and names it', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => okKarma(),
      '/invites': () => json(409, { error: 409, reason: 'A pending invite already names this key' }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A pending invite already names this key');
  });

  it('/invites answers 400 with an error — the faucet answers 400 and names it', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => okKarma(),
      '/invites': () => json(400, { error: 'An invite may not name an existing account' }),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('An invite may not name an existing account');
  });

  // NODE_INTERFACE → Faucet — "the faucet's own key" is a malformed request,
  // which answers 400 before any node call reaches a surface.
  it('a pubkey that is the faucet own key — the faucet answers 400', async () => {
    const app = appWith(router({
      '/status': () => okStatus(),
      '/karma': () => okKarma(),
    }));
    const res = await request(app).post('/faucet/karma').send({ pubkey: pubHex });
    expect(res.status).toBe(400);
  });
});
