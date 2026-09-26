import { computeContentHash, bytesToHex } from '@dagsocial/types';

// The read surface's one use of cryptography: it recomputes a post body's
// commitment with @dagsocial/types and checks it against what the node served.
// It imports computeContentHash rather than copying it — the importing, not
// this check, is what keeps the read surface from being a further
// implementation of anything consensus-critical. This check is a use of the
// shared code, not the reason it is safe.
// WEB_INTERFACE → The client's builds substitute nothing

/** The body's 32-byte commitment as lowercase hex — computeContentHash(content). */
export function contentHashHex(content: string): string {
  return bytesToHex(computeContentHash(content));
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
