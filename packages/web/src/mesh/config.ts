// MESH_INTERFACE → Transports / Discovery — a start-time refusal shared by
// the mesh node and the mesh client: a `/dns4/`, `/dns6/` or `/dnsaddr/`
// component in any address the member is given. Browser-safe
// (`MESH_INTERFACE → Place in the workspace`): pure, no `node:` import, so
// `src/lib.ts` can reach it from the client side.

export class MeshConfigError extends Error {
  override readonly name = 'MeshConfigError';
}

const DNS_RE = /\/dns4\/|\/dns6\/|\/dnsaddr\//;

/**
 * MESH_INTERFACE → Transports / Discovery — refuse an address with a DNS
 * component. `label` names the setting the address came from, so the
 * message points at the operator's input.
 */
export function assertNoDns(label: string, addrs: readonly string[]): void {
  for (const a of addrs) {
    if (DNS_RE.test(a)) {
      throw new MeshConfigError(`${label} address refused: ${a} carries a DNS component`);
    }
  }
}

/**
 * MESH_INTERFACE → The client's node list → "An entry may carry an API base"
 * — the api is an `http:` or `https:` base with no trailing `/`. Anything
 * else is refused; the message names the setting so the operator sees what
 * their input broke.
 */
export function assertApiBase(label: string, api: string): void {
  const isHttp = api.startsWith('http://') || api.startsWith('https://');
  if (!isHttp) {
    throw new MeshConfigError(
      `${label} api refused: ${api} must start with http:// or https://`,
    );
  }
  if (api.endsWith('/')) {
    throw new MeshConfigError(
      `${label} api refused: ${api} must have no trailing '/'`,
    );
  }
}
