import { describe, it, afterAll, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { computeTxId, computePostId, decodeTx, encodeTx } from '@dagsocial/types';
import { checkPosts } from '@dagsocial/nipopow-client';
import { createMesh, type Mesh } from '../src/mesh.js';
import { assertDistFresh, NIPOPOW_CLIENT_LOADS } from '../src/dist-freshness.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  postBatch,
  getKarma,
  getPosts,
  getThread,
  getStatus,
  hasKarma,
  getBlockCurrent,
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';
import type { NodeProcess } from '../src/node-process.js';

const FILE_INDEX = 21;

const TOOL_ENTRY = resolve(
  import.meta.dirname,
  '..',
  '..',
  'nipopow-client',
  'dist',
  'index.js',
);

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

// NODE_INTERFACE → Posts → "The creating transaction rides a post row" — the
// routes answer the row's bytes; the test reads them without the typed getters,
// to assert key presence and absence directly.
async function fetchJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

async function getPostRaw(
  node: NodeProcess,
  id: string,
  tx: boolean,
): Promise<Record<string, unknown>> {
  const q = tx ? '?tx=1' : '';
  const { status, body } = await fetchJson(`${node.url}/posts/${id}${q}`);
  expect(status).toBe(200);
  return body;
}

async function getPostsRaw(
  node: NodeProcess,
  query: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await fetchJson(`${node.url}/posts?${query}`);
  expect(status).toBe(200);
  return body;
}

async function getThreadRaw(
  node: NodeProcess,
  id: string,
  query: string,
): Promise<Record<string, unknown>> {
  const { status, body } = await fetchJson(`${node.url}/posts/${id}/thread?${query}`);
  expect(status).toBe(200);
  return body;
}

function runPostCmd(
  id: string,
  nodeUrl: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  assertDistFresh(NIPOPOW_CLIENT_LOADS);
  return new Promise((r) => {
    const child = spawn(
      process.execPath,
      [TOOL_ENTRY, 'post', id, '--json'],
      {
        env: { ...process.env, NODE_URLS: nodeUrl, NETWORK_TYPE: 'devnet' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => r({ code: code ?? 1, stdout, stderr }));
  });
}

// A row of the answer carries `tx` whose decode's id derives the row's id.
// WEB_INTERFACE → The extension → "The post check" — `computeTxId` of the
// decoded tx is the row's `txId`, and `computePostId(txId, 0)` the row's `id`.
function assertTxBinds(row: Record<string, unknown>): void {
  expect(typeof row['id']).toBe('string');
  expect(typeof row['txId']).toBe('string');
  expect(typeof row['tx']).toBe('string');
  const tx = decodeTx(Buffer.from(row['tx'] as string, 'hex'));
  const txId = computeTxId(tx);
  expect(txId).toBe(row['txId']);
  expect(computePostId(txId, 0)).toBe(row['id']);
  // The re-encoded bytes are the ones served.
  expect(Buffer.from(encodeTx(tx)).toString('hex')).toBe(row['tx']);
}

// NODE_INTERFACE → Posts → "A light row is a post's id and the node's word" —
// the eleven keys a live row of a light answer carries, `kind: 'light'` among
// them. A withdrawn row stays a WithdrawnJson, whole.
const LIGHT_KEYS: readonly string[] = [
  'authorName',
  'blockCreatedAt',
  'blockHeight',
  'blockIndex',
  'descendantCount',
  'id',
  'kind',
  'likeCount',
  'likedByViewer',
  'parentRefs',
  'status',
];

function assertLightKeys(row: Record<string, unknown>): void {
  expect(row['kind']).toBe('light');
  expect(Object.keys(row).sort()).toEqual([...LIGHT_KEYS]);
}

// The batch route's raw rows, with the single boundary cast every raw read
// in this file uses — the existing `fetchJson`/`getPostRaw` pattern.
async function postBatchRaw(
  node: NodeProcess,
  ids: readonly string[],
  query: string,
): Promise<Record<string, unknown>[]> {
  const url = query ? `${node.url}/posts/batch?${query}` : `${node.url}/posts/batch`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { posts: Record<string, unknown>[] };
  return body.posts;
}

async function getPostsLightRaw(
  node: NodeProcess,
): Promise<{ posts: Record<string, unknown>[]; pending: Record<string, unknown>[]; next: string | null; pendingCount: number }> {
  const res = await fetch(`${node.url}/posts?light=1`);
  expect(res.status).toBe(200);
  return await res.json() as { posts: Record<string, unknown>[]; pending: Record<string, unknown>[]; next: string | null; pendingCount: number };
}

async function getThreadLightRaw(
  node: NodeProcess,
  id: string,
): Promise<{
  post: Record<string, unknown>;
  ancestors: Record<string, unknown>[];
  descendants: Record<string, unknown>[];
  pending: Record<string, unknown>[];
  ancestorCount: number;
  descendantCount: number;
  pendingCount: number;
  next: string | null;
}> {
  const res = await fetch(`${node.url}/posts/${id}/thread?light=1`);
  expect(res.status).toBe(200);
  return await res.json() as {
    post: Record<string, unknown>;
    ancestors: Record<string, unknown>[];
    descendants: Record<string, unknown>[];
    pending: Record<string, unknown>[];
    ancestorCount: number;
    descendantCount: number;
    pendingCount: number;
    next: string | null;
  };
}

describe('post-tx', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('tx=1 answers the creating transaction, pending on A, confirmed on A and on a late B, lists bind, the light client binds, tx=2 is 400', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const nodeA = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(nodeA, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice ----
    const version = (await getStatus(nodeA)).protocolVersion;
    const alice = fresh();
    const faucetK = (await getKarma(nodeA, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height, version);
    await postInvite(nodeA, inv.json);
    await confirm(
      async () => await hasKarma(nodeA, alice.publicKeyHex),
      nodeA, mesh.miningSecret,
    );

    // ---- alice submits a post to A (no mining — stays pending) ----
    const aliceK = (await getKarma(nodeA, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'post-tx subject', aliceK.height, version);
    const threadRes = await postPost(nodeA, thread.json, thread.content);
    expect(threadRes.status).toBe('pending');
    expect(threadRes.txId).toBe(thread.txId);

    // ---- step 1: pending on A, tx=1 binds; without tx=1 no `tx` key ----
    const pending = await getPostRaw(nodeA, threadRes.postId, true);
    expect(pending['status']).toBe('pending');
    expect(pending['txId']).toBe(thread.txId);
    assertTxBinds(pending);

    const pendingNoTx = await getPostRaw(nodeA, threadRes.postId, false);
    expect(pendingNoTx['txId']).toBe(thread.txId);
    expect('tx' in pendingNoTx).toBe(false);

    const pendingBytes = pending['tx'] as string;

    // ---- step 2: confirmed on A, tx byte-equal to pending ----
    await confirm(
      async () => {
        const p = await getPostRaw(nodeA, threadRes.postId, false);
        return p['status'] === 'confirmed';
      },
      nodeA, mesh.miningSecret,
    );

    const confirmedA = await getPostRaw(nodeA, threadRes.postId, true);
    expect(confirmedA['status']).toBe('confirmed');
    expect(confirmedA['txId']).toBe(thread.txId);
    assertTxBinds(confirmedA);
    expect(confirmedA['tx']).toBe(pendingBytes);

    // ---- step 3: node B joins after the block carrying the post ----
    const confirmHeight = (await getBlockCurrent(nodeA)).height;
    const nodeB = await mesh.addNode();

    // Wait for B to reach the confirm height.
    const heightDeadline = Date.now() + 15_000;
    let heightReached = false;
    while (Date.now() < heightDeadline) {
      try {
        const tip = await getBlockCurrent(nodeB);
        if (tip.height >= confirmHeight) { heightReached = true; break; }
      } catch { /* still starting */ }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(heightReached).toBe(true);

    // The row is confirmed on B — the block's utxoTxIds carry the id, so the
    // store's body lookup answers the bytes whether the body has arrived or
    // not. `content` may be null (placeholder) or the string, and the bytes
    // bind either way.
    const confirmedB = await getPostRaw(nodeB, threadRes.postId, true);
    expect(confirmedB['status']).toBe('confirmed');
    expect(confirmedB['txId']).toBe(thread.txId);
    assertTxBinds(confirmedB);
    expect(confirmedB['tx']).toBe(pendingBytes);
    // The content is either the string or null (a placeholder before backfill).
    const bContent = confirmedB['content'];
    expect(bContent === null || bContent === 'post-tx subject').toBe(true);

    // Mine a few blocks so the backfill driver's per-block hook fires on B,
    // then wait for the body to land.
    await mine(nodeA, mesh.miningSecret, 3);
    await waitHeight([nodeB], (await getBlockCurrent(nodeA)).height);
    const bodyDeadline = Date.now() + 15_000;
    while (Date.now() < bodyDeadline) {
      const p = await getPostRaw(nodeB, threadRes.postId, false);
      if (p['content'] === 'post-tx subject') break;
      await new Promise(r => setTimeout(r, 100));
    }
    const confirmedBWithBody = await getPostRaw(nodeB, threadRes.postId, true);
    expect(confirmedBWithBody['content']).toBe('post-tx subject');
    assertTxBinds(confirmedBWithBody);
    expect(confirmedBWithBody['tx']).toBe(pendingBytes);

    // ---- step 4: lists on B carry `tx` for every PostJson ----
    const listRaw = await getPostsRaw(nodeB, 'tx=1');
    const posts = listRaw['posts'];
    expect(Array.isArray(posts)).toBe(true);
    const postsArr = posts as Record<string, unknown>[];
    expect(postsArr.length).toBeGreaterThan(0);
    let foundInList = false;
    for (const row of postsArr) {
      assertTxBinds(row);
      if (row['id'] === threadRes.postId) foundInList = true;
    }
    expect(foundInList).toBe(true);

    const threadRaw = await getThreadRaw(nodeB, threadRes.postId, 'tx=1');
    const subject = threadRaw['post'] as Record<string, unknown>;
    assertTxBinds(subject);
    expect(subject['id']).toBe(threadRes.postId);
    expect(subject['tx']).toBe(pendingBytes);
    for (const row of (threadRaw['ancestors'] as Record<string, unknown>[])) assertTxBinds(row);
    for (const row of (threadRaw['descendants'] as Record<string, unknown>[])) assertTxBinds(row);
    for (const row of (threadRaw['pending'] as Record<string, unknown>[])) assertTxBinds(row);

    // ---- step 5: the light client binds `post <id>` on both nodes ----
    for (const node of [nodeA, nodeB]) {
      const out = await runPostCmd(threadRes.postId, node.url);
      expect(out.code).toBe(0);
      const parsed = JSON.parse(out.stdout) as {
        post: { id: string; check: { status: string; id?: string; author?: string } };
      };
      expect(parsed.post.id).toBe(threadRes.postId);
      expect(parsed.post.check.status).toBe('bound');
      expect(parsed.post.check.id).toBe(threadRes.postId);
      expect(parsed.post.check.author).toBe(alice.publicKeyHex);
    }

    // ---- step 6: tx=2 is 400 `tx must be 1` ----
    try {
      await getPosts(nodeB, 'tx=2');
      expect.fail('tx=2 should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      if (err instanceof NodeError) {
        expect(err.status).toBe(400);
        const reason = err.body['error'] ?? err.body['reason'];
        expect(reason).toBe('tx must be 1');
      }
    }

    // Step 7 (restart) is left out: the suite has no restart helper
    // (`src/node-process.ts` exposes `spawnNode` and `kill` only, with no
    // reopen-same-db path), and the brief says to leave it out when none
    // exists.

    // ---- body refusal ----
    // NODE_INTERFACE → HTTP API → "A body the parser refuses is the client's
    // error" — a JSON body the parser refuses answers 400 with the mapped
    // body, no route runs, and the next request answers as before.
    {
      const refused = await fetch(`${nodeA.url}/posts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 400, reason: 'malformed JSON body' });
      // The node answers the next request.
      const sanity = await postBatch(nodeA, [threadRes.postId]);
      expect(sanity.posts.length).toBe(1);
      expect(sanity.posts[0]!.id).toBe(threadRes.postId);
    }

    // ---- the bounds ----
    // NODE_INTERFACE → Posts → "The batch read answers posts by id":
    // 1 to BATCH_READ_MAX ids; 101 is refused.
    {
      const tooMany = Array.from(
        { length: 101 },
        (_, i) => i.toString(16).padStart(2, '0').repeat(32),
      );
      try {
        await postBatch(nodeA, tooMany);
        expect.fail('101 ids should have been refused');
      } catch (err) {
        expect(err).toBeInstanceOf(NodeError);
        if (err instanceof NodeError) {
          expect(err.status).toBe(400);
          expect(err.body['error']).toBe('ids must hold 1 to 100 post ids');
        }
      }
    }
    // NODE_INTERFACE → Posts → "`light` and `tx` do not combine".
    try {
      await getPosts(nodeA, 'light=1&tx=1');
      expect.fail('light=1&tx=1 should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      if (err instanceof NodeError) {
        expect(err.status).toBe(400);
        expect(err.body['error']).toBe('tx and light cannot both be 1');
      }
    }

    // ---- the batch answers by id, in the order asked ----
    // NODE_INTERFACE → Posts → "The batch read answers posts by id" — an id
    // the node has never heard of is left out; the known rows are answered in
    // the order asked. The row's `tx` binds through its id.
    const zerosId = '0'.repeat(64);
    const batchA = await postBatchRaw(nodeA, [zerosId, threadRes.postId], 'tx=1');
    expect(batchA.length).toBe(1);
    const batchRowA = batchA[0]!;
    expect(batchRowA['id']).toBe(threadRes.postId);
    assertTxBinds(batchRowA);
    expect(batchRowA['tx']).toBe(pendingBytes);
    {
      const [check] = checkPosts([batchRowA]);
      expect(check!.status).toBe('bound');
      if (check!.status === 'bound') {
        expect(check!.id).toBe(threadRes.postId);
        expect(check!.author).toBe(alice.publicKeyHex);
      }
    }

    // Reversed order — the known row still binds, the unknown is still left
    // out.
    const batchReversed = await postBatchRaw(nodeA, [threadRes.postId, zerosId], 'tx=1');
    expect(batchReversed.length).toBe(1);
    expect(batchReversed[0]!['id']).toBe(threadRes.postId);

    // ---- two nodes answer one post ----
    // NODE_INTERFACE → Posts → "The creating transaction rides a post row" —
    // the `tx` the batch route answers is byte-equal to A's: the stored body's
    // bytes derive the id either way.
    const batchB = await postBatchRaw(nodeB, [threadRes.postId], 'tx=1');
    expect(batchB.length).toBe(1);
    const batchRowB = batchB[0]!;
    expect(batchRowB['id']).toBe(threadRes.postId);
    assertTxBinds(batchRowB);
    expect(batchRowB['tx']).toBe(pendingBytes);

    // ---- a light listing is the full listing's ids ----
    // NODE_INTERFACE → Posts → "A light row is a post's id and the node's
    // word" — `light=1` is the same page under the same `limit`, `after`,
    // `author`, `roots` and `viewer`; the live rows are LightJson, every one
    // of them its eleven keys with `kind: 'light'`. A pending reply beside the
    // confirmed thread puts one pending and one confirmed row in the read.
    const aliceKReply = (await getKarma(nodeA, alice.publicKeyHex))!;
    const reply = buildReplyTx(
      alice,
      karmaBoxes(aliceKReply),
      'post-tx reply',
      threadRes.postId,
      alice.publicKeyHex,
      aliceKReply.height,
      version,
    );
    const replyRes = await postPost(nodeA, reply.json, reply.content);
    expect(replyRes.status).toBe('pending');

    // Gossip the pending reply to B before the listing read on B.
    const replyOnBDeadline = Date.now() + 10_000;
    while (Date.now() < replyOnBDeadline) {
      const pendingOnB = await getPosts(nodeB);
      if (pendingOnB.pending.some((p) => p.id === replyRes.postId)) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    for (const node of [nodeA, nodeB]) {
      const full = await getPosts(node);
      const light = await getPostsLightRaw(node);
      // Same ids in the same order, same `next` and `pendingCount`.
      expect(light.posts.map((r) => r['id'])).toEqual(full.posts.map((r) => r.id));
      expect(light.pending.map((r) => r['id'])).toEqual(full.pending.map((r) => r.id));
      expect(light.next).toEqual(full.next);
      expect(light.pendingCount).toEqual(full.pendingCount);
      // Every live row is LightJson under the eleven keys, `kind: 'light'`.
      for (const row of light.posts) assertLightKeys(row);
      for (const row of light.pending) assertLightKeys(row);
      // One pending (the reply) and one confirmed (the thread) are among the
      // rows read.
      const pendingIds = light.pending.map((r) => r['id']);
      const confirmedIds = light.posts.map((r) => r['id']);
      expect(pendingIds).toContain(replyRes.postId);
      expect(confirmedIds).toContain(threadRes.postId);
    }

    // ---- a light thread ----
    // NODE_INTERFACE → Posts → "A light row is a post's id and the node's
    // word" — the thread view's `post` and every live row of its lists is a
    // LightJson under `light=1`; its counts and `next` match the full form.
    await confirm(
      async () => {
        const p = await getThread(nodeA, threadRes.postId);
        return (p?.descendants ?? []).some((d) => d.id === replyRes.postId);
      },
      nodeA, mesh.miningSecret,
    );
    await waitHeight([nodeB], (await getBlockCurrent(nodeA)).height);

    const fullThread = (await getThread(nodeA, threadRes.postId))!;
    const lightThread = await getThreadLightRaw(nodeA, threadRes.postId);
    // Same ids in the same order; counts and next identical.
    expect(lightThread.post['id']).toBe(fullThread.post.id);
    expect(lightThread.descendants.map((r) => r['id'])).toEqual(
      fullThread.descendants.map((r) => r.id),
    );
    expect(lightThread.ancestors.map((r) => r['id'])).toEqual(
      fullThread.ancestors.map((r) => r.id),
    );
    expect(lightThread.pending.map((r) => r['id'])).toEqual(
      fullThread.pending.map((r) => r.id),
    );
    expect(lightThread.ancestorCount).toBe(fullThread.ancestorCount);
    expect(lightThread.descendantCount).toBe(fullThread.descendantCount);
    expect(lightThread.pendingCount).toBe(fullThread.pendingCount);
    expect(lightThread.next).toBe(fullThread.next);
    // The subject and every live descendant are LightJson.
    assertLightKeys(lightThread.post);
    for (const row of lightThread.descendants) assertLightKeys(row);
    for (const row of lightThread.ancestors) assertLightKeys(row);
    for (const row of lightThread.pending) assertLightKeys(row);
    // The reply among the descendants names its parent.
    const replyDescendant = lightThread.descendants.find((d) => d['id'] === replyRes.postId);
    expect(replyDescendant).toBeTruthy();
    expect(replyDescendant!['parentRefs']).toEqual([threadRes.postId]);
  });
});
