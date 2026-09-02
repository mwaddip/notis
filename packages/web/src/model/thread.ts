import type { FeedRow, PostJson, Tombstone } from '../api/dto';
import { isWithdrawn } from '../api/dto';

// Build the render order of a thread from the flat descendants the API returns.
// Subtrees are laminar (one parent per post), so this is a plain tree walk.

export interface ThreadNode {
  row: FeedRow;
  depth: number;
  replyCount: number; // size of this node's own subtree, among loaded rows
}

function parentOf(row: FeedRow): string | undefined {
  // A withdrawn row carries no parentRefs in its DTO (only kind/id/author/
  // withdrawnAtHeight), so its true parent is not linkable here — it falls under
  // the root. Recorded as a node-side gap (its exact depth cannot be rebuilt).
  if (isWithdrawn(row)) return undefined;
  return row.parentRefs[0];
}

/** Pre-order flatten of the root and its loaded descendants, with depth (capped
 *  in the view) and each node's loaded-subtree size. A descendant whose parent
 *  is not among the loaded rows attaches under the root, so nothing is dropped
 *  while a thread is still paging. */
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
    out.push({ row: row as FeedRow, depth, replyCount: subtreeSize(row.id) });
    for (const kid of children.get(row.id) ?? []) walk(kid, depth + 1);
  };
  walk(root, 0);
  return out;
}
