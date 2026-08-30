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
  isPost,
  getBlockCurrent,
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 8;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('mempool-cap', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  // MEMPOOL_INTERFACE → Size cap — reject, never evict
  // NODE_INTERFACE → Configuration: MAX_MEMPOOL_ENTRIES, class local
  it('a node started with MAX_MEMPOOL_ENTRIES=1 refuses the second pending post with 503', async () => {
    mesh = await createMesh({
      fileIndex: FILE_INDEX,
      nodeCount: 1,
      env: { MAX_MEMPOOL_ENTRIES: '1' },
    });
    const node = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(node, mesh.miningSecret, 1);
    await waitHeight([node], 1);
    const tip = await getBlockCurrent(node);
    expect(tip.height).toBe(1);

    const version = (await getStatus(node)).protocolVersion;

    // ---- invite alice (sequential: cap 1 allows one pending entry) ----
    const alice = fresh();
    const faucetKarma = (await getKarma(node, DEVNET_FAUCET.publicKeyHex))!;
    const inviteAlice = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      alice,
      50n,
      faucetKarma.height,
      version,
    );
    await postInvite(node, inviteAlice.json);
    await confirm(
      async () => await hasKarma(node, alice.publicKeyHex),
      node,
      mesh.miningSecret,
    );

    // ---- invite bob (re-read faucet karma: boxes changed) ----
    const bob = fresh();
    const faucetKarma2 = (await getKarma(node, DEVNET_FAUCET.publicKeyHex))!;
    const inviteBob = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma2),
      bob,
      50n,
      faucetKarma2.height,
      version,
    );
    await postInvite(node, inviteBob.json);
    await confirm(
      async () => await hasKarma(node, bob.publicKeyHex),
      node,
      mesh.miningSecret,
    );

    // ---- alice posts a thread: accepted, slot now full ----
    const aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const aliceThread = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'first pending post',
      aliceK.height,
      version,
    );
    const aliceRes = await postPost(node, aliceThread.json, aliceThread.content);
    expect(aliceRes.txId).toBeTruthy();

    // ---- bob posts a thread: valid tx, rejected at the capacity gate ----
    // MEMPOOL_INTERFACE → Eviction, inside the credit class only:
    // cap 1 -> 0 credit slots, 1 karma slot; posts bid null (karma class)
    const bobK = (await getKarma(node, bob.publicKeyHex))!;
    const bobThread = buildThreadTx(
      bob,
      karmaBoxes(bobK),
      'second pending post',
      bobK.height,
      version,
    );
    let rejection: NodeError | null = null;
    try {
      await postPost(node, bobThread.json, bobThread.content);
    } catch (err) {
      if (!(err instanceof NodeError)) throw err;
      rejection = err;
    }
    expect(rejection).not.toBeNull();
    expect(rejection!.status).toBe(503);
    expect(rejection!.body).toEqual({ error: 'mempool full' });

    // ---- control: confirm alice's post, then re-submit bob's same bytes ----
    // blockHeight non-null = post confirmed in a block, mempool slot freed
    await confirm(
      async () => {
        const post = await getPost(node, aliceRes.postId);
        return post !== null && isPost(post) && post.blockHeight !== null;
      },
      node,
      mesh.miningSecret,
    );
    const bobRetry = await postPost(node, bobThread.json, bobThread.content);
    expect(bobRetry.txId).toBeTruthy();
  });
});
