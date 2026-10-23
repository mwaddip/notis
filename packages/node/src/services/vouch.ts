import {
  VOUCH_MIN_BALANCE,
} from '@dagsocial/types';
import type { VouchBox, VouchEscrowBox, UtxoTransaction } from '@dagsocial/types';
import { isValidVouchTarget } from '@dagsocial/validation';
import { isMember, validateTx } from '@dagsocial/consensus';
import { admitWriteTx } from './admit-tx.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { ClientError } from './client-error.js';

export function castVouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): { status: 'pending'; txId: string; expiresAtHeight: number; tx: UtxoTransaction } {
  // NODE_INTERFACE → Service Layer Architecture → "A write request runs in
  // one order, cheapest first", → "One function admits". The pool's word on
  // the id leads; the caller's checks ride inside `admitWriteTx` so a held
  // transaction never reaches them (MEMPOOL_INTERFACE → getHeldEntry).
  const r = admitWriteTx(
    () => {
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

      // One live vouch per (voucher, target) pair — the confirmed check
      // stays here; the pending-pair gate rides admission (MEMPOOL_INTERFACE
      // → Correctness gates).
      if (deps.getVouchBox(voucherId, targetId)) {
        throw new ClientError('A live vouch already exists for this (voucher, target) pair');
      }

      // A vouch cast is a karma spend of VOUCH_KARMA_AMOUNT, which must leave
      // the floor standing (NODE_INTERFACE → Karma transition rules → "Only
      // a post spends the floor"; → "Engine inputs the rule needs"): the
      // voucher's `remaining = held − owed` must cover VOUCH_MIN_BALANCE
      // (the stake plus the floor; TYPES_INTERFACE → VOUCH_MIN_BALANCE).
      const voucherHeld = deps.getKarmaValue(voucherId);
      const voucherOwed = deps.getKarmaOwed(voucherId, currentBlockHeight);
      const voucherRemaining = voucherHeld - voucherOwed;
      if (voucherRemaining < VOUCH_MIN_BALANCE) {
        throw new ClientError(
          `Insufficient karma: need at least ${VOUCH_MIN_BALANCE} to vouch`,
        );
      }

      // ⛔ Keyed on the voucher, because the escrow carries no target
      // (TYPES_INTERFACE → VouchEscrowBox). `checkTransitions` holds the
      // same predicate at apply, so this is the named early refusal rather
      // than the rule's only statement.
      if (deps.hasActiveVouchEscrow(voucherId)) {
        throw new ClientError('Vouch cooldown active — cannot re-vouch yet');
      }
    },
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid vouch transaction: ',
  );
  return { status: 'pending', txId: r.txId, expiresAtHeight: r.expiresAtHeight, tx: r.tx };
}

export function initiateUnvouch(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
  expectedTargetHex: string,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  karmaReturnsAtBlock: number;
  tx: UtxoTransaction;
} {
  // NODE_INTERFACE → Service Layer Architecture → "A write request runs in
  // one order, cheapest first", → "One function admits". The pool's word on
  // the id leads; the caller's checks ride inside `admitWriteTx` so a held
  // transaction never reaches them (MEMPOOL_INTERFACE → getHeldEntry).
  const r = admitWriteTx(
    () => {
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

      // NODE_INTERFACE → Vouches, the `DELETE /vouches/:targetId` row's
      // "400 where `:targetId` is not the target of the VouchBox the
      // transaction spends": the service holds `:targetId` to the spent
      // box's `targetId` before `validateTx`.
      const targetHex = Buffer.from(targetId).toString('hex');
      if (expectedTargetHex !== targetHex) {
        throw new ClientError(':targetId does not match the spent VouchBox\'s targetId');
      }

      const signerHex = Object.keys(tx.signatures)[0];
      if (!signerHex || Buffer.from(voucherId).toString('hex') !== signerHex) {
        throw new ClientError('VouchBox does not belong to signer');
      }
    },
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid unvouch transaction: ',
  );
  // ⛔ **Read off the escrow the returned transaction itself carries, never
  // recomputed.** The engine pins `releaseAtBlock` as an exact equality
  // against `vouch.createdAtBlock + vouchCooldownBlocks`, so the value on
  // the output is authoritative; for a held answer the returned transaction
  // is the pooled one, and the escrow it carries is the first admission's.
  const escrow = r.tx.outputs.find(
    (o): o is VouchEscrowBox => o.boxType === 'vouch_escrow',
  );
  return {
    status: 'pending',
    txId: r.txId,
    expiresAtHeight: r.expiresAtHeight,
    karmaReturnsAtBlock: escrow!.releaseAtBlock,
    tx: r.tx,
  };
}
