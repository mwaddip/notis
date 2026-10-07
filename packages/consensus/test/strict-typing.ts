// Type-level test: `verifierSession` takes either of `@dagsocial/avltree`'s two
// step-by-step verifier classes (CONSENSUS_INTERFACE → The tree session). The
// package's typecheck is what passes this check — a nominal parameter would
// fail with `TS2345 … separate declarations of a private property 'config'`,
// since neither class is assignable to the other.
import { BatchAVLVerifier, StrictBatchAVLVerifier } from '@dagsocial/avltree';
import { TREE_KEY_LENGTH } from '@dagsocial/types';
import { verifierSession } from '../src/verifier-session.js';

declare const digest: Uint8Array;
declare const proof: Uint8Array;
const config = { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null };

export const plain = verifierSession(new BatchAVLVerifier(digest, proof, config));
export const strict = verifierSession(new StrictBatchAVLVerifier(digest, proof, config));
