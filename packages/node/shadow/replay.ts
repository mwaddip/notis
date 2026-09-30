import { chmodSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { applyBlock, treeStateView, treeWritesOf } from '@dagsocial/consensus';
import type { ApplyContext, ApplyResult, BlockEffects, StateView, TreeStateView } from '@dagsocial/consensus';
import { bytesToHex, decodeHeader, decodeUtxoTxTree } from '@dagsocial/types';
import type { AnyBox, OrderingBlock, VouchBox } from '@dagsocial/types';
import { storeStateView, writeBlockEffects } from '../src/services/block-apply.js';
import { getDb } from '../src/store/db.js';
import { rowToBox } from '../src/store/utxo.js';
import type { UtxoRow } from '../src/store/utxo.js';
import { checkpointProver, getAvlProver, performTreeWrites } from '../src/state/avl-prover.js';
import type { AvlProverHandle } from '../src/state/avl-prover.js';
import { proverSession } from '../src/state/prover-session.js';

/**
 * The shadow replay: a stored chain's bodies applied over this node's store and
 * prover, every read the rules make asked of the tables (`storeStateView`) and
 * of the tree (`treeStateView`), and the answers compared read by read
 * (NODE_INTERFACE → AVL+ State Root → "The rules read the tree, and nothing
 * else"). The rules are answered with the tables' answer — the reference the
 * chain was mined against — and each block's effects are written as the node
 * writes them. The headers' `stateRoot`s are not checked unless asked: a chain
 * mined under another layout commits to that layout's roots.
 */

// ---------------------------------------------------------------------------
// Comparing two answers
// ---------------------------------------------------------------------------

/** Every read of `StateView` — the compiler holds this to the interface, key for key. */
const READS: { readonly [R in keyof StateView]: true } = {
  getBox: true,
  getBoxProvenance: true,
  getIdentityRecord: true,
  getNetworkRecord: true,
  getUsername: true,
  getUsernameByOwner: true,
  getEmissionBox: true,
  getTreasuryBox: true,
  getKarmaPoolBox: true,
  getBackerPoolBox: true,
  getKarmaBoxes: true,
  getVouchEscrowsFor: true,
  getVouchBoxes: true,
  getLikeAccrualBoxes: true,
  getBondsInvitedAt: true,
  getVouchEscrowsReleasableAt: true,
  getLapsedVouches: true,
  getTopologyAuthor: true,
  getTopologyHeight: true,
  getPostStanding: true,
  hasLikeRecord: true,
};

export interface Comparison {
  /** Where the two first differ — a path from `answer` or `effects` — or null. */
  difference: string | null;
  /** Where two byte arrays hold the same bytes in different classes (a `Buffer` against a `Uint8Array`). */
  byteClasses: string[];
}

/**
 * The path of the first difference between `a` and `b`, or null: primitives by
 * `Object.is` (a bigint is never a number), arrays element by element in order,
 * objects by their own keys — a key holding `undefined` is not an absent key —
 * and their prototype, byte arrays by their bytes. Two byte arrays of different
 * classes holding the same bytes are a difference under `strictByteClass`, and
 * otherwise noted in `byteClasses`.
 */
function firstDifference(a: unknown, b: unknown, path: string, byteClasses: string[], strictByteClass: boolean): string | null {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return path;
    if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) return path;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) {
      if (strictByteClass) return path;
      byteClasses.push(path);
    }
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path;
    if (a.length !== b.length) return `${path}.length`;
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${path}[${i}]`, byteClasses, strictByteClass);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return path;
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.join(',') !== keysB.join(',')) return `${path}{${keysA.join(',')} / ${keysB.join(',')}}`;
    for (const key of keysA) {
      const found = firstDifference(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
        byteClasses,
        strictByteClass,
      );
      if (found !== null) return found;
    }
    return null;
  }
  return Object.is(a, b) ? null : path;
}

function byBoxId(boxes: readonly VouchBox[]): VouchBox[] {
  return [...boxes].sort((x, y) => (x.id! < y.id! ? -1 : x.id! > y.id! ? 1 : 0));
}

/**
 * The store's answer to `read` against the tree's: exactly, but
 * `getLapsedVouches` as a set — the one read whose order the tree layout
 * changes (CONSENSUS_INTERFACE → StateView → "The lapses run voucher by
 * voucher"; CONSENSUS_INTERFACE → The tree view → "The lapses share one
 * limit"). A byte field compares by its bytes, and a class that differs around
 * the same bytes is noted rather than counted: consensus reads no Node global
 * (CONSENSUS_INTERFACE → Place in the workspace), so no rule calls a `Buffer`'s
 * own methods, and a class that reached a block's effects would differ in the
 * effects comparison, which holds byte classes strictly (`replayShadow`).
 */
export function compareAnswers(read: keyof StateView, store: unknown, tree: unknown): Comparison {
  const byteClasses: string[] = [];
  const difference = read === 'getLapsedVouches'
    ? firstDifference(byBoxId(store as VouchBox[]), byBoxId(tree as VouchBox[]), 'answer', byteClasses, false)
    : firstDifference(store, tree, 'answer', byteClasses, false);
  return { difference, byteClasses };
}

/** A value as a line shows it: a bigint with its `n`, a byte array as its class and hex, `undefined` named. */
export function render(value: unknown): string {
  return JSON.stringify(value, function replace(this: Record<string, unknown>, key: string) {
    // `this[key]` is the value before `toJSON` — a `Buffer` would otherwise
    // arrive here as `{ type, data }`.
    const raw = this[key];
    if (raw === undefined) return 'undefined';
    if (typeof raw === 'bigint') return `${raw}n`;
    if (raw instanceof Uint8Array) return `${Buffer.isBuffer(raw) ? 'Buffer' : 'Uint8Array'}(${bytesToHex(raw)})`;
    return raw;
  });
}

// ---------------------------------------------------------------------------
// The shadow view
// ---------------------------------------------------------------------------

/** The first read at which the tables and the tree answer differently. */
export class ShadowDifferenceError extends Error {
  constructor(
    readonly height: number,
    readonly read: keyof StateView,
    readonly args: readonly unknown[],
    readonly store: unknown,
    readonly tree: unknown,
    readonly at: string,
  ) {
    super(
      `height ${height}: ${read}(${args.map(render).join(', ')}) differs at ${at} — ` +
      `the store answers ${render(store)}, the tree ${render(tree)}`,
    );
    this.name = 'ShadowDifferenceError';
  }
}

/** A block's lapse capture as each side answered it, in the order each answered. */
export interface LapseAnswers {
  store: VouchBox[];
  tree: VouchBox[];
}

/** What the shadow view counts across a run, and records of the block it is asked for. */
export interface ShadowTally {
  reads: number;
  /** Per read, the answers whose byte fields matched in another class. */
  byteClasses: Map<string, number>;
  /** The block's `getLapsedVouches` answers, or null where it made no such read. */
  lapses: LapseAnswers | null;
}

/**
 * The `StateView` that asks `store` and `tree` every read, compares the answers
 * (`compareAnswers`) and throws `ShadowDifferenceError` on the first
 * difference — answering the rules with the store's answer.
 */
export function shadowStateView(store: StateView, tree: StateView, height: number, tally: ShadowTally): StateView {
  const view: Record<string, (...args: unknown[]) => unknown> = {};
  for (const read of Object.keys(READS) as Array<keyof StateView>) {
    view[read] = (...args: unknown[]): unknown => {
      const fromStore: unknown = Reflect.apply(store[read], store, args);
      const fromTree: unknown = Reflect.apply(tree[read], tree, args);
      tally.reads++;
      const { difference, byteClasses } = compareAnswers(read, fromStore, fromTree);
      if (difference !== null) throw new ShadowDifferenceError(height, read, args, fromStore, fromTree, difference);
      if (byteClasses.length > 0) tally.byteClasses.set(read, (tally.byteClasses.get(read) ?? 0) + 1);
      if (read === 'getLapsedVouches') tally.lapses = { store: fromStore as VouchBox[], tree: fromTree as VouchBox[] };
      return fromStore;
    };
  }
  return view as unknown as StateView;
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

/** A block the tree view alone answers differently from the shadow run. */
export interface NewVerdict {
  height: number;
  /** What the tree view alone answered, where the shadow run applied the block. */
  detail: string;
  lapses: LapseAnswers | null;
  /** Whether the lapse order accounts for it: two or more lapsed vouches, one set in two orders. */
  byLapseOrder: boolean;
}

export interface ShadowRefusal {
  height: number;
  reason: string;
  lapses: LapseAnswers | null;
}

export interface ShadowReport {
  /** Blocks applied. */
  blocks: number;
  /** Reads compared. */
  reads: number;
  newVerdicts: NewVerdict[];
  /** The shadow run's refusal, which stops the run; null when every block applied. */
  refusal: ShadowRefusal | null;
  byteClasses: Map<string, number>;
  seconds: number;
  /** The seconds each step took, summed over the blocks: the shadow run, the tree view alone, the writes. */
  steps: { shadow: number; alone: number; writes: number };
}

export interface ShadowReplayOptions {
  /** The chain's blocks in height order from height 1, over a store and prover at the state before it. */
  blocks: Iterable<OrderingBlock>;
  /** The network's numbers the rules read. */
  ctx: ApplyContext;
  /** The tables' `StateView` at a height — `storeStateView` unless a wrapper is asked for. */
  storeAt?: (height: number) => StateView;
  /** Hold the tree's digest after each block to the header's `stateRoot` — for a chain mined under this layout. */
  checkStateRoots?: boolean;
  /** Where the run's lines go. */
  log?: (line: string) => void;
  /** Blocks between two progress lines; none when absent. */
  progressEvery?: number;
  /** The chain's height, for the progress lines. */
  tip?: number;
}

/**
 * Replay `blocks` over the open store and its prover, block by block:
 *
 * - `applyBlock` over the shadow view (`shadowStateView`: the store view and the
 *   block's tree view); a refusal is printed with the block's lapsed vouchers
 *   and stops the run, as its verdict;
 * - `applyBlock` once more over the tree view alone, which writes nothing — a
 *   verdict or effects other than the shadow run's are printed with the block's
 *   lapsed vouchers, and the run goes on;
 * - the shadow run's effects written as the apply path writes them
 *   (NODE_INTERFACE → AVL+ State Root): `treeWritesOf` over the block's tree
 *   view, each write performed (a refusal is `DivergedStateTreeError`), the
 *   tables through `writeBlockEffects`, the prover checkpointed — one SQLite
 *   transaction.
 *
 * The last line printed is the verdict (`verdictLine`); a difference, or any
 * other throw, is printed as that line and thrown.
 */
export async function replayShadow(options: ShadowReplayOptions): Promise<ShadowReport> {
  const log = options.log ?? ((line: string): void => console.log(line));
  const storeAt = options.storeAt ?? ((): StateView => storeStateView);
  const handle = getAvlProver();
  const started = performance.now();
  const tally: ShadowTally = { reads: 0, byteClasses: new Map(), lapses: null };
  const report: ShadowReport = {
    blocks: 0, reads: 0, newVerdicts: [], refusal: null, byteClasses: tally.byteClasses, seconds: 0,
    steps: { shadow: 0, alone: 0, writes: 0 },
  };
  const elapsed = (): number => (performance.now() - started) / 1000;
  const timed = <T>(step: keyof ShadowReport['steps'], run: () => T): T => {
    const from = performance.now();
    try {
      return run();
    } finally {
      report.steps[step] += (performance.now() - from) / 1000;
    }
  };
  let height = 0;
  try {
    for (const block of options.blocks) {
      height = block.header.height;
      if (height !== report.blocks + 1) {
        throw new Error(`the chain is not contiguous: block ${height} follows block ${report.blocks}`);
      }
      tally.lapses = null;
      const tree = treeStateView(proverSession(handle.prover));
      const result = timed('shadow', () =>
        applyBlock(shadowStateView(storeAt(height), tree, height, tally), block, options.ctx));
      report.reads = tally.reads;
      if (!result.ok) {
        report.refusal = { height, reason: result.reason, lapses: tally.lapses };
        log(`refused at height ${height}: ${result.reason} — ${describeLapses(tally.lapses)}`);
        break;
      }

      const detail = newVerdictOf(result.effects, timed('alone', () => overTreeAlone(handle, block, options.ctx)));
      if (detail !== null) {
        const verdict: NewVerdict = { height, detail, lapses: tally.lapses, byLapseOrder: isLapseOrder(tally.lapses) };
        report.newVerdicts.push(verdict);
        log(
          `new verdict at height ${height}: ${detail} — ${describeLapses(verdict.lapses)}; ` +
          `${verdict.byLapseOrder ? 'the lapse order accounts for it' : 'NOT the lapse order'}`,
        );
      }

      timed('writes', () => writeShadowEffects(handle, result.effects, height, tree));
      if (options.checkStateRoots === true) {
        const digest = handle.prover.digest();
        const root = digest === null ? 'null' : bytesToHex(digest);
        if (root !== block.header.stateRoot) {
          throw new Error(`height ${height}: the tree's digest ${root} is not the header's stateRoot ${block.header.stateRoot}`);
        }
      }
      report.blocks++;
      if (options.progressEvery !== undefined && report.blocks % options.progressEvery === 0) {
        const of = options.tip === undefined ? '' : `/${options.tip}`;
        log(`shadow: ${report.blocks}${of} blocks, ${report.reads} reads, ${rate(report.blocks, elapsed())} blocks/s`);
      }
      // A turn of the event loop between blocks, so the worker running the
      // replay keeps answering its test runner through a run of minutes.
      await nextTurn();
    }
  } catch (err) {
    report.seconds = elapsed();
    const what = err instanceof ShadowDifferenceError ? 'difference' : 'stopped';
    log(`SHADOW: ${what} at height ${height} after ${report.blocks} blocks, ${report.reads} reads: ${String(err)}`);
    throw err;
  }
  report.seconds = elapsed();
  const { shadow, alone, writes } = report.steps;
  log(
    `SHADOW steps: the shadow run ${shadow.toFixed(1)} s, the tree view alone ${alone.toFixed(1)} s ` +
    `(${rate(report.blocks, alone)} blocks/s), the writes ${writes.toFixed(1)} s`,
  );
  log(`SHADOW speed: ${report.blocks} blocks in ${report.seconds.toFixed(1)} s, ${rate(report.blocks, report.seconds)} blocks/s`);
  log(`SHADOW new verdicts at heights: ${report.newVerdicts.length === 0 ? 'none' : report.newVerdicts.map((v) => v.height).join(', ')}`);
  log(`SHADOW same bytes in another class: ${describeByteClasses(report.byteClasses)}`);
  log(verdictLine(report));
  return report;
}

/** The run's last line: its counts, or the refusal that stopped it. */
export function verdictLine(report: ShadowReport): string {
  if (report.refusal !== null) {
    return `SHADOW: refused at height ${report.refusal.height} after ${report.blocks} blocks, ` +
      `${report.reads} reads, 0 differences: ${report.refusal.reason}`;
  }
  return `SHADOW: ${report.blocks} blocks, ${report.reads} reads, 0 differences, ${report.newVerdicts.length} new verdicts`;
}

function rate(blocks: number, seconds: number): string {
  return seconds > 0 ? (blocks / seconds).toFixed(1) : '-';
}

type AloneVerdict = { ran: true; result: ApplyResult } | { ran: false; threw: string };

/**
 * `applyBlock` over the block's tree view alone, a fresh view over the same
 * prover. A throw is its answer too — a tree that contradicts itself is the
 * node's fail-stop (CONSENSUS_INTERFACE → Applying a block → "A throw is not a
 * verdict, and `applyBlock` catches none") — and is printed as a new verdict.
 */
function overTreeAlone(handle: AvlProverHandle, block: OrderingBlock, ctx: ApplyContext): AloneVerdict {
  try {
    return { ran: true, result: applyBlock(treeStateView(proverSession(handle.prover)), block, ctx) };
  } catch (err) {
    return { ran: false, threw: String(err) };
  }
}

/** How the tree view alone answered other than the shadow run's `effects`, or null where it answered the same. */
function newVerdictOf(effects: BlockEffects, alone: AloneVerdict): string | null {
  if (!alone.ran) return `the tree view alone throws: ${alone.threw}`;
  if (!alone.result.ok) return `the tree view alone refuses it: ${alone.result.reason}`;
  const at = firstDifference(effects, alone.result.effects, 'effects', [], true);
  if (at === null) return null;
  return `the tree view alone answers other effects, first at ${at}`;
}

function isLapseOrder(lapses: LapseAnswers | null): boolean {
  if (lapses === null || lapses.store.length < 2) return false;
  return compareAnswers('getLapsedVouches', lapses.store, lapses.tree).difference === null &&
    firstDifference(lapses.store, lapses.tree, 'answer', [], false) !== null;
}

function describeLapses(lapses: LapseAnswers | null): string {
  if (lapses === null) return 'no lapse read';
  const each = (boxes: VouchBox[]): string =>
    boxes.length === 0 ? 'none' : boxes.map((v) => `${bytesToHex(v.voucherId)}→${bytesToHex(v.targetId)}`).join(', ');
  return `lapsed vouchers: store [${each(lapses.store)}], tree [${each(lapses.tree)}]`;
}

function describeByteClasses(byteClasses: Map<string, number>): string {
  if (byteClasses.size === 0) return 'none';
  return [...byteClasses].map(([read, count]) => `${read} ${count}`).join(', ');
}

/**
 * The block's writes to the tree and the tables, in the apply path's order, in
 * one transaction (NODE_INTERFACE → AVL+ State Root; CONSENSUS_INTERFACE → The
 * tree writes).
 */
function writeShadowEffects(handle: AvlProverHandle, effects: BlockEffects, height: number, tree: TreeStateView): void {
  getDb().transaction(() => {
    performTreeWrites(handle.prover, height, treeWritesOf(effects, height, tree), 'replayShadow');
    writeBlockEffects(effects, height);
    checkpointProver(handle, height);
  })();
}

// ---------------------------------------------------------------------------
// A stored chain, read-only
// ---------------------------------------------------------------------------

export interface StoredChain {
  /** The highest height the store holds a block at. */
  readonly tip: number;
  /** The stored blocks from height 1, in height order, through `types`' codecs. */
  blocks(): Generator<OrderingBlock>;
  /** The store's box under `id`, live or spent, as the store's row decoder reads it; null where it holds none. */
  box(id: string): AnyBox | null;
  close(): void;
}

interface StoredBlockRow {
  height: number;
  header_bytes: Buffer;
  utxotx_tree_bytes: Buffer;
  validator_signature: Buffer;
}

/**
 * A node's store of a chain, opened read-only. SQLite creates a WAL store's
 * `-shm` and `-wal` beside the file it opens, even read-only, so the store is
 * copied into `scratch` and the copy opened; a store with a non-empty WAL beside
 * it holds frames the file does not, and is refused.
 */
export function openStoredChain(source: string, scratch: string): StoredChain {
  if (!existsSync(source)) throw new Error(`no stored chain at ${source}`);
  if (existsSync(`${source}-wal`) && statSync(`${source}-wal`).size > 0) {
    throw new Error(`${source} has a non-empty WAL beside it: checkpoint the store before replaying it`);
  }
  const copy = join(scratch, 'stored-chain.db');
  copyFileSync(source, copy);
  chmodSync(copy, 0o600);
  const db = new Database(copy, { readonly: true, fileMustExist: true });
  const tip = (db.prepare('SELECT COALESCE(MAX(height), 0) AS tip FROM ordering_blocks').get() as { tip: number }).tip;
  return {
    tip,
    *blocks(): Generator<OrderingBlock> {
      const rows = db
        .prepare('SELECT height, header_bytes, utxotx_tree_bytes, validator_signature FROM ordering_blocks ORDER BY height')
        .iterate() as IterableIterator<StoredBlockRow>;
      for (const row of rows) yield decodeStoredBlock(row);
    },
    box(id: string): AnyBox | null {
      const row = db.prepare('SELECT * FROM utxo_boxes WHERE id = ?').safeIntegers().get(id) as UtxoRow | undefined;
      return row === undefined ? null : rowToBox(row);
    },
    close(): void {
      db.close();
    },
  };
}

/** A stored row as an `OrderingBlock`: the header and the transaction tree through their codecs, the signature's bytes. */
function decodeStoredBlock(row: StoredBlockRow): OrderingBlock {
  let block: OrderingBlock;
  try {
    block = {
      header: decodeHeader(new Uint8Array(row.header_bytes)),
      utxoTxTree: decodeUtxoTxTree(new Uint8Array(row.utxotx_tree_bytes)),
      validatorSignature: new Uint8Array(row.validator_signature),
    };
  } catch (err) {
    throw new Error(`the stored block at height ${row.height} does not decode: ${String(err)}`);
  }
  if (block.header.height !== row.height) {
    throw new Error(`the stored block at height ${row.height} carries height ${block.header.height}`);
  }
  return block;
}
