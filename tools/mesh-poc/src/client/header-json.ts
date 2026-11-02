// MESH_INTERFACE → The client's node list → "The client's chain" — the client
// reads a header out of `/blocks/:height`'s JSON (NODE_INTERFACE → HTTP API →
// "The `header` object in `/blocks/:height`'s response carries all eleven
// header fields"), converts `validatorId`'s hex to raw bytes, and holds the
// shape to `verifyHeaderFieldDomains`
// (VALIDATION_INTERFACE → verifyHeaderFieldDomains). The stub throws; the
// implementation lands with the client's held chain.

import type { BlockHeader } from '@dagsocial/types';

export function headerFromJson(_v: unknown): BlockHeader | null {
  throw new Error('header-json: not implemented');
}
