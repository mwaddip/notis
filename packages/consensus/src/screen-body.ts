import {
  bytesToHex,
  computePostId,
  computeTxId,
  decodeTx,
  hexToBytes,
} from '@dagsocial/types';
import type { AnyBox, OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { verifyEd25519 } from '@dagsocial/validation';
import {
  applyBlockWithdrawal,
  applyQueuedTx,
  newTxApplyAcc,
  signatureEntryKey,
  utxoDepsOver,
} from './apply-block.js';
import { collectPostBodyKarma, karmaOwed } from './decay.js';
import { BlockOverlay } from './overlay.js';
import type { ApplyContext, StateView } from './state-view.js';
import {
  checkOutputShape,
  checkTxEnvelope,
  materializeOutput,
} from './utxo-engine.js';

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
 * `verifyEd25519`, a failing entry refusing its transaction with the batch's reason
 * (CONSENSUS_INTERFACE → Applying a block). The settlement, the grants, the counters, the
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
  // apply, and a refused transaction's post and inputs no longer belong among
  // them (CONSENSUS_INTERFACE → Screening a body).
  while (runPass(view, block, ctx, height, survivors, refused) > 0) {
    // keep going until a pass refuses nothing
  }

  return { refused: [...refused.values()].sort((a, b) => a.index - b.index) };
}

interface Decoded {
  index: number;
  txId: string;
  tx: UtxoTransaction;
  outputs: AnyBox[];
}

/** The refusals this pass added; the loop stops at zero. */
function runPass(
  view: StateView,
  block: OrderingBlock,
  ctx: ApplyContext,
  height: number,
  survivors: Set<number>,
  refused: Map<number, { index: number; reason: string }>,
): number {
  const before = refused.size;
  const state = new BlockOverlay(view);
  const decoded: Decoded[] = [];
  const verified = new Set<string>();

  // Per-entry decode, id proof, envelope, output shape, over-signed, and the
  // signatures checked alone (CONSENSUS_INTERFACE → Screening a body → "Each
  // signature is checked alone"). An entry `applyBlock` refuses before the
  // loop is refused alone at its index.
  const refuseAt = (i: number, reason: string): void => {
    refused.set(i, { index: i, reason });
    survivors.delete(i);
  };
  for (const i of [...survivors].sort((a, b) => a - b)) {
    const txId = block.utxoTxTree.utxoTxIds[i]!;
    const txBytes = block.utxoTxTree.utxoTxs[i];
    if (!txBytes) {
      refuseAt(i, `Rejected block height=${height}: embedded UTXO tx ${txId} carries no body`);
      continue;
    }
    let tx: UtxoTransaction;
    try {
      tx = decodeTx(txBytes);
    } catch (err) {
      refuseAt(
        i,
        `Rejected block height=${height}: embedded UTXO tx ${txId} did not ` +
        `decode: ${String(err)}`,
      );
      continue;
    }
    const envelopeCheck = checkTxEnvelope(tx, height, ctx.protocolVersionSchedule);
    if (!envelopeCheck.valid) {
      refuseAt(
        i,
        `Rejected block height=${height}: embedded UTXO tx ${txId} has a ` +
        `malformed envelope: ${envelopeCheck.error}`,
      );
      continue;
    }
    const outputCheck = checkOutputShape(tx.outputs);
    if (!outputCheck.valid) {
      refuseAt(
        i,
        `Rejected block height=${height}: embedded UTXO tx ${txId} has an ` +
        `out-of-domain output: ${outputCheck.error}`,
      );
      continue;
    }
    const decodedId = computeTxId(tx);
    if (decodedId !== txId) {
      refuseAt(
        i,
        `Rejected block height=${height}: embedded UTXO tx ${txId} declares an ` +
        `id its bytes do not produce (${decodedId})`,
      );
      continue;
    }
    if (Object.keys(tx.signatures).length > tx.inputs.length) {
      refuseAt(
        i,
        `Rejected block height=${height}: embedded UTXO tx ${txId} ` +
        `carries more signatures than inputs`,
      );
      continue;
    }
    const message = hexToBytes(txId);
    let allVerify = true;
    for (const [keyHex, signature] of Object.entries(tx.signatures)) {
      if (!verifyEd25519(signature, message, hexToBytes(keyHex))) {
        allVerify = false;
        break;
      }
    }
    if (!allVerify) {
      refuseAt(i, `Rejected block height=${height}: a signature in the body does not verify`);
      continue;
    }
    for (const [keyHex, signature] of Object.entries(tx.signatures)) {
      verified.add(signatureEntryKey(txId, keyHex, signature));
    }
    const outputs = tx.outputs.map((box, idx) => materializeOutput(box as AnyBox, txId, idx));
    decoded.push({ index: i, txId, tx, outputs });
  }

  // Posts and their topology rows for every surviving decoded transaction
  // (CONSENSUS_INTERFACE → Applying a block). A tx without a post adds no row.
  for (const d of decoded) {
    if (d.tx.post) state.confirmPost(computePostId(d.txId, 0));
  }
  for (const d of decoded) {
    if (d.tx.post) state.insertBlockTopology(computePostId(d.txId, 0), d.tx.post.author, height);
  }

  // Pre-body captures: `owed` for every identity the body touches, from the
  // view as it stands before any transaction applies (CONSENSUS_INTERFACE →
  // Applying a block → "The owed-decay capture reads the record of every
  // identity the body touches"). Decay plans, escrows, lapsed vouches and the
  // backer pool belong to the settlement, which the screen does not run.
  const postBodyKarma = collectPostBodyKarma(
    state,
    decoded.map((d) => ({ txId: d.txId, inputs: d.tx.inputs, outputs: d.outputs })),
  );
  const preBodyOwed = new Map<string, bigint>();
  for (const { owner } of postBodyKarma.values()) {
    const face = state.getKarmaBoxes(owner).reduce((s, b) => s + b.value, 0n);
    const record = state.getIdentityRecord(owner);
    preBodyOwed.set(bytesToHex(owner), karmaOwed(face, record, height, ctx.decayCfg));
  }
  const utxoDeps = utxoDepsOver(state, ctx, verified, preBodyOwed, height);

  // The per-transaction loop, in committed order. A refused transaction
  // applies nothing (its would-be outputs do not reach the overlay), so a
  // later transaction that spends one of them fails the unresolved-input gate.
  const acc = newTxApplyAcc();
  const refusedThisPass = new Set<number>();
  for (const d of decoded) {
    const result = applyQueuedTx(state, utxoDeps, { txId: d.txId, tx: d.tx, outputs: d.outputs }, height, acc);
    if (!result.ok) {
      refused.set(d.index, { index: d.index, reason: result.reason });
      survivors.delete(d.index);
      refusedThisPass.add(d.index);
    }
  }

  // The withdrawal arm, over the surviving decoded transactions carrying a
  // post-withdraw commit. A transaction the loop refused is skipped — nothing
  // of it applies — so its withdrawal step is skipped too.
  const withdrawnThisBlock = new Set<string>();
  for (const d of decoded) {
    if (!d.tx.postWithdraw) continue;
    if (refusedThisPass.has(d.index)) continue;
    const author = state.getTopologyAuthor(d.tx.postWithdraw.postId);
    if (author === null) continue;
    const result = applyBlockWithdrawal(
      state,
      { txId: d.txId, author, postWithdraw: d.tx.postWithdraw },
      height,
      withdrawnThisBlock,
    );
    if (!result.ok) {
      refused.set(d.index, { index: d.index, reason: result.reason });
      survivors.delete(d.index);
    }
  }

  return refused.size - before;
}
