// NODE_INTERFACE → Service Layer Architecture → "A transaction the pool
// already holds is answered as held": the deps `server.ts` wires for the post
// route — `getHeldEntry` and the feed's `getPendingUtxoTxBytesByTxId` — read
// through `createApp`. Both cases enter through the server the running node
// stands up.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { createApp } from '../../src/server.js';
import type { Config } from '../../src/config.js';
import { setNet } from '../../src/services/net-instance.js';
import {
  computeContentHash,
  encodeTx,
  MAX_BLOCK_BODY_BYTES,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  CandidateOf,
  KarmaBox,
  KarmaPriceBox,
  PostCommit,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  makeTestConfig,
  makeTestIdentity,
  seedBoxes,
  signTransaction,
  toHex,
  txToJson,
} from '../helpers.js';

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

async function postPosts(
  baseUrl: string,
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(baseUrl).port),
        path: '/posts/',
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

async function getPostById(
  baseUrl: string,
  id: string,
  query: string,
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(baseUrl).port),
        path: `/posts/${id}${query}`,
        method: 'GET',
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
    req.end();
  });
}

describe('the post route reads the pool through createApp', () => {
  let server: http.Server;
  let baseUrl: string;
  let broadcastTx: ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };
  let nextKarmaNonce = 500;

  async function freshAuthorWithKarma(value: bigint): Promise<{
    author: ReturnType<typeof makeTestIdentity>;
    karma: KarmaBox;
  }> {
    const author = makeTestIdentity();
    const { seedProvenance } = await import('../helpers.js');
    const karma = seedProvenance<KarmaBox>({
      boxType: 'karma',
      value,
      createdAtBlock: 0,
      owner: author.userId,
    }, 1, nextKarmaNonce++);
    await seedBoxes([karma]);
    return { author, karma };
  }

  function buildPostTx(
    author: ReturnType<typeof makeTestIdentity>,
    karma: KarmaBox,
    content: string,
  ): { tx: UtxoTransaction; txJson: Record<string, unknown> } {
    const contentHash = computeContentHash(content);
    const commit: PostCommit = {
      contentHash,
      author: author.userId,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: karma.value - POST_PRICE_THREAD, createdAtBlock: 0, owner: author.userId } as CandidateOf<KarmaBox>,
        { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: 0 } as CandidateOf<KarmaPriceBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: commit,
    };
    signTransaction(tx, author.privateKey, toHex(author.userId));
    const txJson = {
      ...txToJson(tx),
      post: {
        contentHash: Buffer.from(contentHash).toString('hex'),
        author: toHex(commit.author),
        parentRefs: commit.parentRefs,
        type: commit.type,
      },
    };
    return { tx, txJson };
  }

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    broadcastTx = vi.fn((_tx: UtxoTransaction) => Promise.resolve()) as unknown as typeof broadcastTx;
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

  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state": the second POST /posts' answer equals the
  // first's, under `server.ts`'s wiring of `getHeldEntry` to the post service.
  it('POST /posts twice through createApp', async () => {
    const { author, karma } = await freshAuthorWithKarma(POST_PRICE_THREAD * 4n);
    const content = 'through-create-app body';
    const { txJson } = buildPostTx(author, karma, content);

    const r1 = await postPosts(baseUrl, { tx: txJson, content });
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);

    const block = await makeApplicableBlock({ height: 1 });
    expect(await applyBlockThroughIntake(block)).toBe(true);

    const r2 = await postPosts(baseUrl, { tx: txJson, content });
    expect(r2.status).toBe(r1.status);
    expect(r2.data).toEqual(r1.data);
  });

  // NODE_INTERFACE → Posts → "The creating transaction rides a post row": a
  // pending post's `tx` is the pooled transaction's bytes, read through the
  // feed's `getPendingUtxoTxBytesByTxId` as `server.ts` wires it.
  it('GET /posts/:id?tx=1 answers a pending post\'s pooled bytes', async () => {
    const { author, karma } = await freshAuthorWithKarma(POST_PRICE_THREAD * 4n);
    const content = 'pending-bytes body';
    const { tx, txJson } = buildPostTx(author, karma, content);

    const r1 = await postPosts(baseUrl, { tx: txJson, content });
    expect(r1.status, JSON.stringify(r1.data)).toBe(200);
    const postId = (r1.data as { postId: string }).postId;

    const r = await getPostById(baseUrl, postId, '?tx=1');
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const answer = r.data as { tx?: string };
    expect(typeof answer.tx).toBe('string');
    const pooledBytes = Buffer.from(encodeTx(tx)).toString('hex');
    expect(answer.tx).toBe(pooledBytes);
  });
});
