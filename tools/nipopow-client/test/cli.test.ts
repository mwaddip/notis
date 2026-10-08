import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  PROTOCOL_VERSION,
  bytesToHex,
  computeContentHash,
  computePostId,
  computeTxId,
  encodeTx,
} from '@dagsocial/types';
import type { PostCommit, UtxoTransaction } from '@dagsocial/types';
import { runCli, toJson } from '../src/cli.js';
import type { Config } from '../src/config.js';
import type { HttpFetch } from '../src/http.js';
import {
  buildHoldingsFixture,
  buildMinedChain,
  clockAfterChain,
  createFakeNode,
  devnetProfile,
  hexToBytes,
  identityProofKeyHex,
  jsonResponse,
  karmaBoxFor,
  rangeAnswerFromProver,
  singleKeyAnswerFromProver,
  suffixHeadForChain,
} from './helpers.js';
import type { HoldingKind } from '@dagsocial/consensus';
import type { IdentityRecord, UserId } from '@dagsocial/types';

const M = 6;
const K = 6;
const CHAIN_LEN = M + K + 10;
const FAKE_USER = 'ab'.repeat(32);
const FAKE_USER_BYTES = hexToBytes(FAKE_USER) as UserId;
const RECORD_KEY_HEX = identityProofKeyHex(FAKE_USER_BYTES);

const RECORD_STANDING: IdentityRecord = {
  lastActivityBlock: 5,
  lastDecayBlock: 5,
  invitedAtBlock: 1,
  lifetimeLikesReceived: 0n,
  memberSinceBlock: 0,
  memberBar: 0,
  memberVouches: 0,
  memberLikes: 0n,
  invitesUsed: 0,
};

