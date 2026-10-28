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
  getStatus,
  hasKarma,
  getBlockCurrent,
  getPosts,
  type KarmaPage,
} from '../src/http.js';
import {
  NETWORK_PROFILES,
  KARMA_DECAY_AMOUNT,
  POST_PRICE_THREAD,
  decayCfgFor,
  effectiveKarma,
  type IdentityRecord,
} from '@dagsocial/types';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 13;

const devnet = NETWORK_PROFILES.devnet;
const CFG = decayCfgFor(devnet);
const THRESHOLD = devnet.karmaStaleThresholdBlocks;   // 500
const INTERVAL  = devnet.karmaDecayIntervalBlocks;     // 3

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string; income?: true }[] },
): BoxRef[] {
  return karma.boxes.map((b) =>
    b.income === true
      ? { boxId: b.boxId, value: BigInt(b.value), income: true }
      : { boxId: b.boxId, value: BigInt(b.value) },
  );
}

// The record the route serves, as `effectiveKarma` reads it (NODE_INTERFACE → UTXO queries).
function recordOf(k: KarmaPage): IdentityRecord {
  return {
    lastActivityBlock: k.lastActivityBlock,
    lastDecayBlock: k.lastDecayBlock,
    invitedAtBlock: k.invitedAtBlock,
    lifetimeLikesReceived: BigInt(k.lifetimeLikesReceived),
    memberSinceBlock: k.memberSinceBlock,
    memberBar: k.memberBar,
    memberVouches: k.memberVouches,
    memberLikes: BigInt(k.memberLikes),
    invitesUsed: k.invitesUsed,
  };
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

    const version = (await getStatus(node)).protocolVersion;

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
      version,
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
    // NODE_INTERFACE → Karma decay → "Decay starts at the grace window's end, and from nothing":
    // the clock starts at lastActivityBlock + staleThresholdBlocks and the first period falls one interval later.
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

    // one period owed at claimHeight + T + I: the valuation and the stated figure both hold
    expect(karmaStale.height).toBe(targetHeight);
    expect(karmaStale.lastActivityBlock).toBe(claimHeight);
    expect(staleEffective).toBe(
      effectiveKarma(staleTotal, recordOf(karmaStale), karmaStale.height, CFG),
    );
    expect(staleEffective).toBe(aliceTotal - KARMA_DECAY_AMOUNT);

    // ---- step 5: activity resets the clock ----
    let aliceK = (await getKarma(node, alice.publicKeyHex))!;
    const threadTx = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'hello from the other side of staleness',
      aliceK.height,
      version,
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

    // NODE_INTERFACE → Karma decay: the post's block squares alice over her pre-body record,
    // read off the served record at the block's height. The body deducted POST_PRICE_THREAD.
    const postRow = (await getPosts(node)).posts.find((r) => r.id === postRes.postId)!;
    const postBodyFace = aliceTotal - POST_PRICE_THREAD;
    const squaredValue = effectiveKarma(
      postBodyFace,
      recordOf(karmaStale),
      postRow.blockHeight!,
      CFG,
    );
    expect(postTotal).toBe(squaredValue);
    // activity reset the clock — effective equals the post-squaring total
    expect(postEffective).toBe(postTotal);
  }, 120_000);
});
