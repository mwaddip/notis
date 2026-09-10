import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import { buildClaimTx } from '../src/tx/claim.js';
import { buildBurnTx } from '../src/tx/burn.js';
import {
  postInvite,
  postPost,
  postClaim,
  postBurn,
  getKarma,
  getStatus,
  hasKarma,
  getPost,
  getUsername,
  getUsernameByOwner,
  getVouchesTarget,
  getBlockCurrent,
  NodeError,
  isPost,
} from '../src/http.js';
import { USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 19;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('usernames', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('claim, alias resolution, authorName, collision, burn, restored claim, pending gate', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const miner = mesh.nodes[0]!;
    const peer = mesh.nodes[1]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    const tips = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const tip of tips) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toBe(tips[0]!.hash);
    }

    const block1s = await Promise.all(
      mesh.nodes.map(async (n) => {
        const res = await fetch(`${n.url}/blocks/1`);
        expect(res.ok).toBe(true);
        return (await res.json()) as { header: { stateRoot: string } };
      }),
    );
    for (const b of block1s) {
      expect(b.header.stateRoot).toBe(block1s[0]!.header.stateRoot);
    }

    const version = (await getStatus(miner)).protocolVersion;

    // ---- invite A and B ----
    const A = fresh();
    const B = fresh();
    const bondAmount = 50n;

    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), A, bondAmount, faucetK.height, version);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], B, bondAmount, faucetK.height, version);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => await hasKarma(miner, B.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const statusBeforeClaim = await getStatus(miner);
    const usernameCountBefore = statusBeforeClaim.usernameCount;

    // ---- A claims Alice_01 on node 1 ----
    const aK = (await getKarma(miner, A.publicKeyHex))!;
    const claim1 = buildClaimTx(A, karmaBoxes(aK), 'Alice_01', aK.height, version);
    await postClaim(miner, claim1.json);

    await confirm(
      async () => (await getUsername(miner, 'alice_01')) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- GET /usernames/@alice on node 2 — with and without @ ----
    // NODE_INTERFACE → Usernames
    for (const name of ['@alice_01', 'alice_01', '@Alice_01', 'Alice_01']) {
      const u = await getUsername(peer, name);
      expect(u).not.toBeNull();
      expect(u!.name).toBe('Alice_01');
      expect(u!.owner).toBe(A.publicKeyHex);
      expect(u!.boxId).toBeTruthy();
      expect(u!.claimedAtBlock).toBeGreaterThan(0);
    }

    // ---- GET /usernames?owner=<A> on peer ----
    const byOwner = await getUsernameByOwner(peer, A.publicKeyHex);
    expect(byOwner).not.toBeNull();
    expect(byOwner!.name).toBe('Alice_01');

    // ---- usernameCount rose ----
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.usernameCount).toBe(usernameCountBefore + 1);
    }

    // ---- alias resolves on a read parameter: GET /karma/@ALICE_01 on peer ----
    // NODE_INTERFACE → Identity parameters
    const karmaByAlias = (await getKarma(peer, '@ALICE_01'))!;
    expect(karmaByAlias.boxCount).toBeGreaterThan(0);
    expect(BigInt(karmaByAlias.total)).toBe(BigInt((await getKarma(peer, A.publicKeyHex)).total));

    // ---- GET /vouches?target=@alice_01 answers ----
    const vByAlias = await getVouchesTarget(peer, '@alice_01');
    expect(vByAlias.count).toBe(0);

    // ---- unknown handle → 404 ----
    try {
      await getKarma(peer, '@nobody');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(404);
    }

    // ---- malformed handle → 400 ----
    try {
      await getKarma(peer, '@a-b');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- case-insensitive collision: B claims ALICE_01 → 400 ----
    const bK = (await getKarma(miner, B.publicKeyHex))!;
    const collisionTx = buildClaimTx(B, karmaBoxes(bK), 'ALICE_01', bK.height, version);
    try {
      await postClaim(miner, collisionTx.json);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- lowercase collision too ----
    const bK2 = (await getKarma(miner, B.publicKeyHex))!;
    const collisionTx2 = buildClaimTx(B, karmaBoxes(bK2), 'alice_01', bK2.height, version);
    try {
      await postClaim(miner, collisionTx2.json);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- one per identity: A claims another name → 400 ----
    const aK2 = (await getKarma(miner, A.publicKeyHex))!;
    const secondClaim = buildClaimTx(A, karmaBoxes(aK2), 'AnotherName', aK2.height, version);
    try {
      await postClaim(miner, secondClaim.json);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- authorName rides the post row ----
    // NODE_INTERFACE → Usernames
    const aK3 = (await getKarma(miner, A.publicKeyHex))!;
    const postA = buildThreadTx(A, karmaBoxes(aK3), 'alice post', aK3.height, version);
    const postARes = await postPost(miner, postA.json, postA.content);

    const bK3 = (await getKarma(miner, B.publicKeyHex))!;
    const postB = buildThreadTx(B, karmaBoxes(bK3), 'bob post', bK3.height, version);
    const postBRes = await postPost(miner, postB.json, postB.content);

    await confirm(
      async () => {
        const p = await getPost(miner, postBRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const pA = await getPost(node, postARes.postId);
      expect(pA).not.toBeNull();
      expect(isPost(pA!)).toBe(true);
      if (isPost(pA!)) {
        expect(pA.authorName).toBe('Alice_01');
      }

      const pB = await getPost(node, postBRes.postId);
      expect(pB).not.toBeNull();
      expect(isPost(pB!)).toBe(true);
      if (isPost(pB!)) {
        expect(pB.authorName).toBeNull();
      }
    }

    // ---- the burn: A burns for USERNAME_BURN_PRICE ----
    // NODE_INTERFACE → Username transition rules
    const aK4 = (await getKarma(miner, A.publicKeyHex))!;
    const aKarmaBefore = BigInt(aK4.total);
    const usernameEntry = await getUsername(miner, 'alice_01');
    expect(usernameEntry).not.toBeNull();

    const burnTx = buildBurnTx(A, karmaBoxes(aK4), usernameEntry!.boxId, aK4.height, version);
    await postBurn(miner, 'alice_01', burnTx.json);

    await confirm(
      async () => (await getUsername(miner, 'alice_01')) === null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- GET /usernames/@alice_01 is 404 on both ----
    for (const node of mesh.nodes) {
      const u = await getUsername(node, 'alice_01');
      expect(u).toBeNull();
    }

    // ---- A's karma fell by exactly USERNAME_BURN_PRICE ----
    for (const node of mesh.nodes) {
      const ak = await getKarma(node, A.publicKeyHex);
      expect(BigInt(ak.total)).toBe(aKarmaBefore - USERNAME_BURN_PRICE);
    }

    // ---- usernameCount fell by one ----
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.usernameCount).toBe(usernameCountBefore);
    }

    // ---- the restored claim: B claims alice_01 ----
    // ARCHITECTURE → Usernames
    const bK4 = (await getKarma(miner, B.publicKeyHex))!;
    const bClaim = buildClaimTx(B, karmaBoxes(bK4), 'alice_01', bK4.height, version);
    await postClaim(miner, bClaim.json);

    await confirm(
      async () => (await getUsername(miner, 'alice_01')) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const bName = await getUsername(miner, 'alice_01');
    expect(bName).not.toBeNull();
    expect(bName!.owner).toBe(B.publicKeyHex);
    expect(bName!.name).toBe('alice_01');

    // ---- A's free claim is restored by the burn: A claims Alice_02 ----
    const aK5 = (await getKarma(miner, A.publicKeyHex))!;
    const aClaim2 = buildClaimTx(A, karmaBoxes(aK5), 'Alice_02', aK5.height, version);
    await postClaim(miner, aClaim2.json);

    await confirm(
      async () => (await getUsername(peer, 'alice_02')) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const aName2 = await getUsername(peer, 'alice_02');
    expect(aName2).not.toBeNull();
    expect(aName2!.owner).toBe(A.publicKeyHex);

    // ---- the pending gate: two claims of one canonical name before a block → 409 ----
    // NODE_INTERFACE → Usernames
    const C = fresh();
    const D = fresh();
    const faucetK2 = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv3 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK2), C, bondAmount, faucetK2.height, version);
    await postInvite(miner, inv3.json);
    const inv4 = buildInviteTx(DEVNET_FAUCET, [inv3.outputs[0]!], D, bondAmount, faucetK2.height, version);
    await postInvite(miner, inv4.json);

    await confirm(
      async () => await hasKarma(miner, D.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    const cK = (await getKarma(miner, C.publicKeyHex))!;
    const pendingClaim = buildClaimTx(C, karmaBoxes(cK), 'PendingName', cK.height, version);
    await postClaim(miner, pendingClaim.json);

    const dK = (await getKarma(miner, D.publicKeyHex))!;
    const pendingDup = buildClaimTx(D, karmaBoxes(dK), 'pendingname', dK.height, version);
    try {
      await postClaim(miner, pendingDup.json);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(409);
    }
  });
});
