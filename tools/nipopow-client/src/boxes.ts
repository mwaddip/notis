import { verifyAvlLookup } from '@ergots/avltree';
import {
  TREE_KEY_LENGTH,
  boxKey,
  boxRecordFromBytes,
  bytesToHex,
  computeCandidateBoxId,
  decayCfgFor,
  effectiveKarma,
  hexToBytes,
  identityKey,
  identityRecordFromBytes,
} from '@dagsocial/types';
import type {
  AnyBox,
  BlockHeader,
  CreditBox,
  DecodedBoxCandidate,
  IdentityRecord,
  NetworkProfile,
  UserId,
} from '@dagsocial/types';
import type { PoPowHeader } from '@dagsocial/nipopow';
import type { HttpFetch } from './http.js';
import { base64ToBytes, capped, fetchJson, isRecord, shown } from './http.js';
import { proveRange } from './holdings.js';
import type { RangeResult } from './holdings.js';

export interface ListedBox {
  boxId: string;
  value: string;
  lockedUntilBlock?: number;
}

export interface Listing {
  karma: { boxes: ListedBox[]; height: number; effective: string };
  /**
   * The credits listing the caller handed in, or `null` meaning *not read*:
   * the run reads no credit range, answers no credit box, zeroes every credit
   * sum, and sets `credits.holdings` to `'not-read'`
   * (WEB_INTERFACE → The extension → "The verified figures").
   */
  credits: { boxes: ListedBox[] } | null;
}

export type ListingResult = { ok: true; listing: Listing } | { ok: false; reason: string };

export interface Anchor {
  tip: BlockHeader;
  suffixHead: PoPowHeader;
}

/**
 * The classes a listed or held box falls into (WEB_INTERFACE → The extension
 * → "The verified figures"). `unlisted` names a box the key holds at `tip`
 * that is named nowhere in its ledger's listing while `heightAfter` equals
 * `tip.height` — the chain holds what the node did not list. `undecided`
 * names the same box where `heightAfter` is not `tip.height`: a block landed
 * since the anchor and may have spent it, or the node withheld it; the run
 * cannot say which, and sets no `failed`.
 */
export type FigureStatus = 'proven' | 'young' | 'unchecked' | 'absent' | 'unlisted' | 'undecided' | 'unproven' | 'no-proof';

export interface FigureBox {
  boxId: string;
  boxClass: 'karma' | 'credit';
  value: bigint;
  lockedUntilBlock: number | null;
  status: FigureStatus;
  verdict: string;
}

export type RecordResult =
  | { status: 'proven'; record: IdentityRecord }
  | { status: 'absent' }
  | { status: 'unproven' | 'no-proof'; verdict: string };

/**
 * The sums each class contributes to a ledger (WEB_INTERFACE → The extension
 * → "The verified figures"). `unlisted` and `undecided` sum apart from the
 * four — the chain holds what the node did not list, or the run cannot say.
 * `unlisted` sets `failed`; `undecided` does not.
 */
export interface LedgerSums {
  proven: bigint;
  young: bigint;
  unchecked: bigint;
  absent: bigint;
  unlisted: bigint;
  undecided: bigint;
}

/**
 * Each ledger's holdings read, beside its boxes'
 * (WEB_INTERFACE → The extension → "The verified figures").
 * - `read` — the key's whole range at both heights was proven;
 * - `unproven` — one height's range failed `unproven` (the suffix read did
 *   not verify); every listed box of the ledger carries it, and the run
 *   `failed`;
 * - `stale` — the `tip` range answers a `stateRoot` other than the header's
 *   (WEB_INTERFACE → The extension → "A `stateRoot` other than the header's
 *   at `tip` is no failed proof"): every listed box of the ledger is
 *   `unchecked`, nothing `unlisted` or `undecided` of it, and the run keeps
 *   its state;
 * - `no-proof` — one height's range failed `no-proof`; every listed box
 *   carries it, and the run keeps its state;
 * - `not-read` — the listing was handed as `null`: no range request was
 *   made.
 *
 * **Each ledger carries its own status**: a credit range that failed does
 * not mark karma failed, and karma's does not mark credits failed. This
 * follows WEB_INTERFACE → The extension → "The verified figures" — *"Each
 * ledger's read carries a status of its own beside its boxes'"*.
 */
export type HoldingsRead = 'read' | 'unproven' | 'stale' | 'no-proof' | 'not-read';

export interface FiguresResult {
  boxes: FigureBox[];
  record: RecordResult;
  karma: LedgerSums & { effective: bigint | null; holdings: HoldingsRead; holdingsVerdict: string | null };
  credits: LedgerSums & { holdings: HoldingsRead; holdingsVerdict: string | null };
  heightAfter: number | null;
  failed: boolean;
}

