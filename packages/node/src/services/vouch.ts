import {
  computeTxId,
  VOUCH_MIN_BALANCE,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { VouchBox, VouchEscrowBox, UtxoTransaction } from '@dagsocial/types';
import {
  hasPendingVouch,
} from '../store/index.js';
import { isValidVouchTarget } from '@dagsocial/validation';
import { effectiveKarma } from './decay.js';
import { isMember, validateTx } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

export function castVouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  const vouchOutput = tx.outputs.find((o): o is VouchBox => o.boxType === 'vouch');
  if (!vouchOutput) {
    throw new ClientError('Transaction must contain a VouchBox output');
  }
  const { voucherId, targetId } = vouchOutput;

  if (!isValidVouchTarget(targetId)) {
    throw new ClientError('Invalid vouch target: must be a 32-byte public key');
  }

  // NODE_INTERFACE → Vouch transition rules: only a member casts.
  const voucherRecord = deps.getIdentityRecord(voucherId);
  if (!voucherRecord || !isMember(voucherRecord)) {
    throw new ClientError('Only a member may vouch');
  }

  // The target holds an IdentityRecord.
  const targetRecord = deps.getIdentityRecord(targetId);
  if (!targetRecord) {
    throw new ClientError('Vouch target holds no identity record');
  }

  // No self-vouch.
  if (Buffer.from(voucherId).equals(Buffer.from(targetId))) {
    throw new ClientError('Cannot vouch for yourself');
  }

  // One live vouch per (voucher, target) pair — confirmed and pending.
  if (deps.getVouchBox(voucherId, targetId)) {
    throw new ClientError('A live vouch already exists for this (voucher, target) pair');
  }
  const voucherHex = Buffer.from(voucherId).toString('hex');
  const targetHex = Buffer.from(targetId).toString('hex');
  if (hasPendingVouch(voucherHex, targetHex)) {
    throw new ClientError('A vouch for this pair is already pending');
  }

  // The balance check and escrow gate are consensus-enforced in checkTransitions.
  const voucherFace = deps.getKarmaValue(voucherId);
  const balance = effectiveKarma(voucherFace, voucherRecord, currentBlockHeight, deps.decayCfg);
  if (balance < VOUCH_MIN_BALANCE) {
    throw new ClientError(
      `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
    );
  }

  // ⛔ Keyed on the voucher, because the escrow carries no target
  // (TYPES_INTERFACE → VouchEscrowBox). `checkTransitions` holds the same
  // predicate at apply, so this is the named early refusal rather than the
  // rule's only statement.
  if (deps.hasActiveVouchEscrow(voucherId)) {
    throw new ClientError('Vouch cooldown active — cannot re-vouch yet');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid vouch transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  const txId = computeTxId(tx);
  return { status: 'pending', txId, expiresAtHeight, tx };
}

export function initiateUnvouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  karmaReturnsAtBlock: number;
  tx: UtxoTransaction;
} {
  let voucherId: Uint8Array | undefined;
  let targetId: Uint8Array | undefined;

  for (const inputId of tx.inputs) {
    const box = deps.getBox(inputId);
    if (box && box.boxType === 'vouch') {
      const vouchBox = box as VouchBox;
      voucherId = vouchBox.voucherId;
      targetId = vouchBox.targetId;
      break;
    }
  }

  if (!voucherId || !targetId) {
    throw new ClientError('Transaction does not consume a VouchBox');
  }

  const signerHex = Object.keys(tx.signatures)[0];
  if (!signerHex || Buffer.from(voucherId).toString('hex') !== signerHex) {
    throw new ClientError('VouchBox does not belong to signer');
  }

  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid unvouch transaction: ${result.error}`);
  }

  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  const txId = computeTxId(tx);
  // ⛔ **Read off the escrow the transaction itself carries, never recomputed.**
  // The engine pins `releaseAtBlock` as an exact equality against
  // `vouch.createdAtBlock + vouchCooldownBlocks`, so the value on the output
  // is authoritative.
  const escrow = tx.outputs.find(
    (o): o is VouchEscrowBox => o.boxType === 'vouch_escrow',
  );
  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    karmaReturnsAtBlock: escrow!.releaseAtBlock,
    tx,
  };
}
