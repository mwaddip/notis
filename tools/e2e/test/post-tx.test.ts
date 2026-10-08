import { describe, it, afterAll, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { computeTxId, computePostId, decodeTx, encodeTx } from '@dagsocial/types';
import { createMesh, type Mesh } from '../src/mesh.js';
import { assertDistFresh, NIPOPOW_CLIENT_LOADS } from '../src/dist-freshness.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  getKarma,
  getPosts,
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
  });
});
