// The DTOs the read surface consumes. Declared here, against NODE_INTERFACE —
// `@dagsocial/web` depends on no other workspace package (the node carries
// better-sqlite3 and an Express server). These shapes mirror
// `packages/node/src/services/feed-service.ts` and the route wrappers over it,
// measured at 207e1c9.
//
// No shared DTO module exists in the tree.

/** `PostStatus` on the node — 'pending' is a mempool post, 'confirmed' is in a block. */
export type PostStatus = 'pending' | 'confirmed';
export type PostType = 'regular' | 'profile';

export interface PostJson {
  id: string;
  /** null when the node holds the post by commit but has not backfilled its body. */
  content: string | null;
  contentHash: string;
  author: string;                 // hex
  parentRefs: string[];           // 0–1 parent post ids
  protocolVersion: number;
  type: PostType;
  status: PostStatus;
  blockHeight: number | null;     // null while pending
  blockIndex: number | null;
  blockCreatedAt: number | null;
  likeCount: number;
  /** The whole subtree's size, pending included — a `PostJson` row carries the same
   *  number a thread on it answers (NODE_INTERFACE → Posts). */
  descendantCount: number;
  /** The author's username as typed, or null (NODE_INTERFACE → Posts). */
  authorName: string | null;
  /** Always null on the read surface: it sends no viewer parameter. */
  likedByViewer: boolean | null;
  /** The row's creating transaction id, 64-hex (NODE_INTERFACE → Posts →
   *  "The creating transaction rides a post row"). */
  txId: string;
  /** The transaction's bytes, lowercase hex, present on a `tx=1` read; null
   *  where the node holds the row but no bytes for it; undefined where the
   *  read did not ask for the transaction (WEB_INTERFACE → The extension →
   *  "The post check"). */
  tx?: string | null;
}

export interface WithdrawnJson {
  kind: 'withdrawn';
  id: string;
  author: string;                 // hex
  withdrawnAtHeight: number;
  parentRefs: string[];           // hex ids — kept at withdrawal (NODE_INTERFACE → "The JSON projection has two arms where the store has one shape")
  /** The whole subtree's size, pending included — the same definition
   *  `PostJson.descendantCount` carries (NODE_INTERFACE → Posts). */
  descendantCount: number;
  /** The author's username as typed, or null (NODE_INTERFACE → Posts). */
  authorName: string | null;
  /** The row's creating transaction id, 64-hex (NODE_INTERFACE → Posts →
   *  "The creating transaction rides a post row"). */
  txId: string;
}

/** A light row: the post's id and the node's word (NODE_INTERFACE → Posts →
 *  "A light row is a post's id and the node's word", WEB_INTERFACE → The
 *  extension → "The light read"). Every field is `PostJson`'s under the same
 *  definition; a light row carries no `txId`, `tx`, `content`, `contentHash`,
 *  `author`, `protocolVersion` or `type` — what the post's creating transaction
 *  fixes under its id, which a reader that holds the post has and one that
 *  lacks it reads by id ("The resolve"). */
export interface LightJson {
  kind: 'light';
  id: string;
  parentRefs: string[];           // 0–1 — where a reader that lacks the post places its row
  status: PostStatus;
  blockHeight: number | null;
  blockIndex: number | null;
  blockCreatedAt: number | null;
  likeCount: number;
  descendantCount: number;
  authorName: string | null;
  likedByViewer: boolean | null;
}

/** A feed or descendant row: a live post, a withdrawn marker, or a light row —
 *  the row a reader that lacks the post holds against its id (WEB_INTERFACE →
 *  The extension → "The light read"). */
export type FeedRow = PostJson | WithdrawnJson | LightJson;

export interface FeedResult {
  posts: FeedRow[];
  next: string | null;            // a formatted keyset key, or null at the end
  pending: FeedRow[];
  pendingCount: number;
}

/** `GET /posts/:id` — a post or the withdrawn marker, plus the topology-confirmed
 *  author. `GET /posts/:id` takes no `light`, so this read never answers a light
 *  row (NODE_INTERFACE → Posts → "A light row is a post's id and the node's
 *  word"). */
export type PostResult = (PostJson | WithdrawnJson) & { confirmedAuthor: string | null };

export interface ThreadResult {
  /** Under `light=1` the subject is a `LightJson` where a reader lacks the
   *  post (WEB_INTERFACE → The extension → "The light read"). */
  post: FeedRow | null;
  ancestors: FeedRow[];
  ancestorCount: number;
  descendants: FeedRow[];
  descendantCount: number;
  next: string | null;
  pending: FeedRow[];
  pendingCount: number;
}

export interface StatusResult {
  networkType: string;
  blockHeight: number;
  protocolVersion: number;
  postCount: number;
  pendingPosts: number;
  totalKarma: string;
  liquidKarma: string;
  totalCredits: string;
  inviteProbationBlocks: number;
  vouchCooldownBlocks: number;
  inviteBondMin: string;
  inviteBondMax: string;
  membership: { memberCount: number; memberBar: number; memberLikesBar: number };
}

