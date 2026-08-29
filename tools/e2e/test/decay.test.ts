import { describe, it, afterAll, expect } from 'vitest';
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
  getBlockCurrent,
  getPosts,
} from '../src/http.js';
import {
  NETWORK_PROFILES,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  POST_PRICE_THREAD,
} from '@dagsocial/types';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 13;

const devnet = NETWORK_PROFILES.devnet;
const THRESHOLD = devnet.karmaStaleThresholdBlocks;   // 500
const INTERVAL  = devnet.karmaDecayIntervalBlocks;     // 3

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

// NODE_INTERFACE → Karma decay (virtual, squared on touch)
function expectedEffective(
  faceTotal: bigint,
  height: number,
  lastActivity: number,
  lastDecay: number,
): bigint {
  const stale = height - lastActivity >= THRESHOLD;
  if (!stale) return faceTotal;
  const clockStart = Math.max(lastActivity, lastDecay);
  const periods = Math.floor((height - clockStart) / INTERVAL);
  if (periods <= 0) return faceTotal;
  const owed = BigInt(periods) * KARMA_DECAY_AMOUNT;
  const floor = faceTotal < KARMA_MINIMUM ? faceTotal : KARMA_MINIMUM;
  const decayed = faceTotal - owed;
  return decayed > floor ? decayed : floor;
}

describe('decay', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('effective falls below total once stale, activity resets it', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 1 });
    const node = mesh.nodes[0]!;

    // ---- mesh proof ----
    await mine(node, mesh.miningSecret, 1);
    await waitHeight([node], 1);

    const tip = await getBlockCurrent(node);
    expect(tip.height).toBe(1);

    const block1 = await fetch(`${node.url}/blocks/1`);
    expect(block1.ok).toBe(true);

    // ---- invite alice ----
    const alice = fresh();
    const bondAmount = 50n;

    const faucetKarma = (await getKarma(node, DEVNET_FAUCET.publicKeyHex))!;
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetKarma),
      alice,
      bondAmount,
      faucetKarma.height,
    );
    await postInvite(node, invite.json);

    await confirm(
      async () => await hasKarma(node, alice.publicKeyHex),
      node,
      mesh.miningSecret,
    );

    // ---- step 3: effective === total when not stale ----
    const karmaAfterInvite = (await getKarma(node, alice.publicKeyHex))!;
    const aliceTotal = BigInt(karmaAfterInvite.total);
    expect(aliceTotal).toBe(bondAmount);
    expect(karmaAfterInvite.effective).toBe(karmaAfterInvite.total);

    const claimHeight = karmaAfterInvite.height;

    // ---- step 4: mine to stale + one interval ----
    // ARCHITECTURE → Karma decay: stale = (height − lastActivityBlock) >= threshold
    const targetHeight = claimHeight + THRESHOLD + INTERVAL;
    const currentTip = await getBlockCurrent(node);
    const blocksNeeded = targetHeight - currentTip.height;
    await mine(node, mesh.miningSecret, blocksNeeded);
    await waitHeight([node], targetHeight);

    const karmaStale = (await getKarma(node, alice.publicKeyHex))!;
    const staleTotal = BigInt(karmaStale.total);
    const staleEffective = BigInt(karmaStale.effective);

    // total unchanged — decay is virtual
    expect(staleTotal).toBe(aliceTotal);
    expect(staleEffective).toBeLessThan(staleTotal);

    // the exact figure, computed from the profile's numbers
    const expected = expectedEffective(
      staleTotal,
      karmaStale.height,
      claimHeight,
      0,
    );
    expect(staleEffective).toBe(expected);

    // ---- step 5: activity resets the clock ----
    let aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const threadTx = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'hello from the other side of staleness',
      aliceK.height,
    );
    const postRes = await postPost(node, threadTx.json, threadTx.content);
    await confirm(
      async () => {
        const p = await getPosts(node);
        return p.posts.some((r) => r.id === postRes.postId && r.status === 'confirmed');
      },
      node,
      mesh.miningSecret,
    );

    const karmaAfterPost = (await getKarma(node, alice.publicKeyHex))!;
    const postTotal = BigInt(karmaAfterPost.total);
    const postEffective = BigInt(karmaAfterPost.effective);

    // ARCHITECTURE → Karma decay: squaring materializes the decay on touch.
    // The user tx deducted POST_PRICE_THREAD from face total (50n → 45n),
    // then the settlement squared 45n to effective (10n, clamped at KARMA_MINIMUM).
    const postBodyFace = aliceTotal - POST_PRICE_THREAD;
    const squaredValue = expectedEffective(postBodyFace, karmaStale.height, claimHeight, 0);
    expect(postTotal).toBe(squaredValue);
    // activity reset the clock — effective equals the post-squaring total
    expect(postEffective).toBe(postTotal);
  }, 120_000);
});
