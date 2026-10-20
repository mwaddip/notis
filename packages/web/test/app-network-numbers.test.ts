// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { profileFor } from '@dagsocial/types';
import { networkNumbers } from '../src/model/network-numbers';
import { submitUnvouchFlow } from '../src/wallet/submit';
import { PendingLedger } from '../src/wallet/ledger';
import type { StatusResult } from '../src/api/dto';

// The App answers the four — `inviteBondMin`, `inviteBondMax`,
// `vouchCooldownBlocks`, `inviteProbationBlocks` — from one place
// (WEB_INTERFACE → Invariants → "A per-network number is read, never assumed"):
// where the build names its network the caller hands `networkNumbers` that
// network and the profile answers it, where it names none the caller hands
// null and `/status` answers it. The App passes `BUILD_NETWORK` and submit
// flows pass `deps.network`, so no reader of those numbers takes `/status`'s
// field directly in a build that names its network.

function statusOf(over: Partial<StatusResult> = {}): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 10, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0',
    inviteProbationBlocks: 1, vouchCooldownBlocks: 1,
    inviteBondMin: '99999', inviteBondMax: '99999',
    membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
    ...over,
  };
}

describe('the four network numbers — one place', () => {
  it('a build that names its network reads the profile, never `/status`', () => {
    const p = profileFor('testnet');
    const nn = networkNumbers('testnet', statusOf({ inviteBondMin: '99999', vouchCooldownBlocks: 7, inviteProbationBlocks: 9, inviteBondMax: '42' }));
    expect(nn).not.toBeNull();
    expect(nn!.inviteBondMin).toBe(p.inviteBondMin.toString());
    expect(nn!.inviteBondMax).toBe(p.inviteBondMax.toString());
    expect(nn!.vouchCooldownBlocks).toBe(p.vouchCooldownBlocks);
    expect(nn!.inviteProbationBlocks).toBe(p.inviteProbationBlocks);
  });

  it('a build that names no network reads `/status`', () => {
    const nn = networkNumbers(null, statusOf());
    expect(nn).not.toBeNull();
    expect(nn!.inviteBondMin).toBe('99999');
    expect(nn!.inviteBondMax).toBe('99999');
    expect(nn!.vouchCooldownBlocks).toBe(1);
    expect(nn!.inviteProbationBlocks).toBe(1);
  });

  it('a build that names no network and holds no `/status` yet reads null', () => {
    expect(networkNumbers(null, null)).toBeNull();
  });
});

describe('the unvouch flow — cooldown comes from the one place', () => {
  it('an unvouch built in a build that names its network releases at the profile\'s cooldown whatever `/status` answers', async () => {
    const PUB = 'aa'.repeat(32);
    const TARGET = '22'.repeat(32);
    const VOUCH_BOX = '44'.repeat(32);
    const SIG = 'cc'.repeat(64);
    const CREATED_AT = 5;

    const ledger = new PendingLedger(PUB);
    let seenTx: Record<string, unknown> | undefined;

    const deps: Parameters<typeof submitUnvouchFlow>[0] = {
      reads: {
        karma: async () => ({ userId: PUB, total: '0', effective: '0', boxes: [], boxCount: 0, next: null, lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0', memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0', invitesUsed: 0, member: true, invitesAvailable: 2, height: 10 }),
        credits: async () => ({ userId: PUB, total: '0', boxes: [], boxCount: 0, next: null }),
        status: async () => statusOf({ vouchCooldownBlocks: 99999 }),
        post: async () => null,
        vouchesByVoucher: async () => ({ vouches: [{ boxId: VOUCH_BOX, value: '1', createdAtBlock: CREATED_AT, voucherId: PUB, targetId: TARGET, voucherName: null, targetName: null }], count: 1, next: null }),
        usernameByOwner: async () => null,
      },
      write: {
        submitUnvouch: async (_t: string, tx: Record<string, unknown>) => {
          seenTx = tx;
          return { status: 'pending', txId: 'ff'.repeat(32), expiresAtHeight: 1000 };
        },
      } as unknown as Parameters<typeof submitUnvouchFlow>[0]['write'],
      ledger,
      identity: {
        current: () => ({ pubKeyHex: PUB }),
        sign: async () => ({ signature: SIG } as const),
      },
      network: 'testnet',
    };

    await submitUnvouchFlow(deps, TARGET);
    const expected = profileFor('testnet').vouchCooldownBlocks;
    const outputs = seenTx?.['outputs'] as Array<Record<string, unknown>> | undefined;
    const escrow = outputs?.find((o) => o['boxType'] === 'vouch_escrow');
    expect(escrow?.['releaseAtBlock']).toBe(CREATED_AT + expected);
  });
});
