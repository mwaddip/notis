import { describe, it, afterAll, expect } from 'vitest';
import { createMesh, type Mesh } from '../src/mesh.js';
import { assertDistFresh, NIPOPOW_CLIENT_LOADS } from '../src/dist-freshness.js';
import { confirm, mine, waitHeight } from '../src/miner.js';
import { DEVNET_BACKER_A, DEVNET_FAUCET, fresh } from '../src/identities.js';
import { buildInviteTx } from '../src/tx/invite.js';
import { buildUnstakeTx } from '../src/tx/unstake.js';
import { buildCreditTransferTx } from '../src/tx/credit-transfer.js';
import {
  getBacker,
  getBlockCurrent,
  getBlockHeader,
  getCredits,
  getKarma,
  getStatus,
  hasKarma,
  postCreditTransfer,
  postInvite,
  postUnstake,
} from '../src/http.js';
import type { BoxRef } from '../src/tx/render.js';
import type { NodeProcess } from '../src/node-process.js';
import { proveHoldings } from '@dagsocial/nipopow-client';

const FILE_INDEX = 1;

// NODE_INTERFACE → "A proof at an older height restores a kept root" — the
// ring sized to the chapter: `confirm` paces on an observation and may mine
// up to 3 blocks for a transfer, so the recorded `h` is at most 3 behind the
// tip the older-height arm asks it at. A ring of 5 keeps `h` under the arm,
// and the edge arm then asserts `tip − 5` is 404 and `tip − 4` is ok.
const PROOF_WINDOW = 5;

// CONSENSUS_INTERFACE → The holdings page — the five kinds a key's boxes are
// indexed under.
const KINDS = ['karma', 'credit', 'escrow', 'vouch', 'accrual'] as const;

function toBoxRefs(boxes: readonly { boxId: string; value: string }[]): BoxRef[] {
  return boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
}

