import { validateTx } from '@dagsocial/consensus';
import { MEMPOOL_EXPIRY_BLOCKS, bytesToHex, computePostId, computeTxId } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { config } from '../config.js';
import { emitPostReceived, emitPostValidated } from '../journal.js';
import { getDb } from '../store/db.js';
import {
  hasActiveVouchEscrow,
  getTopologyAuthorBytes,
  getPendingPostAuthor,
  getIdentityRecord,
  insertPost,
  getBoxProvenance,
  nextBlockHeight,
  MempoolFullError,
  PendingSpendConflictError,
  getVouchBox,
  getNetworkRecord,
  putIdentityRecord,
  getUsername,
  getUsernameByOwner,
} from '../store/index.js';
import { getBoxWithPending, getHeldEntry } from '../store/mempool.js';
import { noteRelayedTxInputMissing } from '../metrics.js';
import { admitTx } from './admit-tx.js';
import { admissionHeld, admissionOwed, admissionGetOwnKarmaBoxIds } from './karma-admission.js';
import { ClientError } from './client-error.js';

/**
 * The gossip registration's transaction handler, wired at startup to
 * `net.onTx` (NODE_INTERFACE → Net Integration → Relay handlers
 * (mempool-based)): judges the relayed transaction against the pending view
 * (MEMPOOL_INTERFACE → getBoxWithPending → "A relayed transaction is judged
 * against the pending view, as a submitted one is"), then admits it — for
 * a post transaction, with the packet's body as the pending row in the same
 * store transaction.
 *
 * Answers whether it admitted the transaction: net forwards an admitted
 * transaction and penalises nothing on a refusal (NET_INTERFACE → Stage 2 →
 * "A Stage 2 refusal records nothing"). Every refusal is a `false` the
 * handler returns from: a conflict with a pooled entry's input answers
 * `Relayed tx dropped, input spent by a pending entry: <txid>` and false
 * (NODE_INTERFACE → Net Integration → Relay handlers (mempool-based) →
 * "A pooled spender's conflict is the pool's refusal"); the missing-input
 * refusal is counted, not logged
 * (NODE_INTERFACE → Net Integration → Relay handlers (mempool-based) →
 * "A relayed transaction refused for a missing input is counted, not
 * logged"); every other refusal logs `Relayed tx rejected: <error>`. Any
 * other throw reaches net, which logs it as a handler defect.
 */
