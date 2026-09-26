import { applyBlock } from '@dagsocial/consensus';
import type { ApplyResult } from '@dagsocial/consensus';
import { decodeOrderingBlock, hexToBytes } from '@dagsocial/types';
import { canonical, decodeScenario, viewOf } from './bundle-scenario.js';
import { writeEffects } from './memory-state-view.js';

/**
 * The bundle test's entry (CONSENSUS_INTERFACE → Tests): a scenario's text in
 * (`encodeScenario`), the canonical text of its results out (`canonical`). The
 * view, the blocks and the effects are built from those primitives by the realm
 * that runs this function, and nothing but the two strings crosses into or out
 * of it.
 *
 * The blocks apply in order, each over the view as the blocks before it left
 * it: an accepted block's effects are written into the view, and a refused
 * block writes nothing.
 */
export function run(input: string): string {
  const { ctx, seed, blocks } = decodeScenario(input);
  const view = viewOf(seed);
  const results: ApplyResult[] = [];
  for (const blockHex of blocks) {
    const block = decodeOrderingBlock(hexToBytes(blockHex));
    const result = applyBlock(view, block, ctx);
    if (result.ok) writeEffects(view, result.effects, block.header.height);
    results.push(result);
  }
  return canonical(results);
}
