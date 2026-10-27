import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  bytesToHex,
  computeTxId,
  profileFor,
} from '@dagsocial/types';
import type { AnyBox, IdentityRecord, KarmaBox } from '@dagsocial/types';
import { validateTx } from '@dagsocial/consensus';
import type { ApplyContext, UtxoEngineDeps, UtxoResult } from '@dagsocial/consensus';
import {
  FIXTURE_BOND_KARMA,
  applyContextFor,
  identityRecord,
  inviteTx,
  karmaBox,
  seededIdentity,
} from './helpers.js';

// NODE_INTERFACE → Bond transition rules → "Only a root or a member creates a
// bond, and a member's invites are a budget". The invite arm reads the
// inviter's identity record first, and reads the network record once for a
// member and never for a root, a non-member or a key with no record.

const PROFILE = profileFor('devnet');
const CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  decayCfg: {
    staleThresholdBlocks: 1_000_000,
    decayIntervalBlocks: 1,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  },
};
const H = 10;

const inviter = seededIdentity('invite-arm/inviter');
const invitee = seededIdentity('invite-arm/invitee').userId;

interface Recorded {
  identityReads: string[];
  networkReads: number;
}

function stubDeps(opts: {
  input: KarmaBox;
  inviterRecord: IdentityRecord | null;
  memberCount: number;
}): { deps: UtxoEngineDeps; log: Recorded } {
  const log: Recorded = { identityReads: [], networkReads: 0 };
  const live = new Map<string, AnyBox>([[opts.input.id!, opts.input]]);
  const unread = (name: string) =>
    (..._args: unknown[]): never => {
      throw new Error(`invite-arm case reads no ${name}`);
    };
  const deps: UtxoEngineDeps = {
    getBox: (id) => live.get(id) ?? null,
    insertBox: unread('insertBox'),
    consumeBox: unread('consumeBox'),
    getKarmaValue: () => opts.input.value,
    getKarmaOwed: () => 0n,
    getOwnKarmaBoxIds: () => [opts.input.id!],
    getIdentityRecord: (id) => {
      log.identityReads.push(bytesToHex(id));
      if (bytesToHex(id) === bytesToHex(invitee)) return null;
      if (bytesToHex(id) === bytesToHex(inviter.userId)) return opts.inviterRecord;
      return null;
    },
    hasActiveVouchEscrow: () => false,
    vouchCooldownBlocks: CTX.vouchCooldownBlocks,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => fn(),
    inviteBondMin: CTX.inviteBondMin,
    inviteBondMax: CTX.inviteBondMax,
    decayCfg: CTX.decayCfg,
    storageRentPeriodBlocks: CTX.storageRentPeriodBlocks,
    getBoxProvenance: (id) => {
      const b = live.get(id);
      return b ? { txId: b.txId, index: b.index } : null;
    },
    getVouchBox: () => null,
    getNetworkRecord: () => {
      log.networkReads++;
      return { memberCount: opts.memberCount };
    },
    membershipBarMultiplier: CTX.membershipBarMultiplier,
    putIdentityRecord: unread('putIdentityRecord'),
    protocolVersionSchedule: CTX.protocolVersionSchedule,
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
  return { deps, log };
}

function runInvite(inviterRecord: IdentityRecord | null, memberCount = 1): {
  result: UtxoResult;
  log: Recorded;
} {
  const input = karmaBox(inviter.userId, 500n, 0, H);
  const { deps, log } = stubDeps({ input, inviterRecord, memberCount });
  const tx = inviteTx(inviter, input, invitee, FIXTURE_BOND_KARMA, H);
  return { result: validateTx(deps, tx.tx, computeTxId(tx.tx), H), log };
}

describe('the invite arm reads the identity record first, and the network record only for a member', () => {
  it('a key with no record — refused as "Inviter holds no identity record", network not read', () => {
    const { result, log } = runInvite(null);
    expect(result).toEqual({ valid: false, error: `Inviter holds no identity record` });
    expect(log.identityReads).toEqual([bytesToHex(invitee), bytesToHex(inviter.userId)]);
    expect(log.networkReads).toBe(0);
  });

  it('a root — the invite-create arm passes, network not read', () => {
    const root = identityRecord({ memberSinceBlock: 1 });
    const { result, log } = runInvite(root);
    expect(result.valid).toBe(true);
    expect(log.identityReads).toEqual([bytesToHex(invitee), bytesToHex(inviter.userId)]);
    expect(log.networkReads).toBe(0);
  });

  it('a non-member resident — refused as "Only a root or a member may invite", network not read', () => {
    const resident = identityRecord({ memberSinceBlock: 0 });
    const { result, log } = runInvite(resident);
    expect(result).toEqual({ valid: false, error: `Only a root or a member may invite` });
    expect(log.identityReads).toEqual([bytesToHex(invitee), bytesToHex(inviter.userId)]);
    expect(log.networkReads).toBe(0);
  });

  it('a member with budget — the invite-create arm passes, network read once', () => {
    const member = identityRecord({
      memberSinceBlock: 1,
      memberBar: 1,
      memberVouches: 2,
      invitesUsed: 0,
    });
    const { result, log } = runInvite(member, 1);
    expect(result.valid).toBe(true);
    expect(log.identityReads).toEqual([bytesToHex(invitee), bytesToHex(inviter.userId)]);
    expect(log.networkReads).toBe(1);
  });

  it('a member without budget — refused, the refusal names vouches, D and used, network read once', () => {
    const member = identityRecord({
      memberSinceBlock: 1,
      memberBar: 1,
      memberVouches: 1,
      invitesUsed: 2,
    });
    const { result, log } = runInvite(member, 1);
    expect(result).toEqual({
      valid: false,
      error: `Inviter has no invites available (vouches: 1, D: 1, used: 2)`,
    });
    expect(log.identityReads).toEqual([bytesToHex(invitee), bytesToHex(inviter.userId)]);
    expect(log.networkReads).toBe(1);
  });
});
