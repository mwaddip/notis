// MESH_INTERFACE → The mesh URL — the browser half is `@dagsocial/net/browser`'s;
// this file is a re-export so callers that have not yet moved to it compile
// against the one implementation (`MESH_INTERFACE → Place in the workspace`).

export { MeshUrlError, meshBaseUrl, parseMeshUrl, idOfMeshUrl } from '@dagsocial/net/browser';
