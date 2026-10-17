import {
  GENESIS_PREV_BLOCK_HASH,
  EMPTY_STATE_ROOT,
  RETARGET_HALFLIFE_BLOCKS,
  interlinkRoot,
  updateInterlinks,
  protocolVersionAt,
  type BlockHeader,
  type ProtocolEra,
} from '@dagsocial/types';
import {
  asertTargetBits,
  blockHash,
  level,
  meetsPowTarget,
  orderingPowTarget,
  powHit,
  type RetargetParams,
} from '@dagsocial/validation';

const ZERO_HEX_32 = '0'.repeat(64);
const ZERO_BYTES_32 = new Uint8Array(32);

/**
 * `asertTargetBits` for the schedule anchored at `t_a` above `parent`.
 * MINING_INTERFACE → Difficulty schedule.
 */
function nextTargetBits(parent: { height: number; createdAt: number }, t_a: number, params: RetargetParams): number {
  return asertTargetBits(params, t_a, parent);
}

/** Default `RetargetParams` the suite's devnet profile answers. */
export function defaultParams(opts: { anchorBits: number; floorBits: number; ceilingBits: number; idealMs: number }): RetargetParams {
  return {
    anchorBits: opts.anchorBits,
    idealMs: opts.idealMs,
    halflifeMs: RETARGET_HALFLIFE_BLOCKS * opts.idealMs,
    floorBits: opts.floorBits,
    ceilingBits: opts.ceilingBits,
  };
}

export interface ParentHeaderInfo {
  hash: string;
  header: BlockHeader;
  interlinks: string[];
  pathTa: number;
}

export interface MakeHeaderOpts {
  /** Height of this header. 1 forks from the virtual root. */
  height: number;
  /** The parent — `null` for height-1. */
  parent?: ParentHeaderInfo | null;
  /** `createdAt` in ms. Default: parent's + idealMs, or 1_700_000_000_000 at height 1. */
  createdAt?: number;
  /** Override `powTargetBits`. Default: anchor at height 1, else `nextTargetBits`. */
  powTargetBits?: number;
  /** Override `interlinks` the header commits to. Default: `updateInterlinks` from the parent. */
  interlinks?: string[];
  /** Override `prevBlockHash`. Default: parent's hash, or `GENESIS_PREV_BLOCK_HASH`. */
  prevBlockHash?: string;
  /** Override `protocolVersion`. Default: the era in force at this height. */
  protocolVersion?: number;
  /** Retarget parameters. */
  params: RetargetParams;
  /** Protocol-version schedule. */
  schedule: readonly ProtocolEra[];
  /** When true, mine PoW; when false, leave `powNonce` as given (default true). */
  minePow?: boolean;
  /** Starting nonce (default 0). */
  startNonce?: number;
  /** Override `validatorId` (32 bytes). */
  validatorId?: Uint8Array;
  /** When true, SKIP ensuring `powNonce` meets the target — allows a header that fails PoW. */
  intentionallyMissPow?: boolean;
}

/** How many nonces to try before giving up — anchor bits make the first iteration succeed. */
const MINE_NONCE_LIMIT = 1_000_000;

/**
 * Build one header above `parent`, mining PoW at `powTargetBits`.
 *
 * The returned record carries the header plus the fields a tree row needs
 * (`hash`, `pathTa`, `interlinks`): a caller writing to the tree does not
 * recompute them.
 */
export function makeHeader(opts: MakeHeaderOpts): ParentHeaderInfo {
  const { params, schedule } = opts;
  const h = opts.height;
  if (!Number.isInteger(h) || h < 1) throw new Error(`make-header: height must be ≥ 1, got ${h}`);

  const parent = opts.parent ?? null;
  if (h === 1 && parent !== null) throw new Error('make-header: height=1 must have no parent');
  if (h > 1 && parent === null) throw new Error('make-header: height > 1 needs a parent');

  const prevBlockHash = opts.prevBlockHash ?? (parent ? parent.hash : GENESIS_PREV_BLOCK_HASH);

  const createdAt = opts.createdAt ?? (parent ? parent.header.createdAt + params.idealMs : 1_700_000_000_000);

  const powTargetBits = opts.powTargetBits ?? (h === 1
    ? params.anchorBits
    : nextTargetBits({ height: parent!.header.height, createdAt: parent!.header.createdAt }, parent!.pathTa, params));

  let interlinks: string[];
  if (opts.interlinks !== undefined) {
    interlinks = opts.interlinks;
  } else if (h === 1) {
    interlinks = [];
  } else {
    const parentLevel = level(parent!.header, params.anchorBits);
    if (parentLevel === null) throw new Error('make-header: parent level is null');
    interlinks = updateInterlinks(parent!.interlinks, parent!.hash, parentLevel);
  }

  const protocolVersion = opts.protocolVersion ?? (() => {
    const era = protocolVersionAt(schedule, h);
    if (era === null) throw new Error(`make-header: no era for height ${h}`);
    return era;
  })();

  const validatorId = opts.validatorId ?? ZERO_BYTES_32;

  // Mine the nonce.
  let nonce = opts.startNonce ?? 0;
  const target = orderingPowTarget(powTargetBits);
  if (target === null) throw new Error(`make-header: powTargetBits ${powTargetBits} outside orderingPowTarget's domain`);

  const header: BlockHeader = {
    protocolVersion,
    height: h,
    prevBlockHash,
    utxoTxRoot: ZERO_HEX_32,
    stateRoot: EMPTY_STATE_ROOT,
    validatorId,
    powNonce: nonce,
    powTargetBits,
    createdAt,
    interlinkRoot: interlinkRoot(interlinks),
    adProofsRoot: ZERO_HEX_32,
  };

  const mine = opts.minePow ?? true;
  if (mine && !opts.intentionallyMissPow) {
    let found = false;
    for (let n = nonce; n < MINE_NONCE_LIMIT; n++) {
      header.powNonce = n;
      const hit = powHit(header);
      if (hit !== null && meetsPowTarget(hit, target)) { found = true; break; }
    }
    if (!found) throw new Error(`make-header: no nonce met the target in ${MINE_NONCE_LIMIT} iterations`);
  }

  const hash = blockHash(header);
  if (hash === null) throw new Error('make-header: produced an unhashable header');

  const pathTa = parent ? parent.pathTa : createdAt;

  return { hash, header, interlinks, pathTa };
}

/** Build `n` honest headers on top of `parent` (or from the virtual root when null). */
export function makeChain(opts: {
  parent: ParentHeaderInfo | null;
  n: number;
  params: RetargetParams;
  schedule: readonly ProtocolEra[];
  startAt?: number;
}): ParentHeaderInfo[] {
  const chain: ParentHeaderInfo[] = [];
  let prev = opts.parent;
  const startAt = opts.startAt ?? (opts.parent ? opts.parent.header.createdAt + opts.params.idealMs : 1_700_000_000_000);
  for (let i = 0; i < opts.n; i++) {
    const height = (prev ? prev.header.height : 0) + 1;
    const createdAt = i === 0 ? startAt : prev!.header.createdAt + opts.params.idealMs;
    const row = makeHeader({ height, parent: prev, params: opts.params, schedule: opts.schedule, createdAt });
    chain.push(row);
    prev = row;
  }
  return chain;
}
