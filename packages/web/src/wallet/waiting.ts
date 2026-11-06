import type { LockManager } from '../locks';
import type { BuildContext, RepBuildContext } from './builders';
import type { ChangeRef, EntryKind, SendRef, SpendableBox } from './types';

// The waiting store — WEB_INTERFACE → The wallet → "The waiting store keeps
// every waiting write as a record of its own". Per identity, under one lock
// (`notis.waiting.<pubKeyHex>`), with every read going straight to storage so
// two pages of the same browser see each other's writes. Nothing calls the
// store yet; the flows that write and send waiting writes are a later unit.

/** The two ledgers a waiting write rides, as a view
 *  (WEB_INTERFACE → The wallet → "The waiting view"): the rep view is
 *  `/karma`'s, the credits view `/credits`'s. */
export type WaitingLedger = 'rep' | 'credits';

/** The kinds that can wait — WEB_INTERFACE → The wallet → "A write no node
 *  answers waits": a post, a like, a vouch, an invite, a withdrawal, a claim
 *  and a send to a key. An unvouch, a burn and a send to a handle never wait,
 *  so they are not WaitingKind; the two faucet grants ride the ledger as a
 *  submitted write does, not as a waiting one. */
export type WaitingKind = Exclude<EntryKind, 'grant' | 'creditGrant' | 'unvouch' | 'burn'>;

/** One waiting write of the key, as the store holds it
 *  (WEB_INTERFACE → The wallet → "The waiting store keeps every waiting write
 *  as a record of its own"). `tx` is `txToJson` of the signed transaction as
 *  the write client would post it — a flow whose send got no answer keeps the
 *  transaction it signed; a flow whose reads got no answer signs and keeps
 *  the same shape. `content` is a post's text, enough to re-shape the row
 *  from the bytes alone. `spent` are the input box ids the write took off the
 *  ledger's view, `change` the output it added back (null when the spend had
 *  no change), and `cost` what the spend takes off `effective` on the rep
 *  side (sum of inputs less the change). */
export interface WaitingWrite {
  seq: number;
  chain: string;
  ledger: WaitingLedger;
  txId: string;
  kind: WaitingKind;
  postId: string;
  send?: SendRef;
  tx: Record<string, unknown>;
  content?: string;
  spent: string[];
  change: ChangeRef | null;
  cost: bigint;
  builtAtHeight: number;
}

/** The subset of the `Storage` interface the waiting store reads — so a test
 *  can hand a `Map`-backed fake and the real build hands `localStorage`
 *  (WEB_INTERFACE → The wallet → "The waiting store keeps every waiting write
 *  as a record of its own"). */
export type WaitingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** `recordBase` and the views need the key the record names, so the store
 *  reads this seam rather than importing a type that would bring in the view
 *  reads. */
interface Deps {
  storage: WaitingStorage;
  locks: LockManager;
}

// Storage keys — WEB_INTERFACE → The wallet → "The waiting store keeps every
// waiting write as a record of its own": `notis.waiting.<pubKeyHex>.…`.
const K_PREFIX = 'notis.waiting.';
const K_W = '.w.';
const K_BASE_REP = '.base.rep';
const K_BASE_CREDITS = '.base.credits';
const K_SEQ = '.seq';

// ---------------------------------------------------------------------------
// The persisted shape — a bigint is a decimal string, a key missing in storage
// is absent. Every read parses from scratch, so two stores over one storage
// see each other's writes. A record that does not parse is dropped alone, and
// a storage call that throws reads as empty (as `prefs.ts`' `readStore` does).
// ---------------------------------------------------------------------------

interface StoredBase {
  chain: string;
  spendable: Array<{ boxId: string; value: string; income?: true }>;
  effective?: string; // rep only
  height: number;
  era: number;
  author: string;
}

interface StoredSend {
  toHex: string;
  toName: string | null;
  amount: string;
  boxId: string;
}

