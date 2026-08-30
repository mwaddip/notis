import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';
import { getBlockCurrent } from '../src/http.js';
import { NETWORK_PROFILES } from '@dagsocial/types';

const FILE_INDEX = 5;
const HORIZON = NETWORK_PROFILES.devnet.maxReorgDepth;

function p2pAddr(node: { p2pPort: number }): string {
  return `/ip4/127.0.0.1/tcp/${node.p2pPort}`;
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

    // ---- C bridges A and B ----
    // A listed first — the pick targets B (retained-highest) regardless of connect order
    const nodeC = await mesh.addNode([p2pAddr(nodeA), p2pAddr(nodeB)]);

    // C connects to both; the pick targets B (retained-highest, height not
    // work). Mining 1 on B after the connection pushes a gossip block that
    // triggers the sync round, and a second mine on C (once it has caught up)
    // gossips to A, forcing A's reorg.
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

    // ---- inside the horizon: fork at depth 30, converges ----
    const convergeTarget = HORIZON - 10;
    const meshHeight = (await getBlockCurrent(nodeA)).height;
    await mine(nodeC, mesh.miningSecret, convergeTarget - meshHeight);
    await waitHeight([nodeA], convergeTarget, 30_000);

    // D: isolated, mines its own chain from genesis — at devnet difficulty
    // (floor 2304, ceiling 4096) the schedule stays near the floor for bursts
    // faster than the 60 s ideal, so more blocks is more work
    const nodeD = await mesh.addNode([]);
    const dHeight = convergeTarget + 5;
    await mine(nodeD, mesh.miningSecret, dHeight);
    await waitHeight([nodeD], dHeight);

    const tipABefore = await getBlockCurrent(nodeA);
    const tipD = await getBlockCurrent(nodeD);
    expect(tipABefore.height).toBe(convergeTarget);
    expect(tipD.height).toBe(dHeight);
    expect(tipD.height).toBeGreaterThan(tipABefore.height);

    // E bridges D and A — fork depth is convergeTarget (inside HORIZON), so
    // the walk reaches genesis and the heavier chain wins
    const logBaselineA = nodeA.linesSeen;
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

    // NODE_INTERFACE → Fork choice decides on verified headers
    const reorgLogs = nodeA.linesSince(logBaselineA);
    expect(
      reorgLogs.some((l) => l.includes('Reorg complete: new tip at height=')),
    ).toBe(true);

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
    const logBaselineA2 = nodeA.linesSeen;
    const nodeG = await mesh.addNode([p2pAddr(nodeF), p2pAddr(nodeA)]);
    await waitHeight([nodeG], fHeight, 30_000);

    await mine(nodeG, mesh.miningSecret, 1);
    await waitHeight([nodeF], fHeight + 1, 30_000);

    // A stays — fork depth (45) exceeds the horizon (40)
    const tipAFinal = await getBlockCurrent(nodeA);
    expect(tipAFinal.height).toBe(tipABeforeStrand.height);

    // NODE_INTERFACE → Fork choice decides on verified headers
    const strandLogs = nodeA.linesSince(logBaselineA2);
    expect(
      strandLogs.some((l) =>
        l.includes(
          `Fork resolution failed: no common ancestor within ${HORIZON} blocks`,
        ),
      ),
    ).toBe(true);
  });
});
