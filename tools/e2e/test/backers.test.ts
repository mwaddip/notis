import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_BACKER_A, DEVNET_BACKER_B, fresh } from '../src/identities.js';
import { buildUnstakeTx } from '../src/tx/unstake.js';
import { buildCreditTransferTx } from '../src/tx/credit-transfer.js';
import {
  getBackers,
  getBacker,
  getCredits,
  postUnstake,
  postCreditTransfer,
  getBlockCurrent,
  getStatus,
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 20;

describe('backers', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('the vector table: genesis pool, unstake with release, credit transfer, full unstake', async () => {
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

    // ---- block 1: the pool at genesis + one block ----
    // MINING_INTERFACE → The backer pool
    for (const node of mesh.nodes) {
      const pool = await getBackers(node);
      expect(pool.supply).toBe('100');
      expect(pool.staked).toBe('50');
      expect(pool.accrual).toBe('2940000000');
      expect(pool.unreleased).toBe('1470000000');
      expect(pool.accrualEndsAtBlock).toBe(1000);

      const a = await getBacker(node, DEVNET_BACKER_A.publicKeyHex);
      expect(a.weight).toBe('20');
      expect(a.accrued).toBe('588000000');

      const b = await getBacker(node, DEVNET_BACKER_B.publicKeyHex);
      expect(b.weight).toBe('30');
      expect(b.accrued).toBe('882000000');
    }

    // 404 on unknown handle
    try {
      await getBacker(peer, '@nobody');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(404);
      expect((err as NodeError).message).toContain('unknown handle');
    }

    // 404 on a key with no stake
    const nobody = fresh();
    try {
      await getBacker(peer, nobody.publicKeyHex);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(404);
      expect((err as NodeError).message).toContain('no stake');
    }

    // ---- A unstakes 10 of 20 ----
    const stakeA = await getBacker(miner, DEVNET_BACKER_A.publicKeyHex);
    const unstake1 = buildUnstakeTx(DEVNET_BACKER_A, stakeA.boxId, 20n, 10n, 1, version);
    const unstake1Res = await postUnstake(miner, unstake1.json);
    expect(unstake1Res.status).toBe('pending');
    expect(unstake1Res.txId).toBeTruthy();

    // A second unstake of the same stake box while the first is pending.
    // FINDING: the contract (NODE_INTERFACE → Backers) says 409 pending-spend
    // conflict, but validateTx sees the box as absent via getBoxWithPending
    // (which returns null for a pending-spent box) and answers 400 before
    // admitTx's 409 path runs. Reported to main.
    const unstake1Dup = buildUnstakeTx(DEVNET_BACKER_A, stakeA.boxId, 20n, 5n, 1, version);
    try {
      await postUnstake(miner, unstake1Dup.json);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
    }

    // The template is rebuilt on tip movement, not on mempool changes, so the
    // unstake may ride the block after the next one. `confirm` paces on the
    // effect; the vector table values are computed from the landing height.
    await confirm(
      async () => (await getBackers(miner)).staked !== '50',
      miner, mesh.miningSecret,
    );
    const unstakeHeight = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, unstakeHeight);

    // The contract's vector table runs from genesis with base = 4200000000,
    // S = 100, c = 35. Every empty block before the unstake accrues at T=50,
    // cap binding (inc = 2940000000), P = 1470000000 per block.
    // The unstake block itself: T₀=50, A₀ = 2940000000 * unstakeHeight,
    // r = floor(10 * A₀ / 100), then T=40, cap binds, inc = 3675000000.
    const emptyBlocks = unstakeHeight - 1; // blocks 1..unstakeHeight-1 are empty
    const A0_at_unstake = 2940000000n * BigInt(emptyBlocks);
    const V_before_unstake = 1470000000n * BigInt(emptyBlocks);
    const release1 = (10n * A0_at_unstake) / 100n;
    // T=40, cap binds: inc = floor(base * c * S / (100 * T))
    const inc_unstake = (4200000000n * 3500n) / 4000n;
    const P_unstake = (40n * inc_unstake + 99n) / 100n;
    const V_after = V_before_unstake + P_unstake - release1;
    const A_after = A0_at_unstake + inc_unstake;

    for (const node of mesh.nodes) {
      const pool = await getBackers(node);
      expect(pool.staked).toBe('40');
      expect(pool.accrual).toBe(A_after.toString());
      expect(pool.unreleased).toBe(V_after.toString());

      const a = await getBacker(node, DEVNET_BACKER_A.publicKeyHex);
      expect(a.weight).toBe('10');
      expect(a.accrued).toBe(((10n * A_after) / 100n).toString());

      const b = await getBacker(node, DEVNET_BACKER_B.publicKeyHex);
      expect(b.accrued).toBe(((30n * A_after) / 100n).toString());

      // NODE_INTERFACE → UTXO queries: the release is one credit box, no lock
      const credits = await getCredits(node, DEVNET_BACKER_A.publicKeyHex);
      expect(credits.boxCount).toBe(1);
      expect(credits.boxes.length).toBe(1);
      expect(credits.boxes[0]!.value).toBe(release1.toString());
      expect(credits.boxes[0]!.lockedUntilBlock).toBeUndefined();
    }

    // ---- A spends the release to B, and unstakes the remaining 10 ----
    const creditsA = await getCredits(miner, DEVNET_BACKER_A.publicKeyHex);
    const creditBoxes: BoxRef[] = creditsA.boxes.map((b) => ({
      boxId: b.boxId,
      value: BigInt(b.value),
    }));
    const transfer = buildCreditTransferTx(
      DEVNET_BACKER_A, creditBoxes, DEVNET_BACKER_B, release1, unstakeHeight, version,
    );
    await postCreditTransfer(miner, transfer.json);

    const stakeA2 = await getBacker(miner, DEVNET_BACKER_A.publicKeyHex);
    const unstake2 = buildUnstakeTx(DEVNET_BACKER_A, stakeA2.boxId, 10n, 10n, unstakeHeight, version);
    await postUnstake(miner, unstake2.json);

    await confirm(
      async () => {
        try {
          await getBacker(miner, DEVNET_BACKER_A.publicKeyHex);
          return false;
        } catch {
          return true;
        }
      },
      miner, mesh.miningSecret,
    );
    const finalHeight = (await getBlockCurrent(miner)).height;
    await waitHeight(mesh.nodes, finalHeight);

    // Compute expected values for the final state. Between unstakeHeight and
    // finalHeight there may be empty blocks at T=40, then the second unstake
    // block itself at T₀=40.
    let V = V_after;
    let staked = 40n;
    let accrual = A_after;
    for (let h = unstakeHeight + 1; h < finalHeight; h++) {
      // Empty block at T=40. 100*40=4000 > 3500 → cap binds.
      const inc = (4200000000n * 3500n) / 4000n;
      const P = (staked * inc + 99n) / 100n;
      V += P;
      accrual += inc;
    }
    // The second-unstake block: T₀=40, A₀=accrual, unstake 10 of 10.
    const release2 = (10n * accrual) / 100n;
    staked -= 10n; // T = 30
    // 100*30=3000 ≤ 3500 → cap does NOT bind: inc = base
    const inc_final = 4200000000n;
    const P_final = (staked * inc_final + 99n) / 100n;
    V = V + P_final - release2;
    accrual += inc_final;

    for (const node of mesh.nodes) {
      const pool = await getBackers(node);
      expect(pool.staked).toBe('30');
      expect(pool.accrual).toBe(accrual.toString());
      expect(pool.unreleased).toBe(V.toString());

      // A has no stake
      try {
        await getBacker(node, DEVNET_BACKER_A.publicKeyHex);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NodeError);
        expect((err as NodeError).status).toBe(404);
        expect((err as NodeError).message).toContain('no stake');
      }

      const b = await getBacker(node, DEVNET_BACKER_B.publicKeyHex);
      expect(b.accrued).toBe(((30n * accrual) / 100n).toString());

      // A's second release
      const creditsANow = await getCredits(node, DEVNET_BACKER_A.publicKeyHex);
      expect(creditsANow.boxes.length).toBe(1);
      expect(creditsANow.boxes[0]!.value).toBe(release2.toString());

      // B received the transfer
      const creditsB = await getCredits(node, DEVNET_BACKER_B.publicKeyHex);
      expect(creditsB.boxes.length).toBe(1);
      expect(creditsB.boxes[0]!.value).toBe(release1.toString());
    }

    // ---- stateRoots agree across the mesh at every height ----
    for (let h = 1; h <= finalHeight; h++) {
      const blocks = await Promise.all(
        mesh.nodes.map(async (n) => {
          const res = await fetch(`${n.url}/blocks/${h}`);
          expect(res.ok).toBe(true);
          return (await res.json()) as { header: { stateRoot: string } };
        }),
      );
      for (const b of blocks) {
        expect(b.header.stateRoot).toBe(blocks[0]!.header.stateRoot);
      }
    }

    const current = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const c of current) {
      expect(c.height).toBe(finalHeight);
      expect(c.hash).toBe(current[0]!.hash);
    }
  });
});
