import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeUtxoTxRoot,
  generateKeyPair,
  hexToBytes,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import { blockHash, verifyOrderingBlockPoW } from '@dagsocial/validation';

/**
 * A valid mined devnet ordering block at the network's floor
 * (TYPES_INTERFACE → Layout — Block). The base header reads as the one
 * verifyOrderingBlockStructure admits: height >= 1,
 * powTargetBits == ORDERING_BLOCK_POW_TARGET_FLOOR, a one-settlement body.
 *
 * `overrides` lets a case alter one header field before mining; the block
 * is re-mined against the altered header so the alteration stands. A
 * powTargetBits that orderingPowTarget cannot expand
 * (VALIDATION_INTERFACE → Invariants) is left with powNonce = 0 — the block
 * has no valid PoW, which is the arrangement a case failing before
 * verifyOrderingBlockPoW runs needs.
 */
export function makeBlockAt(
  height: number,
  protocolVersion: number,
  overrides?: {
    prevBlockHash?: string;
    createdAt?: number;
    powTargetBits?: number;
    protocolVersion?: number;
  },
): OrderingBlock {
  const kp = generateKeyPair();
  const seed = kp.secretKey.subarray(16);
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds: [height.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(height & 0xff)],
  };
  const base: BlockHeader = {
    protocolVersion: overrides?.protocolVersion ?? protocolVersion,
    height,
    prevBlockHash: overrides?.prevBlockHash ?? '00'.repeat(32),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: '00'.repeat(33),
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: overrides?.powTargetBits ?? ORDERING_BLOCK_POW_TARGET_FLOOR,
    createdAt: overrides?.createdAt ?? 1_000_000 + height,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
  let header: BlockHeader = base;
  let mined = false;
  for (let n = 0; n < 1_000_000; n++) {
    const h = { ...base, powNonce: n };
    if (verifyOrderingBlockPoW(h)) {
      header = h;
      mined = true;
      break;
    }
  }
  if (!mined) {
    header = base;
  }
  const hash = blockHash(header);
  const validatorSignature =
    hash === null
      ? new Uint8Array(64)
      : ed25519.sign(hexToBytes(hash), seed);
  return { header, utxoTxTree, validatorSignature };
}
