import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import { buildPruneTx } from '../src/tx/prune.js';
import {
  postInvite,
  postPost,
  postPrune,
  getKarma,
  getPost,
  getBlockCurrent,
  NodeError,
  isPost,
  isStump,
  isPruned,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 1;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('prune', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row b-prune: prune transaction reaches consensus via gossip, stump and pruned shapes, non-author rejection, same-block rejection', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;
    const peer = mesh.nodes[1]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice (the author) and bob (the non-author) ----
    const alice = fresh();
    const bob = fresh();
    const bondAmount = 50n;

    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, bondAmount, faucetK.height);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], bob, bondAmount, faucetK.height);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => (await getKarma(miner, alice.publicKeyHex)) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice posts a thread with two replies ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'prune root', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);

    const reply1 = buildReplyTx(alice, [thread.outputs[0]!], 'reply 1', threadRes.postId, aliceK.height);
    const reply1Res = await postPost(miner, reply1.json, reply1.content);

    const reply2 = buildReplyTx(alice, [reply1.outputs[0]!], 'reply 2', threadRes.postId, aliceK.height);
    const reply2Res = await postPost(miner, reply2.json, reply2.content);

    // ---- bob posts a thread (for the non-author test later) ----
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const bobThread = buildThreadTx(bob, karmaBoxes(bobK), 'bob thread', bobK.height);
    const bobThreadRes = await postPost(miner, bobThread.json, bobThread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // The maturity bind requires rootHeight < currentHeight.
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice prunes her thread ----
    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const subtreePostIds = [threadRes.postId, reply1Res.postId, reply2Res.postId];
    const pruneTx = buildPruneTx(alice, karmaBoxes(aliceK2), threadRes.postId, subtreePostIds, aliceK2.height);
    await postPrune(miner, threadRes.postId, pruneTx.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isStump(p);
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- pruned root reads as StumpJson on all nodes ----
    for (const node of mesh.nodes) {
      const rootPost = await getPost(node, threadRes.postId);
      expect(rootPost).not.toBeNull();
      expect(isStump(rootPost!)).toBe(true);
      if (isStump(rootPost!)) {
        expect(rootPost.kind).toBe('stump');
        expect(rootPost.compactedAtBlockHeight).toBeGreaterThan(0);
      }
    }

    // ---- pruned replies: kind 'pruned' with rootPostHash and compactedAtBlockHeight ----
    const minerRoot = await getPost(miner, threadRes.postId);
    expect(isStump(minerRoot!)).toBe(true);
    const rootHeight = isStump(minerRoot!) ? minerRoot.compactedAtBlockHeight : -1;

    for (const node of mesh.nodes) {
      const r1 = await getPost(node, reply1Res.postId);
      expect(r1).not.toBeNull();
      expect(isPruned(r1!)).toBe(true);
      if (isPruned(r1!)) {
        expect(r1.rootPostHash).toBe(threadRes.postId);
        expect(r1.compactedAtBlockHeight).toBe(rootHeight);
      }

      const r2 = await getPost(node, reply2Res.postId);
      expect(r2).not.toBeNull();
      expect(isPruned(r2!)).toBe(true);
      if (isPruned(r2!)) {
        expect(r2.rootPostHash).toBe(threadRes.postId);
        expect(r2.compactedAtBlockHeight).toBe(rootHeight);
      }
    }

    // ---- non-author prune → 400 ----
    // Authorship is the transition arm's `inputKarma.owner === topologyAuthor`.
    // validateTx fires before the transaction is pooled, so the route rejects
    // outright — the prune never enters the mempool.
    const aliceK3 = (await getKarma(miner, alice.publicKeyHex))!;
    const fakePrune = buildPruneTx(alice, karmaBoxes(aliceK3), bobThreadRes.postId, [bobThreadRes.postId], aliceK3.height);
    try {
      await postPrune(miner, bobThreadRes.postId, fakePrune.json);
      expect.fail('non-author prune should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- PROPAGATION: prune submitted to a non-mining node reaches consensus ----
    //
    // A prune is an ordinary transaction, so the route broadcasts it and it
    // gossips to every peer's pool; whichever node mines includes it. This pins
    // the GOSSIP PATH, not the route: the submit below goes to `peer`, which
    // never mines, and the stump is asserted on `miner` and then on every node.
    // ⚠ **If this goes red, propagation broke** — a route change alone would
    // fail the submit, not the mesh-wide stump.
    const aliceK4 = (await getKarma(miner, alice.publicKeyHex))!;
    const propThread = buildThreadTx(alice, karmaBoxes(aliceK4), 'propagation root', aliceK4.height);
    const propThreadRes = await postPost(miner, propThread.json, propThread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, propThreadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const aliceK5 = (await getKarma(miner, alice.publicKeyHex))!;
    const propPruneTx = buildPruneTx(alice, karmaBoxes(aliceK5), propThreadRes.postId, [propThreadRes.postId], aliceK5.height);
    await postPrune(peer, propThreadRes.postId, propPruneTx.json);

    await confirm(
      async () => {
        const p = await getPost(miner, propThreadRes.postId);
        return p !== null && isStump(p);
      },
      miner, mesh.miningSecret, 5,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const p = await getPost(node, propThreadRes.postId);
      expect(p).not.toBeNull();
      expect(isStump(p!)).toBe(true);
    }

    // ---- SAME-BLOCK REJECTION: prune of an unconfirmed post ----
    // The maturity bind requires the root's topology height to be strictly less
    // than the current height. An unconfirmed post has no topology entry, so the
    // route rejects the prune.
    const aliceK7 = (await getKarma(miner, alice.publicKeyHex))!;
    const immThread = buildThreadTx(alice, karmaBoxes(aliceK7), 'immediate prune', aliceK7.height);
    const immThreadRes = await postPost(miner, immThread.json, immThread.content);

    const immPruneTx = buildPruneTx(alice, [immThread.outputs[0]!], immThreadRes.postId, [immThreadRes.postId], aliceK7.height);
    try {
      await postPrune(miner, immThreadRes.postId, immPruneTx.json);
      expect.fail('prune of an unconfirmed post should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }
  });
});
