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
  NodeError,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';

const FILE_INDEX = 18;

function karmaBoxes(
  karma: { boxes: { boxId: string; value: string }[] },
): BoxRef[] {
  return karma.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

describe('version-schedule', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it('row a: /status, the header and the template report era 1; a version-2 tx is refused naming the era', async () => {
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

    // block 1's header carries the era at its own height — era 1 — and its
    // stateRoot is identical on every node (NODE_INTERFACE → Status).
    const block1s = await Promise.all(
      mesh.nodes.map(async (n) => {
        const res = await fetch(`${n.url}/blocks/1`);
        expect(res.ok).toBe(true);
        return (await res.json()) as {
          header: { stateRoot: string; protocolVersion: number };
        };
      }),
    );
    for (const b of block1s) {
      expect(b.header.stateRoot).toBe(block1s[0]!.header.stateRoot);
      expect(b.header.protocolVersion).toBe(1);
    }

    // ---- /status reports the era at blockHeight + 1 — era 1 on every node ----
    // WEB_INTERFACE → Invariants: a client signs the era the node reports.
    for (const node of mesh.nodes) {
      const status = await getStatus(node);
      expect(status.protocolVersion).toBe(1);
    }

    // ---- the template a miner is handed stamps the era at its height — era 1 ----
    // MINING_INTERFACE → GET /mining/template
    const tplRes = await fetch(`${miner.url}/mining/template`, {
      headers: { Authorization: `Bearer ${mesh.miningSecret}` },
    });
    expect(tplRes.ok).toBe(true);
    const tpl = (await tplRes.json()) as { header: { protocolVersion: number } };
    expect(tpl.header.protocolVersion).toBe(1);

    const version = (await getStatus(miner)).protocolVersion;
    expect(version).toBe(1);

    // ---- the envelope surface: a tx whose envelope declares era 2 is refused
    // at admission, the reason naming the era (NODE_INTERFACE → validateTx) ----
    const faucetK = (await getKarma(miner, DEVNET_FAUCET.publicKeyHex))!;
    const badEnvelope = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetK),
      fresh(),
      50n,
      faucetK.height,
      2,
    );
    try {
      await postInvite(miner, badEnvelope.json);
      expect.fail('a version-2 tx envelope should be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
      expect((err as NodeError).message).toMatch(/era\s+1\b/i);
    }

    // ---- invite alice with a valid era-1 tx (the rejected envelope above
    // spent nothing, so the same faucet boxes fund it) ----
    const alice = fresh();
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      karmaBoxes(faucetK),
      alice,
      50n,
      faucetK.height,
      version,
    );
    await postInvite(miner, invite.json);
    await confirm(
      async () => await hasKarma(miner, alice.publicKeyHex),
      miner,
      mesh.miningSecret,
    );
    await waitHeight(mesh.nodes, (await getBlockCurrent(miner)).height);

    // ---- the commit surface: a post whose envelope is era 1 but whose commit
    // declares era 2 is refused, the reason naming the era. The commit's version
    // rides in the post-id preimage, so it is checked too (NODE_INTERFACE →
    // validateTx) ----
    const aliceK = (await getKarma(miner, alice.publicKeyHex))!;
    const badCommit = buildThreadTx(
      alice,
      karmaBoxes(aliceK),
      'version probe',
      aliceK.height,
      version,
      2,
    );
    try {
      await postPost(miner, badCommit.json, badCommit.content);
      expect.fail('a version-2 post commit should be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(NodeError);
      expect((err as NodeError).status).toBe(400);
      expect((err as NodeError).message).toMatch(/era\s+1\b/i);
    }
  });
});
