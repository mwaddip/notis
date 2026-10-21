import { membershipBar } from '@dagsocial/types';
import type { IdentityRecord } from '@dagsocial/types';
import { isMember, isRoot } from '@dagsocial/consensus';

/**
 * The invites still available to the identity whose record is `record`, under
 * a network of `memberCount` members and the ambient `multiplier`
 * (`ARCHITECTURE → The invite budget`): the single arithmetic
 * `⌊memberVouches / D(N)⌋ − invitesUsed` admission's bond gate
 * (MEMPOOL_INTERFACE → Correctness gates) and the invite service's named
 * refusals (NODE_INTERFACE → Invites) both read.
 *
 * A pure function of what it is handed. Each caller reads the identity record,
 * the network record and its multiplier from the source it owns — admission
 * from the store and `config.membershipBarMultiplier`, the service from its
 * `deps` — and the function answers over them, so no site holds a second copy
 * of the arithmetic.
 *
 * `'no-record'` where the key holds no identity record; `'root'` where it
 * holds a root (uncapped, `ARCHITECTURE → Roots`); `'none'` where it holds a
 * record that is neither a root nor a member; a `number` where it is a member.
 */
export type AvailableInvites = 'no-record' | 'root' | 'none' | number;

export function availableInvites(
  record: IdentityRecord | null,
  memberCount: number,
  multiplier: number,
): AvailableInvites {
  if (!record) return 'no-record';
  if (isRoot(record)) return 'root';
  if (!isMember(record)) return 'none';
  const d = membershipBar(memberCount, multiplier);
  return Math.floor(record.memberVouches / d) - record.invitesUsed;
}