interface StoredWrite {
  seq: number;
  chain: string;
  ledger: WaitingLedger;
  txId: string;
  kind: WaitingKind;
  postId: string;
  send?: StoredSend;
  tx: Record<string, unknown>;
  content?: string;
  spent: string[];
  change: { boxId: string; value: string; createdAtBlock: number } | null;
  cost: string;
  builtAtHeight: number;
}

const WAITING_KINDS: ReadonlySet<WaitingKind> = new Set<WaitingKind>([
  'post', 'like', 'vouch', 'invite', 'withdraw', 'claim', 'send',
]);

function readRaw(storage: WaitingStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(storage: WaitingStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* private mode, blocked storage — the write lives for this session only */
  }
}

function removeRaw(storage: WaitingStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    /* private mode, blocked storage */
  }
}

function parseBigint(v: unknown): bigint {
  if (typeof v !== 'string') throw new Error('bigint field is not a decimal string');
  // BigInt throws on an empty string or anything not a decimal integer.
  return BigInt(v);
}

function parseSpendable(v: unknown): SpendableBox[] {
  if (!Array.isArray(v)) throw new Error('spendable is not an array');
  const out: SpendableBox[] = [];
  for (const b of v) {
    if (typeof b !== 'object' || b === null) throw new Error('spendable entry is not an object');
    const o = b as Record<string, unknown>;
    if (typeof o.boxId !== 'string') throw new Error('spendable boxId is not a string');
    const value = parseBigint(o.value);
    const income = o.income === true ? { income: true as const } : {};
    out.push({ boxId: o.boxId, value, ...income });
  }
  return out;
}

function toStoredSpendable(boxes: readonly SpendableBox[]): StoredBase['spendable'] {
  return boxes.map((b) => ({
    boxId: b.boxId,
    value: b.value.toString(),
    ...(b.income === true ? { income: true as const } : {}),
  }));
}

function parseStoredBase(raw: string, ledger: WaitingLedger): { chain: string; ctx: BuildContext | RepBuildContext } {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) throw new Error('base is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.chain !== 'string') throw new Error('base chain is not a string');
  if (typeof o.height !== 'number') throw new Error('base height is not a number');
  if (typeof o.era !== 'number') throw new Error('base era is not a number');
  if (typeof o.author !== 'string') throw new Error('base author is not a string');
  const spendable = parseSpendable(o.spendable);
  const bare: BuildContext = { spendable, height: o.height, era: o.era, author: o.author };
  if (ledger === 'rep') {
    const effective = parseBigint(o.effective);
    return { chain: o.chain, ctx: { ...bare, effective } };
  }
  return { chain: o.chain, ctx: bare };
}

function parseStoredChange(v: unknown): ChangeRef | null {
  if (v === null) return null;
  if (typeof v !== 'object') throw new Error('change is not an object or null');
  const o = v as Record<string, unknown>;
  if (typeof o.boxId !== 'string') throw new Error('change boxId is not a string');
  if (typeof o.createdAtBlock !== 'number') throw new Error('change createdAtBlock is not a number');
  const value = parseBigint(o.value);
  return { boxId: o.boxId, value, createdAtBlock: o.createdAtBlock };
}

