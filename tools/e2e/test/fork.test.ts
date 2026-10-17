import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';
import { getBlock, getBlockCurrent } from '../src/http.js';
import { clockOffsetNodeOptions } from '../src/node-process.js';
import type { NodeProcess } from '../src/node-process.js';
import { NETWORK_PROFILES } from '@dagsocial/types';
import { blockWork } from '@dagsocial/validation';

const FILE_INDEX = 5;
const FILE_INDEX_ROOT_FORK = 23;
const HORIZON = NETWORK_PROFILES.devnet.maxReorgDepth;

function p2pAddr(node: { p2pPort: number }): string {
  return `/ip4/127.0.0.1/tcp/${node.p2pPort}`;
}

async function chainWork(
  node: NodeProcess,
  from: number,
  to: number,
): Promise<bigint> {
  let sum = 0n;
  for (let h = from; h <= to; h++) {
    const raw = await getBlock(node, h);
    if (raw === null) {
      throw new Error(`node :${node.httpPort} has no block at height ${h}`);
    }
    const hdr = raw['header'] as Record<string, unknown>;
    const bits = hdr['powTargetBits'] as number;
    const work = blockWork(bits);
    if (work === null) {
      throw new Error(`unreadable powTargetBits ${bits} at height ${h}`);
    }
    sum += work;
  }
  return sum;
}

describe('fork', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row c: isolated fork converges via bridge', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const nodeA = mesh.nodes[0]!;

    // ---- mesh proof on A ----
    await mine(nodeA, mesh.miningSecret, 1);
    await waitHeight([nodeA], 1);

    // ---- B: isolated, no bootstrap ----
    const nodeB = await mesh.addNode([]);
    await mine(nodeB, mesh.miningSecret, 1);
    await waitHeight([nodeB], 1);

    // ---- mine 3 on A, 5 on B — no gossip between them ----
    await mine(nodeA, mesh.miningSecret, 2);
    await waitHeight([nodeA], 3);

    await mine(nodeB, mesh.miningSecret, 4);
    await waitHeight([nodeB], 5);

    const tipA = await getBlockCurrent(nodeA);
    const tipB = await getBlockCurrent(nodeB);
    expect(tipA.height).toBe(3);
    expect(tipB.height).toBe(5);
    expect(tipA.hash).not.toBe(tipB.hash);

    // ---- C bridges A and B — the heavier chain wins
    // (NODE_INTERFACE → Fork choice decides on verified headers →
    // "The best chain is the heaviest reachable branch").
    const nodeC = await mesh.addNode([p2pAddr(nodeA), p2pAddr(nodeB)]);

    // Mining 1 on B after the connection pushes a gossip block that
    // triggers the sync round, and a second mine on C (once it has caught up)
    // gossips to A, forcing A's switch.
    await mine(nodeB, mesh.miningSecret, 1);
    await waitHeight([nodeC], 6, 60_000);

    await mine(nodeC, mesh.miningSecret, 1);
    await waitHeight([nodeA, nodeC], 7, 60_000);

    const tips = await Promise.all(
      [nodeA, nodeB, nodeC].map(getBlockCurrent),
    );
    for (const tip of tips) {
      expect(tip.height).toBe(7);
      expect(tip.hash).toBe(tips[0]!.hash);
    }
  });

  it('deep fork inside the horizon converges; past the horizon strands', async () => {
    const nodeA = mesh.nodes[0]!;
    const nodeC = mesh.nodes[2]!;

    // ---- inside the horizon: fork converges on the heavier chain ----
    const convergeTarget = HORIZON - 10;
    const meshHeight = (await getBlockCurrent(nodeA)).height;
    await mine(nodeC, mesh.miningSecret, convergeTarget - meshHeight);
    await waitHeight([nodeA], convergeTarget, 30_000);

    // D: isolated, mines its own chain from genesis past the mesh's tip —
    // on a burst mined at a similar pace to the mesh, taller = more work.
    const nodeD = await mesh.addNode([]);
    const dHeight = convergeTarget + 5;
    await mine(nodeD, mesh.miningSecret, dHeight);
    await waitHeight([nodeD], dHeight);

    const tipABefore = await getBlockCurrent(nodeA);
    const tipD = await getBlockCurrent(nodeD);
    expect(tipABefore.height).toBe(convergeTarget);
    expect(tipD.height).toBe(dHeight);
    expect(tipD.height).toBeGreaterThan(tipABefore.height);

    // E bridges D and A — fork depth is convergeTarget (inside HORIZON),
    // so the fork point is reachable and the heavier chain wins
    // (NODE_INTERFACE → Fork choice decides on verified headers →
    // "The reach floor is the horizon, one rule for every fork point").
    const nodeE = await mesh.addNode([p2pAddr(nodeD), p2pAddr(nodeA)]);
    await waitHeight([nodeE], dHeight, 60_000);

    await mine(nodeE, mesh.miningSecret, 1);
    await waitHeight([nodeA, nodeD], dHeight + 1, 60_000);

    const convergeTips = await Promise.all(
      [nodeA, nodeD, nodeE].map(getBlockCurrent),
    );
    for (const tip of convergeTips) {
      expect(tip.height).toBe(dHeight + 1);
      expect(tip.hash).toBe(convergeTips[0]!.hash);
    }

    // ---- past the horizon strands ----
    const strandTarget = HORIZON + 5;
    const afterReorgHeight = (await getBlockCurrent(nodeA)).height;
    await mine(nodeA, mesh.miningSecret, strandTarget - afterReorgHeight);
    await waitHeight([nodeA], strandTarget, 30_000);

    const tipABeforeStrand = await getBlockCurrent(nodeA);
    expect(tipABeforeStrand.height).toBe(strandTarget);

    // F: isolated, mines from genesis past the horizon
    const nodeF = await mesh.addNode([]);
    const fHeight = strandTarget + 5;
    await mine(nodeF, mesh.miningSecret, fHeight);
    await waitHeight([nodeF], fHeight);

    // G bridges F and A
    const nodeG = await mesh.addNode([p2pAddr(nodeF), p2pAddr(nodeA)]);
    await waitHeight([nodeG], fHeight, 30_000);

    await mine(nodeG, mesh.miningSecret, 1);
    await waitHeight([nodeF], fHeight + 1, 30_000);

    // A's applied tip is more than `maxReorgDepth` above the fork point;
    // its admission refuses F's chain under the age rule, with no penalty
    // and no log — assert A stays put by tips alone (NODE_INTERFACE → Fork
    // choice decides on verified headers → "The reach floor is the horizon,
    // one rule for every fork point").
    const tipAFinal = await getBlockCurrent(nodeA);
    expect(tipAFinal.height).toBe(tipABeforeStrand.height);
    expect(tipAFinal.hash).toBe(tipABeforeStrand.hash);
  });
});

