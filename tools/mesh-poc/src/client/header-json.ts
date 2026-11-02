// MESH_INTERFACE → The client's node list → "The client's chain" — the client
// reads a header out of `/blocks/:height`'s JSON (NODE_INTERFACE → HTTP API →
// "The `header` object in `/blocks/:height`'s response carries all eleven
// header fields"), converts `validatorId`'s hex to raw bytes, and holds the
// shape to `verifyHeaderFieldDomains`
// (VALIDATION_INTERFACE → verifyHeaderFieldDomains).

import { hexToBytes, isHex64 } from '@dagsocial/types';
import type { BlockHeader } from '@dagsocial/types';
import { verifyHeaderFieldDomains } from '@dagsocial/validation';

/**
 * Read a served `/blocks/:height` header object as a `BlockHeader`, or
 * answer `null` when any field is of the wrong shape or `validatorId`'s
 * hex does not decode. The eleven fields are those of
 * `TYPES_INTERFACE → Layout — Block`, with `validatorId` as 64 lowercase
 * hex (NODE_INTERFACE → `blockToJson`); every other field crosses as JSON
 * as it reads in the type. `verifyHeaderFieldDomains` is the last gate —
 * a reader that passed it is of the domain every hasher and verifier the
 * client calls accepts (TYPES_INTERFACE → Layout — Block → "The domains").
 */
export function headerFromJson(v: unknown): BlockHeader | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const validatorIdRaw = o['validatorId'];
  if (!isHex64(validatorIdRaw)) return null;
  const validatorId = hexToBytes(validatorIdRaw);
  const header = {
    protocolVersion: o['protocolVersion'],
    height: o['height'],
    prevBlockHash: o['prevBlockHash'],
    utxoTxRoot: o['utxoTxRoot'],
    stateRoot: o['stateRoot'],
    validatorId,
    powNonce: o['powNonce'],
    powTargetBits: o['powTargetBits'],
    createdAt: o['createdAt'],
    interlinkRoot: o['interlinkRoot'],
    adProofsRoot: o['adProofsRoot'],
  };
  const verdict = verifyHeaderFieldDomains(header);
  if (!verdict.valid) return null;
  return header as BlockHeader;
}
