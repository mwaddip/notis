import type { FeedRow } from '../api/dto';

// Build the render order of a thread from the flat descendants the API returns.
// Subtrees are laminar (one parent per post), so this is a plain tree walk.
// A slot stands at the depth its `parentRefs` gives, as a full row does
// (WEB_INTERFACE → The extension → "Any other row stands as a slot").

export interface ThreadNode {
  row: FeedRow;
  depth: number;
  replyCount: number; // the row's own descendantCount (NODE_INTERFACE → Posts)
}

function parentOf(row: FeedRow): string | undefined {
  // A withdrawn row keeps its parentRefs at withdrawal (NODE_INTERFACE → "The
  // JSON projection has two arms where the store has one shape"), and a slot
  // carries them from the node's light row (NODE_INTERFACE → Posts → "A light
  // row is a post's id and the node's word"), so a slot renders at its own
  // depth like any live row.
  return row.parentRefs[0];
}

/** Pre-order flatten of the root and its loaded descendants, with depth (capped
 *  in the view) and each node's own descendantCount. A descendant whose parent is
 *  not among the loaded rows attaches under the root, so nothing is dropped while
 *  a thread is still paging. */
export function flattenThread(root: FeedRow, descendants: FeedRow[]): ThreadNode[] {
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
  const walk = (row: FeedRow, depth: number): void => {
    out.push({ row, depth, replyCount: row.descendantCount });
    for (const kid of children.get(row.id) ?? []) walk(kid, depth + 1);
  };
  walk(root, 0);
  return out;
}
