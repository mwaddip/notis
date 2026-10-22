import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { computeCandidateBoxId } from '@dagsocial/types';
import type { AnyBoxCandidate } from '@dagsocial/types';
import { createApp } from '../src/server.js';
import { NodeError } from '../src/node-client.js';
import type { NodeClient } from '../src/node-client.js';
import { C1, ERA, K1, baseCfg, pubHex, recipient } from './fixture.js';

const cfg = { ...baseCfg, creditAmount: 100n, rateLimitPerHour: 2 };
const other = 'bb'.repeat(32);

let submitted: Record<string, unknown>[];
let client: NodeClient;

beforeEach(() => {
  submitted = [];
  client = {
    status: async () => ({ blockHeight: 100, protocolVersion: ERA }),
    karmaBoxes: async () => [{ boxId: K1, value: 1000n }],
    creditBoxes: async () => [{ boxId: C1, value: 1000n }],
    submitInvite: async (tx) => { submitted.push(tx); return { expiresAtHeight: 821 }; },
    submitTransfer: async (tx) => { submitted.push(tx); return { expiresAtHeight: 921 }; },
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
    expect(res.body.expiresAtHeight).toBe(821);
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

  // NODE_INTERFACE → Faucet → "Every other answer is the service's own or
  // the node's, never one dressed as the other." — a drained faucet answers
  // 503, which an invite reaches when the view's effective, less the bond,
  // stands below `KARMA_MINIMUM` (→ Karma transition rules → "Only a post
  // spends the floor").
  it('answers 503 when the view effective, less the bond, falls below the floor', async () => {
    client.karmaBoxes = async () => [{ boxId: K1, value: 10n }];
    const res = await request(createApp(cfg, client))
      .post('/faucet/karma').send({ pubkey: recipient });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/insufficient karma/);
  });

  // NODE_INTERFACE → Faucet: at exactly the bond, the view's effective less
  // the bond is zero, below the floor an invite leaves standing.
  it('answers 503 at exactly the bond, with no floor beside it', async () => {
    client.karmaBoxes = async () => [{ boxId: K1, value: cfg.bondAmount }];
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

  // A caller controls the leading X-Forwarded-For hops; nginx appends the one
  // that identifies it. Keying on that appended hop means rotating the leading
  // value cannot spend a key other than the caller's own.
  it('keys on the hop nginx appends, so a spoofed leading hop cannot dodge the cap', async () => {
    const app = createApp(cfg, client);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/faucet/karma').send({ pubkey: recipient })
        .set(from(`${i + 1}.${i + 1}.${i + 1}.${i + 1}, 10.0.0.1`));
    }
    const capped = await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('9.9.9.9, 10.0.0.1'));
    expect(capped.status).toBe(429);
  });

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint." — each call reads the view and
  // submits against it, so a shared stub answering the same view each read
  // yields two submissions with the same inputs.
  it.fails('builds each karma call on the view it reads', async () => {
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('9.9.9.9'));
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('9.9.9.8'));
    expect(submitted).toHaveLength(2);
    expect(submitted[0]!.inputs).toEqual([K1]);
    expect(submitted[1]!.inputs).toEqual([K1]);
    expect((submitted[0]!.outputs as Record<string, unknown>[])[0]!.value).toBe('750');
    expect((submitted[1]!.outputs as Record<string, unknown>[])[0]!.value).toBe('750');
  });

  // NODE_INTERFACE → Faucet → "The service keeps no record of its own
  // submissions": a request the node refuses leaves no trace, and the request
  // after it reads the view the stub answers at its own read.
  it('a refused karma call leaves the next one reading the view it reads', async () => {
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('7.7.7.1'));
    client.submitInvite = async () => { throw new NodeError(400, 'nope'); };
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('7.7.7.2'));
    client.submitInvite = async (tx) => { submitted.push(tx); return { expiresAtHeight: 821 }; };
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
    expect(outputs[0]).toEqual({ boxType: 'credit', value: '100', createdAtBlock: 100, owner: recipient });
  });

  // NODE_INTERFACE → Faucet: the 202 body carries `expiresAtHeight` — the
  // node's own mempool expiry, relayed from `POST /credits/transfer`'s answer —
  // and `boxId`, the payment output's id (TYPES_INTERFACE → BoxId), so a client
  // can recognise the grant among boxes the key already holds.
  it('relays expiresAtHeight and the payment boxId', async () => {
    const res = await request(createApp(cfg, client))
      .post('/faucet/credits').send({ pubkey: recipient });
    expect(res.status).toBe(202);
    expect(res.body.expiresAtHeight).toBe(921);
    expect(res.body.boxId).toMatch(/^[0-9a-f]{64}$/);
    // The boxId equals `computeCandidateBoxId` over outputs[0] of the
    // submitted transaction at index 0 with the built txId — derived from the
    // output that was signed, exactly as the transfer builder derives it.
    const submittedOut = (submitted[0]!.outputs as Record<string, unknown>[])[0]!;
    const paymentOut: AnyBoxCandidate = {
      boxType: submittedOut['boxType'] as 'credit',
      value: BigInt(submittedOut['value'] as string),
      createdAtBlock: submittedOut['createdAtBlock'] as number,
      owner: Buffer.from(submittedOut['owner'] as string, 'hex'),
    };
    const expected = computeCandidateBoxId(paymentOut, res.body.txId as string, 0);
    expect(res.body.boxId).toBe(expected);
  });

  // NODE_INTERFACE → Faucet: a node answer without a numeric expiresAtHeight
  // is refused as a 502 by the node client, and the server relays that.
  it('relays a 502 when the node answer carries no expiresAtHeight', async () => {
    client.submitTransfer = async () => {
      throw new NodeError(502, 'transfer response carried no expiresAtHeight');
    };
    const res = await request(createApp(cfg, client))
      .post('/faucet/credits').send({ pubkey: recipient });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/expiresAtHeight/);
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

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint." — the credit endpoint reads the
  // view the stub answers at each call; a shared stub answering the same view
  // yields two submissions with the same inputs.
  it('each credit call builds on the view the stub answers at its read', async () => {
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

describe('the era the faucet signs', () => {
  // WEB_INTERFACE → Invariants: the faucet signs the era the node reports. When
  // the node answers a different era, both endpoints stamp it into what they submit.
  it('stamps the protocolVersion the node reports on both endpoints', async () => {
    client.status = async () => ({ blockHeight: 100, protocolVersion: 2 });
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('8.8.8.1'));
    await request(app).post('/faucet/credits').send({ pubkey: recipient }).set(from('8.8.8.2'));
    expect(submitted).toHaveLength(2);
    expect(submitted[0]!.protocolVersion).toBe(2);
    expect(submitted[1]!.protocolVersion).toBe(2);
  });
});

// NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
// one request at a time per endpoint." The views below are the stub's answer
// to each listing read, with its order of calls recorded; a request builds on
// the view that answered its own read.
describe('builds on the view it reads, one request at a time per endpoint', () => {
  const K2 = '77'.repeat(32);
  const K3 = '88'.repeat(32);
  const C2 = '99'.repeat(32);

  // NODE_INTERFACE → Faucet → "The service keeps no record of its own
  // submissions": a request refused by the node leaves no trace, and the
  // request after it builds on the view the stub answers at its read.
  it.fails('a refusal between two grants leaves the request after it reading the view it reads', async () => {
    const views: readonly { readonly boxId: string; readonly value: bigint }[][] = [
      [{ boxId: K1, value: 1000n }],
      [{ boxId: K2, value: 900n }],
      [{ boxId: K3, value: 800n }],
    ];
    let karmaReads = 0;
    client.karmaBoxes = async () => views[karmaReads++]!;
    let refuseOnce = false;
    client.submitInvite = async (tx) => {
      if (refuseOnce) { refuseOnce = false; throw new NodeError(400, 'no'); }
      submitted.push(tx);
      return { expiresAtHeight: 821 };
    };
    const app = createApp(cfg, client);
    await request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('1.1.1.1'));
    refuseOnce = true;
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('1.1.1.2'));
    await request(app).post('/faucet/karma').send({ pubkey: other }).set(from('1.1.1.3'));
    // The request after the refused one builds on the view answering its own read.
    expect(submitted.at(-1)!.inputs).toEqual([K3]);
  });

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint" — the endpoint's next request waits for
  // the previous submission's answer; two karma calls arriving together are
  // served in arrival order, so only the first has read /status while its
  // submission is held.
  it.fails('two karma requests arrive together, the second reads /status after the first submits', async () => {
    const calls: string[] = [];
    let heldRelease: (() => void) | null = null;
    const held = new Promise<void>((r) => { heldRelease = r; });
    client.status = async () => { calls.push('status'); return { blockHeight: 100, protocolVersion: ERA }; };
    client.karmaBoxes = async () => [{ boxId: K1, value: 1000n }];
    let firstHeld = false;
    client.submitInvite = async (tx) => {
      submitted.push(tx);
      if (!firstHeld) { firstHeld = true; await held; }
      return { expiresAtHeight: 821 };
    };
    const app = createApp(cfg, client);
    const p1 = request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('2.2.2.1'))
      .then((r) => r);
    const p2 = request(app).post('/faucet/karma').send({ pubkey: other }).set(from('2.2.2.2'))
      .then((r) => r);
    // A control: 100 ms is long enough for both handlers to have run every
    // step they can up to the point the service's queue holds the second one.
    await new Promise((r) => setTimeout(r, 100));
    expect(firstHeld).toBe(true);
    const beforeRelease = calls.filter((c) => c === 'status').length;
    heldRelease!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(beforeRelease).toBe(1);
  });

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint." — the two endpoints spend different
  // ledgers and wait for each other in nothing, so a karma request held at the
  // node runs beside a credit request that answers to its end.
  it('a karma request held at the node does not block the credit endpoint', async () => {
    let heldRelease: (() => void) | null = null;
    const held = new Promise<void>((r) => { heldRelease = r; });
    const originalSubmitInvite = client.submitInvite;
    client.submitInvite = async (tx) => {
      await held;
      return originalSubmitInvite(tx);
    };
    const app = createApp(cfg, client);
    const karmaPending = request(app).post('/faucet/karma').send({ pubkey: recipient }).set(from('3.3.3.1'))
      .then((r) => r);
    const credit = await request(app).post('/faucet/credits').send({ pubkey: recipient }).set(from('3.3.3.2'));
    expect(credit.status).toBe(202);
    heldRelease!();
    const karma = await karmaPending;
    expect(karma.status).toBe(202);
  });

  // NODE_INTERFACE → Faucet → "The service builds on the node's pending view,
  // one request at a time per endpoint" — a second credit call reads the view
  // the stub answers after the first's submission, and uses that view's boxes.
  it('two credit requests in one block, the second reads the view that answers after the first submits', async () => {
    const views: readonly { readonly boxId: string; readonly value: bigint }[][] = [
      [{ boxId: C1, value: 1000n }],
      [{ boxId: C2, value: 500n }],
    ];
    let creditReads = 0;
    client.creditBoxes = async () => views[creditReads++]!;
    const app = createApp(cfg, client);
    const r1 = await request(app).post('/faucet/credits').send({ pubkey: recipient }).set(from('4.4.4.1'));
    const r2 = await request(app).post('/faucet/credits').send({ pubkey: other }).set(from('4.4.4.2'));
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect(submitted[0]!.inputs).toEqual([C1]);
    expect(submitted[1]!.inputs).toEqual([C2]);
  });

  // NODE_INTERFACE → Faucet → "The service keeps no record of its own
  // submissions": a restarted service reads what the node holds, so a fresh
  // app over the same stub builds on the stub's current view.
  it('a fresh app over the same stub builds on the view the stub answers', async () => {
    client.karmaBoxes = async () => [{ boxId: K2, value: 900n }];
    const first = createApp(cfg, client);
    const r1 = await request(first).post('/faucet/karma').send({ pubkey: recipient }).set(from('5.5.5.1'));
    expect(r1.status).toBe(202);
    const fresh = createApp(cfg, client);
    const r2 = await request(fresh).post('/faucet/karma').send({ pubkey: other }).set(from('5.5.5.2'));
    expect(r2.status).toBe(202);
    expect(submitted[0]!.inputs).toEqual([K2]);
    expect(submitted[1]!.inputs).toEqual([K2]);
  });

  // NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
  // node's, never one dressed as the other." — for an invite, 503 is one whose
  // `effective` under `pending=1`, less the bond, stands below `KARMA_MINIMUM`.
  it.fails('drained by effective: boxes cover the bond and the floor by face, effective falls below', async () => {
    const stub: NodeClient = {
      ...client,
      karmaBoxes: (async () => ({
        boxes: [{ boxId: K1, value: 1000n }],
        effective: cfg.bondAmount + 10n - 1n,
      })) as unknown as NodeClient['karmaBoxes'],
    };
    const res = await request(createApp(cfg, stub))
      .post('/faucet/karma').send({ pubkey: recipient }).set(from('6.6.6.1'));
    expect(submitted).toHaveLength(0);
    expect(res.status).toBe(503);
  });

  // NODE_INTERFACE → Faucet: at exactly `bond + KARMA_MINIMUM` of effective
  // the invite leaves the floor standing, so the request is admitted.
  it.fails('at bond plus KARMA_MINIMUM of effective the request is admitted', async () => {
    const stub: NodeClient = {
      ...client,
      karmaBoxes: (async () => ({
        boxes: [{ boxId: K1, value: 1000n }],
        effective: cfg.bondAmount + 10n,
      })) as unknown as NodeClient['karmaBoxes'],
    };
    const res = await request(createApp(cfg, stub))
      .post('/faucet/karma').send({ pubkey: recipient }).set(from('6.6.6.2'));
    expect(res.status).toBe(202);
  });

  // NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
  // node's, never one dressed as the other." — for a credit grant, 503 is one
  // whose first page of the pending view cannot cover it.
  it('drained credits: a credit view whose unlocked boxes cannot cover the grant', async () => {
    const credits = { ...cfg, creditAmount: 1000n };
    client.creditBoxes = async () => [{ boxId: C1, value: 100n }];
    const res = await request(createApp(credits, client))
      .post('/faucet/credits').send({ pubkey: recipient }).set(from('7.7.7.1'));
    expect(submitted).toHaveLength(0);
    expect(res.status).toBe(503);
  });

  // NODE_INTERFACE → Faucet → "Its rate limit is keyed on the caller's
  // address, an IPv6 caller's by its /64" — two spellings of one /64 share
  // one allowance; a separate /64 has its own; an IPv4 and its mapped form
  // share one.
  it.fails('the IPv6 /64 is the key, with mapped IPv4 and bare IPv4 sharing one', async () => {
    const limited = { ...cfg, rateLimitPerHour: 1 };
    const app = createApp(limited, client);
    expect((await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('2001:db8:1:2::1'))).status).toBe(202);
    expect((await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('2001:0db8:0001:0002:ffff::7'))).status).toBe(429);
    expect((await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('2001:db8:1:3::1'))).status).toBe(202);
    expect((await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('::ffff:9.9.9.9'))).status).toBe(202);
    expect((await request(app).post('/faucet/karma').send({ pubkey: recipient })
      .set(from('9.9.9.9'))).status).toBe(429);
  });
});