describe("the command line's composition — runCli + toJson", () => {
  it('a proven flow: the --json object carries the figures the command line writes', async () => {
    // One karma box held in both heights' states, under the chain's stateRoot.
    const karma = karmaBoxFor(FAKE_USER_BYTES, 100n, 1);
    const fixture = buildHoldingsFixture({
      boxes: [karma],
      records: [{ identityId: FAKE_USER_BYTES, record: RECORD_STANDING }],
    });
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: fixture.stateRoot });
    const suffixHead = suffixHeadForChain(chain, M, K);
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    function figureFetch(nodeUrl: string, base: HttpFetch): HttpFetch {
      return async (url: string): Promise<Response> => {
        const u = new URL(url);
        if (u.origin !== new URL(nodeUrl).origin) return base(url);
        if (u.pathname === `/karma/${FAKE_USER}`) {
          return jsonResponse(200, {
            userId: FAKE_USER, total: '100', effective: '100',
            boxes: [{ boxId: karma.id!, value: '100' }],
            next: null, height: chain.headers.length,
          });
        }
        if (u.pathname === `/credits/${FAKE_USER}`) {
          return jsonResponse(200, {
            userId: FAKE_USER, total: '0', boxes: [], next: null,
          });
        }
        const rangeMatch = u.pathname.match(/^\/api\/v1\/range\/([a-z]+)\/[0-9a-f]{64}$/);
        if (rangeMatch) {
          const kind = rangeMatch[1] as HoldingKind;
          const atHeight = Number(u.searchParams.get('atHeight'));
          const fromHex = u.searchParams.get('from');
          const from = fromHex === null ? null : hexToBytes(fromHex);
          const limit = Number(u.searchParams.get('limit') ?? '256');
          return jsonResponse(200, rangeAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, kind, FAKE_USER_BYTES, from, limit));
        }
        if (u.pathname === `/api/v1/proof/${RECORD_KEY_HEX}`) {
          const atHeight = Number(u.searchParams.get('atHeight'));
          return jsonResponse(200, singleKeyAnswerFromProver(fixture.prover, fixture.stateRoot, atHeight, hexToBytes(RECORD_KEY_HEX), 'record'));
        }
        if (u.pathname === '/blocks/current') {
          return jsonResponse(200, { height: chain.headers.length, hash: null });
        }
        return base(url);
      };
    }

    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });

    const combinedFetch: HttpFetch = async (url: string): Promise<Response> => {
      if (url.startsWith('http://a:3000')) return figureFetch('http://a:3000', nodeA.fetch)(url);
      return figureFetch('http://b:3001', nodeB.fetch)(url);
    };

    const config: Config = {
      nodeUrls: ['http://a:3000', 'http://b:3001'],
      m: M,
      k: K,
      profile,
      user: FAKE_USER,
      post: null,
      allowSingle: false,
      json: true,
    };
    const result = await runCli(config, combinedFetch, now);
    expect(result.exitCode).toBe(0);
    expect(result.tip.splits).toEqual([]);
    expect(result.tip.winner).not.toBeNull();
    expect(result.run).not.toBeNull();
    expect(result.run!.figures.failed).toBe(false);
    expect(result.run!.figures.karma.proven).toBe(100n);

    // Silence an unused warning on `suffixHead` — it's a sanity reference.
    expect(suffixHead.header.height).toBeGreaterThan(0);

    // The --json object the command line writes.
    const json = toJson(result);
    expect((json as { karmaTotal: string }).karmaTotal).toBe('100');
    expect((json as { creditTotal: string }).creditTotal).toBe('0');
    expect((json as { heightAfter: number }).heightAfter).toBe(chain.headers.length);

    const karmaField = json['karma'] as Record<string, unknown>;
    expect(karmaField['holdings']).toBe('read');
    expect(karmaField['holdingsVerdict']).toBeNull();
    expect(karmaField['proven']).toBe('100');
    expect(karmaField['unlisted']).toBe('0');
    expect(karmaField['undecided']).toBe('0');
    expect(karmaField['effective']).toBe('100');
    expect(karmaField['height']).toBe(chain.headers.length);

    const creditsField = json['credits'] as Record<string, unknown>;
    // The /credits route answered 200 with the empty page — a listing the
    // node knows the key by, with no boxes — and the ledger reads
    // (NODE_INTERFACE → UTXO queries).
    expect(creditsField['holdings']).toBe('read');
    expect(creditsField['undecided']).toBe('0');

    const boxes = json['boxes'] as { status: string; class: string }[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0]!.status).toBe('proven');
    expect(boxes[0]!.class).toBe('karma');

    const recordField = json['record'] as { status: string };
    expect(recordField.status).toBe('proven');
  });

  it("a listing failure lands as exitCode 1 with both holdings 'not-read' and both undecided sums zero", async () => {
    const chain = buildMinedChain({ count: CHAIN_LEN, stateRoot: 'aa'.repeat(33) });
    const profile = devnetProfile();
    const now = clockAfterChain(chain);

    const nodeA = createFakeNode({ url: 'http://a:3000', chain, m: M, k: K });
    const nodeB = createFakeNode({ url: 'http://b:3001', chain, m: M, k: K });
    const fetch: HttpFetch = async (url: string): Promise<Response> => {
      const u = new URL(url);
      if (u.pathname === `/karma/${FAKE_USER}`) {
        return jsonResponse(500, { error: 'internal' });
      }
      if (url.startsWith('http://a:3000')) return nodeA.fetch(url);
      return nodeB.fetch(url);
    };

    const config: Config = {
      nodeUrls: ['http://a:3000', 'http://b:3001'],
      m: M,
      k: K,
      profile,
      user: FAKE_USER,
      post: null,
      allowSingle: false,
      json: true,
    };
    const result = await runCli(config, fetch, now);
    expect(result.exitCode).toBe(1);
    expect(result.run).not.toBeNull();
    expect(result.run!.figures.failed).toBe(true);
    expect(result.run!.figures.karma.holdings).toBe('not-read');
    expect(result.run!.figures.credits.holdings).toBe('not-read');
    expect(result.run!.figures.karma.undecided).toBe(0n);
    expect(result.run!.figures.credits.undecided).toBe(0n);

    const json = toJson(result);
    expect((json['karma'] as Record<string, unknown>)['holdings']).toBe('not-read');
    expect((json['credits'] as Record<string, unknown>)['holdings']).toBe('not-read');
  });
});