function parseStoredSend(v: unknown): SendRef {
  if (typeof v !== 'object' || v === null) throw new Error('send is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.toHex !== 'string') throw new Error('send toHex is not a string');
  if (o.toName !== null && typeof o.toName !== 'string') throw new Error('send toName is not string or null');
  if (typeof o.boxId !== 'string') throw new Error('send boxId is not a string');
  return { toHex: o.toHex, toName: o.toName as string | null, amount: parseBigint(o.amount), boxId: o.boxId };
}

function parseStoredWrite(raw: string): WaitingWrite {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null) throw new Error('write is not an object');
  const o = v as Record<string, unknown>;
  if (typeof o.seq !== 'number') throw new Error('write seq is not a number');
  if (typeof o.chain !== 'string') throw new Error('write chain is not a string');
  if (o.ledger !== 'rep' && o.ledger !== 'credits') throw new Error('write ledger is not rep or credits');
  if (typeof o.txId !== 'string') throw new Error('write txId is not a string');
  if (typeof o.kind !== 'string' || !WAITING_KINDS.has(o.kind as WaitingKind)) throw new Error('write kind is outside WaitingKind');
  if (typeof o.postId !== 'string') throw new Error('write postId is not a string');
  if (typeof o.tx !== 'object' || o.tx === null) throw new Error('write tx is not an object');
  if (o.content !== undefined && typeof o.content !== 'string') throw new Error('write content is not a string');
  if (!Array.isArray(o.spent) || !o.spent.every((x) => typeof x === 'string')) throw new Error('write spent is not a string array');
  if (typeof o.builtAtHeight !== 'number') throw new Error('write builtAtHeight is not a number');
  const change = parseStoredChange(o.change);
  const cost = parseBigint(o.cost);
  const send = o.send !== undefined ? parseStoredSend(o.send) : undefined;
  return {
    seq: o.seq,
    chain: o.chain,
    ledger: o.ledger,
    txId: o.txId,
    kind: o.kind as WaitingKind,
    postId: o.postId,
    ...(send ? { send } : {}),
    tx: o.tx as Record<string, unknown>,
    ...(o.content !== undefined ? { content: o.content as string } : {}),
    spent: o.spent as string[],
    change,
    cost,
    builtAtHeight: o.builtAtHeight,
  };
}

function toStoredWrite(w: WaitingWrite): StoredWrite {
  return {
    seq: w.seq,
    chain: w.chain,
    ledger: w.ledger,
    txId: w.txId,
    kind: w.kind,
    postId: w.postId,
    ...(w.send ? { send: { toHex: w.send.toHex, toName: w.send.toName, amount: w.send.amount.toString(), boxId: w.send.boxId } } : {}),
    tx: w.tx,
    ...(w.content !== undefined ? { content: w.content } : {}),
    spent: w.spent,
    change: w.change === null ? null : { boxId: w.change.boxId, value: w.change.value.toString(), createdAtBlock: w.change.createdAtBlock },
    cost: w.cost.toString(),
    builtAtHeight: w.builtAtHeight,
  };
}

/** The store — one per identity. `pubKeyHex` keys every row, so a store of
 *  another key sees none of this key's writes (WEB_INTERFACE → The wallet →
 *  "The waiting store keeps every waiting write as a record of its own"). */
export class WaitingStore {
  private readonly ns: string;
  private readonly wPrefix: string;
  private readonly baseRepKey: string;
  private readonly baseCreditsKey: string;
  private readonly seqKey: string;
  private readonly storage: WaitingStorage;
  private readonly locks: LockManager;

  constructor(pubKeyHex: string, deps: Deps) {
    this.ns = K_PREFIX + pubKeyHex;
    this.wPrefix = this.ns + K_W;
    this.baseRepKey = this.ns + K_BASE_REP;
    this.baseCreditsKey = this.ns + K_BASE_CREDITS;
    this.seqKey = this.ns + K_SEQ;
    this.storage = deps.storage;
    this.locks = deps.locks;
  }

