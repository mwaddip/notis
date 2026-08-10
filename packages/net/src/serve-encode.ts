import { encodeOrderingBlock, encodeSubBlock } from '@dagsocial/types';
import type { OrderingBlock, SubBlock } from '@dagsocial/types';
import type { NetValidators } from './types.js';

// ---------------------------------------------------------------------------
// Serve-side encode boundary
//
// The mirror of `sync-codec.ts`'s decode boundary, on the side that faces our
// own store. A serve path answers a peer from a value `@dagsocial/node` handed
// across the package seam, and the positional writers that value reaches are
// not total: the fixed-width writers throw outside their domain and `writeVlqU`
// collides by sentinel instead (TYPES_INTERFACE → Totality). An annotation at
// the registration boundary says nothing about a runtime row.
//
// So the rule the decode boundary states holds here too — net's serve paths do
// not throw, they produce `null`, and the caller decides what a `null` means.
// It means our store, never the peer: nothing in this module penalizes anyone
// (NET_INTERFACE → Penalty Attribution).
//
// The verdict comes from the injected `NetValidators` because every other
// validation call in this package does (NET_INTERFACE → Validation
// Architecture); a second surface would let a stubbed test and production
// disagree about what a servable object is.
// ---------------------------------------------------------------------------

function encodeServable<T>(
  kind: string,
  value: unknown,
  verify: (candidate: T) => { valid: boolean; error?: string },
  encodeItem: (candidate: T) => Uint8Array,
  subject: string,
): Uint8Array | null {
  const candidate = value as T;

  const verdict = verify(candidate);
  if (!verdict.valid) {
    console.error(
      `[net] cannot serve ${kind} ${subject}: stored row is out of domain — ${verdict.error ?? 'structure invalid'}`,
    );
    return null;
  }

  try {
    return encodeItem(candidate);
  } catch (err) {
    // `verifyPostFieldDomains` stops at `timestamp`, so the verdict above never
    // reaches `post.powNonce` or `post.signature`, both of which `POST` writes
    // with writers that are not total. Until `@dagsocial/validation` pins them,
    // the throw becomes the same verdict rather than leaving the serve path.
    console.error(`[net] cannot serve ${kind} ${subject}: encode failed — ${String(err)}`);
    return null;
  }
}

/** Encode a stored sub-block for a peer, or `null` if this node cannot serve it. */
export function encodeServableSubBlock(
  value: unknown,
  validators: NetValidators,
  subject: string,
): Uint8Array | null {
  return encodeServable<SubBlock>(
    'sub-block',
    value,
    (sb) => validators.verifySubBlockStructure(sb),
    encodeSubBlock,
    subject,
  );
}

/** Encode a stored ordering block for a peer, or `null` if this node cannot serve it. */
export function encodeServableOrderingBlock(
  value: unknown,
  validators: NetValidators,
  subject: string,
): Uint8Array | null {
  return encodeServable<OrderingBlock>(
    'ordering block',
    value,
    (block) => validators.verifyOrderingBlockStructure(block),
    encodeOrderingBlock,
    subject,
  );
}
