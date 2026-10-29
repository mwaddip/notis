// The mesh URL (`MESH_INTERFACE → The mesh URL`): `notis-mesh://<notisId><path>`, where
// `<notisId>` is 64 lowercase hex and `<path>` keeps its query. Any other scheme, any
// hex that is not 64 lowercase characters, and an empty path are refused.

export class MeshUrlError extends Error {
  override readonly name = 'MeshUrlError';
}

export function meshBaseUrl(_notisId: string): string {
  throw new Error('not implemented yet');
}

export function parseMeshUrl(_url: string): { notisId: string; path: string } {
  throw new Error('not implemented yet');
}
