import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import { buildLikeTx } from '../src/tx/like.js';
import { buildPostWithdrawTx } from '../src/tx/post-withdraw.js';
import {
  postInvite,
  postPost,
  postLike,
  postPostWithdraw,
  getKarma,
  hasKarma,
  getPost,
  getBlockCurrent,
  NodeError,
  isPost,
  isWithdrawn,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 9;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('post-withdraw', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('postWithdraw mechanism — propagation, like+withdraw coexistence, content resurrection guard, non-author refusal, maturity bind', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;
    const peer = mesh.nodes[1]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice (author) and bob (liker / non-author) ----
    const alice = fresh();
    const bob = fresh();
    const bondAmount = 50n;

    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, bondAmount, faucetK.height);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], bob, bondAmount, faucetK.height);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- A: propagation — withdrawal submitted to a NON-MINING node reaches consensus ----

    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const propPost = buildThreadTx(alice, karmaBoxes(aliceK), 'propagation target', aliceK.height);
    const propPostRes = await postPost(miner, propPost.json, propPost.content);

    await confirm(
      async () => {
        const p = await getPost(miner, propPostRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Maturity bind: root height must be strictly less than current height.
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Submit the withdrawal to `peer`, which never mines.
    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const withdrawTx = buildPostWithdrawTx(alice, karmaBoxes(aliceK2), propPostRes.postId, aliceK2.height);
    await postPostWithdraw(peer, propPostRes.postId, withdrawTx.json);

    await confirm(
      async () => {
        const p = await getPost(miner, propPostRes.postId);
        return p !== null && isWithdrawn(p);
      },
      miner, mesh.miningSecret, 5,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const p = await getPost(node, propPostRes.postId);
      expect(p).not.toBeNull();
      expect(isWithdrawn(p!)).toBe(true);
      if (isWithdrawn(p!)) {
        expect(p.kind).toBe('withdrawn');
        expect(p.withdrawnAtHeight).toBeGreaterThan(0);
      }
    }

    // ---- B: like(P) and withdraw(P) in one block ----
    // Two identities, two transactions in flight, one block. The phase move
    // (§5) makes this a valid block; without it the pair rejects.

    const aliceK3 = (await getKarma(miner, alice.publicKeyHex))!;
    const coexPost = buildThreadTx(alice, karmaBoxes(aliceK3), 'coexistence target', aliceK3.height);
    const coexPostRes = await postPost(miner, coexPost.json, coexPost.content);

    await confirm(
      async () => {
        const p = await getPost(miner, coexPostRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Bob likes, alice withdraws — both submitted before mining.
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const likeTx = buildLikeTx(bob, karmaBoxes(bobK), coexPostRes.postId, alice.publicKeyHex, bobK.height);
    await postLike(miner, likeTx.json);

    const aliceK4 = (await getKarma(miner, alice.publicKeyHex))!;
    const coexWithdraw = buildPostWithdrawTx(alice, karmaBoxes(aliceK4), coexPostRes.postId, aliceK4.height);
    await postPostWithdraw(miner, coexPostRes.postId, coexWithdraw.json);

    await confirm(
      async () => {
        const p = await getPost(miner, coexPostRes.postId);
        return p !== null && isWithdrawn(p);
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // The post is withdrawn on all nodes.
    for (const node of mesh.nodes) {
      const p = await getPost(node, coexPostRes.postId);
      expect(p).not.toBeNull();
      expect(isWithdrawn(p!)).toBe(true);
    }

    // The like consumed bob's karma — it counted.
    const bobKAfter = (await getKarma(miner, bob.publicKeyHex))!;
    expect(BigInt(bobKAfter.total)).toBeLessThan(BigInt(bobK.total));

    // ---- C: content resurrection guard ----
    // A withdrawn post's content must NOT be refetched from a peer. The
    // backfill path (`getMissingBodies` → peer request → `setPostBody`) runs
    // on every block; §8's SQL guards stop it from selecting a withdrawn row.

    const aliceK5 = (await getKarma(miner, alice.publicKeyHex))!;
    const guardPost = buildThreadTx(alice, karmaBoxes(aliceK5), 'resurrection guard target', aliceK5.height);
    const guardPostRes = await postPost(miner, guardPost.json, guardPost.content);

    await confirm(
      async () => {
        const p = await getPost(miner, guardPostRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Verify content is present on all nodes before withdrawal.
    for (const node of mesh.nodes) {
      const p = await getPost(node, guardPostRes.postId);
      expect(p).not.toBeNull();
      expect(isPost(p!)).toBe(true);
      if (isPost(p!)) {
        expect(p.content).toBe('resurrection guard target');
      }
    }

    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const aliceK6 = (await getKarma(miner, alice.publicKeyHex))!;
    const guardWithdraw = buildPostWithdrawTx(alice, karmaBoxes(aliceK6), guardPostRes.postId, aliceK6.height);
    await postPostWithdraw(miner, guardPostRes.postId, guardWithdraw.json);

    await confirm(
      async () => {
        const p = await getPost(miner, guardPostRes.postId);
        return p !== null && isWithdrawn(p);
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // Mine several more blocks to give the backfill rounds a real chance to
    // fire. Each block triggers `getMissingBodies`; if the SQL guard is
    // missing, a peer still holding the bytes would refill the content.
    await mine(miner, mesh.miningSecret, 3);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const p = await getPost(node, guardPostRes.postId);
      expect(p).not.toBeNull();
      expect(isWithdrawn(p!)).toBe(true);
      if (isWithdrawn(p!)) {
        expect(p.kind).toBe('withdrawn');
      }
    }

    // ---- non-author withdrawal → 400 ----
    const aliceK7 = (await getKarma(miner, alice.publicKeyHex))!;
    const bobTarget = buildThreadTx(alice, karmaBoxes(aliceK7), 'bob target', aliceK7.height);
    const bobTargetRes = await postPost(miner, bobTarget.json, bobTarget.content);

    await confirm(
      async () => {
        const p = await getPost(miner, bobTargetRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const bobK2 = (await getKarma(miner, bob.publicKeyHex))!;
    const fakeWithdraw = buildPostWithdrawTx(bob, karmaBoxes(bobK2), bobTargetRes.postId, bobK2.height);
    try {
      await postPostWithdraw(miner, bobTargetRes.postId, fakeWithdraw.json);
      expect.fail('non-author withdrawal should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- maturity bind: withdrawal of an unconfirmed post → 400 ----
    const aliceK8 = (await getKarma(miner, alice.publicKeyHex))!;
    const immPost = buildThreadTx(alice, karmaBoxes(aliceK8), 'immediate withdraw', aliceK8.height);
    const immPostRes = await postPost(miner, immPost.json, immPost.content);

    const immWithdraw = buildPostWithdrawTx(alice, [immPost.outputs[0]!], immPostRes.postId, aliceK8.height);
    try {
      await postPostWithdraw(miner, immPostRes.postId, immWithdraw.json);
      expect.fail('withdrawal of an unconfirmed post should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }
  });
});
