import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { closeDb, initDb } from '../src/store/db.js';
import { getUnspentBoxes } from '../src/store/utxo.js';
import { createAvlProver } from '../src/state/avl-prover.js';
import { applyContextFrom } from '../src/services/block-apply.js';
import { seedGenesisState } from '../src/services/genesis-state.js';
import { compareAnswers, openStoredChain, render, replayShadow } from './replay.js';

/**
 * The shadow replay of testnet's chain (NODE_INTERFACE → AVL+ State Root): the
 * store `SHADOW_STORE` names — a node's database, read through a copy — replayed
 * from block 1 to its tip over a fresh store seeded with this tree's genesis for
 * testnet, every read the rules make compared between the tables and the tree.
 * Run by `vitest.shadow.config.ts` alone; the node's suite neither runs nor
 * counts it.
 */
describe('the shadow replay of a stored chain', () => {
  it('the tree answers every read the rules make as the tables do, block 1 to the tip', async () => {
    const source = process.env['SHADOW_STORE'];
    if (source === undefined || source.trim() === '') {
      throw new Error(
        'SHADOW_STORE names no store: set it to a node database holding the chain to replay — ' +
        'SHADOW_STORE=<path> pnpm --filter @dagsocial/node exec vitest run -c vitest.shadow.config.ts',
      );
    }
    expect(config.networkType).toBe('testnet');

    const scratch = mkdtempSync(join(tmpdir(), 'notis-shadow-'));
    const chain = openStoredChain(source, scratch);
    try {
      initDb(join(scratch, 'shadow.db'));
      createAvlProver();
      seedGenesisState();

      // Every box this tree's genesis seeds, against the stored chain's box
      // under the same id: the layout moved the tree's keys, not the boxes.
      const genesis = getUnspentBoxes();
      for (const box of genesis) {
        const stored = chain.box(box.id!);
        const { difference } = compareAnswers('getBox', stored, box);
        if (difference !== null) {
          throw new Error(`genesis box ${box.id}: the stored chain holds ${render(stored)}, this genesis seeds ${render(box)}`);
        }
      }
      console.log(`shadow: ${source} holds blocks 1–${chain.tip}; genesis seeds ${genesis.length} boxes, each the stored chain's under its id`);

      const report = await replayShadow({
        blocks: chain.blocks(),
        ctx: applyContextFrom(config),
        progressEvery: 1000,
        tip: chain.tip,
      });
      expect(report.refusal).toBeNull();
      expect(report.blocks).toBe(chain.tip);
    } finally {
      chain.close();
      closeDb();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