// NODE_INTERFACE → UTXO queries — one page per fetch, follow `next` to null
interface KarmaPageResponse {
  boxes: { boxId: string; value: string }[];
  next: string | null;
  height: number;
  effective: string;
}

interface CreditPageResponse {
  boxes: { boxId: string; value: string; lockedUntilBlock?: number }[];
  next: string | null;
}

// WEB_INTERFACE → The extension → "A run is total" — the paging walks a page's
// `boxes` and follows its `next`, so a page is an object with a `boxes` array
// and a `next` that is null or a row's key: text that is not empty, since no
// row's key is (NODE_INTERFACE → "Every paged response carries `next`"), and
// well-formed, the next request carrying it through `encodeURIComponent`; any
// other answer is a malformed page. Each entry is the node's claim, checked by
// proveFigures before a proof is asked for it.
function isPage(data: unknown): boolean {
  if (!isRecord(data) || !Array.isArray(data['boxes'])) return false;
  const next = data['next'];
  return next === null || (typeof next === 'string' && next !== '' && isWellFormedText(next));
}

// Text with no lone surrogate, the one thing `encodeURIComponent` throws on.
// Iterating a string yields a surrogate pair as one code point and a lone
// surrogate singly, so a code point in U+D800–U+DFFF is a lone one.
function isWellFormedText(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && cp >= 0xd800 && cp <= 0xdfff) return false;
  }
  return true;
}

// NODE_INTERFACE → UTXO queries — /karma/:userId and /credits/:userId are paged
// by keyset, `after=<next>` on each following request until `next` is null.
// A 404 is an identity the node has never seen (empty listing); any other
// non-ok, or a malformed page, is a listing failure carrying the route.
export async function fetchListing(
  nodeUrl: string,
  user: string,
  httpFetch: HttpFetch,
): Promise<ListingResult> {
  const karmaBoxes: ListedBox[] = [];
  let karmaHeight = 0;
  let karmaEffective = '0';

  const firstKarma = await fetchJson<KarmaPageResponse>(
    httpFetch,
    `${nodeUrl}/karma/${user}`,
  );
  if (firstKarma.ok) {
    if (!isPage(firstKarma.data)) {
      return { ok: false, reason: `GET /karma/${user}: malformed page` };
    }
    for (const b of firstKarma.data.boxes) karmaBoxes.push(b);
    karmaHeight = firstKarma.data.height;
    karmaEffective = firstKarma.data.effective;
    let next: string | null = firstKarma.data.next;
    while (next !== null) {
      const r = await fetchJson<KarmaPageResponse>(
        httpFetch,
        `${nodeUrl}/karma/${user}?after=${encodeURIComponent(next)}`,
      );
      if (!r.ok) {
        return { ok: false, reason: `GET /karma/${user}?after=${capped(next)}: HTTP ${r.status}` };
      }
      if (!isPage(r.data)) {
        return { ok: false, reason: `GET /karma/${user}?after=${capped(next)}: malformed page` };
      }
      for (const b of r.data.boxes) karmaBoxes.push(b);
      next = r.data.next;
    }
  } else if (firstKarma.status !== 404) {
    return { ok: false, reason: `GET /karma/${user}: HTTP ${firstKarma.status}` };
  }

  const creditsBoxes: ListedBox[] = [];
  const firstCredit = await fetchJson<CreditPageResponse>(
    httpFetch,
    `${nodeUrl}/credits/${user}`,
  );
  if (firstCredit.ok) {
    if (!isPage(firstCredit.data)) {
      return { ok: false, reason: `GET /credits/${user}: malformed page` };
    }
    for (const b of firstCredit.data.boxes) creditsBoxes.push(b);
    let next: string | null = firstCredit.data.next;
    while (next !== null) {
      const r = await fetchJson<CreditPageResponse>(
        httpFetch,
        `${nodeUrl}/credits/${user}?after=${encodeURIComponent(next)}`,
      );
      if (!r.ok) {
        return { ok: false, reason: `GET /credits/${user}?after=${capped(next)}: HTTP ${r.status}` };
      }
      if (!isPage(r.data)) {
        return { ok: false, reason: `GET /credits/${user}?after=${capped(next)}: malformed page` };
      }
      for (const b of r.data.boxes) creditsBoxes.push(b);
      next = r.data.next;
    }
  } else if (firstCredit.status !== 404) {
    return { ok: false, reason: `GET /credits/${user}: HTTP ${firstCredit.status}` };
  }

  return {
    ok: true,
    listing: {
      karma: { boxes: karmaBoxes, height: karmaHeight, effective: karmaEffective },
      credits: { boxes: creditsBoxes },
    },
  };
}

