import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode } from 'cbor-x';
import {
  CONSENSUS_TABLES,
  PIN_CONFIG,
  rowsDigest,
  runApplyPinScenario,
  type ApplyPinCapture,
  type PinCarrier,
  type PinnedBlock,
  type PinnedRefusal,
  type Row,
  type StateCapture,
} from '../harness/block-apply-pin.js';

/**
 * The block-application pin: what applying a scripted chain of blocks does to
 * the store, frozen once as a fixture — each block's stored journal bytes, its
 * header's stateRoot and hash, and the node-local rows it wrote; the bodies it
 * refuses; and the state a revert of the whole set returns to. Every block
 * reaches the store through `applyOrderingBlockVerdict`; the scenario is
 * `test/harness/block-apply-pin.ts`.
 *
 * Two pins run the one scenario, one fixture each: the blocks as built, every
 * byte field a `Uint8Array`, and the same blocks decoded from a `Buffer`, every
 * byte field the codec reads a `Buffer`. A journal records a `Buffer` as a bare
 * CBOR byte string and a `Uint8Array` under tag 64, so the second pin freezes
 * which recorded byte fields are the decoded body's own and which a store
 * read's.
 *
 * **Do not regenerate a fixture.** Each pin's capture writes only when its file
 * is absent and its own variable is set to `1`, and never overwrites: a
 * difference from it is a finding about the change under test.
 */

interface Pin {
  title: string;
  carrier: PinCarrier;
  fixturePath: string;
  /** The variable that opts a run into capturing this pin's fixture. */
  captureVariable: string;
  capturedFrom: string;
}

const PINS: Pin[] = [
  {
    title: 'block application, pinned',
    carrier: 'Uint8Array',
    fixturePath: fileURLToPath(new URL('../fixtures/block-apply-pin.json', import.meta.url)),
    captureVariable: 'BLOCK_APPLY_PIN_CAPTURE',
    capturedFrom: '9de7bbe9 on consensus-package-stage-2, before any stage-2 source change',
  },
  {
    title: 'block application, pinned — bodies carried as Buffers',
    carrier: 'Buffer',
    fixturePath: fileURLToPath(new URL('../fixtures/block-apply-pin-buffer.json', import.meta.url)),
    captureVariable: 'BLOCK_APPLY_PIN_BUFFER_CAPTURE',
    capturedFrom: '96fd2aed on consensus-package-stage-2, before the node runs applyBlock',
  },
];

interface Fixture {
  capturedFrom: string;
  config: typeof PIN_CONFIG;
  preSet: StateCapture;
  blocks: PinnedBlock[];
  refusals: PinnedRefusal[];
  postRevert: StateCapture;
}

/** The decoded journal fields the coverage check reads. */
interface JournalView {
  mutations: Array<{
    kind: string;
    op?: string;
    box?: { boxType: string };
    identityId?: Uint8Array;
    row?: unknown;
    record?: unknown;
    replaced?: unknown;
  }>;
  likeRecordInsertions: unknown[];
  withdrawnPosts: Array<{ id: string; content: string | null }>;
}

function decodeJournal(hex: string): unknown {
  return decode(Buffer.from(hex, 'hex'));
}

/**
 * A decoded CBOR value with every distinction its bytes carry made visible: a
 * bare byte string against tag 64 (a `Uint8Array`), bigint against number,
 * `undefined` against absent, and each map's key order.
 */
function describeCbor(value: unknown): unknown {
  if (value === undefined) return { undefined: true };
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? { bigint: value.toString() } : value;
  }
  if (Buffer.isBuffer(value)) return { bytes: value.toString('hex') };
  if (value instanceof Uint8Array) return { tag64: Buffer.from(value).toString('hex') };
  if (Array.isArray(value)) return value.map(describeCbor);
  return Object.entries(value).map(([key, v]) => [key, describeCbor(v)]);
}

