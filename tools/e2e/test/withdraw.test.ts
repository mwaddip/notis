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
import { PROTOCOL_VERSION } from '@dagsocial/types';
import { signAndRender } from '../src/tx/render.js';

const FILE_INDEX = 2;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('withdraw', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row b-withdraw: vouch, unvouch, the settlement returns the escrow at releaseAtBlock', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite voucher and target ----
    const voucher = fresh();
    const target = fresh();
    const bondAmount = 50n;

    const faucetK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), voucher, bondAmount, faucetK.height);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], target, bondAmount, faucetK.height);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => await hasKarma(miner, voucher.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- ARCHITECTURE → Membership: the voucher must be a member to cast ----
    // faucet vouches the voucher, voucher posts two threads, faucet likes each
    let fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const faucetVouch = buildVouchTx(DEVNET_FAUCET, karmaBoxes(fK), voucher, fK.height);
    await postVouch(miner, faucetVouch.json);

    await confirm(
      async () => (await getKarma(miner, voucher.publicKeyHex)).memberVouches >= 1,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    let vK = await getKarma(miner, voucher.publicKeyHex);
    const t1 = buildThreadTx(voucher, karmaBoxes(vK), 'w thread 1', vK.height);
    const t1Res = await postPost(miner, t1.json, t1.content);
    const t2 = buildThreadTx(voucher, [t1.outputs[0]!], 'w thread 2', vK.height);
    const t2Res = await postPost(miner, t2.json, t2.content);

    await confirm(
      async () => {
        const p = await getPost(miner, t2Res.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    fK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const lk1 = buildLikeTx(DEVNET_FAUCET, karmaBoxes(fK), t1Res.postId, voucher.publicKeyHex, fK.height);
    await postLike(miner, lk1.json);
    const lk2 = buildLikeTx(DEVNET_FAUCET, [lk1.outputs[0]!], t2Res.postId, voucher.publicKeyHex, fK.height);
    await postLike(miner, lk2.json);

    await confirm(
      async () => (await getKarma(miner, voucher.publicKeyHex)).member,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- vouch ----
    const voucherK = await getKarma(miner, voucher.publicKeyHex);
    const voucherKarmaBefore = BigInt(voucherK.total);
    const vouch = buildVouchTx(voucher, karmaBoxes(voucherK), target, voucherK.height);
    await postVouch(miner, vouch.json);

    await confirm(
      async () => (await getVouchesTarget(miner, target.publicKeyHex)).count > 0,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- verify vouch on all nodes ----
    for (const node of mesh.nodes) {
      const v = await getVouchesTarget(node, target.publicKeyHex);
      expect(v.count).toBe(1);
      expect(v.vouches[0]!.voucherId).toBe(voucher.publicKeyHex);
    }

    // ---- change-box id cross-check ----
    for (const node of mesh.nodes) {
      const vk = await getKarma(node, voucher.publicKeyHex);
      const boxIds = vk.boxes.map((b) => b.boxId);
      expect(boxIds).toContain(vouch.outputs[0]!.boxId);
    }

    // ---- unvouch ----
    const vouchesData = await getVouchesVoucher(miner, voucher.publicKeyHex);
    const vouchBox = vouchesData.vouches[0]!;

    const status = await getStatus(miner);
    const unvouch = buildUnvouchTx(
      voucher,
      vouchBox.boxId,
      BigInt(vouchBox.value),
      vouchBox.createdAtBlock,
      status.blockHeight,
      status.vouchCooldownBlocks,
    );
    await deleteVouch(miner, target.publicKeyHex, unvouch.json);

    await confirm(
      async () => (await getVouchCooldowns(miner, voucher.publicKeyHex)).cooldowns.length > 0,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- escrow exists on all nodes ----
    for (const node of mesh.nodes) {
      const cd = await getVouchCooldowns(node, voucher.publicKeyHex);
      expect(cd.cooldowns.length).toBe(1);
      expect(BigInt(cd.cooldowns[0]!.value)).toBe(1n);
    }

    // ---- NODE_INTERFACE → The settlement transaction:
    // the settlement consumes every escrow at or past releaseAtBlock ----
    await mine(miner, mesh.miningSecret, status.vouchCooldownBlocks + 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- NODE_INTERFACE → Vouch transition rules:
    // the escrow is consumed and the voucher's karma is restored ----
    for (const node of mesh.nodes) {
      const cd = await getVouchCooldowns(node, voucher.publicKeyHex);
      expect(cd.cooldowns).toHaveLength(0);
    }

    for (const node of mesh.nodes) {
      const vk = await getKarma(node, voucher.publicKeyHex);
      expect(BigInt(vk.total)).toBe(voucherKarmaBefore);
    }

    // ---- NODE_INTERFACE → Vouch transition rules:
    // the hasActiveVouchEscrow gate clears through the settlement ----
    const voucherKAfterReturn = await getKarma(miner, voucher.publicKeyHex);
    const recast = buildVouchTx(
      voucher,
      karmaBoxes(voucherKAfterReturn),
      target,
      voucherKAfterReturn.height,
    );
    await postVouch(miner, recast.json);

    await confirm(
      async () => (await getVouchesVoucher(miner, voucher.publicKeyHex)).count > 0,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    for (const node of mesh.nodes) {
      const v = await getVouchesVoucher(node, voucher.publicKeyHex);
      expect(v.count).toBe(1);
      expect(v.vouches[0]!.voucherId).toBe(voucher.publicKeyHex);
    }

    // ---- NODE_INTERFACE → Legal box transitions:
    // no user transaction spends a VouchEscrowBox ----
    const escrowBoxId = unvouch.outputs[0]!.boxId;
    const probeTx = signAndRender(voucher, {
      inputs: [escrowBoxId],
      outputs: [
        {
          boxType: 'karma',
          value: 1n,
          createdAtBlock: (await getBlockCurrent(miner)).height,
          owner: Buffer.from(voucher.publicKeyHex, 'hex'),
        },
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    try {
      await fetch(`${miner.url}/credits/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx: probeTx.json }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          throw new NodeError(res.status, data);
        }
      });
      expect.fail('a user transaction spending an escrow should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
      expect((err as NodeError).body['error']).toBe(
        'credit transfer outputs must all be CreditBoxes',
      );
    }
  });
});
