import { computeContentHash } from '@dagsocial/types';

// The read surface's one use of cryptography: it recomputes a post body's
// commitment with @dagsocial/types and checks it against what the node served.
// It reaches computeContentHash through the build-time shim and imports it rather
// than copying it — the importing, not this check, is what keeps the read surface
// from being a further implementation of anything consensus-critical. This check
// is a use of the shared code, not the reason it is safe.
// WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim

/** Hex without a Node `Buffer`: the read surface holds no Node global. */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The body's 32-byte commitment as lowercase hex — computeContentHash(content). */
export function contentHashHex(content: string): string {
  return toHex(computeContentHash(content));
}

/**
 * Assert a rendered post's content matches the contentHash the node served,
 * displaying nothing. The read surface computes and asserts; surfacing a
 * mismatch is a design question left to the write surface, so the check is
 * silent on a match and reports only to the console otherwise.
 */
export function assertContentHash(id: string, content: string, servedContentHash: string): void {
  console.assert(
    contentHashHex(content) === servedContentHash,
    `post ${id}: content does not match its served contentHash`,
  );
}
