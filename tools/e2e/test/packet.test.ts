import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  getKarma,
  getPost,
  getBlockCurrent,
  NodeError,
  isPost,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 7;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('packet', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row a: pending-with-content on origin, confirmed after block, mismatched body → 400', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice ----
    const alice = fresh();
    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height);
    await postInvite(miner, inv.json);

    await confirm(
      async () => (await getKarma(miner, alice.publicKeyHex)) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice posts a thread on the miner (no mining — stays pending) ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'packet post', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);
    expect(threadRes.status).toBe('pending');

    // ---- pending-with-content on the origin (miner) ----
    // FINDING: gossip tx relay does not deliver post transactions to relay
    // nodes — karmaMembers is never populated in the node, so the topic
    // validator rejects every post with "post author holds no karma".
    const minerPost = await getPost(miner, threadRes.postId);
    expect(minerPost).not.toBeNull();
    expect(isPost(minerPost!)).toBe(true);
    if (isPost(minerPost!)) {
      expect(minerPost.status).toBe('pending');
      expect(minerPost.content).toBe('packet post');
    }

    // ---- mine a block, confirmed on the miner with content ----
    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const confirmedMiner = await getPost(miner, threadRes.postId);
    expect(confirmedMiner).not.toBeNull();
    expect(isPost(confirmedMiner!)).toBe(true);
    let minerContentHash = '';
    if (isPost(confirmedMiner!)) {
      expect(confirmedMiner.status).toBe('confirmed');
      expect(confirmedMiner.content).toBe('packet post');
      minerContentHash = confirmedMiner.contentHash;
    }

    // Non-miner nodes: confirmed as placeholders (content null) — the
    // block carries PostCommit, not the body. Gossip relay and backfill
    // are both broken (see REPORT findings).
    for (const node of mesh.nodes.slice(1)) {
      const p = await getPost(node, threadRes.postId);
      expect(p).not.toBeNull();
      expect(isPost(p!)).toBe(true);
      if (isPost(p!)) {
        expect(p.status).toBe('confirmed');
        expect(p.contentHash).toBe(minerContentHash);
      }
    }

    // ---- mismatched body → 400 ----
    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const bad = buildThreadTx(alice, karmaBoxes(aliceK2), 'correct body', aliceK2.height);
    try {
      await postPost(miner, bad.json, 'wrong body');
      expect.fail('mismatched body should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }
  });
});
