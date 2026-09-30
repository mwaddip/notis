import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { StateView } from '@dagsocial/consensus';
import type { OrderingBlock, VouchBox } from '@dagsocial/types';
import { PIN_CONFIG, openApplyPinPreSet, runApplyPinScenario } from '../harness/block-apply-pin.js';

/**
 * The shadow replay's harness (NODE_INTERFACE → AVL+ State Root), held to the
 * chain the block-application pin builds (`runApplyPinScenario`): replayed over
 * the pre-set state that chain was built on, the tables and the tree answer
 * every read the rules make alike, no block takes a new verdict, and the
 * tree's digest after each block is its header's `stateRoot`; a store answer
 * altered in a wrapper is found, naming its read and its height; the lapsed
 * vouches compare as a set, every other list in its order.
 */
describe('the shadow replay, over the block-application pin\'s chain', () => {
  let chain: OrderingBlock[];
  let shadow: typeof import('../../shadow/replay.js');
  let blockApply: typeof import('../../src/services/block-apply.js');
  let db: typeof import('../../src/store/db.js');
  let ctx: import('@dagsocial/consensus').ApplyContext;

  beforeAll(async () => {
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
      return {
        ...actual,
        config: Object.freeze({
          ...actual.config,
          ...PIN_CONFIG,
          profile: Object.freeze({ ...actual.config.profile, ...PIN_CONFIG }),
        }),
      };
    });
    vi.resetModules();
    chain = (await runApplyPinScenario()).chain;
    shadow = await import('../../shadow/replay.js');
    blockApply = await import('../../src/services/block-apply.js');
    db = await import('../../src/store/db.js');
    ctx = blockApply.applyContextFrom((await import('../../src/config.js')).config);
  }, 120_000);

  afterAll(() => {
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  /** The chain replayed over a fresh copy of its pre-set state, each line it prints kept in `lines`. */
  async function replay(lines: string[], storeAt?: (height: number) => StateView) {
    await openApplyPinPreSet();
    try {
      return await shadow.replayShadow({ blocks: chain, ctx, storeAt, checkStateRoots: true, log: (line) => lines.push(line) });
    } finally {
      db.closeDb();
    }
  }

  it('the tables and the tree answer every read alike, and the tree reaches each header\'s stateRoot', async () => {
    const lines: string[] = [];
    const report = await replay(lines);
    expect(chain.length).toBeGreaterThan(0);
    expect(report.refusal).toBeNull();
    expect(report.blocks).toBe(chain.length);
    expect(report.newVerdicts).toEqual([]);
    expect(report.reads).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe(`SHADOW: ${chain.length} blocks, ${report.reads} reads, 0 differences, 0 new verdicts`);
  });

  it('a store answer altered in a wrapper is found, naming its read and its height', async () => {
    const store = blockApply.storeStateView;
    const altered: StateView = {
      ...store,
      getEmissionBox: () => {
        const box = store.getEmissionBox();
        return box === null ? null : { ...box, value: box.value + 1n };
      },
    };
    const planted = chain.length - 2;
    const lines: string[] = [];
    const failed: unknown = await replay(lines, (height) => (height === planted ? altered : store))
      .catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(shadow.ShadowDifferenceError);
    const difference = failed as InstanceType<typeof shadow.ShadowDifferenceError>;
    expect(difference.height).toBe(planted);
    expect(difference.read).toBe('getEmissionBox');
    expect(difference.at).toBe('answer.value');
    expect(difference.message).toContain(`height ${planted}: getEmissionBox()`);
    // The run's last line is the difference.
    expect(lines.at(-1)?.startsWith(`SHADOW: difference at height ${planted} after ${planted - 1} blocks, `)).toBe(true);
  });

  it('the lapsed vouches compare as a set, every other list in its order, a byte field by its bytes', () => {
    const vouch = (id: string): VouchBox => ({
      id: id.repeat(64),
      boxType: 'vouch',
      value: 1n,
      createdAtBlock: 1,
      voucherId: new Uint8Array(32).fill(1),
      targetId: new Uint8Array(32).fill(2),
      txId: 'c'.repeat(64),
      index: 0,
    });
    const [a, b] = [vouch('a'), vouch('b')];
    expect(shadow.compareAnswers('getLapsedVouches', [a, b], [b, a]).difference).toBeNull();
    expect(shadow.compareAnswers('getLapsedVouches', [a, b], [b]).difference).toBe('answer.length');
    expect(shadow.compareAnswers('getVouchBoxes', [a, b], [b, a]).difference).toBe('answer[0].id');

    // The same bytes in a `Buffer` are the same answer, noted by their class.
    const bytes = Uint8Array.of(1, 2, 3);
    expect(shadow.compareAnswers('getTopologyAuthor', Buffer.from(bytes), bytes)).toEqual({ difference: null, byteClasses: ['answer'] });
    // A key holding `undefined` is not an absent key, and a bigint is not a number.
    expect(shadow.compareAnswers('getBox', { ...a, lockedUntilBlock: undefined }, a).difference).not.toBeNull();
    expect(shadow.compareAnswers('getBox', { ...a, value: 1 }, a).difference).toBe('answer.value');
  });
});
