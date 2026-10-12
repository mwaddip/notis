import { describe, it, afterAll, expect } from 'vitest';
import {
  LIKES_PER_KARMA_PAYOUT,
  POST_PRICE_THREAD,
  computeContentHash,
} from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx, buildReplyTx } from '../src/tx/post.js';
import { signAndRender, type BoxRef } from '../src/tx/render.js';
import {
  postInvite,
  postPost,
  getKarma,
  getStatus,
  hasKarma,
  getPost,
  getBlockCurrent,
  NodeError,
  isPost,
  type KarmaPage,
} from '../src/http.js';

const FILE_INDEX = 22;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string; income?: true }[] },
): BoxRef[] {
  return karma.boxes.map((b) =>
    b.income === true
      ? { boxId: b.boxId, value: BigInt(b.value), income: true }
      : { boxId: b.boxId, value: BigInt(b.value) },
  );
}

// NODE_INTERFACE → UTXO queries — a karma box carries `income: true` when it
// is the owner's income box and no such key when it is their own.
function ownBox(page: KarmaPage): { boxId: string; value: bigint } {
  const own = page.boxes.filter((b) => b.income !== true);
  expect(own.length).toBe(1);
  return { boxId: own[0]!.boxId, value: BigInt(own[0]!.value) };
}

function incomeBox(page: KarmaPage): { boxId: string; value: bigint } {
  const income = page.boxes.filter((b) => b.income === true);
  expect(income.length).toBe(1);
  return { boxId: income[0]!.boxId, value: BigInt(income[0]!.value) };
}

