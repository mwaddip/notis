import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import { signAndRender, type BoxRef } from '../src/tx/render.js';
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
import { POST_PRICE_THREAD, computeContentHash } from '@dagsocial/types';

const FILE_INDEX = 14;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string; income?: true }[] },
): BoxRef[] {
  return karma.boxes.map((b) =>
    b.income === true
      ? { boxId: b.boxId, value: BigInt(b.value), income: true }
      : { boxId: b.boxId, value: BigInt(b.value) },
  );
}

describe('zero-change', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('an exact spend leaves no karma box, and karma(0) is refused', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);
    const tip = await getBlockCurrent(miner);
    expect(tip.height).toBe(1);

    const version = (await getStatus(miner)).protocolVersion;

    // ---- faucet invites alice with bond 5 (inviteBondMin), grant is 5 ----
    const alice = fresh();
    const bondAmount = 5n;
    const faucetK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetK),
      alice,
      bondAmount,
      faucetK.height,
      version,
    );
    await postInvite(miner, invite.json);

    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner,
      mesh.miningSecret,
    );

    // ---- alice's grant equals the price ----
    const aliceK = await getKarma(miner, alice.publicKeyHex);
    expect(BigInt(aliceK.total)).toBe(bondAmount);
    expect(bondAmount).toBe(POST_PRICE_THREAD);
    expect(aliceK.boxes.length).toBe(1);
    const aliceBox = aliceK.boxes[0]!;

    // ---- karma(0) is refused ----
    // NODE_INTERFACE → Karma transition rules → "A karma output carries at
    // least `1n`, and the change output is optional". A single-karma-output
    // thread that would conserve — alice's own box in, a karma_price for the
    // whole price, and one karma output valued `0n` — meets rule 1 and rule
    // 3; the zero-value guard answers it.
    const aliceOwner = Buffer.from(alice.publicKeyHex, 'hex');
    const probeContent = 'karma zero probe';
    const probeTx = signAndRender(alice, {
      inputs: [aliceBox.boxId],
      outputs: [
        { boxType: 'karma', value: 0n, createdAtBlock: aliceK.height, owner: aliceOwner },
        { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: aliceK.height },
      ],
      signatures: {},
      protocolVersion: version,
      post: {
        contentHash: computeContentHash(probeContent),
        author: aliceOwner,
        parentRefs: [],
        protocolVersion: version,
        type: 'regular' as const,
      },
    });
    try {
      await postPost(miner, probeTx.json, probeContent);
      expect.fail('a karma output of value 0n should have been refused');
    } catch (e) {
      expect(e).toBeInstanceOf(NodeError);
      const err = e as NodeError;
      expect(err.status).toBe(400);
      expect(err.body['reason']).toBe(
        'A zero-value karma output is not created; zero means no box',
      );
    }

    // ---- exact spend: thread price exhausts alice's karma ----
    // NODE_INTERFACE → Karma transition rules — a karma output carries at
    // least 1n and the change output is optional; an exact spend emits no
    // karma output, so the thread body is the karma_price alone.
    const thread = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'exact spend',
      aliceK.height,
      version,
    );
    expect(thread.outputs.length).toBe(1);

    const postRes = await postPost(miner, thread.json, thread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, postRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner,
      mesh.miningSecret,
    );

    // ---- after the exact spend alice holds no karma boxes ----
    const confirmedPost = await getPost(miner, postRes.postId);
    expect(confirmedPost).not.toBeNull();
    expect(isPost(confirmedPost!)).toBe(true);
    const postHeight = (confirmedPost as { blockHeight: number }).blockHeight;

    const aliceAfter = await getKarma(miner, alice.publicKeyHex);
    expect(aliceAfter.boxCount).toBe(0);
    expect(aliceAfter.total).toBe('0');
    expect(aliceAfter.lastActivityBlock).toBe(postHeight);
  });
});
