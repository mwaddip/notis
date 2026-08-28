import { describe, it, afterAll, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { postInvite, getKarma, hasKarma, getBlockCurrent } from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';
import type { NodeProcess } from '../src/node-process.js';

const FILE_INDEX = 11;
const M = 2;
const K = 3;
const REQUIRED_HEIGHT = M + K;

const TOOL_ENTRY = resolve(
  import.meta.dirname,
  '..',
  '..',
  'nipopow-client',
  'dist',
  'index.js',
);

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

function runTool(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TOOL_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr!.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

describe('nipopow-client', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('the light client binary agrees two nodes\' tip and proves a key\'s boxes', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const [node1, node2] = mesh.nodes as [NodeProcess, NodeProcess];

    // ---- mesh proof ----
    await mine(node1, mesh.miningSecret, 1);
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

    // ---- invite a member so the key holds karma ----
    const member = fresh();
    const bondAmount = 50n;

    const faucetKarma = (await getKarma(node1, DEVNET_FAUCET.publicKeyHex))!;
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      member,
      bondAmount,
      faucetKarma.height,
    );
    await postInvite(node1, invite.json);

    await confirm(
      async () => await hasKarma(node1, member.publicKeyHex),
      node1,
      mesh.miningSecret,
    );

    // Mine past m + k with the karma box k-deep from suffixHead
    const afterInvite = (await getBlockCurrent(node1)).height;
    const targetHeight = Math.max(afterInvite + K, REQUIRED_HEIGHT + 1);
    const blocksNeeded = targetHeight - afterInvite;
    if (blocksNeeded > 0) {
      await mine(node1, mesh.miningSecret, blocksNeeded);
    }
    await waitHeight(mesh.nodes, targetHeight);

    // ---- run the built tool as a child process ----
    const toolEnv = {
      NODE_URLS: `${node1.url},${node2.url}`,
      NETWORK_TYPE: 'devnet',
    };
    const result = await runTool(
      ['--m', String(M), '--k', String(K), '--user', member.publicKeyHex, '--json'],
      toolEnv,
    );
    expect(result.code).toBe(0);

    const json = JSON.parse(result.stdout) as {
      tip: { height: number; hash: string };
      suffixHead: { height: number; hash: string; stateRoot: string };
      nodes: { url: string; verified: boolean; refuseReason: string | null }[];
      splits: { indexA: number; indexB: number; reason: string }[];
      boxes: { boxId: string; class: string; value: string; status: string; verdict: string }[];
      karmaTotal: string;
      creditTotal: string;
    };

    // Tip equals both nodes' /blocks/current
    const finalTips = await Promise.all(mesh.nodes.map(getBlockCurrent));
    expect(finalTips[0]!.height).toBe(finalTips[1]!.height);
    expect(finalTips[0]!.hash).toBe(finalTips[1]!.hash);
    expect(json.tip.height).toBe(finalTips[0]!.height);
    expect(json.tip.hash).toBe(finalTips[0]!.hash);

    // Both nodes verified, no splits
    expect(json.nodes).toHaveLength(2);
    for (const n of json.nodes) {
      expect(n.verified).toBe(true);
      expect(n.refuseReason).toBeNull();
    }
    expect(json.splits).toEqual([]);

    // suffixHead.height === tip − (k − 1)
    expect(json.suffixHead.height).toBe(json.tip.height - (K - 1));

    // Every listed box is proven with the value the chain gave it
    expect(json.boxes.length).toBeGreaterThan(0);
    const memberKarma = (await getKarma(node1, member.publicKeyHex))!;
    const chainBoxValues = new Map(
      memberKarma.boxes.map((b) => [b.boxId, b.value]),
    );
    for (const b of json.boxes) {
      expect(b.status).toBe('proven');
      expect(chainBoxValues.has(b.boxId)).toBe(true);
      expect(b.value).toBe(chainBoxValues.get(b.boxId));
    }

    // Karma total equals /karma/:user's total (face values)
    expect(json.karmaTotal).toBe(memberKarma.total);

    // ---- negative: single URL without --allow-single → exit 2 ----
    const singleResult = await runTool(
      ['--m', String(M), '--k', String(K), '--user', member.publicKeyHex, '--json'],
      { NODE_URLS: node1.url, NETWORK_TYPE: 'devnet' },
    );
    expect(singleResult.code).toBe(2);
    expect(singleResult.stderr).toContain('at least 2 node URLs');

    // ---- negative: key with no boxes → exit 0, empty ----
    const unknown = fresh();
    const emptyResult = await runTool(
      ['--m', String(M), '--k', String(K), '--user', unknown.publicKeyHex, '--json'],
      toolEnv,
    );
    expect(emptyResult.code).toBe(0);
    const emptyJson = JSON.parse(emptyResult.stdout) as {
      boxes: unknown[];
      karmaTotal: string;
      creditTotal: string;
    };
    expect(emptyJson.boxes).toEqual([]);
    expect(emptyJson.karmaTotal).toBe('0');
    expect(emptyJson.creditTotal).toBe('0');
  });
});
