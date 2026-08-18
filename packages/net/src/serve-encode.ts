import { encodeOrderingBlock } from '@dagsocial/types';
import type { OrderingBlock } from '@dagsocial/types';
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
    // Depth behind the verdict, not a second one. The fixed-width writers throw
    // outside their domain (TYPES_INTERFACE → Totality), and this module's rule
    // is that a serve path produces `null` rather than leaving by exception —
    // which has to hold whatever the verdict above happens to cover, since the
    // two are stated in different packages and move independently. The throw
    // becomes the same verdict rather than leaving the serve path.
    console.error(`[net] cannot serve ${kind} ${subject}: encode failed — ${String(err)}`);
    return null;
  }
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