type KeyProofOutcome =
  | { kind: 'included'; value: Uint8Array }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type BoxAtHeight =
  | { kind: 'included'; candidate: DecodedBoxCandidate }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

type RecordProofOutcome =
  | { kind: 'proven'; record: IdentityRecord }
  | { kind: 'exclusion' }
  | { kind: 'unproven'; verdict: string }
  | { kind: 'no-proof'; verdict: string };

// NODE_INTERFACE → AVL+ State Root — one tree key, one height, one lookup
// proof, verified against the stateRoot the caller verified under
// proof-of-work. The answer's `kind` is the node's reading, trusted only to
// refuse; its `value` is never read — the value is the one the proof carries.
// An answer of another shape — a body that is not an object, a `stateRoot`
// that is not the header's, a `proof` that is not a string — is unproven
// (WEB_INTERFACE → The extension → "A run is total"). The tool's one
// single-key AVL verification; a key's holdings read whole go through
// `proveRange` (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the range
// route").
async function proveKeyAtHeight(
  nodeUrl: string,
  treeKey: Uint8Array,
  entity: 'box' | 'record',
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<KeyProofOutcome> {
  const keyHex = bytesToHex(treeKey);
  const proofRes = await fetchJson<unknown>(
    httpFetch,
    `${nodeUrl}/api/v1/proof/${keyHex}?atHeight=${atHeight}`,
  );
  if (!proofRes.ok) {
    if (proofRes.status === 0) {
      return { kind: 'no-proof', verdict: `transport failure: ${capped(proofRes.body)}` };
    }
    return { kind: 'no-proof', verdict: `HTTP ${proofRes.status}: ${capped(proofRes.body)}` };
  }
  const resp = isRecord(proofRes.data) ? proofRes.data : {};
  if (resp['stateRoot'] !== expectedStateRoot) {
    return { kind: 'unproven', verdict: 'stateRoot mismatch' };
  }
  // NODE_INTERFACE → Entity kinds — the AVL value carries provenance
  const kind = resp['kind'];
  if (kind != null && kind !== entity) {
    return {
      kind: 'unproven',
      verdict: `node returned kind ${shown(kind)} for a ${entity === 'box' ? 'box id' : 'record key'}`,
    };
  }
  const proof = resp['proof'];
  if (typeof proof !== 'string') return { kind: 'unproven', verdict: 'proof rejected' };
  const proofBytes = base64ToBytes(proof);
  if (proofBytes === null) return { kind: 'unproven', verdict: 'proof rejected' };
  const avlResult = verifyAvlLookup(
    hexToBytes(expectedStateRoot),
    proofBytes,
    { keyLength: TREE_KEY_LENGTH, valueLengthOpt: null },
    treeKey,
  );
  if (avlResult === null) return { kind: 'unproven', verdict: 'proof rejected' };
  if (avlResult.value === null) return { kind: 'exclusion' };
  return { kind: 'included', value: avlResult.value };
}

// NODE_INTERFACE → Entity kinds — a box at one height: included under its tree
// key `boxKey(boxId)` (TYPES_INTERFACE → The tree keys), its value decoded and
// hashed back to the box id that key carries. What the box must further be —
// its type, its owner — is each caller's check on the candidate.
export async function proveBoxAtHeight(
  nodeUrl: string,
  boxId: string,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<BoxAtHeight> {
  const outcome = await proveKeyAtHeight(nodeUrl, boxKey(hexToBytes(boxId)), 'box', atHeight, expectedStateRoot, httpFetch);
  if (outcome.kind !== 'included') return outcome;
  let record;
  try {
    record = boxRecordFromBytes(outcome.value);
  } catch {
    return { kind: 'unproven', verdict: 'value decode failed' };
  }
  const derivedId = computeCandidateBoxId(record.candidate, record.txId, record.index);
  if (derivedId !== boxId) {
    return { kind: 'unproven', verdict: 'value does not hash to the key' };
  }
  return { kind: 'included', candidate: record.candidate };
}

// TYPES_INTERFACE → The tree keys — the identity record's tree key is
// `identityKey(identityId)`: tag `0x02`, then the raw `identityId`. The tag
// alone keeps it apart from a box key, so the lookup proof binds this key to
// the value and no owner check applies beyond it.
async function proveRecordAtHeight(
  nodeUrl: string,
  identityId: UserId,
  atHeight: number,
  expectedStateRoot: string,
  httpFetch: HttpFetch,
): Promise<RecordProofOutcome> {
  const outcome = await proveKeyAtHeight(nodeUrl, identityKey(identityId), 'record', atHeight, expectedStateRoot, httpFetch);
  if (outcome.kind !== 'included') return outcome;
  let record: IdentityRecord;
  try {
    record = identityRecordFromBytes(outcome.value);
  } catch {
    return { kind: 'unproven', verdict: 'value decode failed' };
  }
  return { kind: 'proven', record };
}

/** The ledgers each listing kind commits to, in the run's order. */
const KINDS: readonly ('karma' | 'credit')[] = ['karma', 'credit'];
type LedgerKind = (typeof KINDS)[number];

/**
 * One ledger's reads (WEB_INTERFACE → The extension → "The verified figures"):
 * `null` where the listing was handed as `null` and nothing is read; the
 * `suffixHead` read alone where it failed, the ledger then not asked at `tip`;
 * both where it succeeded.
 */
type LedgerReads =
  | null
  | { suffix: Extract<RangeResult, { ok: false }>; tip?: undefined }
  | { suffix: Extract<RangeResult, { ok: true }>; tip: RangeResult };

/** The computed state of one ledger's reads: its `holdings` status, its
 *  verdict (if not `read`/`not-read`), and the proven box indexes. A `stale`
 *  tip read keeps `atSuffix` populated and leaves `atTip` empty. */
interface LedgerState {
  holdings: HoldingsRead;
  holdingsVerdict: string | null;
  atSuffix: Map<string, AnyBox>;
  atTip: Map<string, AnyBox>;
}

/**
 * One ledger's `holdings` state from its two reads
 * (WEB_INTERFACE → The extension → "The verified figures"). Each ledger
 * stands on its own: a `no-proof`, `unproven` or `stale` on one does not
 * reach the other's status. A `stale` on the suffix read fails `unproven`
 * at the suffix: the node answers another block at `suffixHead`, and that
 * ledger's listed boxes read `unproven`. A `stale` on the tip read keeps
 * the ledger `stale` — listed boxes read `unchecked`, nothing `unlisted`
 * or `undecided` of it.
 */
function stateOf(reads: LedgerReads): LedgerState {
  const atSuffix = new Map<string, AnyBox>();
  const atTip = new Map<string, AnyBox>();
  if (reads === null) {
    return { holdings: 'not-read', holdingsVerdict: null, atSuffix, atTip };
  }
  if (reads.tip === undefined) {
    // A failure at `suffixHead` cannot leave the suffix read `stale`, since a
    // run cannot anchor there under another block's root — it reads as
    // `unproven`, with the node named as answering another block.
    const status: 'unproven' | 'no-proof' = reads.suffix.status === 'no-proof' ? 'no-proof' : 'unproven';
    return {
      holdings: status,
      holdingsVerdict: `holdings read failed at suffixHead: ${reads.suffix.verdict}`,
      atSuffix,
      atTip,
    };
  }
  for (const b of reads.suffix.boxes) atSuffix.set(b.id!.toLowerCase(), b);
  if (!reads.tip.ok) {
    return {
      holdings: reads.tip.status,
      holdingsVerdict: `holdings read failed at tip: ${reads.tip.verdict}`,
      atSuffix,
      atTip,
    };
  }
  for (const b of reads.tip.boxes) atTip.set(b.id!.toLowerCase(), b);
  return { holdings: 'read', holdingsVerdict: null, atSuffix, atTip };
}

// WEB_INTERFACE → The extension → "The verified figures" — the run reads the
// key's holdings whole, by range, at `suffixHead` and at `tip`, then judges
// the listing against them. Order of the run: the identity record at
// `suffixHead`; `karma` at `suffixHead`; `credit` at `suffixHead` where
// `listing.credits` is not `null`; `karma` at `tip` where its suffix read
// succeeded; `credit` at `tip` where its suffix read succeeded; then
// `readHeightAfter`. Each ledger is read on its own by `proveRange` — a
// ledger whose `suffixHead` read failed is not asked at `tip`, and its tip's
// outcome does not reach the other ledger's status. The classes:
// - `proven` — the ledger's listing names a box held in both `S` and `T`, in
//   the ledger it was listed under, with the listing's value and (for a
//   credit box) its lock;
// - `young` — held in `T` and not in `S`;
// - `absent` — not held in `T` and `heightAfter` equals `tip.height`;
// - `unchecked` — not held in `T` and `heightAfter` differs or is unread, or
//   every listed box of a ledger whose `tip` read is `stale`;
// - `unlisted` — held in `T`, named nowhere in its ledger's listing, and
//   `heightAfter` equals `tip.height`; a `FigureBox` of the run's own, after
//   the listed ones, summed apart from the five;
// - `undecided` — held in `T`, named nowhere in its ledger's listing, and
//   `heightAfter` not `tip.height`; a `FigureBox` of the run's own, summed
//   apart from the five, that does not fail the run;
// - `unproven` — a listed value or lock that differs from the held box's, a
//   malformed entry, or an id named twice in the listing; a failed holdings
//   read (`unproven`) also hands this status to every listed box of the
//   ledger;
// - `no-proof` — a failed holdings read (`no-proof`) hands this status to
//   every listed box of the ledger.
// A ledger whose listing is `null` is not read: no range request, no box of
// it, every sum zero. Each ledger's read status rides as `karma.holdings` /
// `credits.holdings`, with the failure's verdict in `karma.holdingsVerdict`
// / `credits.holdingsVerdict` (`null` for `read` and `not-read`). A `stale`
// tip read is `karma.holdings`/`credits.holdings` `stale`, listed boxes
// `unchecked`, nothing `unlisted` or `undecided` of it, and the run keeps
// its state (WEB_INTERFACE → The extension → "A `stateRoot` other than the
// header's at `tip` is no failed proof").
export async function proveFigures(
  nodeUrl: string,
  user: string,
  listing: Listing,
  anchor: Anchor,
  profile: NetworkProfile,
  httpFetch: HttpFetch,
): Promise<FiguresResult> {
  const userLowerHex = user.toLowerCase();
  const userBytes = hexToBytes(userLowerHex) as UserId;
  const suffixHeight = anchor.suffixHead.header.height;
  const suffixStateRoot = anchor.suffixHead.header.stateRoot;
  const tipHeight = anchor.tip.height;
  const tipStateRoot = anchor.tip.stateRoot;
  const suffixHeader = { height: suffixHeight, stateRoot: suffixStateRoot };
  const tipHeader = { height: tipHeight, stateRoot: tipStateRoot };

  // Step 1 — the identity record at suffixHead.
  const recordOutcome = await proveRecordAtHeight(nodeUrl, userBytes, suffixHeight, suffixStateRoot, httpFetch);

  // Steps 2–5 — each ledger's two range reads, in the order:
  // karma@suffix, credit@suffix, karma@tip, credit@tip. A ledger that failed
  // at `suffixHead` is not asked at `tip`.
  const karmaSuffix = await proveRange(nodeUrl, 'karma', userLowerHex, suffixHeader, httpFetch);
  const creditSuffix = listing.credits !== null
    ? await proveRange(nodeUrl, 'credit', userLowerHex, suffixHeader, httpFetch)
    : null;
  const karmaReads: LedgerReads = karmaSuffix.ok
    ? { suffix: karmaSuffix, tip: await proveRange(nodeUrl, 'karma', userLowerHex, tipHeader, httpFetch) }
    : { suffix: karmaSuffix };
  const creditReads: LedgerReads = creditSuffix === null
    ? null
    : creditSuffix.ok
      ? { suffix: creditSuffix, tip: await proveRange(nodeUrl, 'credit', userLowerHex, tipHeader, httpFetch) }
      : { suffix: creditSuffix };

  // Step 6 — one GET /blocks/current.
  const heightAfter = await readHeightAfter(nodeUrl, httpFetch);

  // Each ledger's state, independently.
  const karmaState = stateOf(karmaReads);
  const creditState = stateOf(creditReads);
  const stateOfLedger = (ledger: LedgerKind): LedgerState =>
    ledger === 'karma' ? karmaState : creditState;

  // Walk the listing. `named` holds every 64-hex id the listing named earlier
  // (lowercased), across both ledgers (WEB_INTERFACE → The extension → "The
  // verified figures" — an id named twice is unproven in its second place on,
  // and the chain holds a box once). `checked` is each entry's lowercased
  // form, indexed by listing position, so the per-ledger set of listed ids
  // reads from this walk, never from the raw listing.
  const allListed: { listed: unknown; boxClass: LedgerKind }[] = [];
  for (const b of listing.karma.boxes) allListed.push({ listed: b, boxClass: 'karma' });
  if (listing.credits !== null) {
    for (const b of listing.credits.boxes) allListed.push({ listed: b, boxClass: 'credit' });
  }

  const named = new Set<string>();
  const listedIds: Record<LedgerKind, Set<string>> = { karma: new Set(), credit: new Set() };
  const boxes: FigureBox[] = [];
  let failed = false;

  for (const { listed, boxClass } of allListed) {
    const check = checkListedBox(listed, named);
    if (!check.ok) {
      boxes.push(malformedFigureBox(listed, boxClass, check.verdict));
      failed = true;
      continue;
    }
    listedIds[boxClass].add(check.listed.boxId);

    const ledgerState = stateOfLedger(boxClass);
    // If this ledger's holdings read failed, every listed box of it carries
    // the failure. The other ledger's reads are not reached — each ledger
    // stands on its own (WEB_INTERFACE → The extension → "The verified
    // figures" — "Each ledger's read carries a status of its own"). A `stale`
    // tip read reads every listed box `unchecked`: the node holds another
    // block at `tip`, and the next verified tip decides it
    // (WEB_INTERFACE → The extension → "A `stateRoot` other than the header's
    // at `tip` is no failed proof").
    if (ledgerState.holdings === 'unproven' || ledgerState.holdings === 'no-proof') {
      const verdict = ledgerState.holdingsVerdict!;
      const listingValue = BigInt(check.listed.value);
      const listingLocked = boxClass === 'credit' ? check.listed.lockedUntilBlock ?? null : null;
      boxes.push({
        boxId: check.listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: ledgerState.holdings,
        verdict,
      });
      if (ledgerState.holdings === 'unproven') failed = true;
      continue;
    }
    if (ledgerState.holdings === 'stale') {
      const listingValue = BigInt(check.listed.value);
      const listingLocked = boxClass === 'credit' ? check.listed.lockedUntilBlock ?? null : null;
      boxes.push({
        boxId: check.listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: 'unchecked',
        verdict: `unchecked — ${ledgerState.holdingsVerdict}`,
      });
      continue;
    }

    // The ledger's reads succeeded. Decide the class from `S` and `T`.
    const heldT = ledgerState.atTip.get(check.listed.boxId);
    const heldS = ledgerState.atSuffix.get(check.listed.boxId);
    const listingValue = BigInt(check.listed.value);
    const listingLocked = boxClass === 'credit' ? check.listed.lockedUntilBlock ?? null : null;

    if (heldT !== undefined) {
      // Held in `T`. Verify the listing's value and (for credit) lock.
      const mismatch = valueOrLockMismatch(heldT, boxClass, check.listed);
      if (mismatch !== null) {
        boxes.push({
          boxId: check.listed.boxId,
          boxClass,
          value: listingValue,
          lockedUntilBlock: listingLocked,
          status: 'unproven',
          verdict: `unproven: ${mismatch}`,
        });
        failed = true;
        continue;
      }
      const provenLock = boxClass === 'credit'
        ? (heldT as CreditBox).lockedUntilBlock ?? null
        : null;
      if (heldS !== undefined) {
        boxes.push({
          boxId: check.listed.boxId,
          boxClass,
          value: heldT.value,
          lockedUntilBlock: provenLock,
          status: 'proven',
          verdict: `proven — held at suffixHead (height ${suffixHeight}) and at tip (height ${tipHeight})`,
        });
      } else {
        boxes.push({
          boxId: check.listed.boxId,
          boxClass,
          value: heldT.value,
          lockedUntilBlock: provenLock,
          status: 'young',
          verdict: `young — held at tip (height ${tipHeight}), not at suffixHead`,
        });
      }
      continue;
    }

    // Not held in `T`. `heightAfter` decides absent vs unchecked.
    const decided = excludedAtBoth(heightAfter, tipHeight);
    if (decided.absent) {
      boxes.push({
        boxId: check.listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: 'absent',
        verdict: `absent — the node lists what the chain does not hold at height ${tipHeight}`,
      });
      failed = true;
    } else {
      boxes.push({
        boxId: check.listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status: 'unchecked',
        verdict: `unchecked — ${decided.why}`,
      });
    }
  }

  // Unlisted and undecided boxes: for each successfully-read ledger, every
  // box in `T` the listing names nowhere becomes an `unlisted` figure where
  // `heightAfter` equals `tip.height` (the chain holds what the node did not
  // list), and an `undecided` figure otherwise — a block landed since the
  // anchor and may have spent it, or the node withheld it; the run cannot
  // say which (WEB_INTERFACE → The extension → "The verified figures" —
  // "`undecided` — held at `tip`, named nowhere in the listing of its
  // ledger, and `heightAfter` not `tip.height`"). The run `failed` on
  // `unlisted` and not on `undecided`.
  for (const ledger of KINDS) {
    const state = stateOfLedger(ledger);
    if (state.holdings !== 'read') continue;
    // Deterministic order: by box id ascending.
    const held: AnyBox[] = [];
    for (const [id, box] of state.atTip) {
      if (!listedIds[ledger].has(id)) held.push(box);
    }
    held.sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));
    for (const box of held) {
      const provenLock = ledger === 'credit' ? (box as CreditBox).lockedUntilBlock ?? null : null;
      if (heightAfter === tipHeight) {
        boxes.push({
          boxId: box.id!,
          boxClass: ledger,
          value: box.value,
          lockedUntilBlock: provenLock,
          status: 'unlisted',
          verdict: `unlisted — the chain holds what the node did not list at height ${tipHeight}`,
        });
        failed = true;
      } else {
        // excludedAtBoth returns `absent: false` on this branch, naming the
        // reason the two heights disagree.
        const decided = excludedAtBoth(heightAfter, tipHeight);
        const why = decided.absent ? '' : decided.why;
        boxes.push({
          boxId: box.id!,
          boxClass: ledger,
          value: box.value,
          lockedUntilBlock: provenLock,
          status: 'undecided',
          verdict: `undecided — ${why}`,
        });
      }
    }
  }

  // The record verdict, and whether it counts as a failure.
  let record: RecordResult;
  if (recordOutcome.kind === 'proven') {
    record = { status: 'proven', record: recordOutcome.record };
  } else if (recordOutcome.kind === 'exclusion') {
    record = { status: 'absent' };
  } else if (recordOutcome.kind === 'unproven') {
    record = { status: 'unproven', verdict: recordOutcome.verdict };
    failed = true;
  } else {
    record = { status: 'no-proof', verdict: recordOutcome.verdict };
  }

  // A ledger with an empty listing whose holdings read failed `unproven`
  // sets `failed` even where no box stands to carry it
  // (WEB_INTERFACE → The extension → "The verified figures").
  for (const ledger of KINDS) {
    if (stateOfLedger(ledger).holdings === 'unproven') failed = true;
  }

  // Per-ledger sums.
  const sums = (cls: LedgerKind): LedgerSums => {
    let proven = 0n;
    let young = 0n;
    let unchecked = 0n;
    let absent = 0n;
    let unlisted = 0n;
    let undecided = 0n;
    for (const b of boxes) {
      if (b.boxClass !== cls) continue;
      if (b.status === 'proven') proven += b.value;
      else if (b.status === 'young') young += b.value;
      else if (b.status === 'unchecked') unchecked += b.value;
      else if (b.status === 'absent') absent += b.value;
      else if (b.status === 'unlisted') unlisted += b.value;
      else if (b.status === 'undecided') undecided += b.value;
    }
    return { proven, young, unchecked, absent, unlisted, undecided };
  };
  const karmaSums = sums('karma');
  const creditsSums = sums('credit');

  // TYPES_INTERFACE → Identity record and karma valuation — one implementation
  // of the valuation shared by the node and the client; valued at the row's
  // own height, so an unchanged state reproduces the number exactly. The
  // listing's height is the node's word, and the run values rep only where
  // it is a block height from `tip.height` up — and no higher than
  // `heightAfter` where that was read (WEB_INTERFACE → The extension → "The
  // verified figures" — "That height is the node's word, and is taken only
  // from `tip.height` to `heightAfter`"). Outside those bounds `effective`
  // is null and the run `failed`, as for a height that is not a block
  // height.
  const valuedAt: unknown = listing.karma.height;
  const heightInRange = isBlockHeight(valuedAt)
    && valuedAt >= tipHeight
    && (heightAfter === null || valuedAt <= heightAfter);
  let effective: bigint | null;
  if (!heightInRange) {
    effective = null;
    failed = true;
  } else if (record.status === 'proven') {
    effective = effectiveKarma(karmaSums.proven, record.record, valuedAt, decayCfgFor(profile));
  } else if (record.status === 'absent') {
    effective = effectiveKarma(karmaSums.proven, null, valuedAt, decayCfgFor(profile));
  } else {
    effective = null;
  }

  return {
    boxes,
    record,
    karma: {
      ...karmaSums,
      effective,
      holdings: karmaState.holdings,
      holdingsVerdict: karmaState.holdingsVerdict,
    },
    credits: {
      ...creditsSums,
      holdings: creditState.holdings,
      holdingsVerdict: creditState.holdingsVerdict,
    },
    heightAfter,
    failed,
  };
}