export function handleRelayedTx(
  tx: UtxoTransaction,
  content: string | undefined,
  fromPeerId: string,
): boolean {
  // Admission's `held` and `owed` are the spend rule's engine inputs
  // (NODE_INTERFACE → Karma transition rules → "Engine inputs the rule
  // needs"), the one implementation the HTTP routes' deps literal also wires.
  const decayCfg = {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  };
  // NET_INTERFACE → Stage 1 → "A transaction's signatures are checked at Stage 1":
  // net verified every entry of the map over this transaction's id before the
  // handler saw it, so admission answers each required signature from the
  // map rather than calling `verifyEd25519` a second time (CONSENSUS_INTERFACE
  // → The overlay). `true` exactly when the signature is the map's own entry
  // for that key and the message is this transaction's id.
  const txIdHex = computeTxId(tx);
  // MEMPOOL_INTERFACE → "A transaction the pool holds is answered as held,
  // before anything reads state". The pool's one point read by id leads
  // the relay handler's work; a standing entry ends the path with `false`
  // and no log line (NODE_INTERFACE → Service Layer Architecture →
  // "A transaction the pool already holds is answered as held").
  if (getHeldEntry(txIdHex) !== null) {
    return false;
  }
  const relayVerifySignature = (
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
  ): boolean => {
    if (bytesToHex(message) !== txIdHex) return false;
    const mapEntry = tx.signatures[bytesToHex(publicKey)];
    if (mapEntry === undefined) return false;
    if (mapEntry.length !== signature.length) return false;
    for (let i = 0; i < mapEntry.length; i++) {
      if (mapEntry[i] !== signature[i]) return false;
    }
    return true;
  };
  const deps = {
    // MEMPOOL_INTERFACE → getBoxWithPending → "A relayed transaction is
    // judged against the pending view, as a submitted one is": the
    // same two reads the HTTP routes wire — a chained arrival at this
    // node is admitted on the parent this node already pools, and a box
    // a pooled entry spends raises `PendingSpendConflictError` at the
    // input read.
    getBox: getBoxWithPending,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaValue: admissionHeld,
    getKarmaOwed: admissionOwed(decayCfg),
    // NODE_INTERFACE → Karma transition rules →
    // "`getOwnKarmaBoxIds(owner)` answers rule 3": the same answer
    // submission wires, under the pending view
    // (MEMPOOL_INTERFACE → getOwnKarmaBoxIdsWithPending).
    getOwnKarmaBoxIds: admissionGetOwnKarmaBoxIds,
    verifySignature: relayVerifySignature,
    // The vouch cast's cooldown gate (NODE_INTERFACE → "Vouch transition
    // rules") — same rule.
    hasActiveVouchEscrow,
    vouchCooldownBlocks: config.vouchCooldownBlocks,
    inviteBondMin: config.inviteBondMin,
    inviteBondMax: config.inviteBondMax,
    decayCfg,
    // The like marker's author pin (NODE_INTERFACE → Karma transition rules) —
    // same rule again: a relayed like whose marker names the wrong author must
    // be refused here as well as at the block path.
    getTopologyAuthor: getTopologyAuthorBytes,
    getPendingPostAuthor,
    // The invite-create not-already-an-account bar (NODE_INTERFACE → "Bond
    // transition rules") — same rule again: a relayed invite naming an existing
    // account must be refused here as well as at the block path.
    getIdentityRecord,
    storageRentPeriodBlocks: config.storageRentPeriodBlocks,
    getBoxProvenance,
    runInTransaction: (fn: () => void) => fn(),
    getVouchBox,
    getNetworkRecord,
    membershipBarMultiplier: config.membershipBarMultiplier,
    putIdentityRecord,
    protocolVersionSchedule: config.protocolVersionSchedule,
    getUsername,
    getUsernameByOwner,
  };
  // Admission judges a transaction at the height of the block that would carry
  // it — tip + 1 (NODE_INTERFACE → validateTx).
  const currentHeight = nextBlockHeight();
  const validationStart = performance.now();
  let result;
  try {
    result = validateTx(deps, tx, txIdHex, currentHeight);
  } catch (err) {
    // MEMPOOL_INTERFACE → getBoxWithPending: the pending view throws
    // `PendingSpendConflictError` where `validateTx` reads an input a pooled
    // entry spends. The handler answers it as the conflict gate's — one
    // line, `false` — never as a throw out of the handler
    // (NODE_INTERFACE → Net Integration → Relay handlers (mempool-based) →
    // "A pooled spender's conflict is the pool's refusal"). Caught ahead of
    // `ClientError` so the conflict is never read as a policy refusal.
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Relayed tx dropped, input spent by a pending entry: ${txIdHex}`);
      return false;
    }
    throw err;
  }
  if (!result.valid) {
    // NODE_INTERFACE → Net Integration → Relay handlers (mempool-based) →
    // "A relayed transaction refused for a missing input is counted, not
    // logged": the engine's `Input box not found or already spent: <id>`
    // over the pending view — the answer to a copy of a transaction a
    // block already carried, and to a child whose parent this node does
    // not pool — writes no line and adds one to
    // `relayed_txs_input_missing_total` (NODE_INTERFACE → Admin Listener).
    if (result.error?.startsWith('Input box not found or already spent: ')) {
      noteRelayedTxInputMissing();
      return false;
    }
    console.warn(`Relayed tx rejected: ${result.error}`);
    return false;
  }
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  try {
    // NODE_INTERFACE → Post transactions — the packet is the unit: admitTx and
    // the pending row in one store transaction for a post, or admitTx alone.
    const db = getDb();
    db.transaction(() => {
      admitTx(tx, txIdHex, expiresAtHeight);
      if (tx.post) {
        const postId = computePostId(txIdHex, 0);
        insertPost(postId, txIdHex, tx.post, content ?? null);
        emitPostReceived(postId, fromPeerId, 'packet');
        emitPostValidated(postId, performance.now() - validationStart);
      }
    })();
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Relayed tx dropped, mempool full: ${txIdHex}`);
      return false;
    }
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Relayed tx dropped, input spent by a pending entry: ${txIdHex}`);
      return false;
    }
    // Admission's policy refusals — the fee floor, rent, the cost gate — are
    // this node's answer to the transaction, not a defect in the handler.
    if (err instanceof ClientError) {
      console.warn(`Relayed tx refused: ${err.message}`);
      return false;
    }
    throw err;
  }
  console.log(`Relayed tx queued in mempool: ${txIdHex}`);
  return true;
}
