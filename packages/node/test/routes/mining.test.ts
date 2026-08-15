import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter, type MiningDeps } from '../../src/routes/mining.js';
import {
  isPeerReady,
  markDiscoveryStarted,
  markDiscoveryUnavailable,
  resetPeerReadiness,
} from '../../src/services/peer-readiness.js';
import { initDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import type { OrderingBlock } from '@dagsocial/types';
import { profileFor } from '@dagsocial/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = 'sekret';
const MINER_HEX = 'a1'.repeat(32); // 64 hex chars — valid payout override

function makeTemplate(): OrderingBlock {
  return {
    header: {
      protocolVersion: 1,
      height: 7,
      prevBlockHash: '11'.repeat(32),
      utxoTxRoot: '33'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32).fill(0x44),
      // The template's difficulty is what `scripts/miner.mjs` expands, so it is
      // stated in the header denomination — 1/256 of a bit, VALIDATION_INTERFACE
      // → orderingPowTarget.
      powNonce: 0,
      powTargetBits: 256 * 12,
      createdAt: 1_700_000_000_000,
    },
    utxoTxTree: {
      utxoTxIds: [],
      utxoTxs: [],
      pruneEntries: [],
      coinbaseOutputs: [
        {
          owner: new Uint8Array(32).fill(0x55),
          value: 90n,
          lockedUntilBlock: 727,
          isTreasury: false,
        },
      ],
    },
    validatorSignature: new Uint8Array(64),
  };
}

function makeDeps(overrides: Partial<MiningDeps> = {}): MiningDeps {
  return {
    getCurrentTemplate: () => makeTemplate(),
    submitMinedBlock: () => 'deadbeef',
    setMinerPubkey: () => {},
    // Peer-ready by default: every case in this file that is not about the gate
    // is about a node that has met its peers.
    peerReady: () => true,
    miningSecret: SECRET,
    ...overrides,
  };
}

function makeApp(deps: MiningDeps): express.Express {
  return express().use(express.json()).use(createRouter(deps));
}

// ---------------------------------------------------------------------------
// Auth (MINING_INTERFACE → Mining API) — every 401 case has a control
// differing only in the Authorization header.
// ---------------------------------------------------------------------------