// NODE_INTERFACE → Blocks — `GET /blocks/current` answers `{ height, hash }`; no
// answer, or one whose `height` is not a block height, leaves `heightAfter`
// unread (WEB_INTERFACE → The extension → "A run is total").
export async function readHeightAfter(nodeUrl: string, httpFetch: HttpFetch): Promise<number | null> {
  const res = await fetchJson<unknown>(httpFetch, `${nodeUrl}/blocks/current`);
  if (!res.ok || !isRecord(res.data)) return null;
  const height = res.data['height'];
  return isBlockHeight(height) ? height : null;
}

// WEB_INTERFACE → The extension → "The verified figures" — a key not held at
// `tip` is `absent` when the node's height after the run is the anchor's
// tip; a block landed since, a fallen height or an unread one leaves it
// `unchecked` — undecided reads as unchecked, never as a lie.
export function excludedAtBoth(
  heightAfter: number | null,
  tipHeight: number,
): { absent: true } | { absent: false; why: string } {
  if (heightAfter === tipHeight) return { absent: true };
  const why =
    heightAfter === null
      ? '/blocks/current unavailable'
      : heightAfter > tipHeight
        ? `heightAfter ${heightAfter} > tip ${tipHeight} — a block landed since the anchor`
        : `heightAfter ${heightAfter} < tip ${tipHeight} — the node's height fell`;
  return { absent: false, why };
}