function expectBlockMatches(actual: PinnedBlock, golden: PinnedBlock): void {
  expect(actual.height).toBe(golden.height);
  // The structural view first, so a difference reads as the field it is in;
  // the bytes second, for anything the view does not show.
  expect(describeCbor(decodeJournal(actual.journalCbor)))
    .toEqual(describeCbor(decodeJournal(golden.journalCbor)));
  expect(actual.journalCbor).toBe(golden.journalCbor);
  expect(actual.stateRoot).toBe(golden.stateRoot);
  expect(actual.blockHash).toBe(golden.blockHash);
  expect(actual.blockTopology).toEqual(golden.blockTopology);
  expect(actual.likeRecords).toEqual(golden.likeRecords);
  expect(actual.dagPosts).toEqual(golden.dagPosts);
}

function describePin(pin: Pin): void {
  const FIXTURE_PATH = pin.fixturePath;
  const CAPTURE = process.env[pin.captureVariable] === '1';

  const fixture: Fixture | null = existsSync(FIXTURE_PATH)
    ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture)
    : null;

  let capture: ApplyPinCapture;

  describe(pin.title, () => {
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
      capture = await runApplyPinScenario(pin.carrier);
    }, 120_000);

    afterAll(() => {
      vi.doUnmock('../../src/config.js');
      vi.resetModules();
    });

    it('captures the fixture when it is absent (opt-in, never overwrites)', () => {
      if (!CAPTURE) return;
      if (existsSync(FIXTURE_PATH)) {
        throw new Error(`${FIXTURE_PATH} already exists — refusing to overwrite a frozen pin.`);
      }
      const frozen: Fixture = {
        capturedFrom: pin.capturedFrom,
        config: PIN_CONFIG,
        preSet: capture.preSet,
        blocks: capture.blocks,
        refusals: capture.refusals.map(({ height, name, verdict, speculation }) => ({
          height, name, verdict, speculation,
        })),
        postRevert: capture.postRevert,
      };
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(frozen, null, 2)}\n`);
    });

    it('the fixture exists and was captured under the scenario\'s profile numbers', () => {
      if (fixture === null) {
        throw new Error(
          `Missing ${FIXTURE_PATH}. It is captured once, with ${pin.captureVariable}=1, ` +
          `from the tree the pin freezes; a capture from a changed tree would freeze ` +
          `the change as correct.`,
        );
      }
      expect(fixture.config).toEqual(PIN_CONFIG);
      expect(capture.blocks.map((b) => b.height)).toEqual(fixture.blocks.map((b) => b.height));
      expect(capture.refusals.map((r) => r.name)).toEqual(fixture.refusals.map((r) => r.name));
    });

    for (const golden of fixture?.blocks ?? []) {
      it(`block ${golden.height}: the journal, the stateRoot, the hash and the node-local rows`, () => {
        const actual = capture.blocks.find((b) => b.height === golden.height);
        expect(actual, `no block ${golden.height} in this run`).toBeDefined();
        expectBlockMatches(actual!, golden);
      });
    }

    for (const golden of fixture?.refusals ?? []) {
      it(`refused at height ${golden.height}: ${golden.name}`, () => {
        const actual = capture.refusals.find((r) => r.name === golden.name);
        expect(actual, `no refusal "${golden.name}" in this run`).toBeDefined();
        const { rule, logged, ...pinned } = actual!;
        expect(pinned).toEqual(golden);
        expect(logged.some((line) => line.includes(rule)), logged.join('\n')).toBe(true);
      });
    }

    it('the pre-set state', () => {
      expect(capture.preSet).toEqual(fixture!.preSet);
    });

    it('a revert of the whole set restores the stateRoot and every committed table', () => {
      expect(capture.postRevert).toEqual(fixture!.postRevert);
      expect(capture.postRevert.stateRoot).toBe(capture.preSet.stateRoot);
      for (const [table] of CONSENSUS_TABLES) {
        if (table === 'dag_posts' || table === 'dag_parent_refs') continue;
        expect(capture.postRevert.tables[table], table).toBe(capture.preSet.tables[table]);
      }

      // Every post the set confirmed is a pending row again, its transaction back
      // in the pool (NODE_INTERFACE → Post transactions): the rows the set
      // inserted for placeholders stay, with their parent refs.
      const confirmed = new Map<string, Row>();
      for (const block of capture.blocks) {
        for (const row of block.dagPosts) {
          if (row['block_height'] === String(block.height) && !confirmed.has(row['id']!)) {
            confirmed.set(row['id']!, row);
          }
        }
      }
      const pending = [...confirmed.values()]
        .map((row): Row => ({ ...row, status: 'pending', block_height: null, block_index: null, withdrawn_at_height: null }))
        .sort((a, b) => (a['id']! < b['id']! ? -1 : 1));
      expect(capture.postRevert.tables['dag_posts']).toBe(rowsDigest(pending));
      const parentRefs: Row[] = pending
        .flatMap((row) => (JSON.parse(row['parent_refs']!) as string[]).map((parent) => ({
          post_id: row['id']!,
          parent_id: parent,
        })))
        .sort((a, b) => (a.post_id < b.post_id ? -1 : a.post_id > b.post_id ? 1 : a.parent_id < b.parent_id ? -1 : 1));
      expect(capture.postRevert.tables['dag_parent_refs']).toBe(rowsDigest(parentRefs));
    });

    it('applying the set again over the reverted store reproduces every block', () => {
      expect(capture.reapplied.length).toBe(capture.blocks.length);
      capture.reapplied.forEach((again, i) => expectBlockMatches(again, capture.blocks[i]!));
    });

    it('the frozen set covers every class the pin is for', () => {
      const journals = fixture!.blocks.map((b) => decodeJournal(b.journalCbor) as JournalView);
      const all = journals.flatMap((j) => j.mutations);

      const inserted = new Set(
        all.filter((m) => m.kind === 'box' && m.op === 'insert').map((m) => m.box!.boxType),
      );
      expect([...inserted].sort()).toEqual([
        'backer_pool', 'backer_stake', 'backer_unstake', 'bond', 'credit', 'emission', 'fee',
        'karma', 'karma_pool', 'karma_price', 'like_accrual', 'treasury', 'username', 'vouch',
        'vouch_escrow',
      ]);

      // A record created by the block (no pre-image) and a network record write.
      expect(all.some((m) => m.kind === 'record' && !('replaced' in m))).toBe(true);
      expect(all.some((m) => m.kind === 'network')).toBe(true);
      // A name and its holder record, each written and removed.
      const names = all.filter((m) => m.kind === 'username');
      const holders = all.filter((m) => m.kind === 'holder');
      expect(names.some((m) => m.row !== null)).toBe(true);
      expect(names.some((m) => m.row === null)).toBe(true);
      expect(holders.some((m) => m.record !== null)).toBe(true);
      expect(holders.some((m) => m.record === null)).toBe(true);
      // One identity record written more than once in one block.
      expect(journals.some((j) => {
        const ids = j.mutations
          .filter((m) => m.kind === 'record')
          .map((m) => Buffer.from(m.identityId!).toString('hex'));
        return new Set(ids).size < ids.length;
      })).toBe(true);
      // Likes recorded; a full post and a placeholder withdrawn.
      expect(journals.some((j) => j.likeRecordInsertions.length > 0)).toBe(true);
      const withdrawn = journals.flatMap((j) => j.withdrawnPosts);
      expect(withdrawn.some((w) => typeof w.content === 'string')).toBe(true);
      expect(withdrawn.some((w) => w.content === null)).toBe(true);
    });

    it('a frozen journal is the CBOR of its decoded structure, byte type included', () => {
      for (const golden of fixture!.blocks) {
        const decoded = decodeJournal(golden.journalCbor);
        expect(Buffer.from(encode(decoded)).toString('hex')).toBe(golden.journalCbor);
      }

      // The same bytes carried as a `Buffer` where the journal holds a
      // `Uint8Array` encode differently, and the comparison refuses them.
      const golden = fixture!.blocks[0]!;
      const decoded = decodeJournal(golden.journalCbor) as JournalView;
      const record = decoded.mutations.find((m) => m.kind === 'record')!;
      expect(Buffer.isBuffer(record.identityId)).toBe(false);
      record.identityId = Buffer.from(record.identityId!);
      const swapped = { ...golden, journalCbor: Buffer.from(encode(decoded)).toString('hex') };
      expect(swapped.journalCbor).not.toBe(golden.journalCbor);
      expect(() => expectBlockMatches(swapped, golden)).toThrow();
    });
  });
}

for (const pin of PINS) describePin(pin);