describe('karma income box', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it(
    'the settlement pays an author in one income box, the own box stays, a spend over the own box names both, income alone and two karma outputs are refused',
    async () => {
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

      const version = (await getStatus(miner)).protocolVersion;

      // ---- faucet invites alice (author) and bob (replier) ----
      const alice = fresh();
      const bob = fresh();
      const aliceBond = 11n;
      const bobBond = 100n;

      const faucetK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
      const inv1 = buildInviteTx(
        DEVNET_FAUCET,
        karmaBoxes(faucetK),
        alice,
        aliceBond,
        faucetK.height,
        version,
      );
      await postInvite(miner, inv1.json);
      const inv2 = buildInviteTx(
        DEVNET_FAUCET,
        [inv1.outputs[0]!],
        bob,
        bobBond,
        faucetK.height,
        version,
      );
      await postInvite(miner, inv2.json);

      await confirm(
        async () =>
          (await hasKarma(miner, alice.publicKeyHex)) &&
          (await hasKarma(miner, bob.publicKeyHex)),
        miner,
        mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

      // ---- alice posts her thread, bob posts the one she will later reply to ----
      const aliceK0 = await getKarma(miner, alice.publicKeyHex);
      expect(BigInt(aliceK0.total)).toBe(aliceBond);
      const aliceThread = buildThreadTx(
        alice,
        karmaBoxes(aliceK0),
        'alice thread for likes',
        aliceK0.height,
        version,
      );
      const aliceThreadRes = await postPost(miner, aliceThread.json, aliceThread.content);
      await confirm(
        async () => {
          const p = await getPost(miner, aliceThreadRes.postId);
          return p !== null && isPost(p) && p.status === 'confirmed';
        },
        miner,
        mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

      const bobK0 = await getKarma(miner, bob.publicKeyHex);
      const bobThread = buildThreadTx(
        bob,
        karmaBoxes(bobK0),
        'bob thread for a reply case A',
        bobK0.height,
        version,
      );
      const bobThreadRes = await postPost(miner, bobThread.json, bobThread.content);
      await confirm(
        async () => {
          const p = await getPost(miner, bobThreadRes.postId);
          return p !== null && isPost(p) && p.status === 'confirmed';
        },
        miner,
        mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

      // NODE_INTERFACE → Karma transition rules — alice posts no more and
      // claims nothing until the probes and the case A spend, so her own box
      // stands with its post-thread value from here through every payout.
      const ownValueBefore = aliceBond - POST_PRICE_THREAD;
      const aliceKPreLikes = await getKarma(miner, alice.publicKeyHex);
      expect(aliceKPreLikes.boxes.length).toBe(1);
      const ownBefore = ownBox(aliceKPreLikes);
      expect(ownBefore.value).toBe(ownValueBefore);

      // ---- three payouts in different blocks ----
      // ARCHITECTURE → Per-block accrual and settlement — one reply per
      // block, so each block delivers one marker to the parent's author; after
      // LIKES_PER_KARMA_PAYOUT such blocks the author's carry fills and the
      // settlement emits an income box of `x − 1` karma for them
      // (NODE_INTERFACE → The settlement transaction → "The income leg pays
      // each owner once").
      const perPayout = BigInt(LIKES_PER_KARMA_PAYOUT - 1);
      const incomeIds: string[] = [];
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < LIKES_PER_KARMA_PAYOUT; i++) {
          const bobK = await getKarma(miner, bob.publicKeyHex);
          const reply = buildReplyTx(
            bob,
            karmaBoxes(bobK),
            `round ${round} reply ${i}`,
            aliceThreadRes.postId,
            alice.publicKeyHex,
            bobK.height,
            version,
          );
          const replyRes = await postPost(miner, reply.json, reply.content);
          await confirm(
            async () => {
              const p = await getPost(miner, replyRes.postId);
              return p !== null && isPost(p) && p.status === 'confirmed';
            },
            miner,
            mesh.miningSecret,
          );
          await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);
        }

        // Each node of the mesh answers alice's two boxes identically after
        // the payout — the own box unchanged, the income box carrying the sum
        // so far, with its id different from the previous payout's.
        const expectedIncomeValue = perPayout * BigInt(round + 1);
        for (const node of mesh.nodes) {
          const page = await getKarma(node, alice.publicKeyHex);
          expect(page.boxes.length).toBe(2);
          const own = ownBox(page);
          const income = incomeBox(page);
          expect(own.boxId).toBe(ownBefore.boxId);
          expect(own.value).toBe(ownBefore.value);
          expect(income.value).toBe(expectedIncomeValue);
          expect(BigInt(page.total)).toBe(own.value + income.value);
          if (round > 0) {
            expect(income.boxId).not.toBe(incomeIds[round - 1]);
          }
          if (node === miner) incomeIds.push(income.boxId);
        }
      }

      // ---- probe: a spend that names income alone while own stands → 400 ----
      // NODE_INTERFACE → Karma transition rules — rule 3: "every unmarked
      // karma box the owner holds is among the inputs".
      {
        const page = await getKarma(miner, alice.publicKeyHex);
        const own = ownBox(page);
        const income = incomeBox(page);
        const aliceOwner = Buffer.from(alice.publicKeyHex, 'hex');
        const probeContent = 'income-alone probe';
        const probeHeight = page.height;
        const probe = signAndRender(alice, {
          inputs: [income.boxId],
          outputs: [
            {
              boxType: 'karma',
              value: income.value - POST_PRICE_THREAD,
              createdAtBlock: probeHeight,
              owner: aliceOwner,
            },
            {
              boxType: 'karma_price',
              value: POST_PRICE_THREAD,
              createdAtBlock: probeHeight,
            },
          ],
          signatures: {},
          protocolVersion: version,
          post: {
            contentHash: computeContentHash(probeContent),
            author: aliceOwner,
            parentRefs: [],
            protocolVersion: version,
            type: 'regular' as const,
          },
        });
        try {
          await postPost(miner, probe.json, probeContent);
          expect.fail('a spend naming the income box alone should have been refused');
        } catch (err) {
          expect(err).toBeInstanceOf(NodeError);
          const ne = err as NodeError;
          expect(ne.status).toBe(400);
          expect(ne.body['reason']).toBe(
            `The owner's own karma box ${own.boxId} is not among the inputs; ` +
              `a karma spend names every unmarked karma box the owner holds`,
          );
        }
      }

      // ---- probe: a transaction with two karma outputs → 400 ----
      // NODE_INTERFACE → Karma transition rules — rule 1: "a spend returns
      // its change in one box or in none".
      {
        const page = await getKarma(miner, alice.publicKeyHex);
        const own = ownBox(page);
        const income = incomeBox(page);
        const aliceOwner = Buffer.from(alice.publicKeyHex, 'hex');
        const probeContent = 'two-karma-outputs probe';
        const probeHeight = page.height;
        const inSum = own.value + income.value;
        const half = (inSum - POST_PRICE_THREAD) / 2n;
        const rest = inSum - POST_PRICE_THREAD - half;
        const twoOutputTx: UtxoTransaction = {
          inputs: [own.boxId, income.boxId],
          outputs: [
            { boxType: 'karma', value: half, createdAtBlock: probeHeight, owner: aliceOwner },
            { boxType: 'karma', value: rest, createdAtBlock: probeHeight, owner: aliceOwner },
            { boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: probeHeight },
          ],
          signatures: {},
          protocolVersion: version,
          post: {
            contentHash: computeContentHash(probeContent),
            author: aliceOwner,
            parentRefs: [],
            protocolVersion: version,
            type: 'regular' as const,
          },
        };
        const probe = signAndRender(alice, twoOutputTx);
        try {
          await postPost(miner, probe.json, probeContent);
          expect.fail('a transaction with two karma outputs should have been refused');
        } catch (err) {
          expect(err).toBeInstanceOf(NodeError);
          const ne = err as NodeError;
          expect(ne.status).toBe(400);
          expect(ne.body['reason']).toBe('A karma spend emits at most one karma output');
        }
      }

      // ---- case A: a spend the own box covers names only the own box ----
      // NODE_INTERFACE → Karma transition rules — the helper takes the own
      // box alone when it covers the spend.
      const aliceKA = await getKarma(miner, alice.publicKeyHex);
      const ownBeforeA = ownBox(aliceKA);
      const incomeBeforeA = incomeBox(aliceKA);
      const replyA = buildReplyTx(
        alice,
        karmaBoxes(aliceKA),
        'alice reply own covers',
        bobThreadRes.postId,
        bob.publicKeyHex,
        aliceKA.height,
        version,
      );
      expect(replyA.json['inputs']).toEqual([ownBeforeA.boxId]);
      const replyARes = await postPost(miner, replyA.json, replyA.content);
      await confirm(
        async () => {
          const p = await getPost(miner, replyARes.postId);
          return p !== null && isPost(p) && p.status === 'confirmed';
        },
        miner,
        mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

      for (const node of mesh.nodes) {
        const page = await getKarma(node, alice.publicKeyHex);
        expect(page.boxes.length).toBe(2);
        const own = ownBox(page);
        const income = incomeBox(page);
        // The reply pays `POST_PRICE_REPLY` to the pool and settlement
        // (`REPLY_AUTHOR_SHARE` ride-along to bob is settled through a marker,
        // not from alice's inputs beyond her spend).
        expect(own.value).toBeLessThan(ownBeforeA.value);
        expect(income.boxId).toBe(incomeBeforeA.boxId);
        expect(income.value).toBe(incomeBeforeA.value);
      }

      // ---- case B: a spend the own box does not cover names both ----
      // NODE_INTERFACE → Karma transition rules — the helper takes the
      // income box only when the own box does not cover the spend. After the
      // thread the owner holds one unmarked box and no marked one
      // (NODE_INTERFACE → The settlement transaction → "The income leg pays
      // each owner once": `income` is the settlement's mark alone).
      const aliceKB = await getKarma(miner, alice.publicKeyHex);
      const ownBeforeB = ownBox(aliceKB);
      const incomeBeforeB = incomeBox(aliceKB);
      expect(ownBeforeB.value).toBeLessThan(POST_PRICE_THREAD);
      expect(ownBeforeB.value + incomeBeforeB.value).toBeGreaterThanOrEqual(POST_PRICE_THREAD);
      const threadB = buildThreadTx(
        alice,
        karmaBoxes(aliceKB),
        'alice thread own does not cover',
        aliceKB.height,
        version,
      );
      const threadBInputs = threadB.json['inputs'] as string[];
      expect(threadBInputs).toEqual([ownBeforeB.boxId, incomeBeforeB.boxId]);
      const threadBRes = await postPost(miner, threadB.json, threadB.content);
      await confirm(
        async () => {
          const p = await getPost(miner, threadBRes.postId);
          return p !== null && isPost(p) && p.status === 'confirmed';
        },
        miner,
        mesh.miningSecret,
      );
      await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

      for (const node of mesh.nodes) {
        const page = await getKarma(node, alice.publicKeyHex);
        expect(page.boxes.length).toBe(1);
        const only = page.boxes[0]!;
        expect(only.income).toBeUndefined();
        expect(BigInt(only.value)).toBe(
          ownBeforeB.value + incomeBeforeB.value - POST_PRICE_THREAD,
        );
        expect(BigInt(page.total)).toBe(
          ownBeforeB.value + incomeBeforeB.value - POST_PRICE_THREAD,
        );
      }
    },
    180_000,
  );
});