// WEB_INTERFACE → The extension → "The post check" — the command line's
// `post <id>` branch of runCli.
describe('the command line\'s post <id> subcommand', () => {
  const postNodeUrl = 'http://a:3000';
  const profile = devnetProfile();

  function buildPostRow(): { id: string; row: Record<string, unknown>; authorHex: string } {
    const seed = new Uint8Array(32).fill(5);
    const pub = ed25519.getPublicKey(seed);
    const content = 'the post the command checks';
    const commit: PostCommit = {
      contentHash: computeContentHash(content),
      author: pub,
      parentRefs: [],
      protocolVersion: PROTOCOL_VERSION,
      type: 'regular',
    };
    const tx: UtxoTransaction = {
      inputs: ['ab'.repeat(32)],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: commit,
    };
    const txId = computeTxId(tx);
    tx.signatures[bytesToHex(pub)] = ed25519.sign(hexToBytes(txId), seed);
    const id = computePostId(txId, 0);
    return {
      id,
      authorHex: bytesToHex(pub),
      row: {
        id,
        txId,
        tx: bytesToHex(encodeTx(tx)),
        content,
        contentHash: bytesToHex(commit.contentHash),
        author: bytesToHex(pub),
        parentRefs: [],
        protocolVersion: PROTOCOL_VERSION,
        type: 'regular',
        status: 'confirmed',
        blockHeight: 10,
        blockIndex: 0,
        blockCreatedAt: 1_000_000,
        likeCount: 0,
        descendantCount: 0,
        authorName: null,
        likedByViewer: null,
      },
    };
  }

  function postConfig(post: string): Config {
    return {
      nodeUrls: [postNodeUrl],
      m: M,
      k: K,
      profile,
      user: null,
      post,
      allowSingle: false,
      json: false,
    };
  }

  it('reads GET /posts/<id>?tx=1 against the first node and binds a real row (exit 0)', async () => {
    const built = buildPostRow();
    let seenUrl = '';
    const httpFetch: HttpFetch = async (url: string) => {
      seenUrl = url;
      return jsonResponse(200, built.row);
    };
    const result = await runCli(postConfig(built.id), httpFetch, () => 0);
    expect(seenUrl).toBe(`${postNodeUrl}/posts/${built.id}?tx=1`);
    expect(result.exitCode).toBe(0);
    expect(result.post!.check!.status).toBe('bound');
    if (result.post!.check!.status === 'bound') {
      expect(result.post!.check!.author).toBe(built.authorHex);
      expect(result.post!.check!.parent).toBeNull();
    }
    expect(result.tip.winner).toBeNull(); // tip resolution skipped
  });

  it('a withdrawn row answers nothing-to-bind, exit 0', async () => {
    const id = 'ab'.repeat(32);
    const httpFetch: HttpFetch = async () =>
      jsonResponse(200, { kind: 'withdrawn', id, txId: 'cd'.repeat(32), author: 'ef'.repeat(32), parentRefs: [] });
    const result = await runCli(postConfig(id), httpFetch, () => 0);
    expect(result.exitCode).toBe(0);
    expect(result.post!.check!.status).toBe('nothing-to-bind');
  });

  it('a tx: null row is unserved, exit 0 (the node has no bytes, no claim about text)', async () => {
    const id = 'ab'.repeat(32);
    const httpFetch: HttpFetch = async () =>
      jsonResponse(200, { id, tx: null });
    const result = await runCli(postConfig(id), httpFetch, () => 0);
    expect(result.exitCode).toBe(0);
    expect(result.post!.check!.status).toBe('unserved');
  });

  it('an unbound row exits 1 and the reason is on the result', async () => {
    const built = buildPostRow();
    const spoiled = { ...built.row, author: 'ff'.repeat(32) };
    const httpFetch: HttpFetch = async () => jsonResponse(200, spoiled);
    const result = await runCli(postConfig(built.id), httpFetch, () => 0);
    expect(result.exitCode).toBe(1);
    expect(result.post!.check!.status).toBe('unbound');
    if (result.post!.check!.status === 'unbound') {
      expect(result.post!.check!.reason).toBe('commit');
    }
  });

  it('an HTTP failure exits 1 and reports fetchFailure', async () => {
    const id = 'ab'.repeat(32);
    const httpFetch: HttpFetch = async () => new Response('nope', { status: 500 });
    const result = await runCli(postConfig(id), httpFetch, () => 0);
    expect(result.exitCode).toBe(1);
    expect(result.post!.fetchFailure).toContain('500');
  });

  it('--json carries the post branch alone, no tip object', async () => {
    const built = buildPostRow();
    const httpFetch: HttpFetch = async () => jsonResponse(200, built.row);
    const result = await runCli({ ...postConfig(built.id), json: true }, httpFetch, () => 0);
    const json = toJson(result);
    expect(json['post']).toBeDefined();
    expect(json['tip']).toBeUndefined();
    const postJson = json['post'] as Record<string, unknown>;
    expect(postJson['id']).toBe(built.id);
    const checkJson = postJson['check'] as Record<string, unknown>;
    expect(checkJson['status']).toBe('bound');
    expect(checkJson['author']).toBe(built.authorHex);
  });
});
