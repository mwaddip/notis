import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import { buildPruneTx } from '../src/tx/prune.js';
import {
  MAX_POST_LOCK_RELEASES_PER_BLOCK,
  POST_LOCK_REPLY_COST,
} from '@dagsocial/types';
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
import type { Identity } from '../src/identities.js';

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
    const pruneTx = buildPruneTx(alice, karmaBoxes(aliceK2), threadRes.postId, aliceK2.height);
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
    // NODE_INTERFACE → Prune transactions
    const aliceK3 = (await getKarma(miner, alice.publicKeyHex))!;
    const fakePrune = buildPruneTx(alice, karmaBoxes(aliceK3), bobThreadRes.postId, aliceK3.height);
    try {
      await postPrune(miner, bobThreadRes.postId, fakePrune.json);
      expect.fail('non-author prune should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- PROPAGATION: prune submitted to a non-mining node reaches consensus ----
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
    const propPruneTx = buildPruneTx(alice, karmaBoxes(aliceK5), propThreadRes.postId, aliceK5.height);
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
    // NODE_INTERFACE → Prune transactions
    const aliceK7 = (await getKarma(miner, alice.publicKeyHex))!;
    const immThread = buildThreadTx(alice, karmaBoxes(aliceK7), 'immediate prune', aliceK7.height);
    const immThreadRes = await postPost(miner, immThread.json, immThread.content);

    const immPruneTx = buildPruneTx(alice, [immThread.outputs[0]!], immThreadRes.postId, aliceK7.height);
    try {
      await postPrune(miner, immThreadRes.postId, immPruneTx.json);
      expect.fail('prune of an unconfirmed post should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    await mesh.teardown();
  });

  it('reply and prune in one block: same-block reply is in the derived set, stump replyCount counts it', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice (author) and bob (replier) ----
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

    // ---- alice posts a thread with one reply ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 't5 root', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);

    const reply1 = buildReplyTx(alice, [thread.outputs[0]!], 't5 reply1', threadRes.postId, aliceK.height);
    await postPost(miner, reply1.json, reply1.content);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // maturity bind
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- in one block: bob replies to the thread AND alice prunes it ----
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const bobReply = buildReplyTx(bob, karmaBoxes(bobK), 't5 bob reply', threadRes.postId, bobK.height);
    const bobReplyRes = await postPost(miner, bobReply.json, bobReply.content);

    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const pruneTx = buildPruneTx(alice, karmaBoxes(aliceK2), threadRes.postId, aliceK2.height);
    await postPrune(miner, threadRes.postId, pruneTx.json);

    // mine one block — both the reply and the prune land
    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isStump(p);
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- stump's replyCount counts bob's same-block reply ----
    // NODE_INTERFACE → Prune transactions: set is topology at apply, same-block
    // replies included (§5.3 step 2). replyCount = set size − 1.
    for (const node of mesh.nodes) {
      const root = await getPost(node, threadRes.postId);
      expect(root).not.toBeNull();
      expect(isStump(root!)).toBe(true);
      if (isStump(root!)) {
        // 3 posts in the set: root + alice's reply + bob's same-block reply
        // replyCount = set size - 1 = 2
        expect(root.replyCount).toBe(2);
      }
    }

    // ---- bob's post answers as a tombstone ----
    for (const node of mesh.nodes) {
      const bobPost = await getPost(node, bobReplyRes.postId);
      expect(bobPost).not.toBeNull();
      expect(isPruned(bobPost!)).toBe(true);
      if (isPruned(bobPost!)) {
        expect(bobPost.rootPostHash).toBe(threadRes.postId);
      }
    }

    await mesh.teardown();
  });

  it('release over blocks: post-lock releases drain in (pruned_at_height, post_id) order, capped per block', async () => {
    // NODE_INTERFACE → The post-lock settlement phase
    // TYPES_INTERFACE → Settlement caps
    const REPLY_COUNT = MAX_POST_LOCK_RELEASES_PER_BLOCK + 2; // 66 > 64

    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice (author) + REPLY_COUNT distinct repliers ----
    const alice = fresh();
    const repliers: Identity[] = [];
    const bondAmount = 25n;

    let faucetBox: BoxRef;
    {
      const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
      const invAlice = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, bondAmount, faucetK.height);
      await postInvite(miner, invAlice.json);
      faucetBox = invAlice.outputs[0]!;
    }

    for (let i = 0; i < REPLY_COUNT; i++) {
      const replier = fresh();
      repliers.push(replier);
      const inv = buildInviteTx(DEVNET_FAUCET, [faucetBox], replier, bondAmount, 1);
      await postInvite(miner, inv.json);
      faucetBox = inv.outputs[0]!;
    }

    await confirm(
      async () => (await getKarma(miner, repliers[repliers.length - 1]!.publicKeyHex)) !== null,
      miner, mesh.miningSecret, 5,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice posts a thread ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'release root', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- each replier replies to alice's thread ----
    // NODE_INTERFACE → Post transactions: each reply creates a post_lock box
    const replyPostIds: string[] = [];
    for (const replier of repliers) {
      const rK = (await getKarma(miner, replier.publicKeyHex))!;
      const reply = buildReplyTx(replier, karmaBoxes(rK), `reply by ${replier.publicKeyHex.slice(0, 8)}`, threadRes.postId, rK.height);
      const res = await postPost(miner, reply.json, reply.content);
      replyPostIds.push(res.postId);
    }

    await confirm(
      async () => {
        const p = await getPost(miner, replyPostIds[replyPostIds.length - 1]!);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret, 5,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- capture karma before prune ----
    const karmaBefore = new Map<string, bigint>();
    for (const replier of repliers) {
      const k = await getKarma(miner, replier.publicKeyHex);
      karmaBefore.set(replier.publicKeyHex, k ? BigInt(k.total) : 0n);
    }
    const aliceKBefore = await getKarma(miner, alice.publicKeyHex);
    const aliceTotalBefore = aliceKBefore ? BigInt(aliceKBefore.total) : 0n;

    // maturity bind
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice prunes her thread ----
    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const pruneTx = buildPruneTx(alice, karmaBoxes(aliceK2), threadRes.postId, aliceK2.height);
    await postPrune(miner, threadRes.postId, pruneTx.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isStump(p);
      },
      miner, mesh.miningSecret,
    );
    const pruneHeight = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, pruneHeight);

    // ---- in the prune's block: all replies are gone, all repliers' karma unchanged ----
    for (const node of mesh.nodes) {
      const root = await getPost(node, threadRes.postId);
      expect(isStump(root!)).toBe(true);
      for (const rid of replyPostIds) {
        const r = await getPost(node, rid);
        expect(isPruned(r!)).toBe(true);
      }
    }

    for (const replier of repliers) {
      const k = await getKarma(miner, replier.publicKeyHex);
      const before = karmaBefore.get(replier.publicKeyHex)!;
      expect(BigInt(k!.total)).toBe(before);
    }

    // ---- mine one block: first batch of releases ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // All candidate post_ids: replier locks + alice's thread lock.
    // NODE_INTERFACE → The post-lock settlement phase: order is
    // (pruned_at_height, post_id); all share pruned_at_height, so post_id
    // ascending is the tiebreaker. Alice's thread lock is a candidate whose
    // value goes to the pool (lock.owner === actor).
    const allCandidateIds = [threadRes.postId, ...replyPostIds].sort();
    const firstBatchIds = new Set(allCandidateIds.slice(0, MAX_POST_LOCK_RELEASES_PER_BLOCK));
    const aliceInFirstBatch = firstBatchIds.has(threadRes.postId);
    const expectedReplierRefundsFirst = MAX_POST_LOCK_RELEASES_PER_BLOCK - (aliceInFirstBatch ? 1 : 0);

    let releasedFirst = 0;
    for (const replier of repliers) {
      const k = await getKarma(miner, replier.publicKeyHex);
      const before = karmaBefore.get(replier.publicKeyHex)!;
      if (BigInt(k!.total) > before) releasedFirst++;
    }
    expect(releasedFirst).toBe(expectedReplierRefundsFirst);

    // ---- mine another block: remaining releases ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    let releasedTotal = 0;
    for (const replier of repliers) {
      const k = await getKarma(miner, replier.publicKeyHex);
      const before = karmaBefore.get(replier.publicKeyHex)!;
      if (BigInt(k!.total) > before) releasedTotal++;
    }
    expect(releasedTotal).toBe(REPLY_COUNT);

    // ---- karma conservation: each replier got POST_LOCK_REPLY_COST back ----
    for (const replier of repliers) {
      const k = await getKarma(miner, replier.publicKeyHex);
      const before = karmaBefore.get(replier.publicKeyHex)!;
      expect(BigInt(k!.total)).toBe(before + POST_LOCK_REPLY_COST);
    }

    // ---- alice's own lock: value goes to the pool, never returns ----
    // NODE_INTERFACE → The post-lock settlement phase
    const aliceKAfter = await getKarma(miner, alice.publicKeyHex);
    const aliceTotalAfter = aliceKAfter ? BigInt(aliceKAfter.total) : 0n;
    expect(aliceTotalAfter).toBeLessThanOrEqual(aliceTotalBefore);

    await mesh.teardown();
  }, 120_000);
});
