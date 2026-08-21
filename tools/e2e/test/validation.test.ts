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

const FILE_INDEX = 4;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('validation', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row b-validation: forged sig, malformed tx, double spend', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const [node1, node2] = mesh.nodes;

    // ---- mesh proof ----
    await mine(node1!, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite alice ----
    const alice = fresh();
    const faucetK = (await getKarma(node1!, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height);
    await postInvite(node1!, inv.json);

    await confirm(
      async () => (await getKarma(node1!, alice.publicKeyHex)) !== null,
      node1!, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(node1!)).height);

    // ---- forged signature → 400 ----
    const aliceK = (await getKarma(node1!, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'forged', aliceK.height);
    const forgedJson = { ...thread.json };
    const sigs = forgedJson['signatures'] as Record<string, string>;
    const sigKeys = Object.keys(sigs);
    sigs[sigKeys[0]!] = '00'.repeat(64);
    forgedJson['signatures'] = sigs;
    try {
      await postPost(node1!, forgedJson);
      expect.fail('forged signature should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- malformed tx → 400 ----
    try {
      await postPost(node1!, { inputs: [], outputs: [], protocolVersion: 1 });
      expect.fail('malformed tx should have been rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- double spend: same karma box on two nodes ----
    const aliceK2 = (await getKarma(node1!, alice.publicKeyHex))!;
    const boxes = karmaBoxes(aliceK2);

    const tx1 = buildThreadTx(alice, boxes, 'double spend A', aliceK2.height);
    const tx2 = buildThreadTx(alice, boxes, 'double spend B', aliceK2.height);

    const results = await Promise.allSettled([
      postPost(node1!, tx1.json),
      postPost(node2!, tx2.json),
    ]);

    const submitted: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') submitted.push(r.value.postId);
    }

    await mine(node1!, mesh.miningSecret, 5);
    await waitHeight(mesh.nodes, (await getBlockCurrent(node1!)).height);

    let confirmedCount = 0;
    for (const postId of submitted) {
      const p1 = await getPost(node1!, postId);
      const p2 = await getPost(node2!, postId);
      if (p1 !== null && isPost(p1) && p1.status === 'confirmed') confirmedCount++;
      if (p2 !== null && isPost(p2) && p2.status === 'confirmed') {
        expect(isPost(p1!)).toBe(true);
        if (isPost(p1!)) expect(p1.status).toBe('confirmed');
      }
    }
    expect(confirmedCount).toBeLessThanOrEqual(1);

    // ---- tips identical ----
    const finalTips = await Promise.all(mesh.nodes.map(getBlockCurrent));
    expect(finalTips[0]!.hash).toBe(finalTips[1]!.hash);
  });
});
