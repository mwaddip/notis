import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRouter, type MiningDeps } from '../../src/routes/mining.js';
import type { OrderingBlock } from '@dagsocial/types';

// MINING_INTERFACE → The window gate — the template route answers 404 while
// `appliedTip ≥ S + maxReorgDepth`, beside the peer-readiness gate, behind the
// `?miner=` validation.

const SECRET = 'sekret';

function makeTemplate(): OrderingBlock {
  return {
    header: {
      protocolVersion: 1,
      height: 7,
      prevBlockHash: '11'.repeat(32),
      utxoTxRoot: '33'.repeat(32),
      stateRoot: '00'.repeat(33),
      validatorId: new Uint8Array(32).fill(0x44),
      powNonce: 0,
      powTargetBits: 256 * 12,
      createdAt: 1_700_000_000_000,
      interlinkRoot: '00'.repeat(32),
      adProofsRoot: '66'.repeat(32),
    },
    utxoTxTree: {
      utxoTxIds: ['55'.repeat(32)],
      utxoTxs: [new Uint8Array(96).fill(0x55)],
    },
    validatorSignature: new Uint8Array(64),
  };
}

function makeDeps(overrides: Partial<MiningDeps> = {}): MiningDeps {
  return {
    getCurrentTemplate: () => makeTemplate(),
    submitMinedBlock: () => 'deadbeef',
    setMinerPubkey: () => {},
    peerReady: () => true,
    windowOpen: () => true,
    miningSecret: SECRET,
    getUsername: () => null,
    ...overrides,
  };
}

function makeApp(deps: MiningDeps): express.Express {
  return express().use(express.json()).use(createRouter(deps));
}

describe('mining — the template window gate', () => {
  it('withholds the template with 404 while the window holds extension', async () => {
    const res = await request(makeApp(makeDeps({ windowOpen: () => false })))
      .get('/template')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No block template available');
  });

  it('control: the same request with the window open returns 200', async () => {
    const res = await request(makeApp(makeDeps({ windowOpen: () => true })))
      .get('/template')
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body.header.height).toBe(7);
  });

  it('the window gate sits behind the ?miner= validation (a malformed key earns 400)', async () => {
    const res = await request(makeApp(makeDeps({ windowOpen: () => false })))
      .get('/template')
      .query({ miner: 'nothex' })
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(400);
  });

  it('the window gate withholds before setMinerPubkey writes the override', async () => {
    // The ordering is load-bearing: a 404 that still wrote the payout key
    // would let a refused request mutate the coinbase destination for every
    // block mined later.
    const calls: Uint8Array[] = [];
    const res = await request(makeApp(makeDeps({
      windowOpen: () => false,
      setMinerPubkey: (k) => { if (k) calls.push(k); },
    })))
      .get('/template')
      .query({ miner: 'a1'.repeat(32) })
      .set('Authorization', `Bearer ${SECRET}`);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
