import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import { buildPruneIntent } from '../src/tx/prune.js';
import {
  postInvite,
  postPost,
  postPrune,
  getKarma,
  getPost,
  getBlock,
  getBlockCurrent,
  NodeError,
  isPost,
  type StumpResponse,
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

  it('row b-prune: author prune reads StumpJson, non-author prune → 403', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

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
    const threadRes = await postPost(miner, thread.json);

    const reply1 = buildReplyTx(alice, [thread.outputs[0]!], 'reply 1', threadRes.postId, aliceK.height);
    const reply1Res = await postPost(miner, reply1.json);

    const reply2 = buildReplyTx(alice, [reply1.outputs[0]!], 'reply 2', threadRes.postId, aliceK.height);
    const reply2Res = await postPost(miner, reply2.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice prunes her thread ----
    const subtreePostIds = [threadRes.postId, reply1Res.postId, reply2Res.postId];
    const pruneIntent = buildPruneIntent(alice, threadRes.postId, subtreePostIds);
    await postPrune(miner, threadRes.postId, pruneIntent);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && 'kind' in p && (p as StumpResponse).kind === 'stump';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- pruned root reads as StumpJson on all nodes ----
    for (const node of mesh.nodes) {
      const rootPost = await getPost(node, threadRes.postId);
      expect(rootPost).not.toBeNull();
      expect('kind' in rootPost!).toBe(true);
      expect((rootPost as StumpResponse).kind).toBe('stump');
    }

    // ---- the block carries the prune entry ----
    const pruneHeight = (await getBlockCurrent(miner)).height;
    for (const node of mesh.nodes) {
      const block = await getBlock(node, pruneHeight);
      expect(block).not.toBeNull();
      const tree = (block as Record<string, unknown>)['utxoTxTree'] as {
        pruneEntries: unknown[];
      };
      expect(tree.pruneEntries.length).toBeGreaterThanOrEqual(1);
    }

    // ---- pruned replies: pin what the node returns ----
    for (const node of mesh.nodes) {
      const r1 = await getPost(node, reply1Res.postId);
      const r2 = await getPost(node, reply2Res.postId);
      // pin: pruned replies return null (404)
      expect(r1).toBeNull();
      expect(r2).toBeNull();
    }

    // ---- non-author prune → 403 ----
    // bob creates a thread, alice tries to prune it
    const bobK = (await getKarma(miner, bob.publicKeyHex))!;
    const bobThread = buildThreadTx(bob, karmaBoxes(bobK), 'bob thread', bobK.height);
    const bobThreadRes = await postPost(miner, bobThread.json);

    await confirm(
      async () => {
        const p = await getPost(miner, bobThreadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );

    const fakePrune = buildPruneIntent(alice, bobThreadRes.postId, [bobThreadRes.postId]);
    try {
      await postPrune(miner, bobThreadRes.postId, fakePrune);
      expect.fail('non-author prune should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(403);
    }
  });
});
