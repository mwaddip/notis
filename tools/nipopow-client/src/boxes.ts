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
import type { HoldingKind } from '@dagsocial/consensus';
import type { HttpFetch } from './http.js';
import { capped, fetchJson, isRecord, shown } from './http.js';
import { proveHoldings } from './holdings.js';

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
 * `tip.height` — the chain holds what the node did not list.
 */
export type FigureStatus = 'proven' | 'young' | 'unchecked' | 'absent' | 'unlisted' | 'unproven' | 'no-proof';

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
 * → "The verified figures"). `unlisted` sums apart from the four — the chain
 * holds what the node did not list — and sets `failed` as an `absent` box
 * does.
 */
export interface LedgerSums {
  proven: bigint;
  young: bigint;
  unchecked: bigint;
  absent: bigint;
  unlisted: bigint;
}

/**
 * Each ledger's holdings read, beside its boxes'
 * (WEB_INTERFACE → The extension → "The verified figures").
 * - `read` — the key's whole range at both heights was proven;
 * - `unproven` — one height's range failed `unproven` (`suffixHead` before
 *   `tip`); every listed box of the ledger carries it, and the run `failed`;
 * - `no-proof` — one height's range failed `no-proof`; every listed box
 *   carries it, and the run keeps its state;
 * - `not-read` — the listing was handed as `null`: no range request was
 *   made.
 */
export type HoldingsRead = 'read' | 'unproven' | 'no-proof' | 'not-read';

export interface FiguresResult {
  boxes: FigureBox[];
  record: RecordResult;
  karma: LedgerSums & { effective: bigint | null; holdings: HoldingsRead };
  credits: LedgerSums & { holdings: HoldingsRead };
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
// `proveHoldings` (NODE_INTERFACE → AVL+ State Root → "avl-endpoint, the
// range route").
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

// WEB_INTERFACE → The extension → "The verified figures" — the run reads the
// key's holdings whole, by range, at `suffixHead` and at `tip`, then judges
// the listing against them. Order of the run: the identity record at
// `suffixHead`; `proveHoldings` at `suffixHead` for `karma` and, where
// `listing.credits` is not `null`, `credit`; the same at `tip`; then
// `readHeightAfter`. The classes:
// - `proven` — the ledger's listing names a box held in both `S` and `T`, in
//   the ledger it was listed under, with the listing's value and (for a
//   credit box) its lock;
// - `young` — held in `T` and not in `S`;
// - `absent` — not held in `T` and `heightAfter` equals `tip.height`;
// - `unchecked` — not held in `T` and `heightAfter` differs or is unread;
// - `unlisted` — held in `T`, named nowhere in its ledger's listing, and
//   `heightAfter` equals `tip.height`; a `FigureBox` of the run's own, after
//   the listed ones, summed apart from the four;
// - `unproven` — a listed value or lock that differs from the held box's, a
//   malformed entry, or an id named twice in the listing; a failed holdings
//   read (`unproven`) also hands this status to every listed box of the
//   ledger;
// - `no-proof` — a failed holdings read (`no-proof`) hands this status to
//   every listed box of the ledger.
// A ledger whose listing is `null` is not read: no range request, no box of
// it, every sum zero. Each ledger's read status is `karma.holdings` and
// `credits.holdings`.
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

  // Step 1 — the identity record at suffixHead.
  const recordOutcome = await proveRecordAtHeight(nodeUrl, userBytes, suffixHeight, suffixStateRoot, httpFetch);

  // The kinds of range to read, in the run's order. A `null` credits listing
  // means *not read*; the credit range is not asked.
  const askedKinds: HoldingKind[] = ['karma'];
  if (listing.credits !== null) askedKinds.push('credit');

  // Step 2 — holdings at suffixHead (S).
  const S = await proveHoldings(nodeUrl, userLowerHex, askedKinds, { height: suffixHeight, stateRoot: suffixStateRoot }, httpFetch);

  // Step 3 — holdings at tip (T), only when S succeeded. A ledger that
  // failed at `suffixHead` ends there — its listed boxes carry S's failure.
  const T = S.ok
    ? await proveHoldings(nodeUrl, userLowerHex, askedKinds, { height: tipHeight, stateRoot: tipStateRoot }, httpFetch)
    : null;

  // Step 4 — one GET /blocks/current.
  const heightAfter = await readHeightAfter(nodeUrl, httpFetch);

  // Each ledger's read status (`holdings`): `not-read` for a `null` listing,
  // the first failure's status for a read that failed, `read` otherwise.
  const holdingsStatus = (ledger: LedgerKind): HoldingsRead => {
    if (ledger === 'credit' && listing.credits === null) return 'not-read';
    if (!S.ok) return S.status;
    if (T !== null && !T.ok) return T.status;
    return 'read';
  };

  const holdingsVerdict = (ledger: LedgerKind): string | null => {
    if (ledger === 'credit' && listing.credits === null) return null;
    if (!S.ok) return `holdings read failed at suffixHead: ${S.verdict}`;
    if (T !== null && !T.ok) return `holdings read failed at tip: ${T.verdict}`;
    return null;
  };

