import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, waitHeight } from '../src/miner.js';

const FILE_INDEX = 0;

describe('mesh proof', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('boots 3 nodes, mines 1 block, height 1 and /blocks/1 identical on all', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });

    await mine(mesh.nodes[0]!, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    const tips = await Promise.all(
      mesh.nodes.map(async (n) => {
        const res = await fetch(`${n.url}/blocks/current`);
        expect(res.ok).toBe(true);
        return (await res.json()) as { height: number; hash: string | null };
      }),
    );

    for (const tip of tips) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toEqual(tips[0]!.hash);
    }

    const blocks = await Promise.all(
      mesh.nodes.map(async (n) => {
        const res = await fetch(`${n.url}/blocks/1`);
        expect(res.ok).toBe(true);
        return (await res.json()) as {
          header: { height: number; stateRoot: string };
        };
      }),
    );

    for (const block of blocks) {
      expect(block.header.stateRoot).toEqual(blocks[0]!.header.stateRoot);
    }
  });
});
