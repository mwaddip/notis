import type { PostJson, LightJson } from '../api/dto';

// Fold the node's light word for a post into a full row the resolve has
// bound — WEB_INTERFACE → The extension → "The light read" → "A row the cache
// holds is a card at once". The full row's post identity (id, txId, content,
// contentHash, author, parentRefs, protocolVersion, type) is the resolve's
// answer; the light row carries the node's word on it — status, block position
// and time, counts, name and `likedByViewer`. `tx` is not carried: a cache
// entry's transaction bytes are held once in `txBytes`, and the row beside
// them restates no hex (WEB_INTERFACE → The extension → "An entry").

/** `full`'s id, txId, content, contentHash, author, parentRefs, protocolVersion
 *  and type under `light`'s status, blockHeight, blockIndex, blockCreatedAt,
 *  likeCount, descendantCount, authorName and likedByViewer; no `tx`. */
export function withNodeWord(full: PostJson, light: LightJson): PostJson {
  return {
    id: full.id,
    txId: full.txId,
    content: full.content,
    contentHash: full.contentHash,
    author: full.author,
    parentRefs: full.parentRefs,
    protocolVersion: full.protocolVersion,
    type: full.type,
    status: light.status,
    blockHeight: light.blockHeight,
    blockIndex: light.blockIndex,
    blockCreatedAt: light.blockCreatedAt,
    likeCount: light.likeCount,
    descendantCount: light.descendantCount,
    authorName: light.authorName,
    likedByViewer: light.likedByViewer,
  };
}
