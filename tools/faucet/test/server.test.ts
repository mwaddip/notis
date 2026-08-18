import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { NodeError } from '../src/node-client.js';
import type { NodeClient } from '../src/node-client.js';
import { C1, K1, baseCfg, pubHex, recipient } from './fixture.js';

const cfg = { ...baseCfg, creditAmount: 100n, rateLimitPerHour: 2 };
const other = 'bb'.repeat(32);

let submitted: Record<string, unknown>[];
let client: NodeClient;

beforeEach(() => {
  submitted = [];
  client = {
    karmaBoxes: async () => [{ boxId: K1, value: 1000n }],
    creditBoxes: async () => [{ boxId: C1, value: 1000n }],
    submitInvite: async (tx) => { submitted.push(tx); },
    submitTransfer: async (tx) => { submitted.push(tx); },
  };
});

const from = (ip: string) => ({ 'X-Forwarded-For': ip });

describe('POST /faucet/karma', () => {
  it('submits an invite and returns its txId', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(202);
    expect(res.body.txId).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.status).toBe('pending');
    expect(submitted).toHaveLength(1);
  });

  it('rejects a malformed pubkey without calling the node', async () => {
    const res = await request(createApp(cfg, client)).post('/faucet/karma').send({ pubkey: 'no' });
    expect(res.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it('accepts an uppercase pubkey, since the key is the same key', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').send({ pubkey: recipient.toUpperCase() });
    expect(res.status).toBe(202);
  });

  // ⛔ There is no grant ledger — the node's refusal IS the once-per-identity
  // record, so it must reach the caller intact rather than becoming a 500.
  it('relays the node status and message', async () => {
    client.submitInvite = async () => {
      throw new NodeError(400, 'An invite may not name an existing account');
    };
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('existing account');
  });

  // A drained faucet is the faucet's own state, not a bad request.
  it('answers 503 when it cannot cover the bond', async () => {
    client.karmaBoxes = async () => [{ boxId: K1, value: 10n }];
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/insufficient karma/);
  });

  it('refuses past the rate limit, per IP', async () => {
    const app = createApp(cfg, client);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('1.2.3.4'));
    }
    const capped = await request(app)
      .post('/faucet/karma').send({ pubkey: recipient }).set(from('1.2.3.4'));
    expect(capped.status).toBe(429);
    const elsewhere = await request(app)
      .post('/faucet/karma').send({ pubkey: recipient }).set(from('5.6.7.8'));
    expect(elsewhere.status).toBe(202);
  });

  // nginx terminates in front, so the socket address is the proxy for every
  // caller and only the first forwarded hop identifies the client.
  it('reads the first forwarded hop, not the whole chain', async () => {
    const app = createApp(cfg, client);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/faucet/karma').send({ pubkey: recipient })
        .set(from('9.9.9.9, 10.0.0.1'));
    }
    const capped = await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('9.9.9.9, 172.16.0.9'));
    expect(capped.status).toBe(429);
  });

  // The chain is what makes two invites in one block interval both apply.
  it('spends the first transaction\'s change on the second call', async () => {
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('9.9.9.9'));
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('9.9.9.8'));
    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.inputs).not.toEqual([K1]);
    expect((submitted[0]!.outputs as Record<string, unknown>[])[0]!.value).toBe('750');
    expect((submitted[1]!.outputs as Record<string, unknown>[])[0]!.value).toBe('500');
  });

  // A refused submission means the tip is not what the node holds.
  it('drops the chain tip when the node refuses, and reselects the confirmed set', async () => {
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('7.7.7.1'));
    client.submitInvite = async () => { throw new NodeError(400, 'nope'); };
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('7.7.7.2'));
    client.submitInvite = async (tx) => { submitted.push(tx); };
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('7.7.7.3'));
    expect(submitted[1]!.inputs).toEqual([K1]);
  });
});

describe('POST /faucet/credits', () => {
  it('submits a transfer and returns its txId', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/credits').send({ pubkey: recipient });
    expect(res.status).toBe(202);
    expect(submitted).toHaveLength(1);
    const outputs = submitted[0]!.outputs as Record<string, unknown>[];
    expect(outputs[0]).toEqual({ boxType: 'credit', value: '100', owner: recipient });
  });

  // Separate limits: spending a credit allowance must not consume the invite one.
  it('limits the two endpoints independently', async () => {
    const app = createApp(cfg, client);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/faucet/credits').send({ pubkey: recipient }).set(from('4.4.4.4'));
    }
    const capped = await request(app)
      .post('/faucet/credits').send({ pubkey: recipient }).set(from('4.4.4.4'));
    expect(capped.status).toBe(429);
    const karma = await request(app)
      .post('/faucet/karma').send({ pubkey: recipient }).set(from('4.4.4.4'));
    expect(karma.status).toBe(202);
  });

  // Credits are repeatable, so the credit side is not chained: each call reads
  // the confirmed set again.
  it('does not chain, and reselects the confirmed box each call', async () => {
    const app = createApp(cfg, client);
    await request(app).post('/faucet/credits').send({ pubkey: recipient }).set(from('6.6.6.1'));
    await request(app).post('/faucet/credits').send({ pubkey: other }).set(from('6.6.6.2'));
    expect(submitted[0]!.inputs).toEqual([C1]);
    expect(submitted[1]!.inputs).toEqual([C1]);
  });

  it('refuses to address the faucet itself', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/credits').send({ pubkey: pubHex });
    expect(res.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });
});

describe('the surface', () => {
  it('serves nothing else', async () => {
    const app = createApp(cfg, client);
    expect((await request(app).get('/faucet/karma')).status).toBe(404);
    expect((await request(app).post('/')).status).toBe(404);
  });

  it('answers a body that is not JSON with a 400, not a crash', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').set('Content-Type', 'application/json').send('{oops');
    expect(res.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });
});
