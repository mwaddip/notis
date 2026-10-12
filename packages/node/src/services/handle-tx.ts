import { validateTx } from '@dagsocial/consensus';
import { MEMPOOL_EXPIRY_BLOCKS, computePostId } from '@dagsocial/types';
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
import { admitTx } from './admit-tx.js';
import { admissionHeld, admissionOwed, relayGetOwnKarmaBoxIds } from './karma-admission.js';
import { ClientError } from './client-error.js';

/**
 * The gossip registration's transaction handler, passed by `index.ts` to
 * `net.onTx` (NODE_INTERFACE → Relay handlers): validates the relayed
 * transaction read-only, then admits it — for a post transaction, with the
 * packet's body as the pending row in the same store transaction.
 *
 * Every refusal is an answer the handler logs and returns from: a transaction
 * the rules refuse, a full pool, an input a pending entry spends, and each
 * policy refusal admission throws as a `ClientError`. Any other throw reaches
 * net, which logs it as a handler defect.
 */
export function handleRelayedTx(
  tx: UtxoTransaction,
  content: string | undefined,
  fromPeerId: string,
): void {
  // Admission's `held` and `owed` are the spend rule's engine inputs
  // (NODE_INTERFACE → Karma transition rules → "Engine inputs the rule
  // needs"), the one implementation the HTTP routes' deps literal also wires
  // (`server.ts`).
  const decayCfg = {
    staleThresholdBlocks: config.karmaStaleThresholdBlocks,
    decayIntervalBlocks: config.karmaDecayIntervalBlocks,
    decayAmount: config.karmaDecayAmount,
    karmaMinimum: config.karmaMinimum,
  };
  const deps = {
    getBox,
    insertBox: () => {},
    consumeBox: () => {},
    getKarmaValue: admissionHeld,
    getKarmaOwed: admissionOwed(decayCfg),
    getOwnKarmaBoxIds: relayGetOwnKarmaBoxIds,
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
  const result = validateTx(deps, tx, currentHeight);
  if (!result.valid) {
    // Boxes referenced by relayed txs may not have arrived yet via header sync.
    // The tx will be included in the ordering block that carries the boxes.
    // Only log at debug level — this is expected during normal operation.
    if (result.error?.includes('Missing or invalid owner signature') || result.error?.includes('not found')) {
      // silently skip — tx will arrive via block sync
    } else {
      console.warn(`Relayed tx rejected: ${result.error}`);
    }
    return;
  }
  const expiresAtHeight = currentHeight + MEMPOOL_EXPIRY_BLOCKS;
  try {
    // NODE_INTERFACE → Post transactions — the packet is the unit: admitTx and
    // the pending row in one store transaction for a post, or admitTx alone.
    const db = getDb();
    db.transaction(() => {
      admitTx(tx, expiresAtHeight);
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
      return;
    }
    if (err instanceof PendingSpendConflictError) {
      console.warn(`Relayed tx dropped, input spent by a pending entry: ${result.txId}`);
      return;
    }
    // Admission's policy refusals — the fee floor, rent, the cost gate — are
    // this node's answer to the transaction, not a defect in the handler.
    if (err instanceof ClientError) {
      console.warn(`Relayed tx refused: ${err.message}`);
      return;
    }
    throw err;
  }
  console.log(`Relayed tx queued in mempool: ${result.txId}`);
}
