import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC_DIR = join(__dirname, '../../src');

/**
 * The INSERT half of the provenance claim on `store/ordering.ts`'s
 * `createOrderingBlock` (NODE_INTERFACE → Ordering blocks store).
 *
 * The CALLER half stays hand-maintained by the canonical comment: the
 * `createOrderingBlock`-vs-alias hazard (the block creator exports a
 * function of the same name) is exactly why a caller-count gate would be
 * brittle. This test's own scope is the literal substring in `src`.
 *
 * This search cannot see a writer that assembles the SQL string dynamically
 * (e.g. `'INSERT INTO ' + tableName`); it gates the literal form only.
 */
describe('ordering_blocks single-writer gate (INSERT half)', () => {
  it('INSERT INTO ordering_blocks appears exactly once in src, in store/ordering.ts', () => {
    const hits: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const content = readFileSync(full, 'utf8');
          if (content.includes('INSERT INTO ordering_blocks')) {
            hits.push(full.replace(SRC_DIR + '/', ''));
          }
        }
      }
    }

    walk(SRC_DIR);

    expect(hits).toEqual(['store/ordering.ts']);
  });
});
