import type { FeedRow, PostJson, Tombstone } from '../api/dto';
import { isTombstone } from '../api/dto';

// Build the render order of a thread from the flat descendants the API returns.
// Subtrees are laminar (one parent per post), so this is a plain tree walk.

export interface ThreadNode {
  row: FeedRow;
  depth: number;
  replyCount: number; // a PostJson row's own descendantCount; a withdrawn row's loaded subtree
}

function parentOf(row: FeedRow): string | undefined {
  // A withdrawn row keeps its parentRefs at withdrawal (NODE_INTERFACE → "The
  // JSON projection has a fourth arm where the store has three"), so it renders
  // at its own depth like any live row.
  return row.parentRefs[0];
}

/** Pre-order flatten of the root and its loaded descendants, with depth (capped
 *  in the view) and each node's reply count — a PostJson row's own descendantCount,
 *  a withdrawn row's loaded subtree. A descendant whose parent is not among the
 *  loaded rows attaches under the root, so nothing is dropped while a thread is
 *  still paging. */
export function flattenThread(root: PostJson | Tombstone, descendants: FeedRow[]): ThreadNode[] {
  const rootId = root.id;
  const known = new Set<string>([rootId]);
  for (const d of descendants) known.add(d.id);

  const children = new Map<string, FeedRow[]>();
  const push = (parent: string, row: FeedRow): void => {
    const list = children.get(parent);
    if (list) list.push(row);
    else children.set(parent, [row]);
  };
  for (const d of descendants) {
    const parent = parentOf(d);
    push(parent && known.has(parent) ? parent : rootId, d);
  }

  const out: ThreadNode[] = [];
  const subtreeSize = (id: string): number => {
    const kids = children.get(id);
    if (!kids) return 0;
    let n = kids.length;
    for (const k of kids) n += subtreeSize(k.id);
    return n;
  };
  const walk = (row: FeedRow | (PostJson | Tombstone), depth: number): void => {
    // A PostJson row carries the node's own descendantCount (the whole subtree,
    // pending included); a withdrawn row's shape has no count, so its loaded
    // subtree stands (WEB_INTERFACE → What the feed reads).
    const replyCount = isTombstone(row) ? subtreeSize(row.id) : row.descendantCount;
    out.push({ row: row as FeedRow, depth, replyCount });
    for (const kid of children.get(row.id) ?? []) walk(kid, depth + 1);
  };
  walk(root, 0);
  return out;
}
