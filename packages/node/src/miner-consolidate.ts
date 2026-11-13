// MINING_INTERFACE → Consolidation. A client of a node, not part of one: this
// file is built beside `src/index.ts` so a miner's key-file branch can import
// it without loading the server (MINING_INTERFACE → Consolidation → "With a
// key file the script loads node's build; without one it loads nothing more").
// Imports `@dagsocial/types`, `@dagsocial/node-reads` and `node:crypto` alone.

import type { KeyObject } from 'node:crypto';
import type { HttpFetch } from '@dagsocial/node-reads';

/** MINING_INTERFACE → Consolidation → "The key file is plaintext, in one of
 *  two forms" — the Ed25519 signer, read from the file and held for signing. */
export interface MinerKey {
  readonly publicKeyHex: string;
  readonly signingKey: KeyObject;
}

/** The value a check returns to the caller: whether it posted a transaction,
 *  how many inputs it carried, and whether the byte bound stopped it (full)
 *  rather than the listing's end. */
export interface ConsolidateOutcome {
  readonly sent: boolean;
  readonly inputCount: number;
  readonly full: boolean;
}

/** One log line, the only thing a failing check writes — the seam the caller
 *  injects to route it through the miner's own log format. */
export type Logger = (line: string) => void;

export interface CheckOptions {
  readonly nodeUrl: string;
  readonly key: MinerKey;
  readonly httpFetch: HttpFetch;
  readonly logger: Logger;
}

/**
 * MINING_INTERFACE → Consolidation → "The key file is plaintext, in one of
 * two forms" — stub.
 */
export function readMinerKey(_filePath: string, _expectedPubKeyHex: string | null): MinerKey {
  throw new Error('readMinerKey not implemented');
}

/**
 * MINING_INTERFACE → Consolidation → "A check spends what the pending view
 * leaves spendable" — stub.
 */
export async function runConsolidateCheck(_opts: CheckOptions): Promise<ConsolidateOutcome> {
  return { sent: false, inputCount: 0, full: false };
}

/** MINING_INTERFACE → Consolidation → "A check runs every
 *  `CONSOLIDATE_MIN_BOXES` heights" — the stateful cadence. */
export interface Cadence {
  tick(templateHeight: number): Promise<void>;
}

/** Create the cadence. Stub returns a cadence that never calls the check. */
export function createCadence(_opts: CheckOptions): Cadence {
  return {
    async tick(_templateHeight: number): Promise<void> { /* stub */ },
  };
}
