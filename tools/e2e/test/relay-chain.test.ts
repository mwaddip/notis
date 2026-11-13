import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { mine, confirm, waitHeight } from '../src/miner.js';
import { DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildThreadTx } from '../src/tx/post.js';
import { karmaBoxRefs } from '../src/tx/karma.js';
import {
  postInvite,
  postPost,
  getKarma,
  getKarmaPending,
  getStatus,
  hasKarma,
  getPost,
  getBlockCurrent,
  adminGet,
  isPost,
} from '../src/http.js';
import type { NodeProcess } from '../src/node-process.js';

const FILE_INDEX = 25;


// MEMPOOL_INTERFACE → getBoxWithPending → "A relayed transaction is judged
// against the pending view, as a submitted one is": a child whose parent
// a node already pools is admitted and relayed on. The wait rides the
// gossip arrival, bounded in time as `waitHeight` is.
async function waitPostsPending(
  nodes: NodeProcess[],
  postIds: readonly string[],
  windowMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (const node of nodes) {
    for (const id of postIds) {
      let standing = false;
      while (Date.now() < deadline) {
        const p = await getPost(node, id);
        if (p !== null && isPost(p) && (p.status === 'pending' || p.status === 'confirmed')) {
          standing = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!standing) {
        const tails = nodes
          .map((n) => `--- :${n.httpPort} ---\n${n.logs.slice(-10).join('\n')}`)
          .join('\n');
        throw new Error(
          `Node :${node.httpPort} did not pool post ${id} within ${windowMs}ms\n${tails}`,
        );
      }
    }
  }
}

describe('relay-chain', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('a chain of spends written to a non-mining node is mined on every node', async () => {
    mesh = await createMesh({ fileIndex: FILE_INDEX, nodeCount: 2 });
    const miner = mesh.nodes[0]!;
    const peer = mesh.nodes[1]!;

    // ---- mesh proof ----
    await mine(miner, mesh.miningSecret, 1);
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

    // ---- invite the author, confirm on the miner, wait on both nodes ----
    const version = (await getStatus(miner)).protocolVersion;
    const alice = fresh();
    const bondAmount = 50n;
    const faucetK = await getKarma(miner, DEVNET_FAUCET.publicKeyHex);
    const invite = buildInviteTx(
      DEVNET_FAUCET, karmaBoxRefs(faucetK), alice, bondAmount, faucetK.height, version,
    );
    await postInvite(miner, invite.json);
    await confirm(
      async () => hasKarma(miner, alice.publicKeyHex),
      miner, mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- first spend built on the non-mining peer's pending view ----
    // NODE_INTERFACE → UTXO queries → "`pending=1` answers the pending
    // view, as admission spends from it": the view the peer judges
    // admission against, and the view a client chaining its spends
    // builds on.
    const alicePending1 = await getKarmaPending(peer, alice.publicKeyHex);
    expect(alicePending1.boxes.length).toBe(1);

    const thread1 = buildThreadTx(
      alice, karmaBoxRefs(alicePending1), 'first', alicePending1.height, version,
    );
    const thread1Res = await postPost(peer, thread1.json, thread1.content);

    // ---- second spend built on the peer's pending view, which now names
    // the first post's change ----
    // MEMPOOL_INTERFACE → getBoxWithPending — the subtraction first, over
    // both halves: the first spend's input is out of the view, its change
    // is in. One box, a pool output of the peer's.
    const alicePending2 = await getKarmaPending(peer, alice.publicKeyHex);
    expect(alicePending2.boxes.length).toBe(1);
    expect(alicePending2.boxes[0]!.boxId).toBe(thread1.outputs[0]!.boxId);

    const thread2 = buildThreadTx(
      alice, karmaBoxRefs(alicePending2), 'second', alicePending2.height, version,
    );
    const thread2Res = await postPost(peer, thread2.json, thread2.content);

    // ---- the case chains at all: the second spend's input is the first's
    // change, and no box the miner's confirmed listing holds carries it.
    // MEMPOOL_INTERFACE → getBoxWithPending → "A relayed transaction is
    // judged against the pending view, as a submitted one is."
    const firstChangeBoxId = thread1.outputs[0]!.boxId;
    const minerConfirmed = await getKarma(miner, alice.publicKeyHex);
    const minerConfirmedIds = minerConfirmed.boxes.map((b) => b.boxId);
    expect(minerConfirmedIds).not.toContain(firstChangeBoxId);

    // ---- both posts stand on the miner, pending — a gossip arrival ----
    // MEMPOOL_INTERFACE → getBoxWithPending →
    // "A relayed transaction is judged against the pending view, as a submitted one is":
    // a peer that pools the parent admits the child and relays it on.
    await waitPostsPending(mesh.nodes, [thread1Res.postId, thread2Res.postId]);

    // ---- confirm both on the miner, bounded in blocks ----
    await confirm(
      async () => {
        const p1 = await getPost(miner, thread1Res.postId);
        const p2 = await getPost(miner, thread2Res.postId);
        return p1 !== null && isPost(p1) && p1.status === 'confirmed'
          && p2 !== null && isPost(p2) && p2.status === 'confirmed';
      },
      miner, mesh.miningSecret, 5,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- on every node ----
    // NODE_INTERFACE → Posts — a confirmed row carries `blockHeight` and
    // `blockIndex`, and a block's apply order fixes the two; the parent
    // of a chain rides the earlier slot (NODE_INTERFACE → Block
    // finalization). The second spend's change is re-read on each node
    // and asserted equal to the derived candidate id, as the suite does
    // for every change it builds on.
    const thread2ChangeBoxId = thread2.outputs[0]!.boxId;
    let firstHeight: number | null = null;
    let firstIndex: number | null = null;
    let secondHeight: number | null = null;
    let secondIndex: number | null = null;
    for (const node of mesh.nodes) {
      const p1 = await getPost(node, thread1Res.postId);
      const p2 = await getPost(node, thread2Res.postId);
      expect(p1).not.toBeNull();
      expect(p2).not.toBeNull();
      expect(isPost(p1!)).toBe(true);
      expect(isPost(p2!)).toBe(true);
      if (isPost(p1!) && isPost(p2!)) {
        expect(p1.status).toBe('confirmed');
        expect(p2.status).toBe('confirmed');
        expect(p1.blockHeight).not.toBeNull();
        expect(p2.blockHeight).not.toBeNull();
        expect(p1.blockIndex).not.toBeNull();
        expect(p2.blockIndex).not.toBeNull();
        const h1 = p1.blockHeight!;
        const h2 = p2.blockHeight!;
        const i1 = p1.blockIndex!;
        const i2 = p2.blockIndex!;
        if (h1 === h2) {
          expect(i1).toBeLessThan(i2);
        } else {
          expect(h1).toBeLessThan(h2);
        }
        if (firstHeight === null) {
          firstHeight = h1;
          firstIndex = i1;
          secondHeight = h2;
          secondIndex = i2;
        } else {
          expect(h1).toBe(firstHeight);
          expect(i1).toBe(firstIndex);
          expect(h2).toBe(secondHeight);
          expect(i2).toBe(secondIndex);
        }
      }

      const aliceK = await getKarma(node, alice.publicKeyHex);
      const aliceIds = aliceK.boxes.map((b) => b.boxId);
      expect(aliceIds).toContain(thread2ChangeBoxId);
    }

    // ---- the counter on the miner stays at 0 ----
    // NODE_INTERFACE → Admin Listener — `relayed_txs_input_missing_total`
    // counts every relayed transaction `onTx` refuses for a missing
    // input. The chain of two was admitted on the first try at every
    // link, so the counter stands at 0.
    const stats = await adminGet(miner, '/stats');
    const counters = stats['counters'] as Record<string, number>;
    expect(counters['relayed_txs_input_missing_total']).toBe(0);
  });
});
