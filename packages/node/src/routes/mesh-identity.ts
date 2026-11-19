import { Router } from 'express';
import type { MeshIdentity } from '@dagsocial/net';

// NODE_INTERFACE → Mesh identity
export interface MeshIdentityDeps {
  meshIdentity(): MeshIdentity | null;
}

// GET /mesh/identity — NODE_INTERFACE → Mesh identity → "A mesh node
// answers its identity": the identity line's four fields in order,
// read from `net` at the request, so an address that changed answers
// changed; 404 on a node that runs no mesh or before its mesh has
// started.
export function createRouter(deps: MeshIdentityDeps): Router {
  const router = Router();

  router.get('/mesh/identity', (_req, res) => {
    const id = deps.meshIdentity();
    if (id === null) {
      res.status(404).json({ error: 'mesh not running' });
      return;
    }
    res.json({
      notisId: id.notisId,
      peerId: id.peerId,
      multiaddrs: id.multiaddrs,
      localAddrs: id.localAddrs,
    });
  });

  return router;
}
