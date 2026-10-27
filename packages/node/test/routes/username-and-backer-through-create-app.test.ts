// NODE_INTERFACE → Service Layer Architecture → "One function admits": the
// deps `server.ts` wires for `/usernames` and `/backers/unstake` run through
// the app `createApp` builds. One case per write admits a valid transaction
// and reads the pooled entry under its id.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { KeyObject } from 'crypto';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { setNet } from '../../src/services/net-instance.js';
import {
  computeTxId,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  BackerStakeBox,
  CandidateOf,
  KarmaBox,
  UsernameBox,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  liveProver,
  makeTestConfig,
  makeTestIdentity,
  seedBoxes,
  seedProvenance,
  signTransaction,
  toHex,
  txToJson,
} from '../helpers.js';
import { getHeldEntry } from '../../src/store/mempool.js';

function makeConfig(overrides?: Partial<Config>): Config {
  return makeTestConfig({
    port: 0,
    dbPath: ':memory:',
    networkType: 'testnet',
    profile: profileFor('testnet'),
    nodeRole: 'server',
    blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
    orderingBlockPowTargetBits: 3072,
    bootstrapPeers: [],
    listenAddrs: '/ip4/127.0.0.1/tcp/0',
    maxPeers: 50,
    ...overrides,
  });
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(baseUrl).port),
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) }); }
          catch { resolve({ status: res.statusCode ?? 0, data: d }); }
        });
      },
    );
    req.write(payload);
    req.end();
  });
}

describe('the username and backer routes read through createApp', () => {
  let server: ReturnType<typeof http.createServer>;
  let baseUrl: string;
  let nextNonce = 7000;

  async function freshKarmaForOwner(owner: Uint8Array, value: bigint): Promise<KarmaBox> {
    const karma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner,
    }, 1, nextNonce++);
    await seedBoxes([karma]);
    return karma;
  }

  async function freshBackerStake(owner: Uint8Array, weight: bigint): Promise<BackerStakeBox> {
    const stake = seedProvenance<BackerStakeBox>({
      boxType: 'backer_stake',
      value: 0n as 0n,
      createdAtBlock: 0,
      owner,
      weight,
    }, 1, nextNonce++);
    await seedBoxes([stake]);
    return stake;
  }

  function signAs(tx: UtxoTransaction, priv: KeyObject, owner: Uint8Array): void {
    signTransaction(tx, priv, toHex(owner));
  }

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const broadcastTx = vi.fn(() => Promise.resolve());
    const netStub = {
      penalizePeer: () => {},
      chainMoved: () => {},
      needHeaders: () => {},
      broadcastOrderingBlock: async () => {},
      broadcastTx,
      getConnectedPeers: () => [],
      tipApplied: () => {},
      setKarmaMembers: () => {},
      addKarmaMember: () => {},
      removeKarmaMember: () => {},
      requestPostBodies: async () => [],
    };
    setNet(netStub as unknown as Parameters<typeof setNet>[0]);

    await liveProver();

    const app = createApp(makeConfig());
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    setNet(null as unknown as Parameters<typeof setNet>[0]);
    closeDb();
  });

  // NODE_INTERFACE → Usernames: a claim with a `username` output and the
  // claimant's karma spent to a change box; the pool holds the admitted
  // transaction under the id its route computed.
  it('POST /usernames admits a valid claim through createApp and the pool holds it under its id', async () => {
    const claimant = makeTestIdentity();
    const karma = await freshKarmaForOwner(claimant.userId, 100n);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value, createdAtBlock: 1, owner: claimant.userId } as CandidateOf<KarmaBox>,
        {
          boxType: 'username',
          value: 0n,
          createdAtBlock: 1,
          owner: claimant.userId,
          name: Buffer.from('CreateAppClaim', 'utf8'),
        } as unknown as CandidateOf<UsernameBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signAs(tx, claimant.privateKey, claimant.userId);
    const admittedId = computeTxId(tx);

    const res = await postJson(baseUrl, '/usernames/', { tx: txToJson(tx) });

    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect((res.data as { status: string }).status).toBe('pending');
    expect((res.data as { txId: string }).txId).toBe(admittedId);
    const held = getHeldEntry(admittedId);
    expect(held).not.toBeNull();
  });

  // NODE_INTERFACE → Backers: an unstake splits a `backer_stake` into one
  // smaller stake and one `backer_unstake` marker; the pool holds the admitted
  // transaction under the id its route computed.
  it('POST /backers/unstake admits a valid unstake through createApp and the pool holds it under its id', async () => {
    const holder = makeTestIdentity();
    const stake = await freshBackerStake(holder.userId, 100n);
    const tx: UtxoTransaction = {
      inputs: [stake.id!],
      outputs: [
        {
          boxType: 'backer_stake',
          value: 0n,
          createdAtBlock: 1,
          owner: holder.userId,
          weight: 60n,
        } as unknown as CandidateOf<BackerStakeBox>,
        {
          boxType: 'backer_unstake',
          value: 0n,
          createdAtBlock: 1,
          owner: holder.userId,
          weight: 40n,
        } as unknown as CandidateOf<BackerStakeBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signAs(tx, holder.privateKey, holder.userId);
    const admittedId = computeTxId(tx);

    const res = await postJson(baseUrl, '/backers/unstake', { tx: txToJson(tx) });

    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect((res.data as { status: string }).status).toBe('pending');
    expect((res.data as { txId: string }).txId).toBe(admittedId);
    const held = getHeldEntry(admittedId);
    expect(held).not.toBeNull();
  });
});
