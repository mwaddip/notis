import type { KarmaResult } from '../src/api/dto';

// The empty-page KarmaResult (NODE_INTERFACE → UTXO queries) with overrides — one
// place every field of the shape lands, so a new field is added here and nowhere
// else across the fixtures. The defaults are the no-record shape: no boxes, "0"
// totals and counters, zeroed clocks, not a member, no invites.
export function karmaResult(overrides: Partial<KarmaResult> = {}): KarmaResult {
  return {
    userId: '00'.repeat(32),
    total: '0',
    effective: '0',
    boxes: [],
    boxCount: 0,
    next: null,
    lastActivityBlock: 0,
    lastDecayBlock: 0,
    lifetimeLikesReceived: '0',
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: '0',
    invitesUsed: 0,
    member: false,
    invitesAvailable: 0,
    height: 0,
    ...overrides,
  };
}
