import { hexToBytes } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
import { verifyEd25519 } from '@dagsocial/validation';
import {
  applyBlockWithdrawal,
  applyQueuedTx,
  capturePreBodyOwed,
  decodeBodyEntry,
  newTxApplyAcc,
  overSignedReason,
  signatureEntryKey,
  utxoDepsOver,
  type QueuedTx,
} from './apply-block.js';
import { postsOf, withdrawalsOf } from './block-posts.js';
import { BlockOverlay } from './overlay.js';
import type { ApplyContext, StateView } from './state-view.js';

/**
 * The screen's answer: every user transaction `applyBlock` would refuse against the state the ones
 * before it leave, in body order (CONSENSUS_INTERFACE → Screening a body).
 */
export interface BodyScreen {
  refused: { index: number; reason: string }[];
}

/**
 * Which of a body's user transactions apply, each against the state the ones before it leave
 * (CONSENSUS_INTERFACE → Screening a body). The producer's question about a body `applyBlock`
 * refused: it runs `applyBlock`'s own phases over one overlay of `view` — the block's posts and
 * their topology rows, the pre-body captures, the user transactions in committed order and the
 * withdrawals — refuses a failing transaction alone with the position and the reason `applyBlock`
 * would give, applies nothing of it, judges the later ones without it, and repeats the passes over
 * the survivors until a pass refuses nothing. Each signature is checked alone through
 * `ctx.signatureChecks.verify` when the caller carries it, `verifyEd25519` when it does not
 * (CONSENSUS_INTERFACE → ApplyContext); a failing entry refuses its transaction with the batch's
 * reason (CONSENSUS_INTERFACE → Applying a block). The settlement, the grants, the counters, the
 * membership pass, the decay clocks and the block's cost are not screened.
 */
export function screenBody(view: StateView, block: OrderingBlock, ctx: ApplyContext): BodyScreen {
  const height = block.header.height;
  const lastIndex = block.utxoTxTree.utxoTxIds.length - 1;
  // The settlement, last, is never screened; a body with no user transactions
  // ahead of it has nothing to answer about (CONSENSUS_INTERFACE → Screening
  // a body).
  if (lastIndex < 1) return { refused: [] };

  const refused = new Map<number, { index: number; reason: string }>();
  const survivors = new Set<number>();
  for (let i = 0; i < lastIndex; i++) survivors.add(i);

  // A pass that refuses a transaction runs again over the ones it kept — the
  // posts and the captures are read from the whole body before its transactions
  // apply, and a refused transaction's post and inputs do not belong among
  // them (CONSENSUS_INTERFACE → Screening a body).
  while (runPass(view, block, ctx, height, lastIndex, survivors, refused) > 0) {
    // keep going until a pass refuses nothing
  }

  return { refused: [...refused.values()].sort((a, b) => a.index - b.index) };
}

