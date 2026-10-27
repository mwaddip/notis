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
  getBox,
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
import { getHeldEntry } from '../store/mempool.js';
import { admitTx } from './admit-tx.js';
import { admissionHeld, admissionOwed, relayGetOwnKarmaBoxIds } from './karma-admission.js';
import { ClientError } from './client-error.js';

/**
 * The gossip registration's transaction handler, wired at startup to
 * `net.onTx` (NODE_INTERFACE → Relay handlers): validates the relayed
 * transaction read-only, then admits it — for a post transaction, with the
 * packet's body as the pending row in the same store transaction.
 *
 * Answers whether it admitted the transaction: net forwards an admitted
 * transaction and penalises nothing on a refusal (NET_INTERFACE → Stage 2 →
 * "A Stage 2 refusal records nothing"). Every refusal is a `false` the
 * handler logs and returns from: a transaction the rules refuse, a full
 * pool, an input a pending entry spends, and each policy refusal admission
 * throws as a `ClientError`. Any other throw reaches net, which logs it as
 * a handler defect.
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
    getBox,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaValue: admissionHeld,
    getKarmaOwed: admissionOwed(decayCfg),
    getOwnKarmaBoxIds: relayGetOwnKarmaBoxIds,
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
  const result = validateTx(deps, tx, txIdHex, currentHeight);
  if (!result.valid) {
    // Boxes referenced by relayed txs may not have arrived yet via header sync.
    // The tx will be included in the ordering block that carries the boxes.
    // Only log at debug level — this is expected during normal operation.
    if (result.error?.includes('Missing or invalid owner signature') || result.error?.includes('not found')) {
      // silently skip — tx will arrive via block sync
    } else {
      console.warn(`Relayed tx rejected: ${result.error}`);
    }
    return false;
  }
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  try {
    // NODE_INTERFACE → Post transactions — the packet is the unit: admitTx and
    // the pending row in one store transaction for a post, or admitTx alone.
    const db = getDb();
    db.transaction(() => {
      admitTx(tx, txIdHex, expiresAtHeight);
      if (tx.post && result.txId) {
        const postId = computePostId(result.txId, 0);
        insertPost(postId, result.txId, tx.post, content ?? null);
        emitPostReceived(postId, fromPeerId, 'packet');
        emitPostValidated(postId, performance.now() - validationStart);
      }
    })();
  } catch (err) {
    if (err instanceof MempoolFullError) {
      console.warn(`Relayed tx dropped, mempool full: ${result.txId}`);
      return false;
    }
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Relayed tx dropped, input spent by a pending entry: ${result.txId}`);
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
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
  return true;
}
