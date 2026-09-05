// The DTOs the read surface consumes. Declared here, against NODE_INTERFACE —
// `@dagsocial/web` depends on no other workspace package (the node carries
// better-sqlite3 and an Express server). These shapes mirror
// `packages/node/src/services/feed-service.ts` and the route wrappers over it,
// measured at 207e1c9.
//
// The demo UI and tools/e2e hand-declare the same shapes; there is no shared
// DTO module in the tree.

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
  /** Always null on the read surface: it sends no viewer parameter. */
  likedByViewer: boolean | null;
}

export interface StumpJson {
  kind: 'stump';
  id: string;                     // the rootPostHash
  author: string;                 // hex
  replyCount: number;
  upvoteCount: number;
  protocolVersion: number;
  compactedAtBlockHeight: number;
}

export interface PrunedJson {
  kind: 'pruned';
  id: string;
  author: string;                 // hex
  rootPostHash: string;
  compactedAtBlockHeight: number;
}

export interface WithdrawnJson {
  kind: 'withdrawn';
  id: string;
  author: string;                 // hex
  withdrawnAtHeight: number;
  parentRefs: string[];           // hex ids — kept at withdrawal (NODE_INTERFACE → Pruning)
}

/** The absence states the API can hand back where a post is expected. */
export type Tombstone = StumpJson | PrunedJson | WithdrawnJson;

/** A feed or descendant row: a live post or a withdrawn marker. */
export type FeedRow = PostJson | WithdrawnJson;

export interface FeedResult {
  posts: FeedRow[];
  next: string | null;            // a formatted keyset key, or null at the end
  pending: FeedRow[];
  pendingCount: number;
}

/** `GET /posts/:id` — a post, a tombstone, plus the topology-confirmed author. */
export type PostResult = (PostJson | Tombstone) & { confirmedAuthor: string | null };

export interface ThreadResult {
  post: PostJson | Tombstone | null;
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
 *  after the boxes. The membership and decay fields are the profile window's
 *  standing row; the node derives every predicate and the client evaluates none
 *  of it (NODE_INTERFACE → UTXO queries). */
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
  vouches: { voucherId: string; targetId: string }[];
  count: number;
  next: string | null;
}

/** `GET /vouches?voucher=<key>` — the reader's own vouches, the one arm carrying
 *  `boxId` and `value`, so an unvouch can name the box it spends. */
export interface VouchesVoucherResult {
  vouches: { boxId: string; value: string; createdAtBlock: number; voucherId: string; targetId: string }[];
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
  bonds: { id: string; value: string; inviterId: string; inviteePublicKey: string }[];
  bondCount: number;
  next: string | null;
}

// ---------------------------------------------------------------------------
// Discriminators — PostJson carries no `kind`; every tombstone does.
// ---------------------------------------------------------------------------

export function isTombstone(row: PostJson | Tombstone): row is Tombstone {
  return 'kind' in row;
}

export function isWithdrawn(row: FeedRow): row is WithdrawnJson {
  return 'kind' in row;
}
