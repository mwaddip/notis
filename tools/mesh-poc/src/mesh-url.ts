// The mesh URL (`MESH_INTERFACE → The mesh URL`): `notis-mesh://<notisId><path>`, where
// `<notisId>` is 64 lowercase hex and `<path>` keeps its query. Any other scheme, any
// hex that is not 64 lowercase characters, and an empty path are refused.
//
// WHATWG `URL` keeps the host in whatever case it was given for a non-special scheme,
// so the lowercase and length rules are enforced here, not by the parser.

export class MeshUrlError extends Error {
  override readonly name = 'MeshUrlError';
}

const NOTIS_ID_RE = /^[0-9a-f]{64}$/;
const SCHEME = 'notis-mesh://';

export function meshBaseUrl(notisId: string): string {
  if (!NOTIS_ID_RE.test(notisId)) {
    throw new MeshUrlError('notisId must be 64 lowercase hex characters');
  }
  return SCHEME + notisId;
}

export function parseMeshUrl(url: string): { notisId: string; path: string } {
  if (!url.startsWith(SCHEME)) {
    throw new MeshUrlError(`url must start with "${SCHEME}"`);
  }
  const rest = url.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    throw new MeshUrlError('url has no path');
  }
  const notisId = rest.slice(0, slash);
  if (!NOTIS_ID_RE.test(notisId)) {
    throw new MeshUrlError('notisId must be 64 lowercase hex characters');
  }
  // `path` is everything from the first `/` on, so its query rides with it.
  return { notisId, path: rest.slice(slash) };
}

/**
 * The notisId at the head of a mesh URL whose path may be absent.
 * `parseMeshUrl` is strict about the path (refuses an empty one), while
 * the node URLs `resolveTip` keeps in its answer are bases a mesh fetch
 * appends a path to and so may carry no path of their own. The key rule
 * — 64 lowercase hex characters — is the same.
 */
export function idOfMeshUrl(url: string): string {
  if (!url.startsWith(SCHEME)) {
    throw new MeshUrlError(`url must start with "${SCHEME}"`);
  }
  const rest = url.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  const id = slash === -1 ? rest : rest.slice(0, slash);
  if (!NOTIS_ID_RE.test(id)) {
    throw new MeshUrlError('notisId must be 64 lowercase hex characters');
  }
  return id;
}
