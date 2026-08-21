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
  getBlock,
  getBlockCurrent,
  isPost,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 3;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('sync', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row b-sync: late joiner syncs to height h with posts', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite and post ----
    const alice = fresh();
    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height);
    await postInvite(miner, inv.json);

    await confirm(
      async () => (await getKarma(miner, alice.publicKeyHex)) !== null,
      miner, mesh.miningSecret,
    );

    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'synced post', aliceK.height);
    const threadRes = await postPost(miner, thread.json);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );

    // ---- mine to height >= 10 ----
    const currentTip = (await getBlockCurrent(miner)).height;
    const targetHeight = Math.max(10, currentTip);
    if (currentTip < targetHeight) {
      await mine(miner, mesh.miningSecret, targetHeight - currentTip);
    }
    await waitHeight(mesh.nodes, targetHeight);

    // ---- add late joiner ----
    const lateNode = await mesh.addNode();
    await waitHeight([lateNode], targetHeight);

    // ---- late joiner has all blocks ----
    const node1 = mesh.nodes[0]!;
    for (let h = 1; h <= targetHeight; h++) {
      const b1 = await getBlock(node1, h);
      const bLate = await getBlock(lateNode, h);
      expect(b1).not.toBeNull();
      expect(bLate).not.toBeNull();
      const h1 = (b1 as Record<string, unknown>)['header'] as { stateRoot: string };
      const hLate = (bLate as Record<string, unknown>)['header'] as { stateRoot: string };
      expect(hLate.stateRoot).toBe(h1.stateRoot);
    }

    // ---- post confirmed before join reads confirmed on late joiner ----
    const latePost = await getPost(lateNode, threadRes.postId);
    expect(latePost).not.toBeNull();
    expect(isPost(latePost!)).toBe(true);
    if (isPost(latePost!)) {
      expect(latePost.status).toBe('confirmed');
    }
  });
});
