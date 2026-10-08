// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { withNodeWord } from '../src/model/light';
import { reconcileNewer, isLivePost } from '../src/model/feed-reconcile';
import { flattenThread } from '../src/model/thread';
import type { LightJson, PostJson } from '../src/api/dto';

// The light model: `withNodeWord` folds the full row's post identity with the
// light row's node word; `reconcileNewer` and `flattenThread` carry a slot
// through as a live row, by its id (WEB_INTERFACE → The extension → "The
// light read").

const ID = '00'.repeat(32);
const ID_2 = '11'.repeat(32);
const AUTHOR = '22'.repeat(32);
const CONTENT_HASH = '33'.repeat(32);
const TX_ID = '44'.repeat(32);

function full(over: Partial<PostJson> = {}): PostJson {
  return {
    id: ID, content: 'hello', contentHash: CONTENT_HASH, author: AUTHOR,
    parentRefs: [], protocolVersion: 1, type: 'regular', status: 'pending',
    blockHeight: null, blockIndex: null, blockCreatedAt: null,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
    txId: TX_ID, tx: 'ab'.repeat(64),
    ...over,
  };
}

function light(over: Partial<LightJson> = {}): LightJson {
  return {
    kind: 'light', id: ID, parentRefs: [], status: 'confirmed',
    blockHeight: 100, blockIndex: 1, blockCreatedAt: 1_700_000_000_000,
    likeCount: 5, descendantCount: 2, authorName: 'alice', likedByViewer: true,
    ...over,
  };
}

describe("withNodeWord — the full's identity under the light's node word, and no tx", () => {
  it('takes id, txId, content, contentHash, author, parentRefs, protocolVersion and type from the full row', () => {
    const f = full();
    const l = light();
    const out = withNodeWord(f, l);
    expect(out.id).toBe(f.id);
    expect(out.txId).toBe(f.txId);
    expect(out.content).toBe(f.content);
    expect(out.contentHash).toBe(f.contentHash);
    expect(out.author).toBe(f.author);
    expect(out.parentRefs).toBe(f.parentRefs);
    expect(out.protocolVersion).toBe(f.protocolVersion);
    expect(out.type).toBe(f.type);
  });

  it('takes status, blockHeight, blockIndex, blockCreatedAt, likeCount, descendantCount, authorName and likedByViewer from the light row', () => {
    const out = withNodeWord(full(), light());
    expect(out.status).toBe('confirmed');
    expect(out.blockHeight).toBe(100);
    expect(out.blockIndex).toBe(1);
    expect(out.blockCreatedAt).toBe(1_700_000_000_000);
    expect(out.likeCount).toBe(5);
    expect(out.descendantCount).toBe(2);
    expect(out.authorName).toBe('alice');
    expect(out.likedByViewer).toBe(true);
  });

  it('carries no tx — the transaction bytes were decoded into the row at the check', () => {
    const out = withNodeWord(full({ tx: 'ff'.repeat(32) }), light());
    expect(out.tx).toBeUndefined();
    expect('tx' in out).toBe(false);
  });
});

describe('reconcileNewer — a slot keeps its place in the feed, by its id', () => {
  it('isLivePost admits both a PostJson and a LightJson', () => {
    expect(isLivePost(full())).toBe(true);
    expect(isLivePost(light())).toBe(true);
  });

  it('collects a slot the held list does not have, and prepends it on reconnection', async () => {
    const held: Array<PostJson | LightJson> = [full({ id: ID_2 })];
    const slot = light();
    const r = await reconcileNewer(
      held,
      async () => ({ posts: [slot, full({ id: ID_2 })], next: null }),
      1,
    );
    expect(r.newCount).toBe(1);
    expect(r.posts[0]).toBe(slot);
    expect(r.posts[1]!.id).toBe(ID_2);
  });

  it('a slot already held is the reconnection — not re-collected', async () => {
    const slot = light();
    const held: Array<PostJson | LightJson> = [slot];
    const r = await reconcileNewer(
      held,
      async () => ({ posts: [slot], next: null }),
      1,
    );
    expect(r.newCount).toBe(0);
    expect(r.posts[0]).toBe(slot);
  });
});

describe('flattenThread — a slot stands at its parent\'s depth', () => {
  it('a slot descendant stands under its parent, at the parent\'s depth + 1', () => {
    const root = full({ id: ID, descendantCount: 1 });
    const reply = light({ id: ID_2, parentRefs: [ID], descendantCount: 0 });
    const nodes = flattenThread(root, [reply]);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.row).toBe(root);
    expect(nodes[0]!.depth).toBe(0);
    expect(nodes[1]!.row).toBe(reply);
    expect(nodes[1]!.depth).toBe(1);
  });

  it('a slot root carries at depth 0, with its own replyCount from descendantCount', () => {
    const root = light({ id: ID, descendantCount: 4 });
    const nodes = flattenThread(root, []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.row).toBe(root);
    expect(nodes[0]!.depth).toBe(0);
    expect(nodes[0]!.replyCount).toBe(4);
  });
});