function isBlockHeight(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export const HEX_64 = /^[0-9a-f]{64}$/i;
const DECIMAL = /^[0-9]+$/;

type ListedBoxCheck = { ok: true; listed: ListedBox } | { ok: false; verdict: string };

// An entry is asked about only when it is an object whose `boxId` is 64 hex and
// named nowhere earlier in the listing, in either ledger, and whose `value` is
// a decimal string (WEB_INTERFACE → The extension → "A run is total";
// WEB_INTERFACE → The extension → "The verified figures");
// for any other, the reason it is not, named. `named` holds every 64-hex id the
// listing named before this entry, lowercased. A checked entry's own `boxId`
// comes back lowercased too — the id the duplicate check compares against, and
// the key the range run compares a held box against, is the listing's id in
// its one lowercase form, never the node's own spelling of it.
function checkListedBox(listed: unknown, named: Set<string>): ListedBoxCheck {
  if (!isRecord(listed)) return { ok: false, verdict: `the listed box is not an object: ${shown(listed)}` };
  const rawBoxId = listed['boxId'];
  if (typeof rawBoxId !== 'string' || !HEX_64.test(rawBoxId)) {
    return { ok: false, verdict: `the listed boxId is not 64 hex: ${shown(rawBoxId)}` };
  }
  const boxId = rawBoxId.toLowerCase();
  if (named.has(boxId)) {
    return { ok: false, verdict: `the listed boxId is named earlier in the listing: ${shown(rawBoxId)}` };
  }
  named.add(boxId);
  const value = listed['value'];
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    return { ok: false, verdict: `the listed value is not a decimal integer: ${shown(value)}` };
  }
  return { ok: true, listed: { ...listed, boxId, value } as ListedBox };
}

