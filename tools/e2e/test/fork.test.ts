import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';
import { getBlockCurrent } from '../src/http.js';
import { MAX_REORG_DEPTH } from '@dagsocial/types';

const FILE_INDEX = 5;

function p2pAddr(node: { p2pPort: number }): string {
  return `/ip4/127.0.0.1/tcp/${node.p2pPort}`;
}

describe('fork', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row c: isolated fork converges via bridge; past MAX_REORG_DEPTH strands', async () => {
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
    // B listed first so C syncs from the longer chain before A
    const nodeC = await mesh.addNode([p2pAddr(nodeB), p2pAddr(nodeA)]);

    // C connects to both. The sync machine processes the handshake and pulls
    // blocks from B (more work). Mining 1 on B after the connection pushes a
    // gossip block that triggers the sync round, and a second mine on C (once
    // it has caught up) gossips to A, forcing A's reorg.
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

    // ---- second case: past MAX_REORG_DEPTH strands ----
    // Mine on C (the bridge, connected to both A and B) past MAX_REORG_DEPTH
    const tipBeforeD = (await getBlockCurrent(nodeC)).height;
    const aTarget = MAX_REORG_DEPTH + 2;
    if (tipBeforeD < aTarget) {
      await mine(nodeC, mesh.miningSecret, aTarget - tipBeforeD);
      await waitHeight([nodeA, nodeB, nodeC], aTarget);
    }

    // D: isolated, mines its own chain past A's height
    const nodeD = await mesh.addNode([]);
    const dTarget = aTarget + 5;
    await mine(nodeD, mesh.miningSecret, dTarget);
    await waitHeight([nodeD], dTarget);

    const tipABeforeBridge = await getBlockCurrent(nodeA);
    const tipD = await getBlockCurrent(nodeD);
    expect(tipD.height).toBe(dTarget);
    expect(tipABeforeBridge.height).toBeGreaterThan(MAX_REORG_DEPTH);

    // E bridges D and A — D listed first so E syncs the longer chain
    const nodeE = await mesh.addNode([p2pAddr(nodeD), p2pAddr(nodeA)]);
    // Wait for E to sync — it joins the longer chain (D's)
    await waitHeight([nodeE], dTarget, 30_000);

    // A stays at its own height — it cannot reorg to D's chain (depth > MAX_REORG_DEPTH).
    // Mine 1 on E to gossip D's chain height to A, triggering fork resolution.
    await mine(nodeE, mesh.miningSecret, 1);
    await new Promise((r) => setTimeout(r, 5000));
    const tipAFinal = await getBlockCurrent(nodeA);
    expect(tipAFinal.height).toBe(tipABeforeBridge.height);

    // Pin: A's log mentions the fork resolution failure
    const forkFailLog = nodeA.logs.some((line) =>
      line.includes('no common ancestor') || line.includes('Fork resolution'),
    );
    expect(forkFailLog).toBe(true);
  });
});
