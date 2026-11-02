// MESH_INTERFACE → The node endpoint — `chainUpstream` serves a chain
// in `blockToJson`'s shape (NODE_INTERFACE → Blocks), and the served
// header round-trips through `headerFromJson` to the same `blockHash`.
// MESH_INTERFACE → The client's node list — `chainResolve` answers
// over chains without calling `verifyProof`: two equal chains answer
// the first winner and the second `behind: 0`, a one-block-shorter
// chain `behind: 1`, a fork `behind: null`.

import { describe, it, expect, afterEach } from 'vitest';
import { profileFor } from '@dagsocial/types';
import type { NetworkProfile, NetworkType } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { chainResolve, chainUpstream, type ChainUpstream } from './helpers/chain-harness.js';
import { makeLinkedChain } from './helpers/devnet-block.js';
import { headerFromJson } from '../src/client/header-json.js';

const PROFILE: NetworkProfile = profileFor('devnet' as NetworkType);
const K = 5;

describe('chainUpstream + chainResolve', () => {
  const upstreams: ChainUpstream[] = [];

  afterEach(async () => {
    for (const u of upstreams.splice(0)) {
      await u.close();
    }
  });

  it('the served /blocks/:h JSON round-trips through headerFromJson to the same blockHash', async () => {
    const chain = makeLinkedChain(K, PROFILE);
    const up = await chainUpstream(chain);
    upstreams.push(up);

    const res = await fetch(`${up.base}/blocks/${K}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { header: Record<string, unknown> };
    const parsed = headerFromJson(body.header);
    expect(parsed, 'headerFromJson accepts the served header').not.toBeNull();
    const servedHash = blockHash(parsed!);
    const originalHash = blockHash(chain[K - 1]!.header);
    expect(servedHash).toBe(originalHash);
  });

  it('two equal chains: the first is the winner, the second behind: 0', async () => {
    const chain = makeLinkedChain(K, PROFILE);
    const urlA = 'http://a';
    const urlB = 'http://b';
    const resolve = chainResolve((url) => (url === urlA || url === urlB ? chain : 'unreachable'), K);
    const r = await resolve([urlA, urlB], 24, K, PROFILE, () => 0, (async () => new Response()) as never);
    expect(r.winnerIndex).toBe(0);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]!.verified).toBe(true);
    expect(r.nodes[0]!.behind).toBe(0);
    expect(r.nodes[1]!.verified).toBe(true);
    expect(r.nodes[1]!.behind).toBe(0);
  });

  it('a chain one block shorter answers behind: 1 against the winner', async () => {
    const chain = makeLinkedChain(K + 1, PROFILE);
    const shorter = chain.slice(0, K);
    const urlLong = 'http://long';
    const urlShort = 'http://short';
    const resolve = chainResolve((url) => (url === urlLong ? chain : shorter), K);
    const r = await resolve([urlLong, urlShort], 24, K, PROFILE, () => 0, (async () => new Response()) as never);
    expect(r.winnerIndex).toBe(0);
    expect(r.nodes[0]!.behind).toBe(0);
    expect(r.nodes[1]!.behind).toBe(1);
  });

  it('a fork — two chains that share no block hash — reads behind: null for the non-winner', async () => {
    const chainA = makeLinkedChain(K, PROFILE);
    const chainB = makeLinkedChain(K, PROFILE);
    const urlA = 'http://a';
    const urlB = 'http://b';
    const resolve = chainResolve((url) => (url === urlA ? chainA : chainB), K);
    const r = await resolve([urlA, urlB], 24, K, PROFILE, () => 0, (async () => new Response()) as never);
    expect(r.winnerIndex).toBe(0);
    expect(r.nodes[0]!.behind).toBe(0);
    expect(r.nodes[1]!.behind).toBeNull();
  });
});