describe('fork root', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('joiner meeting a lighter-but-taller chain and a heavier one converges onto the heavier', async () => {
    mesh = await createMesh({
      fileIndex: FILE_INDEX_ROOT_FORK,
      nodeCount: 0,
    });

    // ---- Node L: block 1 under a 16-hour past-stamp preload, then blocks
    // 2..20 at real wall time. The schedule reads header stamps against
    // t_a = createdAt(1), so block 1 placed 16 h back drives Δ positive at
    // block 3's admission and onward, clamping the schedule at the floor
    // (MINING_INTERFACE → Difficulty Schedule).
    const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
    const L_FIRST = await mesh.addNode([], {
      NODE_OPTIONS: clockOffsetNodeOptions(),
      DAGSOCIAL_E2E_CLOCK_OFFSET_MS: String(-SIXTEEN_HOURS_MS),
    });
    await mine(L_FIRST, mesh.miningSecret, 1);
    await waitHeight([L_FIRST], 1);

    const nodeL = await mesh.restartNode(L_FIRST, {});
    await mine(nodeL, mesh.miningSecret, 19);
    await waitHeight([nodeL], 20);

    // ---- Node H: isolated, mines 8 at the anchor target.
    const nodeH = await mesh.addNode([]);
    await mine(nodeH, mesh.miningSecret, 8);
    await waitHeight([nodeH], 8);

    // ---- Measure both chains' cumulative work from the headers each node
    // serves (NODE_INTERFACE → Fork choice decides on verified headers →
    // "The best chain is the heaviest reachable branch").
    const [workL, workH] = await Promise.all([
      chainWork(nodeL, 1, 20),
      chainWork(nodeH, 1, 8),
    ]);
    const tipL = await getBlockCurrent(nodeL);
    const tipH = await getBlockCurrent(nodeH);
    expect(tipL.height).toBe(20);
    expect(tipH.height).toBe(8);
    expect(tipL.height).toBeGreaterThan(tipH.height);
    expect(workL < workH).toBe(true);

    // ---- Node J bootstraps to L alone and ends on L's chain.
    const nodeJ = await mesh.addNode([p2pAddr(nodeL)]);
    await waitHeight([nodeJ], 20, 30_000);
    const tipJAfterL = await getBlockCurrent(nodeJ);
    expect(tipJAfterL.hash).toBe(tipL.hash);

    // ---- Restart H with J as its bootstrap peer; H's data dir keeps its
    // 8-block chain. J's applied tip (20) is within devnet's maxReorgDepth
    // (40) with every journal kept, so the fork at the root is reachable for
    // J (NODE_INTERFACE → Fork choice decides on verified headers → "The
    // reach floor is the horizon, one rule for every fork point"). The gate
    // counts outbound peers; H's inbound side at J does not hold J's gate
    // (NET_INTERFACE → Sync State Machine → "The gate bounds how far blocks
    // apply").
    const nodeH2 = await mesh.restartNode(nodeH, {}, [p2pAddr(nodeJ)]);

    // ---- J switches to H's chain (NODE_INTERFACE → Fork choice decides on
    // verified headers → "The switch.").
    const deadline = Date.now() + 60_000;
    let converged = false;
    while (Date.now() < deadline) {
      const t = await getBlockCurrent(nodeJ);
      if (t.hash === tipH.hash && t.height === tipH.height) {
        converged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const tipJFinal = await getBlockCurrent(nodeJ);
    const tipH2 = await getBlockCurrent(nodeH2);
    if (!converged) {
      const tails = [nodeL, nodeJ, nodeH2]
        .map((n) => `--- :${n.httpPort} ---\n${n.logs.slice(-15).join('\n')}`)
        .join('\n');
      throw new Error(
        `J did not converge onto H within 60s (J tip ${tipJFinal.height}/${tipJFinal.hash}, H tip ${tipH2.height}/${tipH2.hash}, L tip ${tipL.height}/${tipL.hash})\n${tails}`,
      );
    }
    expect(tipJFinal.height).toBe(tipH.height);
    expect(tipJFinal.hash).toBe(tipH.hash);

    // H's own chain is heavier and stays its best.
    expect(tipH2.height).toBe(tipH.height);
    expect(tipH2.hash).toBe(tipH.hash);
  }, 120_000);
});
