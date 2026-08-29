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
  hasKarma,
  getPost,
  getBlockCurrent,
  getStatus,
  isPost,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';
import {
  POST_PRICE_THREAD,
  POST_PRICE_REPLY,
  REPLY_AUTHOR_SHARE,
  LIKES_PER_KARMA_PAYOUT,
} from '@dagsocial/types';

const FILE_INDEX = 15;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('post-price', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('the price, the share and the accrual payout', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    const tips = await Promise.all(mesh.nodes.map(getBlockCurrent));
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

    // ---- invite A and B ----
    const alice = fresh();
    const bob = fresh();
    const bondAmount = 50n;

    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, bondAmount, faucetK.height);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], bob, bondAmount, faucetK.height);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => await hasKarma(miner, bob.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- capture totalKarma before posting ----
    const statusBefore = await getStatus(miner);
    const circulationBefore = BigInt(statusBefore.totalKarma);

    // ---- A posts a thread ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const aliceBefore = BigInt(aliceK.total);
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'price test thread', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- A's total drops by exactly POST_PRICE_THREAD ----
    // ARCHITECTURE → The post price
    for (const node of mesh.nodes) {
      const ak = await getKarma(node, alice.publicKeyHex);
      expect(BigInt(ak.total)).toBe(aliceBefore - POST_PRICE_THREAD);
      expect(ak.lifetimeLikesReceived).toBe('0');
    }

    // ---- circulation drops by POST_PRICE_THREAD ----
    // NODE_INTERFACE → Status: totalKarma excludes the pool
    const statusAfterThread = await getStatus(miner);
    const circulationAfterThread = BigInt(statusAfterThread.totalKarma);
    expect(circulationAfterThread).toBe(circulationBefore - POST_PRICE_THREAD);

    // ---- B replies to A's thread ----
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const bobBefore = BigInt(bobK.total);
    const reply1 = buildReplyTx(bob, karmaBoxes(bobK), 'b reply 1', threadRes.postId, alice.publicKeyHex, bobK.height);
    const reply1Res = await postPost(miner, reply1.json, reply1.content);

    await confirm(
      async () => {
        const p = await getPost(miner, reply1Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- B's total drops by POST_PRICE_REPLY ----
    for (const node of mesh.nodes) {
      const bk = await getKarma(node, bob.publicKeyHex);
      expect(BigInt(bk.total)).toBe(bobBefore - POST_PRICE_REPLY);
    }

    // ---- circulation drops by POST_PRICE_REPLY − REPLY_AUTHOR_SHARE ----
    // ARCHITECTURE → The post price: the share stays in circulation via accrual
    const statusAfterReply = await getStatus(miner);
    const circulationAfterReply = BigInt(statusAfterReply.totalKarma);
    expect(circulationAfterReply).toBe(
      circulationAfterThread - (POST_PRICE_REPLY - REPLY_AUTHOR_SHARE),
    );

    // ---- the reply moves no like counter ----
    // ARCHITECTURE → The post price: "it moves no like counter"
    const threadPost = await getPost(miner, threadRes.postId);
    expect(isPost(threadPost!)).toBe(true);
    if (isPost(threadPost!)) {
      expect(threadPost.likeCount).toBe(0);
    }

    // ---- accumulate LIKES_PER_KARMA_PAYOUT accruals to A via replies ----
    // Already have 1 accrual from B's reply above. Need (LIKES_PER_KARMA_PAYOUT - 1) more.
    const aliceKBeforeAccrual = await getKarma(miner, alice.publicKeyHex);
    const aliceTotalBeforeAccrual = BigInt(aliceKBeforeAccrual.total);

    for (let i = 1; i < LIKES_PER_KARMA_PAYOUT; i++) {
      const bk = (await getKarma(miner, bob.publicKeyHex))!;
      const rTx = buildReplyTx(bob, karmaBoxes(bk), `accrual reply ${i + 1}`, threadRes.postId, alice.publicKeyHex, bk.height);
      const rRes = await postPost(miner, rTx.json, rTx.content);

      await confirm(
        async () => {
          const p = await getPost(miner, rRes.postId);
          return p !== null && isPost(p) && p.status === 'confirmed';
        },
        miner, mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);
    }

    // ---- A's total rises by LIKES_PER_KARMA_PAYOUT − 1 ----
    // ARCHITECTURE → Per-block accrual and settlement: x−1 per x
    for (const node of mesh.nodes) {
      const ak = await getKarma(node, alice.publicKeyHex);
      expect(BigInt(ak.total)).toBe(
        aliceTotalBeforeAccrual + BigInt(LIKES_PER_KARMA_PAYOUT - 1),
      );
      // ARCHITECTURE → The post price: "it moves no like counter"
      expect(ak.lifetimeLikesReceived).toBe('0');
    }

    // ---- the reply accruals moved no like counter ----
    const threadAfterAccrual = await getPost(miner, threadRes.postId);
    expect(isPost(threadAfterAccrual!)).toBe(true);
    if (isPost(threadAfterAccrual!)) {
      expect(threadAfterAccrual.likeCount).toBe(0);
    }

    // ---- a like on A's post still bumps likeCount ----
    const bobKLike = (await getKarma(miner, bob.publicKeyHex))!;
    const like = buildLikeTx(
      bob,
      karmaBoxes(bobKLike),
      threadRes.postId,
      alice.publicKeyHex,
      bobKLike.height,
    );
    await postLike(miner, like.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.likeCount === 1;
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const p = await getPost(node, threadRes.postId);
      expect(isPost(p!)).toBe(true);
      if (isPost(p!)) {
        expect(p.likeCount).toBe(1);
      }
      const ak = await getKarma(node, alice.publicKeyHex);
      expect(ak.lifetimeLikesReceived).toBe('1');
    }
  });
});
