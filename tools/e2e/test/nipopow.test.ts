import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';
import { getBlockCurrent } from '../src/http.js';
import type { NodeProcess } from '../src/node-process.js';
import {
  NETWORK_PROFILES,
  RETARGET_HALFLIFE_BLOCKS,
  MAX_FUTURE_DRIFT_MS,
} from '@dagsocial/types';
import {
  verifyProof,
  compareProofs,
  decodeNipopowProof,
} from '@dagsocial/nipopow';

const FILE_INDEX = 10;
const M = 2;
const K = 3;
const REQUIRED_HEIGHT = M + K;

const devnetProfile = NETWORK_PROFILES.devnet;

function makeVerifyProfile() {
  return {
    retarget: {
      anchorBits: devnetProfile.orderingBlockPowTargetBits,
      idealMs: devnetProfile.orderingBlockIdealMs,
      halflifeMs: RETARGET_HALFLIFE_BLOCKS * devnetProfile.orderingBlockIdealMs,
      floorBits: devnetProfile.orderingBlockPowTargetFloorBits,
      ceilingBits: devnetProfile.orderingBlockPowTargetCeilingBits,
    },
    maxFutureDriftMs: MAX_FUTURE_DRIFT_MS,
    nowMs: Date.now(),
    genesisId: devnetProfile.genesisId,
    protocolVersionSchedule: devnetProfile.protocolVersionSchedule,
  };
}

async function fetchProofRaw(
  node: NodeProcess,
  m: number,
  k: number,
): Promise<Response> {
  return fetch(`${node.url}/nipopow/proof/${m}/${k}`);
}

async function fetchProofBytes(
  node: NodeProcess,
  m: number,
  k: number,
): Promise<Uint8Array> {
  const res = await fetchProofRaw(node, m, k);
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { proof: string };
  return Uint8Array.from(Buffer.from(body.proof, 'hex'));
}

describe('nipopow', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('a served proof verifies and two nodes\' proofs tie', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const [node1, node2] = mesh.nodes as [NodeProcess, NodeProcess];

    // ---- mesh proof ----
    await mine(node1, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);
    const tips1 = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const tip of tips1) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toBe(tips1[0]!.hash);
    }

    // ---- mine past m + k ----
    await mine(node1, mesh.miningSecret, REQUIRED_HEIGHT - 1);
    await waitHeight(mesh.nodes, REQUIRED_HEIGHT);

    // ---- step 1: fetch proof from each node, verify with the devnet profile ----
    const proof1Bytes = await fetchProofBytes(node1, M, K);
    const proof2Bytes = await fetchProofBytes(node2, M, K);

    const profile = makeVerifyProfile();
    const result1 = verifyProof(proof1Bytes, profile);
    const result2 = verifyProof(proof2Bytes, profile);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) return;

    // tipHeight equals the node's /blocks/current height
    const tip1 = await getBlockCurrent(node1);
    const tip2 = await getBlockCurrent(node2);
    expect(result1.tipHeight).toBe(tip1.height);
    expect(result2.tipHeight).toBe(tip2.height);

    // ---- step 2: compareProofs → tie on one chain ----
    const parsed1 = decodeNipopowProof(proof1Bytes);
    const parsed2 = decodeNipopowProof(proof2Bytes);

    const cmp = compareProofs(parsed1, parsed2, M, profile);
    expect(cmp.verdict).toBe('tie');

    // ---- step 3: suffixHead stateRoot matches the block at that height ----
    if (cmp.verdict !== 'tie') return;
    const suffixHead1Height = result1.suffixHead.header.height;
    const suffixHead2Height = result2.suffixHead.header.height;

    const block1 = await fetch(`${node1.url}/blocks/${suffixHead1Height}`);
    const blockData1 = (await block1.json()) as { header: { stateRoot: string } };
    expect(result1.suffixHead.header.stateRoot).toBe(blockData1.header.stateRoot);

    const block2 = await fetch(`${node2.url}/blocks/${suffixHead2Height}`);
    const blockData2 = (await block2.json()) as { header: { stateRoot: string } };
    expect(result2.suffixHead.header.stateRoot).toBe(blockData2.header.stateRoot);

    // ---- step 4: refusals ----
    // NODE_INTERFACE → Nipopow: m=0 → 400
    const bad0 = await fetchProofRaw(node1, 0, K);
    expect(bad0.status).toBe(400);

    // NODE_INTERFACE → Nipopow: k=129 → 400 (above MAX_NIPOPOW_PARAM = 128)
    const bad129 = await fetchProofRaw(node1, M, 129);
    expect(bad129.status).toBe(400);

    // NODE_INTERFACE → Nipopow: chain too short → 404
    // NIPOPOW_INTERFACE → Constants: k must be in [1, 128], so use a valid k
    // where m + k exceeds chain height
    const short = await fetchProofRaw(node1, M, 128);
    expect(short.status).toBe(404);
    const shortBody = (await short.json()) as { error: string };
    expect(shortBody.error).toBe('chain too short');
  });
});
