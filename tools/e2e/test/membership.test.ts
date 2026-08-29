import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildVouchTx, buildUnvouchTx } from '../src/tx/vouch.js';
import { buildThreadTx } from '../src/tx/post.js';
import { buildLikeTx } from '../src/tx/like.js';
import {
  postInvite,
  postPost,
  postLike,
  postVouch,
  deleteVouch,
  getVouchesTarget,
  getVouchesVoucher,
  getVouchCooldowns,
  getKarma,
  hasKarma,
  getStatus,
  getBlockCurrent,
  getPost,
  isPost,
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 16;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('membership', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('the faucet is a root, a member is earned, the cascade lapses both', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const miner = mesh.nodes[0]!;

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

    // ---- /status.membership reads { 1, 1, 2 } — the faucet is the root ----
    // ARCHITECTURE → Membership: devnet k=1, faucet is the one root, N=1
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(1);
      expect(s.membership.memberBar).toBe(1);
      expect(s.membership.memberLikesBar).toBe(2);
    }

    // ---- /karma/<faucet>: root, member: true, invitesAvailable: null ----
    // NODE_INTERFACE → UTXO queries: null for a root
    for (const node of mesh.nodes) {
      const fK = await getKarma(node, DEVNET_FAUCET.publicKeyHex);
      expect(fK.member).toBe(true);
      expect(fK.invitesAvailable).toBeNull();
      expect(fK.memberBar).toBe(0);
    }

    // ---- invite A ----
    const A = fresh();
    let fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const status0 = await getStatus(miner);
    const bondAmount = 50n;
    const invA = buildInviteTx(DEVNET_FAUCET, karmaBoxes(fK), A, bondAmount, fK.height);
    await postInvite(miner, invA.json);

    await confirm(
      async () => await hasKarma(miner, A.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- /karma/A: resident, member: false ----
    // NODE_INTERFACE → UTXO queries: memberSinceBlock 0 for a resident
    for (const node of mesh.nodes) {
      const aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(false);
      expect(aK.memberSinceBlock).toBe(0);
      expect(aK.invitesAvailable).toBe(0);
    }

    // ---- A's cast as a resident is refused ----
    // NODE_INTERFACE → Vouches: "a voucher who is not a member"
    const aKForVouch = await getKarma(miner, A.publicKeyHex);
    const badVouch = buildVouchTx(A, karmaBoxes(aKForVouch), DEVNET_FAUCET, aKForVouch.height);
    try {
      await postVouch(miner, badVouch.json);
      expect.fail('resident vouch should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- faucet vouches A ----
    fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const faucetVouchA = buildVouchTx(DEVNET_FAUCET, karmaBoxes(fK), A, fK.height);
    await postVouch(miner, faucetVouchA.json);

    await confirm(
      async () => (await getKarma(miner, A.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- A posts two threads ----
    let aK = await getKarma(miner, A.publicKeyHex);
    const thread1 = buildThreadTx(A, karmaBoxes(aK), 'm thread 1', aK.height);
    const t1Res = await postPost(miner, thread1.json, thread1.content);
    const thread2 = buildThreadTx(A, [thread1.outputs[0]!], 'm thread 2', aK.height);
    const t2Res = await postPost(miner, thread2.json, thread2.content);

    await confirm(
      async () => {
        const p = await getPost(miner, t2Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- faucet likes each post once ----
    // ARCHITECTURE → The like transaction: one like per (liker, post)
    fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const like1 = buildLikeTx(DEVNET_FAUCET, karmaBoxes(fK), t1Res.postId, A.publicKeyHex, fK.height);
    await postLike(miner, like1.json);
    const like2 = buildLikeTx(DEVNET_FAUCET, [like1.outputs[0]!], t2Res.postId, A.publicKeyHex, fK.height);
    await postLike(miner, like2.json);

    await confirm(
      async () => (await getKarma(miner, A.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    const setHeight = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, setHeight);

    // ---- A is a member ----
    // NODE_INTERFACE → Membership pass: memberSinceBlock = height of the setting block
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(true);
      expect(aK.memberSinceBlock).toBe(setHeight);
      expect(aK.memberBar).toBe(1);
      expect(aK.memberVouches).toBe(1);
      expect(aK.memberLikes).toBe('2');
      expect(aK.invitesAvailable).toBe(1);
      expect(aK.lifetimeLikesReceived).toBe('2');
    }

    // ---- /status.membership.memberCount is 2 ----
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }

    // ---- A invites B ----
    const B = fresh();
    aK = await getKarma(miner, A.publicKeyHex);
    const bBondAmount = 20n;
    const invB = buildInviteTx(A, karmaBoxes(aK), B, bBondAmount, aK.height);
    await postInvite(miner, invB.json);

    await confirm(
      async () => await hasKarma(miner, B.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- A's invitesUsed: 1, invitesAvailable: 0 ----
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.invitesUsed).toBe(1);
      expect(aK.invitesAvailable).toBe(0);
    }

    // ---- A's second invite is refused ----
    // NODE_INTERFACE → Invites: "the inviter is neither a root nor a member with an invite available"
    const C = fresh();
    aK = await getKarma(miner, A.publicKeyHex);
    const invC = buildInviteTx(A, karmaBoxes(aK), C, bBondAmount, aK.height);
    try {
      await postInvite(miner, invC.json);
      expect.fail('second invite should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- A vouches B, B posts two threads, A likes each ----
    aK = await getKarma(miner, A.publicKeyHex);
    const aVouchB = buildVouchTx(A, karmaBoxes(aK), B, aK.height);
    await postVouch(miner, aVouchB.json);

    await confirm(
      async () => (await getKarma(miner, B.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    let bK = await getKarma(miner, B.publicKeyHex);
    const bt1 = buildThreadTx(B, karmaBoxes(bK), 'b thread 1', bK.height);
    const bt1Res = await postPost(miner, bt1.json, bt1.content);
    const bt2 = buildThreadTx(B, [bt1.outputs[0]!], 'b thread 2', bK.height);
    const bt2Res = await postPost(miner, bt2.json, bt2.content);

    await confirm(
      async () => {
        const p = await getPost(miner, bt2Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // A likes each of B's posts (A is a member, so these are member-likes)
    aK = await getKarma(miner, A.publicKeyHex);
    const bLike1 = buildLikeTx(A, karmaBoxes(aK), bt1Res.postId, B.publicKeyHex, aK.height);
    await postLike(miner, bLike1.json);
    const bLike2 = buildLikeTx(A, [bLike1.outputs[0]!], bt2Res.postId, B.publicKeyHex, aK.height);
    await postLike(miner, bLike2.json);

    await confirm(
      async () => (await getKarma(miner, B.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- B is a member, memberCount is 3 ----
    for (const node of mesh.nodes) {
      bK = await getKarma(node, B.publicKeyHex);
      expect(bK.member).toBe(true);
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(3);
    }

    // ---- GET /vouches?voucher=A is a page ----
    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, A.publicKeyHex);
      expect(v.count).toBe(1);
      expect(v.next).toBeNull();
    }

    // ---- GET /vouches?target=B lists A ----
    for (const node of mesh.nodes) {
      const v = await getVouchesTarget(node, B.publicKeyHex);
      expect(v.vouches.some(vi => vi.voucherId === A.publicKeyHex)).toBe(true);
    }

    // ---- the cascade: faucet unvouches A ----
    // NODE_INTERFACE → Vouch transition rules
    const vouchesOnA = await getVouchesVoucher(miner, DEVNET_FAUCET.publicKeyHex);
    const faucetVouchBox = vouchesOnA.vouches.find(v => v.targetId === A.publicKeyHex)!;
    const statusPre = await getStatus(miner);
    const unvouchA = buildUnvouchTx(
      DEVNET_FAUCET,
      faucetVouchBox.boxId,
      BigInt(faucetVouchBox.value),
      faucetVouchBox.createdAtBlock,
      statusPre.blockHeight,
      statusPre.vouchCooldownBlocks,
    );
    await deleteVouch(miner, A.publicKeyHex, unvouchA.json);

    // ---- confirm A lapses ----
    await confirm(
      async () => !(await getKarma(miner, A.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    const lapseHeight = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, lapseHeight);

    // ---- A lapsed, memberCount 2 (B still a member) ----
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(false);
      expect(aK.memberVouches).toBe(0);
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }

    // ---- mine one more block: the settlement's lapse leg withdraws A's vouch on B ----
    // NODE_INTERFACE → Membership pass: "the cascade is one generation per block"
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- A's vouch on B is withdrawn ----
    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, A.publicKeyHex);
      expect(v.count).toBe(0);
    }

    // ---- A's escrow for the lapse-withdrawn vouch on B ----
    // NODE_INTERFACE → The settlement transaction: "the unvouch shape exactly"
    for (const node of mesh.nodes) {
      const cd = await getVouchCooldowns(node, A.publicKeyHex);
      expect(cd.cooldowns.length).toBe(1);
    }

    // ---- B lapses in the same block's pass — one generation per block ----
    for (const node of mesh.nodes) {
      bK = await getKarma(node, B.publicKeyHex);
      expect(bK.member).toBe(false);
      expect(bK.memberVouches).toBe(0);
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(1);
    }

    // ---- A as a resident cannot recast ----
    // NODE_INTERFACE → Vouches: "a voucher who is not a member"
    aK = await getKarma(miner, A.publicKeyHex);
    const recastAttempt = buildVouchTx(A, karmaBoxes(aK), B, aK.height);
    try {
      await postVouch(miner, recastAttempt.json);
      expect.fail('resident recast should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- after vouchCooldownBlocks + 1 more blocks the escrow is returned ----
    await mine(miner, mesh.miningSecret, statusPre.vouchCooldownBlocks + 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const cd = await getVouchCooldowns(node, A.publicKeyHex);
      expect(cd.cooldowns).toHaveLength(0);
    }

    // ---- totalKarma moved ----
    // NODE_INTERFACE → Status: totalKarma
    const statusFinal = await getStatus(miner);
    expect(BigInt(statusFinal.totalKarma)).not.toBe(BigInt(status0.totalKarma));
  });
});
