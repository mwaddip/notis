import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeUtxoTxRoot,
  generateKeyPair,
  hexToBytes,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type { BlockHeader, NetworkProfile, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import { asertTargetBits, blockHash, verifyOrderingBlockPoW } from '@dagsocial/validation';
import { verifierProfile } from '@dagsocial/nipopow-client';

/**
 * A valid mined devnet ordering block at the network's floor
 * (`TYPES_INTERFACE → Layout — Block`). The base header reads as the one
 * `verifyOrderingBlockStructure` admits: `height >= 1`,
 * `powTargetBits == ORDERING_BLOCK_POW_TARGET_FLOOR`, a one-settlement body.
 *
 * `overrides` lets a case alter one header field before mining; the block
 * is re-mined against the altered header so the alteration stands. A
 * `powTargetBits` that `orderingPowTarget` cannot expand
 * (`VALIDATION_INTERFACE → Invariants`) is left with `powNonce = 0` — the
 * block has no valid PoW, which is the arrangement a case failing before
 * `verifyOrderingBlockPoW` runs needs.
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
    // A target `orderingPowTarget` cannot expand (powTargetBits >
    // POW_TARGET_BITS_MAX) accepts no nonce; the resulting block fails
    // `verifyOrderingBlockPoW`, which is the arrangement a case refusing
    // at an earlier check needs. The signature is computed over the
    // header's hash if it has one, otherwise over an all-zero stand-in,
    // which still carries 64 bytes so the frame reads.
    header = base;
  }
  const hash = blockHash(header);
  const validatorSignature =
    hash === null
      ? new Uint8Array(64)
      : ed25519.sign(hexToBytes(hash), seed);
  return { header, utxoTxTree, validatorSignature };
}

/**
 * A linked devnet chain of `n` ordering blocks starting at block 1, each
 * header mined under the scheduled target
 * (`MINING_INTERFACE → Difficulty Schedule`,
 * `VALIDATION_INTERFACE → asertTargetBits`): block 1 carries the retarget's
 * `anchorBits`, every later block carries
 * `asertTargetBits(retarget, t_a, parent)` with `t_a` = block 1's `createdAt`
 * and `parent` the block below. The `createdAt` stamps step by
 * `orderingBlockIdealMs`, so the delta is zero and the bits stay at the
 * anchor for the whole chain — the schedule's shape, cheapest to mine.
 */
export function makeLinkedChain(
  n: number,
  profile: NetworkProfile,
): OrderingBlock[] {
  if (n < 1) return [];
  const retarget = verifierProfile(profile, 0).retarget;
  const ideal = profile.orderingBlockIdealMs;
  const t_a = 1_000_000;
  const chain: OrderingBlock[] = [];
  // Block 1 — anchor bits, no previous.
  chain.push(
    makeBlockAt(1, PROTOCOL_VERSION, {
      createdAt: t_a,
      powTargetBits: retarget.anchorBits,
    }),
  );
  for (let h = 2; h <= n; h++) {
    const parent = chain[h - 2]!.header;
    const parentHash = blockHash(parent);
    if (parentHash === null) {
      throw new Error('makeLinkedChain: parent header outside the encodable domain');
    }
    const scheduled = asertTargetBits(retarget, t_a, {
      height: parent.height,
      createdAt: parent.createdAt,
    });
    chain.push(
      makeBlockAt(h, PROTOCOL_VERSION, {
        prevBlockHash: parentHash,
        createdAt: t_a + (h - 1) * ideal,
        powTargetBits: scheduled,
      }),
    );
  }
  return chain;
}
