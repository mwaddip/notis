import { describe, it, afterAll, expect } from 'vitest';
import {
  NETWORK_PROFILES,
  RETARGET_HALFLIFE_BLOCKS,
} from '@dagsocial/types';
import { asertTargetBits } from '@dagsocial/validation';
import type { RetargetParams } from '@dagsocial/validation';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';
import { getBlock, getBlockCurrent } from '../src/http.js';
import type { NodeProcess } from '../src/node-process.js';

const FILE_INDEX = 17;

const devnet = NETWORK_PROFILES.devnet;
const P_DEV: RetargetParams = {
  anchorBits: devnet.orderingBlockPowTargetBits,
  idealMs: devnet.orderingBlockIdealMs,
  halflifeMs: RETARGET_HALFLIFE_BLOCKS * devnet.orderingBlockIdealMs,
  floorBits: devnet.orderingBlockPowTargetFloorBits,
  ceilingBits: devnet.orderingBlockPowTargetCeilingBits,
};

interface ServedHeader {
  height: number;
  powTargetBits: number;
  createdAt: number;
  prevBlockHash: string;
}

async function readHeader(node: NodeProcess, h: number): Promise<ServedHeader> {
  const raw = await getBlock(node, h);
  expect(raw).not.toBeNull();
  const hdr = (raw as Record<string, unknown>)['header'] as Record<string, unknown>;
  return {
    height: hdr['height'] as number,
    powTargetBits: hdr['powTargetBits'] as number,
    createdAt: hdr['createdAt'] as number,
    prevBlockHash: hdr['prevBlockHash'] as string,
  };
}

describe('retarget', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('a burst\'s targets follow the ASERT schedule and a late joiner agrees', async () => {
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

    // ---- burst: 40 blocks on node 0, paced on height ----
    const BURST = 40;
    await mine(miner, mesh.miningSecret, BURST);
    const burstTip = (await getBlockCurrent(miner)).height;
    expect(burstTip).toBe(1 + BURST);
    await waitHeight(mesh.nodes, burstTip);

    // ---- read every header 1..tip from node 0, recompute the schedule ----
    const block1 = await readHeader(miner, 1);
    // VALIDATION_INTERFACE → asertTargetBits: block 1 = the anchor, no parent
    expect(block1.powTargetBits).toBe(devnet.orderingBlockPowTargetBits);
    const anchorCreatedAt = block1.createdAt;

    let maxBits = block1.powTargetBits;
    let prevCreatedAt = block1.createdAt;

    for (let h = 2; h <= burstTip; h++) {
      const hdr = await readHeader(miner, h);
      const parent = await readHeader(miner, h - 1);

      const expected = asertTargetBits(P_DEV, anchorCreatedAt, parent);
      expect(hdr.powTargetBits).toBe(expected);

      // MINING_INTERFACE → Header timestamp rules: strictly increasing
      expect(hdr.createdAt).toBeGreaterThan(prevCreatedAt);
      prevCreatedAt = hdr.createdAt;

      if (hdr.powTargetBits > maxBits) maxBits = hdr.powTargetBits;
    }

    // A burst mined in seconds puts Δ ≈ −40 · 60 000 ms: the target moves
    // harder (higher bits). 40 · 60 000 · 256 / 17 280 000 ≈ 35.6 units above
    // the anchor. Real mining takes nonzero time, so the peak is a few units
    // lower — assert the direction, not the number.
    expect(maxBits).toBeGreaterThan(devnet.orderingBlockPowTargetBits);

    // ---- late joiner reaches the tip, every header identical ----
    const joiner = await mesh.addNode();
    await waitHeight([joiner], burstTip);

    for (let h = 1; h <= burstTip; h++) {
      const minerHdr = await readHeader(miner, h);
      const joinerHdr = await readHeader(joiner, h);
      expect(joinerHdr.powTargetBits).toBe(minerHdr.powTargetBits);
      expect(joinerHdr.createdAt).toBe(minerHdr.createdAt);
      expect(joinerHdr.prevBlockHash).toBe(minerHdr.prevBlockHash);
    }

    // ---- second burst after the joiner is up ----
    const BURST2 = 10;
    await mine(miner, mesh.miningSecret, BURST2);
    const finalTip = (await getBlockCurrent(miner)).height;
    expect(finalTip).toBe(burstTip + BURST2);
    await waitHeight([joiner], finalTip);

    // The joiner follows: its headers equal node 0's and the recomputation
    // holds over the whole chain.
    prevCreatedAt = anchorCreatedAt;
    for (let h = 2; h <= finalTip; h++) {
      const minerHdr = await readHeader(miner, h);
      const joinerHdr = await readHeader(joiner, h);
      expect(joinerHdr.powTargetBits).toBe(minerHdr.powTargetBits);
      expect(joinerHdr.createdAt).toBe(minerHdr.createdAt);

      const parent = await readHeader(miner, h - 1);
      const expected = asertTargetBits(P_DEV, anchorCreatedAt, parent);
      expect(minerHdr.powTargetBits).toBe(expected);

      expect(minerHdr.createdAt).toBeGreaterThan(prevCreatedAt);
      prevCreatedAt = minerHdr.createdAt;
    }
  });
});