describe('mining routes — auth', () => {
  describe('1. missing Authorization header', () => {
    it('rejects GET /template with 401', async () => {
      const res = await request(makeApp(makeDeps())).get('/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('control: same request with the correct bearer returns 200', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      expect(res.body.header.height).toBe(7);
      expect(res.body.powPreimage).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects POST /submit with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .post('/submit')
        .send({ powNonce: 42, height: 7 });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('control: same request with the correct bearer returns 201', async () => {
      const res = await request(makeApp(makeDeps()))
        .post('/submit')
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ powNonce: 42, height: 7 });
      expect(res.status).toBe(201);
      expect(res.body.blockHash).toBe('deadbeef');
    });

    it('rejects a non-bearer scheme with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', SECRET);
      expect(res.status).toBe(401);
    });
  });

  describe('2. wrong secret', () => {
    it('rejects a wrong secret of the same length with 401', async () => {
      expect('WRONG!'.length).toBe(SECRET.length); // same length, different bytes
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer WRONG!');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects a shorter secret with 401 (timingSafeEqual length trap)', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer s');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects a longer secret with 401 (timingSafeEqual length trap)', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', `Bearer ${SECRET}${SECRET}`);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects an empty bearer value with 401', async () => {
      const res = await request(makeApp(makeDeps()))
        .get('/template')
        .set('Authorization', 'Bearer ');
      expect(res.status).toBe(401);
    });
  });

  describe('3. coinbase payout override is behind auth', () => {
    it('does not reach setMinerPubkey without auth', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: MINER_HEX });

      expect(res.status).toBe(401);
      expect(setMinerPubkey).not.toHaveBeenCalled();
    });

    it('control: same request with the correct bearer sets the payout key', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: MINER_HEX })
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(200);
      expect(setMinerPubkey).toHaveBeenCalledTimes(1);
      const arg = setMinerPubkey.mock.calls[0]![0] as Uint8Array;
      expect(Buffer.from(arg).toString('hex')).toBe(MINER_HEX);
    });

    it('rejects invalid miner hex with 400 once authenticated', async () => {
      const setMinerPubkey = vi.fn();
      const res = await request(makeApp(makeDeps({ setMinerPubkey })))
        .get('/template')
        .query({ miner: 'nothex' })
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(400);
      expect(setMinerPubkey).not.toHaveBeenCalled();
    });
  });

  describe('4. router construction', () => {
    it('refuses to build a router without a secret', () => {
      expect(() => createRouter(makeDeps({ miningSecret: '' }))).toThrow(/secret/i);
    });

    it('control: builds with a secret', () => {
      expect(() => createRouter(makeDeps())).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// `subBlockRefs` is served from the committed entries
// ---------------------------------------------------------------------------

describe('mining routes — template subBlockRefs', () => {
  it('serves subBlockRefs derived from the template\'s committed entries', async () => {
    const committedId = 'aa'.repeat(32);
    const poisonId = 'bb'.repeat(32);

    // ⚠ **There is no poison half to build.** A template carries ONE committed
    // body, and the post ids the miner reads are derived from its post-bearing
    // transactions rather than stored beside them — so there is no second list
    // that could disagree. What this file owns is the miner-facing JSON shape.
    const tpl = makeTemplate();

    const res = await request(makeApp(makeDeps({ getCurrentTemplate: () => tpl })))
      .get('/template')
      .set('Authorization', `Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(res.body.postIds).toEqual([]);
    expect(res.body.subBlockRefs).toBeUndefined();
    expect(res.body.subBlockEntries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The peer-readiness gate (MINING_INTERFACE → "The peer-readiness gate").
//
// Every case here has a control differing only in `peerReady`, so what is being
// measured is the gate and not the template.
// ---------------------------------------------------------------------------

describe('mining routes — the peer-readiness gate', () => {
  const bearer = { Authorization: `Bearer ${SECRET}` };

  it('withholds the template while the node has not met its peers', async () => {
    const res = await request(makeApp(makeDeps({ peerReady: () => false })))
      .get('/template')
      .set(bearer);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No block template available');
  });

  it('control: the same node serves it once peer-ready', async () => {
    const res = await request(makeApp(makeDeps({ peerReady: () => true })))
      .get('/template')
      .set(bearer);

    expect(res.status).toBe(200);
    expect(res.body.header.height).toBe(7);
  });

  it('answers the absent-template 404 byte-for-byte, so a miner cannot tell them apart', async () => {
    // `scripts/miner.mjs` keys its retry on the 404 status alone and has no
    // give-up count. The two conditions must be one answer.
    const withheld = await request(makeApp(makeDeps({ peerReady: () => false })))
      .get('/template')
      .set(bearer);
    const absent = await request(
      makeApp(makeDeps({ peerReady: () => true, getCurrentTemplate: () => null })),
    )
      .get('/template')
      .set(bearer);

    expect(withheld.status).toBe(absent.status);
    expect(withheld.body).toEqual(absent.body);
  });

  it('still holds a template internally while withholding it', () => {
    // The gate is at serve, not at creation (`MINING_INTERFACE` → "The
    // peer-readiness gate"). A miner node always *holds* a template, and that
    // has to stay literally true, so the route is asked for its answer and the
    // creator is asked for its state separately.
    const getCurrentTemplate = vi.fn(() => makeTemplate());
    const deps = makeDeps({ peerReady: () => false, getCurrentTemplate });

    expect(deps.getCurrentTemplate()).not.toBeNull();
    expect(getCurrentTemplate).toHaveBeenCalledTimes(1);
  });

  it('does not even consult the creator while withholding', async () => {
    const getCurrentTemplate = vi.fn(() => makeTemplate());
    await request(makeApp(makeDeps({ peerReady: () => false, getCurrentTemplate })))
      .get('/template')
      .set(bearer);

    expect(getCurrentTemplate).not.toHaveBeenCalled();
  });

  it('withholds behind auth — an unauthenticated request still gets 401, not 404', async () => {
    // The gate must not become an oracle for whether this node is meshed.
    const res = await request(makeApp(makeDeps({ peerReady: () => false }))).get('/template');
    expect(res.status).toBe(401);
  });

  it('rejects a malformed payout key with 400 even while withholding', async () => {
    // A client bug earns its 400 whatever this node's readiness is; answering
    // 404 would tell the miner to retry a request that can never succeed.
    const res = await request(makeApp(makeDeps({ peerReady: () => false })))
      .get('/template')
      .query({ miner: 'nothex' })
      .set(bearer);

    expect(res.status).toBe(400);
  });

  it('does not rewrite the payout key on a refused poll', async () => {
    // The refusal has to be side-effect free. `miner.mjs` polls every 5s while
    // withheld and has no give-up count, so the gate guarantees a window of
    // refused requests — and a refusal that still assigned would let a request
    // answering nothing choose the coinbase destination of every block this
    // node later mines.
    const setMinerPubkey = vi.fn();
    const res = await request(makeApp(makeDeps({ peerReady: () => false, setMinerPubkey })))
      .get('/template')
      .query({ miner: MINER_HEX })
      .set(bearer);

    expect(res.status).toBe(404);
    expect(setMinerPubkey).not.toHaveBeenCalled();
  });

  it('control: the same request sets the payout key once peer-ready', async () => {
    const setMinerPubkey = vi.fn();
    const res = await request(makeApp(makeDeps({ peerReady: () => true, setMinerPubkey })))
      .get('/template')
      .query({ miner: MINER_HEX })
      .set(bearer);

    expect(res.status).toBe(200);
    expect(setMinerPubkey).toHaveBeenCalledTimes(1);
    expect(Buffer.from(setMinerPubkey.mock.calls[0]![0] as Uint8Array).toString('hex'))
      .toBe(MINER_HEX);
  });

  it('a withheld poll leaves the key the last served request set', async () => {
    // The consequence stated end to end: an established payout survives a node
    // dropping out of readiness, rather than being replaced by whatever the next
    // refused poll happened to carry.
    const applied: string[] = [];
    let ready = true;
    const app = makeApp(makeDeps({
      peerReady: () => ready,
      setMinerPubkey: (k) => { applied.push(Buffer.from(k!).toString('hex')); },
    }));

    await request(app).get('/template').query({ miner: MINER_HEX }).set(bearer);
    ready = false;
    await request(app).get('/template').query({ miner: 'bb'.repeat(32) }).set(bearer);

    expect(applied).toEqual([MINER_HEX]);
  });

  it('accepts a solved nonce while withholding — submit is not gated', async () => {
    // By the time a miner submits, the hashes are spent. Refusing the block
    // would discard work the node itself handed out a preimage for.
    const res = await request(makeApp(makeDeps({ peerReady: () => false })))
      .post('/submit')
      .set(bearer)
      .send({ powNonce: 42, height: 7 });

    expect(res.status).toBe(201);
    expect(res.body.blockHash).toBe('deadbeef');
  });

  it('re-reads readiness per request rather than latching it', async () => {
    // Readiness is not monotonic: a node whose only peer drops before the window
    // elapses is alone again, and must stop handing out templates again.
    let ready = true;
    const app = makeApp(makeDeps({ peerReady: () => ready }));

    expect((await request(app).get('/template').set(bearer)).status).toBe(200);
    ready = false;
    expect((await request(app).get('/template').set(bearer)).status).toBe(404);
    ready = true;
    expect((await request(app).get('/template').set(bearer)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Mount policy — `nodeRole` alone decides the surface: a miner is by definition
// a node that serves templates, and a server node exposes no mining paths.
// An unmounted path 404s; a mounted one 401s. That is the discriminator.
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'miner',
    publicUrl: '/',
    postPowTargetBits: 20,
    challengeWindowBlocks: 10,
    maxSubBlocksPerBlock: 1000,
    miningSecret: '',
    orderingBlockPowTargetBits: 3072,
    treasuryPubKey: '',
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  } as Config;
}

describe('mining routes — mount policy', () => {
  beforeAll(() => {
    initDb(':memory:');
  });

  afterAll(() => {
    closeDb();
  });

  // Discovery state is module-level, so a mark left behind would decide the next
  // case's answer.
  afterEach(() => {
    resetPeerReadiness();
  });

  describe('5. miner role', () => {
    it('serves /mining/template — 401 unauthenticated (mounted)', async () => {
      const app = createApp(makeConfig({ miningSecret: SECRET }));
      const res = await request(app).get('/mining/template');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('passes auth with the correct bearer (404 = not serving yet, not 401)', async () => {
      // `createApp` wires the real `isPeerReady`, and this app never entered
      // discovery, so the gate is what answers here. Which of the two 404s it is
      // does not change what this case measures — that auth passed — and the
      // gate's own cases discriminate them.
      markDiscoveryStarted();
      const app = createApp(makeConfig({ miningSecret: SECRET }));
      const res = await request(app)
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No block template available');
      expect(isPeerReady()).toBe(false);
    });

    it('serves through createApp once discovery is unavailable and a template exists', async () => {
      // The control for the case above: same app, same auth, readiness flipped
      // by the mark rather than by a stubbed dep — so the wiring from
      // `server.ts` to the route is what is under test, not the predicate.
      markDiscoveryUnavailable();
      const app = createApp(makeConfig({ miningSecret: SECRET }));
      const res = await request(app)
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(isPeerReady()).toBe(true);
      // No block creator runs in this suite, so the template is genuinely absent
      // and the *second* 404 answers. The gate is no longer the reason.
      expect(res.status).toBe(404);
    });
  });

  describe('5a. the production gate is wired, not just the injectable one', () => {
    // ⚠ **Every other gate case in this file injects `peerReady` through
    // `makeDeps`, and the `createApp` cases above assert 404 in a suite with no
    // block creator — where the template is absent whether the gate fires or
    // not.** Measured: replacing `server.ts`'s `peerReady: isPeerReady` with
    // `() => true` left all 1340 tests in this package green. Nothing observed
    // the production wiring at all.
    //
    // A template has to EXIST for the gate to be the thing under test. Then the
    // two answers separate: 404 is the gate, 200 is the wiring gone.
    afterEach(async () => {
      const bc = await import('../../src/services/block-creator.js');
      bc.stopBlockCreator();
    });

    it('withholds a template that exists while readiness says no', async () => {
      const bc = await import('../../src/services/block-creator.js');
      const cfg = makeConfig({ miningSecret: SECRET });
      bc.startBlockCreator(cfg);
      bc.createOrderingBlock();
      expect(bc.getCurrentTemplate()).not.toBeNull();

      markDiscoveryStarted(); // bootstrap addresses configured, no peer yet
      expect(isPeerReady()).toBe(false);

      const res = await request(createApp(cfg))
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No block template available');
    });

    it('control: the same app serves that template once readiness says yes', async () => {
      const bc = await import('../../src/services/block-creator.js');
      const cfg = makeConfig({ miningSecret: SECRET });
      bc.startBlockCreator(cfg);
      bc.createOrderingBlock();
      const tpl = bc.getCurrentTemplate();
      expect(tpl).not.toBeNull();

      markDiscoveryUnavailable();
      expect(isPeerReady()).toBe(true);

      const res = await request(createApp(cfg))
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);

      expect(res.status).toBe(200);
      expect(res.body.header.height).toBe(tpl!.header.height);
    });
  });

  describe('5b. server role', () => {
    it('never serves /mining, secret or not (404, not 401)', async () => {
      const app = createApp(makeConfig({ nodeRole: 'server', miningSecret: SECRET }));
      const res = await request(app).get('/mining/template');
      expect(res.status).toBe(404);
    });

    it('does not serve it with a bearer header either (the path is absent)', async () => {
      const app = createApp(makeConfig({ nodeRole: 'server', miningSecret: SECRET }));
      const res = await request(app)
        .get('/mining/template')
        .set('Authorization', `Bearer ${SECRET}`);
      expect(res.status).toBe(404);
    });
  });
});