  // Build an index of the held boxes at each height, per ledger. Each key
  // appears once in a ledger's range (`CONSENSUS_INTERFACE → The holdings
  // page`). A credit box's `lockedUntilBlock` is read from the proven box.
  const atSuffix: Record<LedgerKind, Map<string, AnyBox>> = { karma: new Map(), credit: new Map() };
  const atTip: Record<LedgerKind, Map<string, AnyBox>> = { karma: new Map(), credit: new Map() };
  if (S.ok) {
    for (const kind of askedKinds) {
      if (kind !== 'karma' && kind !== 'credit') continue;
      const boxes = S.boxes[kind];
      if (boxes === undefined) continue;
      for (const b of boxes) atSuffix[kind].set(b.id!.toLowerCase(), b);
    }
  }
  if (T !== null && T.ok) {
    for (const kind of askedKinds) {
      if (kind !== 'karma' && kind !== 'credit') continue;
      const boxes = T.boxes[kind];
      if (boxes === undefined) continue;
      for (const b of boxes) atTip[kind].set(b.id!.toLowerCase(), b);
    }
  }

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

    // If this ledger's holdings read failed, every listed box of it carries
    // the failure.
    const status = holdingsStatus(boxClass);
    if (status === 'unproven' || status === 'no-proof') {
      const verdict = holdingsVerdict(boxClass)!;
      const listingValue = BigInt(check.listed.value);
      const listingLocked = boxClass === 'credit' ? check.listed.lockedUntilBlock ?? null : null;
      boxes.push({
        boxId: check.listed.boxId,
        boxClass,
        value: listingValue,
        lockedUntilBlock: listingLocked,
        status,
        verdict,
      });
      if (status === 'unproven') failed = true;
      continue;
    }

    // The ledger's reads succeeded. Decide the class from `S` and `T`.
    const heldT = atTip[boxClass].get(check.listed.boxId);
    const heldS = atSuffix[boxClass].get(check.listed.boxId);
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

  // Unlisted boxes: for each successfully-read ledger, every box in `T` the
  // listing names nowhere becomes an `unlisted` figure with `heightAfter`
  // equal to `tip.height`; otherwise it is in no class and no sum
  // (WEB_INTERFACE → The extension → "The verified figures" — a held box
  // the listing lacks while `heightAfter` is not `tip.height` is in no class
  // and no `FigureBox`).
  if (heightAfter === tipHeight) {
    for (const ledger of KINDS) {
      if (holdingsStatus(ledger) !== 'read') continue;
      // Deterministic order: by box id ascending.
      const unlisted: AnyBox[] = [];
      for (const [id, box] of atTip[ledger]) {
        if (!listedIds[ledger].has(id)) unlisted.push(box);
      }
      unlisted.sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0));
      for (const held of unlisted) {
        const provenLock = ledger === 'credit' ? (held as CreditBox).lockedUntilBlock ?? null : null;
        boxes.push({
          boxId: held.id!,
          boxClass: ledger,
          value: held.value,
          lockedUntilBlock: provenLock,
          status: 'unlisted',
          verdict: `unlisted — the chain holds what the node did not list at height ${tipHeight}`,
        });
        failed = true;
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
    if (holdingsStatus(ledger) === 'unproven') failed = true;
  }

  // Per-ledger sums.
  const sums = (cls: LedgerKind): LedgerSums => {
    let proven = 0n;
    let young = 0n;
    let unchecked = 0n;
    let absent = 0n;
    let unlisted = 0n;
    for (const b of boxes) {
      if (b.boxClass !== cls) continue;
      if (b.status === 'proven') proven += b.value;
      else if (b.status === 'young') young += b.value;
      else if (b.status === 'unchecked') unchecked += b.value;
      else if (b.status === 'absent') absent += b.value;
      else if (b.status === 'unlisted') unlisted += b.value;
    }
    return { proven, young, unchecked, absent, unlisted };
  };
  const karmaSums = sums('karma');
  const creditsSums = sums('credit');

  // TYPES_INTERFACE → Identity record and karma valuation — one implementation
  // of the valuation shared by the node and the client; valued at the row's
  // own height, so an unchanged state reproduces the number exactly. A height
  // that is not a block height values nothing and fails the run.
  const valuedAt: unknown = listing.karma.height;
  let effective: bigint | null;
  if (!isBlockHeight(valuedAt)) {
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
    karma: { ...karmaSums, effective, holdings: holdingsStatus('karma') },
    credits: { ...creditsSums, holdings: holdingsStatus('credit') },
    heightAfter,
    failed,
  };
}

// The command line's entry: fetch the listing and prove it. A listing
// failure answers a FiguresResult carrying `not-read` for both ledgers'
// `holdings` (WEB_INTERFACE → The extension → "The verified figures").
export async function proveBoxes(
  nodeUrl: string,
  user: string,
  anchor: Anchor,
  profile: NetworkProfile,
  httpFetch: HttpFetch,
): Promise<FiguresResult> {
  const listingResult = await fetchListing(nodeUrl, user, httpFetch);
  if (!listingResult.ok) {
    return {
      boxes: [],
      record: { status: 'no-proof', verdict: `listing failed: ${listingResult.reason}` },
      karma: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, effective: null, holdings: 'not-read' },
      credits: { proven: 0n, young: 0n, unchecked: 0n, absent: 0n, unlisted: 0n, holdings: 'not-read' },
      heightAfter: null,
      failed: true,
    };
  }
  return proveFigures(nodeUrl, user, listingResult.listing, anchor, profile, httpFetch);
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
// comes back lowercased too — the AVL key `hexToBytes` decodes, and the id the
// proof endpoint is asked with, are the listing's id in the one case it holds
// in the tree, never the node's own spelling of it.
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

// NODE_INTERFACE → AVL+ State Root — the proof blob is standard base64,
// decoded here with `atob`, a global in both browsers and Node 22. It throws
// on a character outside the alphabet or on a wrong length — caught here so a
// malformed blob from a lying node is a refused proof, `null`, never an
// exception out of the library.
function base64ToBytes(b64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
