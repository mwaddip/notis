import { describe, it, expect } from 'vitest';
import { flattenThread } from '../src/model/thread';
import type { PostJson, WithdrawnJson, FeedRow } from '../src/api/dto';

// flattenThread walks the loaded rows into render order and depth. A withdrawn row
// keeps its parentRefs at withdrawal (NODE_INTERFACE → "The JSON projection has
// two arms where the store has one shape"), so it renders at its own depth rather
// than collapsing under the root.

const ROOT = 'a'.repeat(64);
const REPLY = 'b'.repeat(64);
const GRANDCHILD = 'c'.repeat(64);

function post(id: string, parent: string | null, descendantCount = 0): PostJson {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: 'aa'.repeat(32),
    parentRefs: parent ? [parent] : [], protocolVersion: 1, type: 'regular',
    status: 'confirmed', blockHeight: 10, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount, authorName: null, likedByViewer: null,
  };
}
function withdrawn(id: string, parent: string, descendantCount = 0): WithdrawnJson {
  return { kind: 'withdrawn', id, author: 'aa'.repeat(32), withdrawnAtHeight: 12, parentRefs: [parent], descendantCount, authorName: null };
}

describe('flattenThread — a withdrawn row keeps its depth', () => {
  it('a withdrawn reply renders at its parent depth + 1, its own reply beneath it', () => {
    const root = post(ROOT, null);
    const descendants: FeedRow[] = [withdrawn(REPLY, ROOT, 4), post(GRANDCHILD, REPLY)];
    const nodes = flattenThread(root, descendants);
    const byId = new Map(nodes.map((n) => [n.row.id, n]));
    expect(byId.get(ROOT)!.depth).toBe(0);
    expect(byId.get(REPLY)!.depth).toBe(1);
    // The grandchild hangs off the withdrawn reply, not re-parented to the root.
    expect(byId.get(GRANDCHILD)!.depth).toBe(2);
    // The withdrawn reply's own descendantCount, not the one loaded child.
    expect(byId.get(REPLY)!.replyCount).toBe(4);
  });

  it('a withdrawn root renders at depth 0 with its replies beneath it', () => {
    const root: WithdrawnJson = withdrawn(ROOT, ROOT); // a root's parentRefs are empty on the wire; the root anchor is its id
    const withEmptyRefs: WithdrawnJson = { ...root, parentRefs: [] };
    const descendants: FeedRow[] = [post(REPLY, ROOT)];
    const nodes = flattenThread(withEmptyRefs, descendants);
    const byId = new Map(nodes.map((n) => [n.row.id, n]));
    expect(byId.get(ROOT)!.depth).toBe(0);
    expect(byId.get(REPLY)!.depth).toBe(1);
  });
});

describe('flattenThread — the reply count is the row\'s', () => {
  it('every row shows its own descendantCount — a live reply\'s, a withdrawn row\'s, the root\'s the thread\'s', () => {
    const WD = 'd'.repeat(64);   // a withdrawn reply
    const LEAF = 'e'.repeat(64); // its loaded child — not what replyCount reads
    const root = post(ROOT, null, 5);              // the root: the thread's own number
    const liveReply = post(REPLY, ROOT, 3);         // a live reply the node counts 3, none loaded here
    const withdrawnReply = withdrawn(WD, ROOT, 9);  // the node's own count, not the one loaded child
    const nodes = flattenThread(root, [liveReply, withdrawnReply, post(LEAF, WD)]);
    const byId = new Map(nodes.map((n) => [n.row.id, n]));
    expect(byId.get(ROOT)!.replyCount).toBe(5);
    expect(byId.get(REPLY)!.replyCount).toBe(3);
    expect(byId.get(WD)!.replyCount).toBe(9); // the row's own count, not the loaded subtree of 1
  });
});
