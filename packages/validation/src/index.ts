export {
  blake2b32,
  powTarget,
  orderingPowTarget,
  meetsPowTarget,
  blockWork,
  cumulativeWork,
  verifyValidatorSignature,
  verifyProtocolVersion,
  verifyContentLimits,
  verifyContentCharacters,
  verifyParentRefsCount,
  verifyPostFieldDomains,
  verifyHeaderFieldDomains,
  verifyTxStructure,
  verifyOrderingBlockStructure,
  verifyBlockChainLink,
  verifyOrderingBlockPoW,
  blockHash,
  computePowHash,
  ed25519PublicKeyToKeyObject,
  isValidVouchTarget,
} from './verify.js';

// Reserved, never to be reused: `verifyPoW`, `verifyPostSignature` and
// `verifySubBlockStructure`. A post is a transaction — it carries no signature of
// its own (the creating transaction is signed over its TxId and the signer is the
// author), there is no sub-block to structurally verify, and admission is the
// stateful karma lock rather than a stateless proof of burned milliseconds.
// `verifyPostFieldDomains` survives with a new caller: `verifyTxStructure`.