// A deterministic listing of `(boxId, value)` pairs for `toEqual` — the two
// nodes answer the same set, kind for kind, independent of enumeration order.
function sortedPairs(entries: readonly { id: string; value: bigint }[]): [string, string][] {
  return entries
    .map((e): [string, string] => [e.id, e.value.toString()])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

describe('holdings-range', () => {
  let mesh: Mesh;

  afterAll(async () => {
    await mesh?.teardown();
  });

  it("two nodes prove one key's holdings alike, at the tip and at an older height", async () => {
    mesh = await createMesh({
      fileIndex: FILE_INDEX,
      nodeCount: 2,
      env: { PROOF_WINDOW_BLOCKS: String(PROOF_WINDOW) },
    });
    assertDistFresh(NIPOPOW_CLIENT_LOADS);
    const node1: NodeProcess = mesh.nodes[0]!;

    // --- mesh proof ---
    await mine(node1, mesh.miningSecret, 1);
    await waitHeight(mesh.nodes, 1);
    const tipsAt1 = await Promise.all(mesh.nodes.map(getBlockCurrent));
    for (const tip of tipsAt1) {
      expect(tip.height).toBe(1);
      expect(tip.hash).toBe(tipsAt1[0]!.hash);
    }
    const headersAt1 = await Promise.all(mesh.nodes.map((n) => getBlockHeader(n, 1)));
    for (const header of headersAt1) {
      expect(header).not.toBeNull();
      expect(header!.stateRoot).toBe(headersAt1[0]!.stateRoot);
    }

    // --- setup: a fresh member holds karma (via an invite) and credits
    // (via a backer unstake + transfer, as `test/backers.test.ts` moves them).
    const version = (await getStatus(node1)).protocolVersion;
    const member = fresh();
    const bondAmount = 50n;

    const faucetKarma = await getKarma(node1, DEVNET_FAUCET.publicKeyHex);
    const invite = buildInviteTx(
      DEVNET_FAUCET,
      toBoxRefs(faucetKarma.boxes),
      member,
      bondAmount,
      faucetKarma.height,
      version,
    );
    await postInvite(node1, invite.json);
    await confirm(
      () => hasKarma(node1, member.publicKeyHex),
      node1,
      mesh.miningSecret,
    );

    const stakeA = await getBacker(node1, DEVNET_BACKER_A.publicKeyHex);
    const unstake = buildUnstakeTx(
      DEVNET_BACKER_A,
      stakeA.boxId,
      BigInt(stakeA.weight),
      10n,
      (await getBlockCurrent(node1)).height,
      version,
    );
    await postUnstake(node1, unstake.json);
    await confirm(
      async () =>
        (await getCredits(node1, DEVNET_BACKER_A.publicKeyHex)).boxCount > 0,
      node1,
      mesh.miningSecret,
    );

    const creditsA = await getCredits(node1, DEVNET_BACKER_A.publicKeyHex);
    const transferToMember = buildCreditTransferTx(
      DEVNET_BACKER_A,
      toBoxRefs(creditsA.boxes),
      member,
      BigInt(creditsA.total) / 2n,
      (await getBlockCurrent(node1)).height,
      version,
    );
    await postCreditTransfer(node1, transferToMember.json);
    await confirm(
      async () => (await getCredits(node1, member.publicKeyHex)).boxCount > 0,
      node1,
      mesh.miningSecret,
    );

    const t0 = (await getBlockCurrent(node1)).height;
    await waitHeight(mesh.nodes, t0);

    // --- at the tip, on every node: proveHoldings over all five kinds answers
    // the node's `/karma/` and `/credits/` listings whole and no box of the
    // other three kinds; the two nodes answer the same boxes kind for kind.
    const perNode: { url: string; byKind: Record<string, { id: string; value: bigint }[]> }[] = [];
    for (const node of mesh.nodes) {
      const header = await getBlockHeader(node, t0);
      expect(header).not.toBeNull();
      const result = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: t0, stateRoot: header!.stateRoot },
        fetch,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const nodeKarma = await getKarma(node, member.publicKeyHex);
      const nodeCredits = await getCredits(node, member.publicKeyHex);

      const provenKarma = (result.boxes.karma ?? []).map((b) => ({ id: b.id!, value: b.value }));
      const listedKarma = nodeKarma.boxes.map((b) => ({ id: b.boxId, value: BigInt(b.value) }));
      expect(sortedPairs(provenKarma)).toEqual(sortedPairs(listedKarma));

      const provenCredit = (result.boxes.credit ?? []).map((b) => ({ id: b.id!, value: b.value }));
      const listedCredit = nodeCredits.boxes.map((b) => ({ id: b.boxId, value: BigInt(b.value) }));
      expect(sortedPairs(provenCredit)).toEqual(sortedPairs(listedCredit));

      // CONSENSUS_INTERFACE → The holdings page — a key invited and credited
      // holds no escrow, vouch or accrual box; a vouch_escrow is a voucher's,
      // a vouch is a voucher-target pair the voucher owns, and a like_accrual
      // is an author's.
      expect(result.boxes.escrow).toEqual([]);
      expect(result.boxes.vouch).toEqual([]);
      expect(result.boxes.accrual).toEqual([]);

      const byKind: Record<string, { id: string; value: bigint }[]> = {};
      for (const kind of KINDS) {
        byKind[kind] = (result.boxes[kind] ?? []).map((b) => ({ id: b.id!, value: b.value }));
      }
      perNode.push({ url: node.url, byKind });
    }
    expect(perNode).toHaveLength(2);
    for (const kind of KINDS) {
      expect(sortedPairs(perNode[0]!.byKind[kind]!)).toEqual(
        sortedPairs(perNode[1]!.byKind[kind]!),
      );
    }

    // --- a key that holds nothing: ok with no box of any kind on every node.
    const noone = fresh();
    for (const node of mesh.nodes) {
      const header = (await getBlockHeader(node, t0))!;
      const r = await proveHoldings(
        node.url,
        noone.publicKeyHex,
        KINDS,
        { height: t0, stateRoot: header.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      for (const kind of KINDS) expect(r.boxes[kind]).toEqual([]);
    }

    // --- an older height. Record `h` and the member's credit boxes there.
    // The member sends part of ONE credit box to a new recipient; the holdings
    // at the new tip are the new set — the change box under the id
    // `signAndRender` derived (property 5) and the spent box gone — and the
    // holdings at `h`, asked now, are still the old set, under block `h`'s
    // `stateRoot`.
    const h = t0;
    const headerH = (await getBlockHeader(node1, h))!;
    const creditsBeforeTransfer = toBoxRefs(
      (await getCredits(node1, member.publicKeyHex)).boxes,
    );
    expect(creditsBeforeTransfer.length).toBeGreaterThan(0);
    const spendBox = creditsBeforeTransfer[0]!;
    const sendAmount = spendBox.value / 2n;
    expect(sendAmount).toBeGreaterThan(0n);
    const expectedChange = spendBox.value - sendAmount;

    const recipient = fresh();
    const memberTransfer = buildCreditTransferTx(
      member,
      [spendBox],
      recipient,
      sendAmount,
      h,
      version,
    );
    // buildCreditTransferTx puts the recipient's box at outputs[0] and the
    // change at outputs[1] where change > 0.
    expect(memberTransfer.outputs).toHaveLength(2);
    expect(memberTransfer.outputs[1]!.value).toBe(expectedChange);
    const changeBoxId = memberTransfer.outputs[1]!.boxId;

    await postCreditTransfer(node1, memberTransfer.json);
    await confirm(
      async () => {
        const now = await getCredits(node1, member.publicKeyHex);
        return now.boxes.some((b) => b.boxId === changeBoxId);
      },
      node1,
      mesh.miningSecret,
    );
    const tAfter = (await getBlockCurrent(node1)).height;
    await waitHeight(mesh.nodes, tAfter);

    for (const node of mesh.nodes) {
      const headerAfter = (await getBlockHeader(node, tAfter))!;
      const r = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: tAfter, stateRoot: headerAfter.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const nowCreditIds = new Set((r.boxes.credit ?? []).map((b) => b.id!));
      expect(nowCreditIds.has(spendBox.boxId)).toBe(false);
      expect(nowCreditIds.has(changeBoxId)).toBe(true);
    }

    for (const node of mesh.nodes) {
      const r = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: h, stateRoot: headerH.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const atH = (r.boxes.credit ?? []).map((b) => ({ id: b.id!, value: b.value }));
      const before = creditsBeforeTransfer.map((b) => ({ id: b.boxId, value: b.value }));
      expect(sortedPairs(atH)).toEqual(sortedPairs(before));
    }

    // --- a stateRoot that is not the height's: block `h`'s root offered for
    // the tip's height is unproven on every node (NODE_INTERFACE → AVL+ State
    // Root → "avl-endpoint, the range route"; the client's header stateRoot
    // other than the answer's is unproven before the proof is read).
    for (const node of mesh.nodes) {
      const r = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: tAfter, stateRoot: headerH.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe('unproven');
    }

    // --- a height the node keeps no root of: tip + 1 is 404
    // `{ error: 'height not available' }` over raw HTTP, and `no-proof`
    // through the library (NODE_INTERFACE → "A proof at an older height
    // restores a kept root").
    const tipPlusOne = tAfter + 1;
    for (const node of mesh.nodes) {
      const res = await fetch(
        `${node.url}/api/v1/range/karma/${member.publicKeyHex}?atHeight=${tipPlusOne}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('height not available');
    }
    for (const node of mesh.nodes) {
      const r = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: tipPlusOne, stateRoot: headerH.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe('no-proof');
    }

    // --- the window, measured on a real node. Mine the chain past the window
    // so that `tip − PROOF_WINDOW` is well-defined (≥ 1) and the ring holds
    // the last PROOF_WINDOW heights. Then on every node: that height is 404
    // and `tip − (PROOF_WINDOW − 1)` is ok.
    const windowFloor = PROOF_WINDOW + 2;
    const toReach = windowFloor - (await getBlockCurrent(node1)).height;
    if (toReach > 0) {
      await mine(node1, mesh.miningSecret, toReach);
      await waitHeight(mesh.nodes, windowFloor);
    }
    const t = (await getBlockCurrent(node1)).height;
    expect(t).toBeGreaterThanOrEqual(PROOF_WINDOW + 1);

    for (const node of mesh.nodes) {
      const outside = t - PROOF_WINDOW;
      const res = await fetch(
        `${node.url}/api/v1/range/karma/${member.publicKeyHex}?atHeight=${outside}`,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('height not available');
    }
    for (const node of mesh.nodes) {
      const inside = t - (PROOF_WINDOW - 1);
      const header = (await getBlockHeader(node, inside))!;
      const r = await proveHoldings(
        node.url,
        member.publicKeyHex,
        KINDS,
        { height: inside, stateRoot: header.stateRoot },
        fetch,
      );
      expect(r.ok).toBe(true);
    }
  });
});
