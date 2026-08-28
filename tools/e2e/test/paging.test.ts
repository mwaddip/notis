import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  getKarma,
  getBlockCurrent,
  getPosts,
  getThread,
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 12;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('paging', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('keyset paging: feed and thread continue across real blocks', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const node = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(node, mesh.miningSecret, 1);
    await waitHeight([node], 1);

    const tip = await getBlockCurrent(node);
    expect(tip.height).toBe(1);

    const block1 = await fetch(`${node.url}/blocks/1`);
    expect(block1.ok).toBe(true);

    // ---- invite alice (bond covers 10 thread locks = 50n) ----
    // POST_LOCK_THREAD_COST = 5n, POST_LOCK_REPLY_COST = 3n;
    // 10 thread locks = 50n; actual spend: 6 threads × 5 + 4 replies × 3 = 42n
    const alice = fresh();
    const bondAmount = 50n;

    const faucetKarma = (await getKarma(node, DEVNET_FAUCET.publicKeyHex))!;
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      alice,
      bondAmount,
      faucetKarma.height,
    );
    await postInvite(node, invite.json);

    await confirm(
      async () => (await getKarma(node, alice.publicKeyHex)) !== null,
      node,
      mesh.miningSecret,
    );

    // ---- the feed: three threads confirmed one at a time ----

    let aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p1Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post one', aliceK.height);
    const p1Res = await postPost(node, p1Tx.json, p1Tx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p1Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p2Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post two', aliceK.height);
    const p2Res = await postPost(node, p2Tx.json, p2Tx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p2Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p3Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post three', aliceK.height);
    const p3Res = await postPost(node, p3Tx.json, p3Tx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p3Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    // NODE_INTERFACE → "Every list a view returns is a page"
    // posts is committed posts by (blockHeight, blockIndex) newest first
    const page1 = await getPosts(node, 'limit=2');
    expect(page1.posts.length).toBe(2);
    expect(page1.posts[0]!.id).toBe(p3Res.postId);
    expect(page1.posts[1]!.id).toBe(p2Res.postId);
    // NODE_INTERFACE → "Every list a view returns is a page"
    expect(page1.pending).toEqual([]);
    expect(page1.pendingCount).toBe(0);

    const expectedNext = `${page1.posts[1]!.blockHeight}:${page1.posts[1]!.blockIndex}`;
    expect(page1.next).toBe(expectedNext);

    // ---- post two more, confirm each ----
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p4Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post four', aliceK.height);
    const p4Res = await postPost(node, p4Tx.json, p4Tx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p4Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p5Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post five', aliceK.height);
    const p5Res = await postPost(node, p5Tx.json, p5Tx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p5Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    // NODE_INTERFACE → "Every list a view returns is a page"
    // continuation: the two newer posts are not re-served and nothing is skipped
    const page2 = await getPosts(node, `limit=2&after=${page1.next}`);
    expect(page2.posts.length).toBe(1);
    expect(page2.posts[0]!.id).toBe(p1Res.postId);
    expect(page2.next).toBeNull();

    // NODE_INTERFACE → "Every list a view returns is a page"
    // head fetch sees the two newest
    const head = await getPosts(node, 'limit=2');
    expect(head.posts[0]!.id).toBe(p5Res.postId);
    expect(head.posts[1]!.id).toBe(p4Res.postId);

    // ---- pending: post without mining ----
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const p6Tx = buildThreadTx(alice, karmaBoxes(aliceK), 'post six', aliceK.height);
    const p6Res = await postPost(node, p6Tx.json, p6Tx.content);

    // NODE_INTERFACE → "Every list a view returns is a page"
    // pending posts have no committed position; pending rides beside the page
    const withPending = await getPosts(node, 'limit=2');
    expect(withPending.posts[0]!.id).toBe(p5Res.postId);
    expect(withPending.posts[1]!.id).toBe(p4Res.postId);
    expect(withPending.pending.length).toBe(1);
    expect(withPending.pending[0]!.id).toBe(p6Res.postId);
    expect(withPending.pending[0]!.blockHeight).toBeNull();
    expect(withPending.pending[0]!.status).toBe('pending');
    expect(withPending.pendingCount).toBe(1);

    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === p6Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );
    // NODE_INTERFACE → "Every list a view returns is a page"
    // after confirmation, pending clears and p6 is at the head
    const afterConfirm = await getPosts(node, 'limit=2');
    expect(afterConfirm.pending).toEqual([]);
    expect(afterConfirm.posts[0]!.id).toBe(p6Res.postId);
    expect(afterConfirm.posts[1]!.id).toBe(p5Res.postId);

    // ---- the thread: replies to p1 ----
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const r1Tx = buildReplyTx(alice, karmaBoxes(aliceK), 'reply one', p1Res.postId, aliceK.height);
    const r1Res = await postPost(node, r1Tx.json, r1Tx.content);
    await confirm(
      async () => {
        const t = await getThread(node, p1Res.postId);
        return t !== null && t.descendants.some((r) => r.id === r1Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );

    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const r2Tx = buildReplyTx(alice, karmaBoxes(aliceK), 'reply two', p1Res.postId, aliceK.height);
    const r2Res = await postPost(node, r2Tx.json, r2Tx.content);
    await confirm(
      async () => {
        const t = await getThread(node, p1Res.postId);
        return t !== null && t.descendants.some((r) => r.id === r2Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );

    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const r3Tx = buildReplyTx(alice, karmaBoxes(aliceK), 'reply three', p1Res.postId, aliceK.height);
    const r3Res = await postPost(node, r3Tx.json, r3Tx.content);
    await confirm(
      async () => {
        const t = await getThread(node, p1Res.postId);
        return t !== null && t.descendants.some((r) => r.id === r3Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );

    // NODE_INTERFACE → Posts
    // descendants one page of the subtree's committed rows, ascending
    const threadPage1 = (await getThread(node, p1Res.postId, 'limit=2'))!;
    expect(threadPage1.descendants.length).toBe(2);
    expect(threadPage1.descendants[0]!.id).toBe(r1Res.postId);
    expect(threadPage1.descendants[1]!.id).toBe(r2Res.postId);
    expect(threadPage1.descendantCount).toBe(3);
    expect(threadPage1.pending).toEqual([]);
    const threadNext = `${threadPage1.descendants[1]!.blockHeight}:${threadPage1.descendants[1]!.blockIndex}`;
    expect(threadPage1.next).toBe(threadNext);

    // ---- reply r4, confirm, continue thread ----
    aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const r4Tx = buildReplyTx(alice, karmaBoxes(aliceK), 'reply four', p1Res.postId, aliceK.height);
    const r4Res = await postPost(node, r4Tx.json, r4Tx.content);
    await confirm(
      async () => {
        const t = await getThread(node, p1Res.postId);
        return t !== null && t.descendants.some((r) => r.id === r4Res.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );

    // NODE_INTERFACE → "Every list a view returns is a page"
    // continuation strictly after the key — r3 and r4
    const threadPage2 = (await getThread(node, p1Res.postId, `limit=2&after=${threadPage1.next}`))!;
    expect(threadPage2.descendants.length).toBe(2);
    expect(threadPage2.descendants[0]!.id).toBe(r3Res.postId);
    expect(threadPage2.descendants[1]!.id).toBe(r4Res.postId);
    expect(threadPage2.next).toBeNull();
    expect(threadPage2.descendantCount).toBe(4);

    // ---- malformed key → 400 ----
    // NODE_INTERFACE → "Every list a view returns is a page"
    try {
      await getPosts(node, 'after=abc');
      expect.fail('malformed after should return 400');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // NODE_INTERFACE → "Every list a view returns is a page"
    try {
      await getPosts(node, 'limit=0');
      expect.fail('limit=0 should return 400');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

  });
});
