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
  getStatus,
  hasKarma,
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

  it('row a: pending-with-content on every node, confirmed after block, mismatched body → 400', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice ----
    const version = (await getStatus(miner)).protocolVersion;
    const alice = fresh();
    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height, version);
    await postInvite(miner, inv.json);

    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- alice posts a thread on the miner (no mining — stays pending) ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'packet post', aliceK.height, version);
    const threadRes = await postPost(miner, thread.json, thread.content);
    expect(threadRes.status).toBe('pending');

    // ---- pending-with-content on every node (origin + relay) before any block ----
    for (const node of mesh.nodes) {
      const deadline = Date.now() + 10_000;
      let found = false;
      while (Date.now() < deadline) {
        const p = await getPost(node, threadRes.postId);
        if (p !== null && isPost(p) && p.status === 'pending' && p.content !== null) {
          expect(p.content).toBe('packet post');
          found = true;
          break;
        }
        await new Promise(r => setTimeout(r, 50));
      }
      if (!found) {
        throw new Error(
          `Post not pending-with-content on :${node.httpPort} within 10s`,
        );
      }
    }

    // ---- mine a block, confirmed everywhere with content ----
    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const p = await getPost(node, threadRes.postId);
      expect(p).not.toBeNull();
      expect(isPost(p!)).toBe(true);
      if (isPost(p!)) {
        expect(p.status).toBe('confirmed');
        expect(p.content).toBe('packet post');
      }
    }

    // ---- mismatched body → 400 ----
    const aliceK2 = (await getKarma(miner, alice.publicKeyHex))!;
    const bad = buildThreadTx(alice, karmaBoxes(aliceK2), 'correct body', aliceK2.height, version);
    try {
      await postPost(miner, bad.json, 'wrong body');
      expect.fail('mismatched body should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }
  });
});
