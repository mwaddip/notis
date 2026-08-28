import { describe, it, afterAll, expect } from 'vitest';
import { computeContentHash, updateInterlinks, interlinkRoot } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import { blockHash, level } from '@dagsocial/validation';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import {
  postInvite,
  postPost,
  getKarma,
  hasKarma,
  getPost,
  getBlock,
  getBlockCurrent,
  adminGet,
  isPost,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 3;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('sync', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row b-sync: late joiner syncs and backfills post body', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 3 });
    const miner = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);

    // ---- invite and post ----
    const alice = fresh();
    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const inv = buildInviteTx(DEVNET_FAUCET, karmaBoxes(faucetK), alice, 50n, faucetK.height);
    await postInvite(miner, inv.json);

    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner, mesh.miningSecret,
    );

    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const thread = buildThreadTx(alice, karmaBoxes(aliceK), 'synced post', aliceK.height);
    const threadRes = await postPost(miner, thread.json, thread.content);

    await confirm(
      async () => {
        const p = await getPost(miner, threadRes.postId);
        return p !== null && isPost(p) && p.status === 'confirmed';
      },
      miner, mesh.miningSecret,
    );

    // ---- mine to height >= 10 ----
    const currentTip = (await getBlockCurrent(miner)).height;
    const targetHeight = Math.max(10, currentTip);
    if (currentTip < targetHeight) {
      await mine(miner, mesh.miningSecret, targetHeight - currentTip);
    }
    await waitHeight(mesh.nodes, targetHeight);

    // ---- add late joiner, wait for sync ----
    const lateNode = await mesh.addNode();

    const heightDeadline = Date.now() + 15_000;
    let heightReached = false;
    while (Date.now() < heightDeadline) {
      try {
        const tip = await getBlockCurrent(lateNode);
        if (tip.height >= targetHeight) { heightReached = true; break; }
      } catch { /* node may still be starting */ }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(heightReached).toBe(true);

    // Mine a few blocks so the backfill driver's per-block hook fires
    // on the late joiner after sync completes.
    await mine(miner, mesh.miningSecret, 3);
    await waitHeight([lateNode], (await getBlockCurrent(miner)).height);

    // ---- wait for the body to arrive via backfill ----
    const bodyDeadline = Date.now() + 15_000;
    while (Date.now() < bodyDeadline) {
      const p = await getPost(lateNode, threadRes.postId);
      if (p !== null && isPost(p) && p.content !== null) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // ---- late joiner has all blocks, stateRoots match, interlinkRoots match
    //      a recomputation from served headers (TYPES_INTERFACE → Interlink vector) ----
    const finalTip = (await getBlockCurrent(miner)).height;
    for (const node of [miner, lateNode]) {
      let vector: string[] = [];
      for (let h = 1; h <= finalTip; h++) {
        const raw = await getBlock(node, h);
        expect(raw).not.toBeNull();
        const hdr = (raw as Record<string, unknown>)['header'] as Record<string, unknown>;
        const header: BlockHeader = {
          protocolVersion: hdr['protocolVersion'] as number,
          height: hdr['height'] as number,
          prevBlockHash: hdr['prevBlockHash'] as string,
          utxoTxRoot: hdr['utxoTxRoot'] as string,
          stateRoot: hdr['stateRoot'] as string,
          validatorId: Buffer.from(hdr['validatorId'] as string, 'hex'),
          powNonce: hdr['powNonce'] as number,
          powTargetBits: hdr['powTargetBits'] as number,
          createdAt: hdr['createdAt'] as number,
          interlinkRoot: hdr['interlinkRoot'] as string,
        };

        const hash = blockHash(header);
        expect(hash).not.toBeNull();

        const lv = level(header);
        expect(lv).not.toBeNull();

        const expectedRoot = interlinkRoot(vector);
        expect(header.interlinkRoot).toBe(expectedRoot);

        vector = updateInterlinks(vector, hash!, lv!);
      }
    }

    for (let h = 1; h <= finalTip; h++) {
      const b1 = await getBlock(miner, h);
      const bLate = await getBlock(lateNode, h);
      expect(b1).not.toBeNull();
      expect(bLate).not.toBeNull();
      const h1 = (b1 as Record<string, unknown>)['header'] as Record<string, unknown>;
      const hLate = (bLate as Record<string, unknown>)['header'] as Record<string, unknown>;
      expect(hLate['stateRoot']).toBe(h1['stateRoot']);
      expect(hLate['interlinkRoot']).toBe(h1['interlinkRoot']);
    }

    // ---- post on the late joiner: confirmed with body and correct hash ----
    const expectedHash = Buffer.from(computeContentHash('synced post')).toString('hex');

    const latePost = await getPost(lateNode, threadRes.postId);
    expect(latePost).not.toBeNull();
    expect(isPost(latePost!)).toBe(true);
    if (isPost(latePost!)) {
      expect(latePost.status).toBe('confirmed');
      expect(latePost.content).toBe('synced post');
      expect(latePost.contentHash).toBe(expectedHash);
    }

    // ---- post_bodies_pulled_total: >= 1 on the late node, 0 on the miner ----
    const lateStats = await adminGet(lateNode, '/stats');
    const lateCounters = lateStats['counters'] as Record<string, number>;
    expect(lateCounters['post_bodies_pulled_total']).toBeGreaterThanOrEqual(1);

    const minerStats = await adminGet(miner, '/stats');
    const minerCounters = minerStats['counters'] as Record<string, number>;
    expect(minerCounters['post_bodies_pulled_total']).toBe(0);
  });
});