/** The new refusals this pass added; the loop stops at zero. */
function runPass(
  view: StateView,
  block: OrderingBlock,
  ctx: ApplyContext,
  height: number,
  lastIndex: number,
  survivors: Set<number>,
  refused: Map<number, { index: number; reason: string }>,
): number {
  const before = refused.size;
  const state = new BlockOverlay(view);

  // The survivors' block: the original header, the surviving user entries in body order and the
  // settlement at the end. The screen lays its posts and finds its withdrawals through this block,
  // as `applyBlock` does over its own (CONSENSUS_INTERFACE → Screening a body).
  const sortedSurvivors = [...survivors].sort((a, b) => a - b);
  const survivorsBlock: OrderingBlock = {
    ...block,
    utxoTxTree: {
      utxoTxIds: [
        ...sortedSurvivors.map((i) => block.utxoTxTree.utxoTxIds[i]!),
        block.utxoTxTree.utxoTxIds[lastIndex]!,
      ],
      utxoTxs: [
        ...sortedSurvivors.map((i) => block.utxoTxTree.utxoTxs[i]!),
        block.utxoTxTree.utxoTxs[lastIndex]!,
      ],
    },
  };

  // Confirm each surviving post and lay its topology row. A row the body's own
  // withdrawal arm reads through `state.getTopologyHeight` holds this block's
  // height, so `postHeight >= height` refuses the withdrawal as not confirmed
  // in an earlier block (`applyBlockWithdrawal`). This matches `applyBlock`'s
  // own rule.
  const blockPosts = postsOf(survivorsBlock);
  for (const { postId } of blockPosts) state.confirmPost(postId);
  for (const { postId, post } of blockPosts) state.insertBlockTopology(postId, post.author, height);

  // Per-entry decode, over-signed and signatures — each signature checked
  // alone through `ctx.signatureChecks.verify` on its object,
  // `verifyEd25519` when the context carries no pair
  // (CONSENSUS_INTERFACE → ApplyContext). A failure refuses that index
  // with the reason `applyBlock` would give.
  const checks = ctx.signatureChecks;
  interface Decoded extends QueuedTx { index: number; }
  const decoded: Decoded[] = [];
  const verified = new Set<string>();
  const refuseAt = (i: number, reason: string): void => {
    refused.set(i, { index: i, reason });
    survivors.delete(i);
  };
  for (const i of sortedSurvivors) {
    const d = decodeBodyEntry(block, i, false, height, ctx);
    if (!d.ok) {
      refuseAt(i, d.reason);
      continue;
    }
    const overSigned = overSignedReason(d.item.tx, d.item.txId, height);
    if (overSigned !== null) {
      refuseAt(i, overSigned);
      continue;
    }
    const message = hexToBytes(d.item.txId);
    let allVerify = true;
    for (const [keyHex, signature] of Object.entries(d.item.tx.signatures)) {
      const key = hexToBytes(keyHex);
      const ok = checks ? checks.verify(signature, message, key) : verifyEd25519(signature, message, key);
      if (!ok) {
        allVerify = false;
        break;
      }
    }
    if (!allVerify) {
      refuseAt(i, `Rejected block height=${height}: a signature in the body does not verify`);
      continue;
    }
    for (const [keyHex, signature] of Object.entries(d.item.tx.signatures)) {
      verified.add(signatureEntryKey(d.item.txId, keyHex, signature));
    }
    decoded.push({ index: i, ...d.item });
  }

  // The pre-body `owed` capture, shared with `applyBlock`. The screen does not
  // run decay plans or settlement.
  const { preBodyOwed } = capturePreBodyOwed(
    state,
    decoded.map((d) => ({ txId: d.txId, inputs: d.tx.inputs, outputs: d.outputs })),
    height,
    ctx.decayCfg,
  );
  const utxoDeps = utxoDepsOver(state, ctx, verified, preBodyOwed, height);

  // The per-transaction loop, in body order. A refused transaction applies
  // nothing (its would-be outputs do not reach the overlay), so a later
  // transaction that spends one of them fails the unresolved-input gate.
  const acc = newTxApplyAcc();
  const refusedThisPass = new Set<number>();
  const indexByTxId = new Map<string, number>();
  for (const d of decoded) {
    indexByTxId.set(d.txId, d.index);
    const result = applyQueuedTx(state, utxoDeps, d, height, acc);
    if (!result.ok) {
      refused.set(d.index, { index: d.index, reason: result.reason });
      survivors.delete(d.index);
      refusedThisPass.add(d.index);
    }
  }

  // The withdrawal arm, over `withdrawalsOf` of the survivors' block. A
  // withdrawal whose transaction the pass's loop refused is skipped — nothing
  // of it applies — and so is one whose transaction failed the pre-loop
  // gates, which `withdrawalsOf` picks up by decoded shape rather than by
  // envelope.
  for (const bw of withdrawalsOf(survivorsBlock, (postId) => state.getTopologyAuthor(postId))) {
    const index = indexByTxId.get(bw.txId);
    if (index === undefined) continue;
    if (refusedThisPass.has(index)) continue;
    const result = applyBlockWithdrawal(state, bw, height);
    if (!result.ok) {
      refused.set(index, { index, reason: result.reason });
      survivors.delete(index);
    }
  }

  return refused.size - before;
}
