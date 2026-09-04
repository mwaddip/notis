// The e2e identity and transaction builders promote.mjs needs, re-exported so
// vite can bundle the (unbuilt) tools/e2e TypeScript for Node — DEVNET_FAUCET is
// imported, never copied (docs/specs → the proof; NODE_INTERFACE → Faucet).
export { DEVNET_FAUCET, fresh } from '../../../../tools/e2e/src/identities.ts';
export { buildVouchTx } from '../../../../tools/e2e/src/tx/vouch.ts';
export { buildLikeTx } from '../../../../tools/e2e/src/tx/like.ts';
export { buildThreadTx } from '../../../../tools/e2e/src/tx/post.ts';
