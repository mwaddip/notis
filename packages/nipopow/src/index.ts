export {
  MAX_NIPOPOW_PARAM,
  MAX_NIPOPOW_PREFIX,
  encodePoPowHeader,
  decodePoPowHeader,
  encodeNipopowProof,
  decodeNipopowProof,
} from './codec.js';
export type { PoPowHeader, NipopowProof } from './codec.js';

export { verifyProof } from './verify.js';
export type { VerifyResult, VerifyProfile } from './verify.js';

export { compareProofs, bestArg } from './compare.js';
export type { CompareResult } from './compare.js';

export { proveWithReader, ProofBuildError } from './prover.js';
export type { PopowHeaderReader } from './prover.js';