export interface BlockCurrent {
  height: number;
  hash: string | null;
}

export interface KarmaBoxRow {
  boxId: string;
  value: string;                  // decimal — the client holds it as bigint
}

/** `GET /karma/:userId` — the spendable view's confirmed boxes, paged by `next`.
 *  A box row carries no `createdAtBlock`, which is why the wallet reads `/status`
 *  after the boxes. `member` is the node's derived predicate the vouch gate reads;
 *  `invitesAvailable` distinguishes root (`null`) from member (`≥0`) for the
 *  invites row's line; every other membership and decay field is the node's own
 *  bookkeeping (NODE_INTERFACE → UTXO queries). */
export interface KarmaResult {
  userId: string;
  total: string;
  effective: string;
  boxes: KarmaBoxRow[];
  boxCount: number;
  next: string | null;            // a formatted box key, or null at the end
  lastActivityBlock: number;      // the record's clocks — 0 where no record exists
  lastDecayBlock: number;
  lifetimeLikesReceived: string;  // decimal string — the record's counter, "0" where none
  memberSinceBlock: number;
  memberBar: number;
  memberVouches: number;
  memberLikes: string;            // decimal string — the record's second counter
  invitesUsed: number;
  member: boolean;                // the node's derived predicate
  invitesAvailable: number | null; // 0 for a resident, null for a root
  height: number;
}

// ---------------------------------------------------------------------------
// The membership reads (NODE_INTERFACE → Vouches, → UTXO queries). Every list is
// keyset-paged: a `next` key or null. Values cross as decimal strings, keys as
// hex. None is viewer-bearing.
// ---------------------------------------------------------------------------

/** `GET /vouches?target=<key>` — who vouches for this identity, and the count over
 *  the whole set whatever the page size (NODE_INTERFACE → Vouches). */
export interface VouchesTargetResult {
  vouches: { voucherId: string; targetId: string; voucherName: string | null; targetName: string | null }[];
  count: number;
  next: string | null;
}

/** `GET /vouches?voucher=<key>` — the reader's own vouches, the one arm carrying
 *  `boxId` and `value`, so an unvouch can name the box it spends. */
export interface VouchesVoucherResult {
  vouches: { boxId: string; value: string; createdAtBlock: number; voucherId: string; targetId: string; voucherName: string | null; targetName: string | null }[];
  count: number;
  next: string | null;
}

/** `GET /vouches?voucher=<key>&cooldowns=1` — the reader's unspent escrows, the
 *  escrow gate (NODE_INTERFACE → Vouch escrows). */
export interface VouchCooldownsResult {
  cooldowns: { boxId: string; value: string; releaseAtBlock: number }[];
  count: number;
  next: string | null;
}

/** `GET /invites/<key>` — the inviter's standing bonds (NODE_INTERFACE → UTXO
 *  queries). No settle height: no view serves one. */
export interface BondsResult {
  bonds: { id: string; value: string; inviterId: string; inviteePublicKey: string; inviterName: string | null; inviteeName: string | null }[];
  bondCount: number;
  next: string | null;
}

/** `GET /usernames?owner=<key>` — the owner's held name, or 404 when none
 *  (NODE_INTERFACE → Usernames). The same shape answers `GET /usernames/:name`,
 *  the handle → holder resolution the send form runs at the press. */
export interface UsernameResult {
  name: string;
  owner: string;
  boxId: string;
  claimedAtBlock: number;
}

/** `GET /credits/:userId` — an unspent credit box (NODE_INTERFACE → UTXO
 *  queries). `lockedUntilBlock` is present only on boxes the coinbase minted
 *  locked (TYPES_INTERFACE → CreditBox). */
export interface CreditBoxRow {
  boxId: string;
  value: string;                  // decimal — the client holds it as bigint
  lockedUntilBlock?: number;
}

/** `GET /credits/:userId` — the identity's credit boxes, paged by `next`
 *  (NODE_INTERFACE → UTXO queries). An identity with no unspent credit box
 *  answers the empty page — `boxes: []`, `boxCount 0`, `total "0"`, `next
 *  null`. */
export interface CreditsResult {
  userId: string;
  total: string;
  boxes: CreditBoxRow[];
  boxCount: number;
  next: string | null;
}

// ---------------------------------------------------------------------------
// Discriminators — a FeedRow is one of three arms: a full post (no `kind`), a
// withdrawn marker (`'withdrawn'`) or a light row (`'light'`). Every site that
// reads a row answers each of the three.
// ---------------------------------------------------------------------------

export function isWithdrawn(row: FeedRow): row is WithdrawnJson {
  return 'kind' in row && row.kind === 'withdrawn';
}

export function isLight(row: FeedRow): row is LightJson {
  return 'kind' in row && row.kind === 'light';
}

export function isFull(row: FeedRow): row is PostJson {
  return !('kind' in row);
}
