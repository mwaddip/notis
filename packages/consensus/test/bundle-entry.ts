import { applyBlock } from '@dagsocial/consensus';
import type { ApplyResult } from '@dagsocial/consensus';
import { decodeOrderingBlock } from '@dagsocial/types';
import { replayBlock } from './block-proof.js';
import { canonical, decodeScenario, viewOf } from './bundle-scenario.js';
import { writeEffects } from './memory-state-view.js';

/**
 * The bundle test's entry (CONSENSUS_INTERFACE → Tests): a scenario's text in
 * (`encodeScenario`), the canonical text of its answer out (`canonical`). The
 * view, the blocks, the proofs and the effects are built from those primitives
 * by the realm that runs this function, and nothing but the two strings crosses
 * into or out of it.
 *
 * The blocks apply in order, each over the view as the blocks before it left
 * it: an accepted block's effects are written into the view, and a refused
 * block writes nothing. Each block is also replayed from its parent's digest
 * and its proof alone, over `verifierSession` (CONSENSUS_INTERFACE → The tree
 * session), and the digest its replay reached is answered beside the results.
 */
export function run(input: string): string {
  const { ctx, seed, blocks } = decodeScenario(input);
  const view = viewOf(seed);
  const results: ApplyResult[] = [];
  const digests: Array<Uint8Array | null> = [];
  for (const { block: bytes, parentDigest, proof } of blocks) {
    const block = decodeOrderingBlock(bytes);
    const result = applyBlock(view, block, ctx);
    if (result.ok) writeEffects(view, result.effects, block.header.height);
    results.push(result);
    digests.push(replayBlock(parentDigest, proof, block, ctx).digest);
  }
  return canonical({ results, digests });
}
