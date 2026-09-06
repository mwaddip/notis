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
import { POST_PRICE_THREAD } from '@dagsocial/types';

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

    const status0 = await getStatus(miner);
    const version = status0.protocolVersion;

    // ---- 1. the faucet invites A (bond 50): A is a member at the grant ----
    // NODE_INTERFACE → "A root's grant confers membership": the invitee's
    // record is written with memberSinceBlock = the grant height and
    // memberBar = 0 in the same block that creates it.
    const A = fresh();
    let fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const bondAmount = 50n;
    const invA = buildInviteTx(DEVNET_FAUCET, karmaBoxes(fK), A, bondAmount, fK.height, version);
    await postInvite(miner, invA.json);

    await confirm(
      async () => await hasKarma(miner, A.publicKeyHex),
      miner, mesh.miningSecret,
    );
    const grantHeightA = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, grantHeightA);

    // A is not a resident: it is a member from this block, invitesAvailable a
    // number rather than a root's null (NODE_INTERFACE → UTXO queries).
    for (const node of mesh.nodes) {
      const aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(true);
      expect(aK.memberSinceBlock).toBe(grantHeightA);
      expect(aK.invitedAtBlock).toBe(grantHeightA);
      expect(aK.memberBar).toBe(0);
      expect(aK.memberVouches).toBe(0);
      expect(aK.invitesAvailable).toBe(0);
    }
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
      expect(s.membership.memberBar).toBe(1); // ARCHITECTURE → The bar: D(2) = 1 at devnet's k = 1
    }

    // ---- 2. A's cast as a member is accepted ----
    // NODE_INTERFACE → Vouches: a member vouches without a cap; the faucet is
    // older than A, so the cast counts toward nobody
    // (ARCHITECTURE → Earned, standing, and well-founded by age →
    // "Which vouches count — a vouch counts toward NEWER members"). Kept
    // live for the rest of the chapter.
    let aK = await getKarma(miner, A.publicKeyHex);
    const aVouchFaucet = buildVouchTx(A, karmaBoxes(aK), DEVNET_FAUCET, aK.height, version);
    const aVouchFaucetRes = await postVouch(miner, aVouchFaucet.json);
    expect(aVouchFaucetRes.status).toBe('pending');

    await confirm(
      async () => (await getVouchesVoucher(miner, A.publicKeyHex)).count >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, A.publicKeyHex);
      expect(v.count).toBe(1);
      expect(v.next).toBeNull();
    }

    // ---- 3. the faucet vouches A: budget builds, standing does not move ----
    // ARCHITECTURE → Earned, standing, and well-founded by age → "Conferred":
    // a vouch toward a conferred member builds its budget and nothing else.
    fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const faucetVouchA = buildVouchTx(DEVNET_FAUCET, karmaBoxes(fK), A, fK.height, version);
    await postVouch(miner, faucetVouchA.json);

    await confirm(
      async () => (await getKarma(miner, A.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.memberVouches).toBe(1);
      expect(aK.invitesAvailable).toBe(1);
      expect(aK.member).toBe(true);
      expect(aK.memberBar).toBe(0);
    }

    // ---- 4. A invites B (bond 35): B is a resident ----
    // A's grant (50) funds this bond and still clears the cast's
    // VOUCH_MIN_BALANCE (11) for A's own later vouch (step 6); B's grant
    // funds B's own two thread prices, a bond for C and still clears
    // VOUCH_MIN_BALANCE for B's own cast on C (step 7) —
    // ARCHITECTURE → Vouch boxes.
    const B = fresh();
    aK = await getKarma(miner, A.publicKeyHex);
    const bBondAmount = 35n;
    const invB = buildInviteTx(A, karmaBoxes(aK), B, bBondAmount, aK.height, version);
    await postInvite(miner, invB.json);

    await confirm(
      async () => await hasKarma(miner, B.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // NODE_INTERFACE → UTXO queries: memberSinceBlock 0 for a resident
    for (const node of mesh.nodes) {
      const bK = await getKarma(node, B.publicKeyHex);
      expect(bK.member).toBe(false);
      expect(bK.memberSinceBlock).toBe(0);
      expect(bK.invitesAvailable).toBe(0);
    }
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.invitesUsed).toBe(1);
      expect(aK.invitesAvailable).toBe(0);
    }

    // ---- A's second invite is refused: the budget is spent, never revoked ----
    // NODE_INTERFACE → Invites: a member's invite draws against its budget
    const spuriousInvitee = fresh();
    aK = await getKarma(miner, A.publicKeyHex);
    const invSpurious = buildInviteTx(A, karmaBoxes(aK), spuriousInvitee, 5n, aK.height, version);
    try {
      await postInvite(miner, invSpurious.json);
      expect.fail('second invite should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- 5. B's cast as a resident is refused ----
    // NODE_INTERFACE → Vouches: castVouch refuses a voucher who is not a
    // member (ARCHITECTURE → Membership).
    const bKForVouch = await getKarma(miner, B.publicKeyHex);
    const badVouch = buildVouchTx(B, karmaBoxes(bKForVouch), A, bKForVouch.height, version);
    try {
      await postVouch(miner, badVouch.json);
      expect.fail('resident vouch should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // ---- 6. A vouches B, B posts two threads, A likes each: B is set ----
    aK = await getKarma(miner, A.publicKeyHex);
    const aVouchB = buildVouchTx(A, karmaBoxes(aK), B, aK.height, version);
    await postVouch(miner, aVouchB.json);

    await confirm(
      async () => (await getKarma(miner, B.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    let bK = await getKarma(miner, B.publicKeyHex);
    const bt1 = buildThreadTx(B, karmaBoxes(bK), 'b thread 1', bK.height, version);
    const bt1Res = await postPost(miner, bt1.json, bt1.content);
    const bt2 = buildThreadTx(B, [bt1.outputs[0]!], 'b thread 2', bK.height, version);
    const bt2Res = await postPost(miner, bt2.json, bt2.content);

    await confirm(
      async () => {
        const p = await getPost(miner, bt2Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    aK = await getKarma(miner, A.publicKeyHex);
    const aLikeBt1 = buildLikeTx(A, karmaBoxes(aK), bt1Res.postId, B.publicKeyHex, aK.height, version);
    await postLike(miner, aLikeBt1.json);
    const aLikeBt2 = buildLikeTx(A, [aLikeBt1.outputs[0]!], bt2Res.postId, B.publicKeyHex, aK.height, version);
    await postLike(miner, aLikeBt2.json);

    await confirm(
      async () => (await getKarma(miner, B.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    const setHeightB = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, setHeightB);

    // NODE_INTERFACE → Membership pass, case 1: memberBar = D(N) from the
    // pre-body N (N = 2: the faucet and A).
    for (const node of mesh.nodes) {
      bK = await getKarma(node, B.publicKeyHex);
      expect(bK.member).toBe(true);
      expect(bK.memberSinceBlock).toBe(setHeightB);
      expect(bK.memberBar).toBe(1);
      expect(bK.memberVouches).toBe(1);
      expect(bK.memberLikes).toBe('2');
      expect(bK.invitesAvailable).toBe(1);
      expect(bK.lifetimeLikesReceived).toBe('2');
    }
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(3);
    }

    // ---- 7. B invites C (bond 12): C a resident, then set ----
    // B's remaining karma after its own two thread prices still clears
    // VOUCH_MIN_BALANCE after this bond, for B's own cast below
    // (ARCHITECTURE → Vouch boxes); C's grant from it funds C's own two
    // thread prices (ARCHITECTURE → Earned, standing, and well-founded by
    // age — the earned tier is unchanged for a member's invitee).
    const C = fresh();
    bK = await getKarma(miner, B.publicKeyHex);
    const cBondAmount = 12n;
    const invC = buildInviteTx(B, karmaBoxes(bK), C, cBondAmount, bK.height, version);
    await postInvite(miner, invC.json);

    await confirm(
      async () => await hasKarma(miner, C.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    bK = await getKarma(miner, B.publicKeyHex);
    const bVouchC = buildVouchTx(B, karmaBoxes(bK), C, bK.height, version);
    await postVouch(miner, bVouchC.json);

    await confirm(
      async () => (await getKarma(miner, C.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    let cK = await getKarma(miner, C.publicKeyHex);
    const ct1 = buildThreadTx(C, karmaBoxes(cK), 'c thread 1', cK.height, version);
    const ct1Res = await postPost(miner, ct1.json, ct1.content);
    const ct2 = buildThreadTx(C, [ct1.outputs[0]!], 'c thread 2', cK.height, version);
    const ct2Res = await postPost(miner, ct2.json, ct2.content);

    await confirm(
      async () => {
        const p = await getPost(miner, ct2Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // two member likes from two different members
    aK = await getKarma(miner, A.publicKeyHex);
    const aLikeCt1 = buildLikeTx(A, karmaBoxes(aK), ct1Res.postId, C.publicKeyHex, aK.height, version);
    await postLike(miner, aLikeCt1.json);
    bK = await getKarma(miner, B.publicKeyHex);
    const bLikeCt2 = buildLikeTx(B, karmaBoxes(bK), ct2Res.postId, C.publicKeyHex, bK.height, version);
    await postLike(miner, bLikeCt2.json);

    await confirm(
      async () => (await getKarma(miner, C.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // NODE_INTERFACE → Membership pass, case 1: memberBar = D(3) from the
    // pre-body N (N = 3: the faucet, A and B).
    for (const node of mesh.nodes) {
      cK = await getKarma(node, C.publicKeyHex);
      expect(cK.member).toBe(true);
      expect(cK.memberBar).toBe(1);
    }
    for (const node of mesh.nodes) {
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(4);
    }

    // ---- 8. the vouch pages ----
    const aVouchPage = await getVouchesVoucher(miner, A.publicKeyHex);
    expect(aVouchPage.count).toBe(2); // the faucet and B
    expect(aVouchPage.next).toBeNull();
    const aVouchOnB = aVouchPage.vouches.find((v) => v.targetId === B.publicKeyHex)!;
    for (const node of mesh.nodes.slice(1)) {
      const v = await getVouchesVoucher(node, A.publicKeyHex);
      expect(v.count).toBe(2);
      expect(v.next).toBeNull();
    }

    // B's vouch on C, recorded now: the cascade below consumes it before its
    // own createdAtBlock is readable again.
    const bVouchPage = await getVouchesVoucher(miner, B.publicKeyHex);
    const bVouchOnC = bVouchPage.vouches.find((v) => v.targetId === C.publicKeyHex)!;

    // GET /vouches?target=B lists A, and every row's voucherVouchCount equals
    // that voucher's own target count on every node.
    for (const node of mesh.nodes) {
      const v = await getVouchesTarget(node, B.publicKeyHex);
      expect(v.vouches.some((vi) => vi.voucherId === A.publicKeyHex)).toBe(true);

      // NODE_INTERFACE → Vouches
      for (const row of v.vouches) {
        const voucherAsTarget = await getVouchesTarget(node, row.voucherId);
        expect(row.voucherVouchCount).toBe(voucherAsTarget.count);
      }
    }

    const statusPre = await getStatus(miner);

    // ---- 9. the cascade starts one generation down: A unvouches B ----
    // A never lapses (ARCHITECTURE → Earned, standing, and well-founded by
    // age → "Conferred": bar 0 cannot turn false).
    const unvouchB = buildUnvouchTx(
      A,
      aVouchOnB.boxId,
      BigInt(aVouchOnB.value),
      aVouchOnB.createdAtBlock,
      statusPre.blockHeight,
      statusPre.vouchCooldownBlocks,
      version,
    );
    await deleteVouch(miner, B.publicKeyHex, unvouchB.json);

    await confirm(
      async () => !(await getKarma(miner, B.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      bK = await getKarma(node, B.publicKeyHex);
      expect(bK.member).toBe(false);
      expect(bK.memberVouches).toBe(0);
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(3);
    }

    // mine one more block: the settlement's lapse leg withdraws B's vouch on C
    // NODE_INTERFACE → "The cascade is one generation per block, and the pass
    // is why"
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, B.publicKeyHex);
      expect(v.count).toBe(0);
    }

    // B's escrow for the lapse-withdrawn vouch on C: the lapse leg's
    // withdrawal takes the unvouch shape, releaseAtBlock = the vouch's
    // createdAtBlock + vouchCooldownBlocks
    // (NODE_INTERFACE → "The lapse leg reads PRE-BODY state too, and its
    // predicate is the record's").
    for (const node of mesh.nodes) {
      const cd = await getVouchCooldowns(node, B.publicKeyHex);
      expect(cd.cooldowns.length).toBe(1);
      expect(cd.cooldowns[0]!.releaseAtBlock).toBe(
        bVouchOnC.createdAtBlock + statusPre.vouchCooldownBlocks,
      );
    }

    // C lapses in the same block's pass — one generation per block
    for (const node of mesh.nodes) {
      cK = await getKarma(node, C.publicKeyHex);
      expect(cK.member).toBe(false);
      expect(cK.memberVouches).toBe(0);
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }

    // B as a resident cannot recast
    // NODE_INTERFACE → Vouches
    bK = await getKarma(miner, B.publicKeyHex);
    const bRecastAttempt = buildVouchTx(B, karmaBoxes(bK), C, bK.height, version);
    try {
      await postVouch(miner, bRecastAttempt.json);
      expect.fail('resident recast should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // A is untouched throughout
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(true);
      expect(aK.memberVouches).toBe(1);
    }

    // ---- 10. for life: the faucet unvouches A ----
    const vouchesOnA = await getVouchesVoucher(miner, DEVNET_FAUCET.publicKeyHex);
    const faucetVouchOnA = vouchesOnA.vouches.find((v) => v.targetId === A.publicKeyHex)!;
    const unvouchA = buildUnvouchTx(
      DEVNET_FAUCET,
      faucetVouchOnA.boxId,
      BigInt(faucetVouchOnA.value),
      faucetVouchOnA.createdAtBlock,
      (await getBlockCurrent(miner)).height,
      statusPre.vouchCooldownBlocks,
      version,
    );
    await deleteVouch(miner, A.publicKeyHex, unvouchA.json);

    await confirm(
      async () => (await getKarma(miner, A.publicKeyHex)).memberVouches === 0,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // A is still a member: bar 0 cannot turn false
    // (ARCHITECTURE → Roots; ARCHITECTURE → Earned, standing, and
    // well-founded by age → "Conferred").
    for (const node of mesh.nodes) {
      aK = await getKarma(node, A.publicKeyHex);
      expect(aK.member).toBe(true);
      expect(aK.memberBar).toBe(0);
      expect(aK.memberVouches).toBe(0);
      expect(aK.invitesAvailable).toBe(0); // clamped: floor(0 / D) - 1
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }

    // mine one more block: no lapse leg reaches A
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, A.publicKeyHex);
      expect(v.count).toBe(1); // its vouch on the faucet
      const s = await getStatus(node);
      expect(s.membership.memberCount).toBe(2);
    }

    // ---- 11. after vouchCooldownBlocks + 1 more blocks every escrow returns ----
    await mine(miner, mesh.miningSecret, statusPre.vouchCooldownBlocks + 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const bCooldowns = await getVouchCooldowns(node, B.publicKeyHex);
      expect(bCooldowns.cooldowns).toHaveLength(0);
      const aCooldowns = await getVouchCooldowns(node, A.publicKeyHex);
      expect(aCooldowns.cooldowns).toHaveLength(0);
      const faucetCooldowns = await getVouchCooldowns(node, DEVNET_FAUCET.publicKeyHex);
      expect(faucetCooldowns.cooldowns).toHaveLength(0);
    }

    // ---- 12. totalKarma delta: grants enter supply, prices exit it ----
    // NODE_INTERFACE → Status
    const statusFinal = await getStatus(miner);
    const expectedDelta = bondAmount + bBondAmount + cBondAmount - 4n * POST_PRICE_THREAD;
    expect(BigInt(statusFinal.totalKarma) - BigInt(status0.totalKarma)).toBe(expectedDelta);
  });
});