  /** Every read-then-write of the store runs inside one exclusive lock
   *  (`notis.waiting.<pubKeyHex>`), so two pages build in turn, the second on
   *  the first's change (WEB_INTERFACE → The wallet → "The waiting store keeps
   *  every waiting write as a record of its own"). */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.locks.request(this.ns, fn);
  }

  /** Record the ledger's base of this chain — the last spendable view a flow of
   *  the identity read, recorded at every read a node answered
   *  (WEB_INTERFACE → The wallet → "The waiting view"). The call overwrites the
   *  previous base: a later read is always the base. */
  recordBase(ledger: 'rep', ctx: RepBuildContext, chain: string): void;
  recordBase(ledger: 'credits', ctx: BuildContext, chain: string): void;
  recordBase(ledger: WaitingLedger, ctx: BuildContext | RepBuildContext, chain: string): void {
    const base: StoredBase = {
      chain,
      spendable: toStoredSpendable(ctx.spendable),
      height: ctx.height,
      era: ctx.era,
      author: ctx.author,
      ...(ledger === 'rep' ? { effective: (ctx as RepBuildContext).effective.toString() } : {}),
    };
    writeRaw(this.storage, ledger === 'rep' ? this.baseRepKey : this.baseCreditsKey, JSON.stringify(base));
  }

  /** The rep view of this chain — `null` with no base, or a base of another
   *  chain (WEB_INTERFACE → The wallet → "The view and every waiting write
   *  carry the chain's name"). The base is advanced by every waiting write of
   *  rep on this chain in seq order: each write's `spent` boxes leave
   *  `spendable`, its `change` joins it, and `effective` drops by its `cost`;
   *  `height` and `era` stay the base's. */
  repView(chain: string): RepBuildContext | null {
    const base = this.readBase('rep');
    if (base === null || base.chain !== chain) return null;
    return advanceRep(base.ctx as RepBuildContext, this.waitingOf('rep', chain));
  }

  /** The credits view of this chain — `null` with no base, or a base of another
   *  chain. The base is advanced by every waiting write of credits on this
   *  chain in seq order: each write's `spent` boxes leave `spendable`, its
   *  `change` joins it; `height` and `era` stay the base's. */
  creditView(chain: string): BuildContext | null {
    const base = this.readBase('credits');
    if (base === null || base.chain !== chain) return null;
    return advanceCredits(base.ctx, this.waitingOf('credits', chain));
  }

  /** Keep a waiting write — called inside `withLock` so the next seq is read
   *  and written atomically with the record. Answers the write with its seq
   *  (WEB_INTERFACE → The wallet → "The waiting store keeps every waiting
   *  write as a record of its own"). */
  keep(w: Omit<WaitingWrite, 'seq'>): WaitingWrite {
    const last = readRaw(this.storage, this.seqKey);
    const prev = last === null ? 0 : (Number.parseInt(last, 10) || 0);
    const seq = prev + 1;
    const record: WaitingWrite = { ...w, seq };
    writeRaw(this.storage, this.seqKey, String(seq));
    writeRaw(this.storage, this.wPrefix + w.txId, JSON.stringify(toStoredWrite(record)));
    return record;
  }

  /** Every waiting write of the key, seq ascending. A record that does not
   *  parse is skipped alone — unlike the ledger's all-or-nothing restore —
   *  since each record is its own write (WEB_INTERFACE → The wallet → "The
   *  waiting store keeps every waiting write as a record of its own"). */
  list(): WaitingWrite[] {
    return this.readAllWrites().sort((a, b) => a.seq - b.seq);
  }

  /** Drop one waiting write by `txId`; no other row changes. */
  remove(txId: string): void {
    removeRaw(this.storage, this.wPrefix + txId);
  }

  /** Fold a sent write into its ledger's base and drop its record
   *  (WEB_INTERFACE → The wallet → "Waiting writes go out at the first
   *  answer"): the write's `spent` boxes leave the base's `spendable`, its
   *  `change` joins it, and on the rep side the base's `effective` drops by
   *  its `cost`. The view the remaining writes advance is unchanged — a press
   *  made with no node answering builds past the sent write, never on a box
   *  it spent. A record whose base is missing or of another chain is only
   *  removed; an unknown id is a no-op. */
  absorb(txId: string): void {
    const raw = readRaw(this.storage, this.wPrefix + txId);
    if (raw === null) return;
    let w: WaitingWrite;
    try {
      w = parseStoredWrite(raw);
    } catch {
      removeRaw(this.storage, this.wPrefix + txId);
      return;
    }
    const base = this.readBase(w.ledger);
    if (base !== null && base.chain === w.chain) {
      this.foldIntoBase(w.ledger, base, w.spent, w.change, w.cost);
    }
    removeRaw(this.storage, this.wPrefix + txId);
  }

  /** Fold a sent spend into this ledger's base on this chain
   *  (WEB_INTERFACE → The wallet → "The waiting view" — "Every spend the
   *  client sends and a node takes advances it the same way"): the `spent`
   *  boxes leave the base's `spendable`, `change` joins it, and on rep
   *  `effective` drops by `cost`. With no base, or a base of another chain,
   *  nothing — a later read will record the base from the node's answer, and
   *  the folded spend was already in that answer. The caller holds the lock.
   *  Nothing is kept — the write was sent, not waiting. */
  absorbSent(
    ledger: WaitingLedger,
    chain: string,
    spent: readonly string[],
    change: ChangeRef | null,
    cost: bigint,
  ): void {
    const base = this.readBase(ledger);
    if (base === null || base.chain !== chain) return;
    this.foldIntoBase(ledger, base, spent, change, cost);
  }

  private foldIntoBase(
    ledger: WaitingLedger,
    base: { chain: string; ctx: BuildContext | RepBuildContext },
    spent: readonly string[],
    change: ChangeRef | null,
    cost: bigint,
  ): void {
    const spentSet = new Set(spent);
    const nextSpendable: SpendableBox[] = [];
    for (const b of base.ctx.spendable) if (!spentSet.has(b.boxId)) nextSpendable.push(b);
    if (change !== null) nextSpendable.push({ boxId: change.boxId, value: change.value });
    if (ledger === 'rep') {
      const repCtx = base.ctx as RepBuildContext;
      this.recordBase('rep', {
        spendable: nextSpendable,
        effective: repCtx.effective - cost,
        height: repCtx.height,
        era: repCtx.era,
        author: repCtx.author,
      }, base.chain);
    } else {
      this.recordBase('credits', {
        spendable: nextSpendable,
        height: base.ctx.height,
        era: base.ctx.era,
        author: base.ctx.author,
      }, base.chain);
    }
  }

  // -------------------------------------------------------------------------

  private readBase(ledger: WaitingLedger): { chain: string; ctx: BuildContext | RepBuildContext } | null {
    const raw = readRaw(this.storage, ledger === 'rep' ? this.baseRepKey : this.baseCreditsKey);
    if (raw === null) return null;
    try {
      return parseStoredBase(raw, ledger);
    } catch {
      return null;
    }
  }

  private waitingOf(ledger: WaitingLedger, chain: string): WaitingWrite[] {
    return this.readAllWrites()
      .filter((w) => w.ledger === ledger && w.chain === chain)
      .sort((a, b) => a.seq - b.seq);
  }

  private readAllWrites(): WaitingWrite[] {
    const out: WaitingWrite[] = [];
    let n: number;
    try {
      n = this.storage.length;
    } catch {
      return out;
    }
    for (let i = 0; i < n; i++) {
      let key: string | null;
      try {
        key = this.storage.key(i);
      } catch {
        continue;
      }
      if (key === null || !key.startsWith(this.wPrefix)) continue;
      const raw = readRaw(this.storage, key);
      if (raw === null) continue;
      try {
        out.push(parseStoredWrite(raw));
      } catch {
        // A record that does not parse is skipped and the rest stay.
      }
    }
    return out;
  }
}

// Totality: the view advancers answer a BuildContext / RepBuildContext whose
// spendable and effective reflect the base plus every waiting write of the
// ledger and chain in seq order.

function advanceCredits(base: BuildContext, writes: readonly WaitingWrite[]): BuildContext {
  let spendable = base.spendable;
  for (const w of writes) spendable = applyToSpendable(spendable, w);
  return { spendable, height: base.height, era: base.era, author: base.author };
}

function advanceRep(base: RepBuildContext, writes: readonly WaitingWrite[]): RepBuildContext {
  let spendable = base.spendable;
  let effective = base.effective;
  for (const w of writes) {
    spendable = applyToSpendable(spendable, w);
    effective = effective - w.cost;
  }
  return { spendable, effective, height: base.height, era: base.era, author: base.author };
}

function applyToSpendable(spendable: readonly SpendableBox[], w: WaitingWrite): SpendableBox[] {
  const spent = new Set(w.spent);
  const next: SpendableBox[] = [];
  for (const b of spendable) if (!spent.has(b.boxId)) next.push(b);
  if (w.change !== null) next.push({ boxId: w.change.boxId, value: w.change.value });
  return next;
}