// A malformed entry keeps what reads — its `boxId` where it is a string, its
// `value` where it is a decimal string, else '' and 0n; an unproven box enters
// no sum.
function malformedFigureBox(
  listed: unknown,
  boxClass: 'karma' | 'credit',
  verdict: string,
): FigureBox {
  const entry = isRecord(listed) ? listed : {};
  const boxId = entry['boxId'];
  const value = entry['value'];
  return {
    boxId: typeof boxId === 'string' ? boxId : '',
    boxClass,
    value: typeof value === 'string' && DECIMAL.test(value) ? BigInt(value) : 0n,
    lockedUntilBlock: null,
    status: 'unproven',
    verdict: `unproven: ${verdict}`,
  };
}

/**
 * The listed value and (for credit) lock equal the held box's, both fixed
 * by its id (WEB_INTERFACE → The extension → "The verified figures"). The
 * ledger's range already fixes the box's type and its owner, so neither is
 * checked here.
 */
function valueOrLockMismatch(
  held: AnyBox,
  boxClass: LedgerKind,
  listed: ListedBox,
): string | null {
  const listingValue = BigInt(listed.value);
  if (held.value !== listingValue) {
    return `candidate value ${held.value} does not match listing ${capped(listed.value)}`;
  }
  if (boxClass === 'credit') {
    const listedLock: unknown = listed.lockedUntilBlock ?? null;
    const heldLock = (held as CreditBox).lockedUntilBlock ?? null;
    if (listedLock !== heldLock) {
      return `candidate lockedUntilBlock ${lockShown(heldLock)} does not match listing ${lockShown(listedLock)}`;
    }
  }
  return null;
}

// A lock as a verdict names it: a number as written, no lock as `none`.
function lockShown(v: unknown): string {
  if (v === null) return 'none';
  return typeof v === 'number' ? String(v) : shown(v);
}
