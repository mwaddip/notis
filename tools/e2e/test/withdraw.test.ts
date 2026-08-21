import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildVouchTx, buildUnvouchTx } from '../src/tx/vouch.js';
import {
  postInvite,
  postVouch,
  deleteVouch,
  getVouches,
  getKarma,
  getStatus,
  getBlockCurrent,
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

  it('row b-withdraw: vouch, unvouch, escrow, reclaim has no route (H-J1-1)', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite voucher (needs ≥ 11 karma) and target ----
    const voucher = fresh();
    const target = fresh();
    const bondAmount = 50n;

    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv1 = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), voucher, bondAmount, faucetK.height);
    await postInvite(miner, inv1.json);
    const inv2 = buildInviteTx(DEVNET_FAUCET, [inv1.outputs[0]!], target, bondAmount, faucetK.height);
    await postInvite(miner, inv2.json);

    await confirm(
      async () => (await getKarma(miner, voucher.publicKeyHex)) !== null,
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- vouch ----
    const voucherK = (await getKarma(miner, voucher.publicKeyHex))!;
    const voucherKarmaBefore = BigInt(voucherK.total);
    const vouch = buildVouchTx(voucher, karmaBoxes(voucherK), target, voucherK.height);
    await postVouch(miner, vouch.json);

    await confirm(
      async () => {
        const v = (await getVouches(miner, `target=${target.publicKeyHex}`)) as {
          count: number;
        };
        return v.count > 0;
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- verify vouch on all nodes ----
    for (const node of mesh.nodes) {
      const v = (await getVouches(node, `target=${target.publicKeyHex}`)) as {
        vouches: { voucherId: string }[];
        count: number;
      };
      expect(v.count).toBe(1);
      expect(v.vouches[0]!.voucherId).toBe(voucher.publicKeyHex);
    }

    // ---- change-box id cross-check: the derived karma change matches the node ----
    for (const node of mesh.nodes) {
      const vk = (await getKarma(node, voucher.publicKeyHex))!;
      const boxIds = vk.boxes.map((b) => b.boxId);
      expect(boxIds).toContain(vouch.outputs[0]!.boxId);
    }

    // ---- unvouch ----
    const vouchesData = (await getVouches(miner, `voucher=${voucher.publicKeyHex}`)) as {
      vouches: { boxId: string; value: string; createdAtBlock: number }[];
    };
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
    const unvouchRes = await deleteVouch(miner, target.publicKeyHex, unvouch.json);

    await confirm(
      async () => {
        const cd = (await getVouches(miner, `voucher=${voucher.publicKeyHex}&cooldowns=1`)) as {
          cooldowns: unknown[];
        };
        return cd.cooldowns.length > 0;
      },
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- escrow exists on all nodes ----
    for (const node of mesh.nodes) {
      const cd = (await getVouches(node, `voucher=${voucher.publicKeyHex}&cooldowns=1`)) as {
        cooldowns: { value: string; releaseAtBlock: number }[];
      };
      expect(cd.cooldowns.length).toBe(1);
      expect(BigInt(cd.cooldowns[0]!.value)).toBe(1n);
    }

    // ---- H-J1-1: no route accepts the reclaim ----
    // Mine past releaseAtBlock to ensure the escrow is unlocked
    await mine(miner, mesh.miningSecret, status.vouchCooldownBlocks + 1);
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // The engine validates VouchEscrowBox → KarmaBox (utxo-engine.ts:700) but no
    // HTTP route feeds such a transaction. The POST /credits/transfer route is the
    // closest generic tx endpoint; pin its refusal.
    const escrowBoxId = unvouch.outputs[0]!.boxId;
    const reclaimTx = signAndRender(voucher, {
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
        body: JSON.stringify({ tx: reclaimTx.json }),
      }).then(async (res) => {
        if (!res.ok) {
          const data = (await res.json()) as Record<string, unknown>;
          throw new NodeError(res.status, data);
        }
      });
      expect.fail('reclaim through /credits/transfer should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      // pin the status — the route refuses because the input is not a credit box
      expect((err as NodeError).status).toBeGreaterThanOrEqual(400);
    }

    // ---- voucher karma: decreased by 1 (vouch cost), NOT restored ----
    for (const node of mesh.nodes) {
      const vk = (await getKarma(node, voucher.publicKeyHex))!;
      expect(BigInt(vk.total)).toBe(voucherKarmaBefore - 1n);
    }
  });
});
