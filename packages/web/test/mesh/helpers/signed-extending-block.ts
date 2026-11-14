// A signed, mined OrderingBlock that extends the memoized mined chain at
// `base`, and a NipopowProof of the chain whose tip IS that block's
// header. The mined chain's header at height `base + 1` fixes the fields
// that come from the parent chain (`prevBlockHash`, `powTargetBits`,
// `createdAt`, `interlinkRoot`, `protocolVersion`); the new header
// carries a real `validatorId`, the `utxoTxRoot` of a one-entry body,
// a re-mined `powNonce`, and a validator signature over the hash.
// NET_INTERFACE → Stage 1 — the block the client's registered topic
// validator reads is the one the router delivers (`BlockCheck` of
// `@dagsocial/net/browser`).

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  computeUtxoTxRoot,
  generateKeyPair,
  hexToBytes,
} from '@dagsocial/types';
import type { BlockHeader, OrderingBlock, UtxoTxTree } from '@dagsocial/types';
import { blockHash, verifyOrderingBlockPoW } from '@dagsocial/validation';
import { proveWithReader } from '@dagsocial/nipopow';
import type { NipopowProof, PoPowHeader } from '@dagsocial/nipopow';
import { buildMinedChain, makeReader } from '../../../../nipopow/test/helpers.js';
import type { MinedChain } from '../../../../nipopow/test/helpers.js';

export interface SignedExtendingBlockOptions {
  /** The height of the parent — the extending block sits at `base + 1`. */
  base: number;
  /** Nipopow proof parameters. */
  m: number;
  k: number;
}

export interface SignedExtendingBlock {
  /**
   * The block at height `base + 1` whose `prevBlockHash` is the mined
   * chain's header at `base`. Its hash equals `proof`'s suffix tip hash.
   */
  block: OrderingBlock;
  /**
   * The NipopowProof over the chain whose first `base` headers are the
   * mined chain's own and whose tip is `block.header`. `verifyProof`
   * reads each header's PoW and interlinks.
   */
  proof: NipopowProof;
}

export function signedExtendingBlock(
  opts: SignedExtendingBlockOptions,
): SignedExtendingBlock {
  const extended = buildMinedChain({ count: opts.base + 1 });
  const template = extended.headers[opts.base]!;
  const interlinks = extended.interlinksPerHeader[opts.base]!;

  const kp = generateKeyPair();
  const seed = kp.secretKey.subarray(16);

  const h = opts.base + 1;
  const utxoTxTree: UtxoTxTree = {
    utxoTxIds: [h.toString(16).padStart(64, '0')],
    utxoTxs: [new Uint8Array(96).fill(h & 0xff)],
  };

  const draft: BlockHeader = {
    protocolVersion: template.protocolVersion,
    height: template.height,
    prevBlockHash: template.prevBlockHash,
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: template.stateRoot,
    validatorId: kp.publicKey,
    powNonce: 0,
    powTargetBits: template.powTargetBits,
    createdAt: template.createdAt,
    interlinkRoot: template.interlinkRoot,
    adProofsRoot: template.adProofsRoot,
  };

  let header: BlockHeader = draft;
  let mined = false;
  for (let n = 0; n < 10_000_000; n++) {
    const candidate: BlockHeader = { ...draft, powNonce: n };
    if (verifyOrderingBlockPoW(candidate)) {
      header = candidate;
      mined = true;
      break;
    }
  }
  if (!mined) throw new Error('signedExtendingBlock: could not find a PoW nonce');

  const hash = blockHash(header);
  if (hash === null) throw new Error('signedExtendingBlock: unhashable header');
  const validatorSignature = ed25519.sign(hexToBytes(hash), seed);
  const block: OrderingBlock = { header, utxoTxTree, validatorSignature };

  const popowHeaders: PoPowHeader[] = [
    ...extended.popowHeaders.slice(0, opts.base),
    Object.freeze({ header, interlinks }),
  ];
  const chain: MinedChain = {
    headers: [...extended.headers.slice(0, opts.base), header],
    interlinksPerHeader: [...extended.interlinksPerHeader.slice(0, opts.base), interlinks],
    popowHeaders,
  };
  const proof = proveWithReader(makeReader(chain), { m: opts.m, k: opts.k });
  return { block, proof };
}
