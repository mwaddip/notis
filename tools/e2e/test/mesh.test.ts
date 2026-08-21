import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import { buildLikeTx } from '../src/tx/like.js';
import {
  postInvite,
  postPost,
  postLike,
  getKarma,
  getPost,
  getBlockCurrent,
  NodeError,
  isPost,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 0;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('mesh', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row a: mesh proof, invites, posts, likes, tip equality', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    const tips = await Promise.all(
      mesh.nodes.map(getBlockCurrent),
    );
    for (const tip of tips) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toBe(tips[0]!.hash);
    }

    const block1s = await Promise.all(
      mesh.nodes.map(async (n) => {
        const res = await fetch(`${n.url}/blocks/1`);
        expect(res.ok).toBe(true);
        return (await res.json()) as { header: { stateRoot: string } };
      }),
    );
    for (const b of block1s) {
      expect(b.header.stateRoot).toBe(block1s[0]!.header.stateRoot);
    }

    // ---- faucet invites two identities ----
    const alice = fresh();
    const bob = fresh();
    const bondAmount = 50n;

    const faucetKarma = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inviteAlice = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      alice,
      bondAmount,
      faucetKarma.height,
    );
    await postInvite(miner, inviteAlice.json);

    const inviteBob = buildInviteTx(
      DEVNET_FAUCET,
      [inviteAlice.outputs[0]!],
      bob,
      bondAmount,
      faucetKarma.height,
    );
    await postInvite(miner, inviteBob.json);

    await confirm(
      async () => (await getKarma(miner, alice.publicKeyHex)) !== null,
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const ak = (await getKarma(node, alice.publicKeyHex))!;
      expect(BigInt(ak.total)).toBe(bondAmount);
      const bk = (await getKarma(node, bob.publicKeyHex))!;
      expect(BigInt(bk.total)).toBe(bondAmount);
    }

    // ---- thread + reply ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'hello mesh',
      aliceK.height,
    );
    const threadRes = await postPost(miner, thread.json);

    const reply = buildReplyTx(
      alice,
      [thread.outputs[0]!],
      'reply to mesh',
      threadRes.postId,
      aliceK.height,
    );
    const replyRes = await postPost(miner, reply.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const threadPosts = await Promise.all(
      mesh.nodes.map((n) => getPost(n, threadRes.postId)),
    );
    for (const p of threadPosts) {
      expect(p).not.toBeNull();
      expect(isPost(p!)).toBe(true);
      if (isPost(p!)) {
        expect(p.status).toBe('confirmed');
        const first = threadPosts[0]!;
        if (isPost(first)) expect(p.blockHeight).toBe(first.blockHeight);
      }
    }

    const replyPosts = await Promise.all(
      mesh.nodes.map((n) => getPost(n, replyRes.postId)),
    );
    for (const p of replyPosts) {
      expect(p).not.toBeNull();
      if (isPost(p!)) expect(p.status).toBe('confirmed');
    }

    // ---- one like: likeCount 1, liker karma −1, author karma unchanged ----
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const bobKarmaBefore = BigInt(bobK.total);
    const threadForLike = (await getPost(miner, threadRes.postId))!;
    expect(isPost(threadForLike)).toBe(true);
    const authorHex = isPost(threadForLike) ? threadForLike.confirmedAuthor! : '';

    const like = buildLikeTx(
      bob,
      karmaBoxes(bobK),
      threadRes.postId,
      authorHex,
      bobK.height,
    );
    await postLike(miner, like.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.likeCount === 1;
      },
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Alice's karma: bond (50) − thread (5) − reply (3) = 42, unchanged by one like
    const aliceKarmaExpected = bondAmount - 5n - 3n;
    for (const node of mesh.nodes) {
      const p = (await getPost(node, threadRes.postId))!;
      expect(isPost(p)).toBe(true);
      if (isPost(p)) expect(p.likeCount).toBe(1);

      const bk = (await getKarma(node, bob.publicKeyHex))!;
      expect(BigInt(bk.total)).toBe(bobKarmaBefore - 1n);

      const ak = (await getKarma(node, alice.publicKeyHex))!;
      expect(BigInt(ak.total)).toBe(aliceKarmaExpected);
    }

    // ---- second like by same liker → 400 ----
    const bobK2 = (await getKarma(miner, bob.publicKeyHex))!;
    const like2 = buildLikeTx(
      bob,
      karmaBoxes(bobK2),
      threadRes.postId,
      authorHex,
      bobK2.height,
    );
    try {
      await postLike(miner, like2.json);
      expect.fail('second like by the same liker should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- tip headers identical ----
    const finalTips = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const tip of finalTips) {
      expect(tip.height).toBe(finalTips[0]!.height);
      expect(tip.hash).toBe(finalTips[0]!.hash);
    }
  });
});
