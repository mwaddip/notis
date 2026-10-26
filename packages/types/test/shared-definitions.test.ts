/**
 * The definitions other packages build on, read through the barrel:
 * `EMPTY_IDENTITY_RECORD`, `isBytes`, `isHex64` and `ED25519_PKCS8_PREFIX`
 * (TYPES_INTERFACE → Identity record and karma valuation; Export table;
 * Mempool and encoding).
 */

import { describe, it, expect } from 'vitest';
import {
  EMPTY_IDENTITY_RECORD,
  ED25519_PKCS8_PREFIX,
  bytesToHex,
  effectiveKarma,
  generateKeyPair,
  identityRecordBytes,
  isBytes,
  isHex64,
  decayCfgFor,
  profileFor,
} from '../src/index.js';
import type { IdentityRecord } from '../src/index.js';

describe('EMPTY_IDENTITY_RECORD', () => {
  it('is a record of zeros, field by field', () => {
    expect(EMPTY_IDENTITY_RECORD.lastActivityBlock).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.lastDecayBlock).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.invitedAtBlock).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.lifetimeLikesReceived).toBe(0n);
    expect(EMPTY_IDENTITY_RECORD.memberSinceBlock).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.memberBar).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.memberVouches).toBe(0);
    expect(EMPTY_IDENTITY_RECORD.memberLikes).toBe(0n);
    expect(EMPTY_IDENTITY_RECORD.invitesUsed).toBe(0);
    expect(Object.keys(EMPTY_IDENTITY_RECORD)).toEqual([
      'lastActivityBlock',
      'lastDecayBlock',
      'invitedAtBlock',
      'lifetimeLikesReceived',
      'memberSinceBlock',
      'memberBar',
      'memberVouches',
      'memberLikes',
      'invitesUsed',
    ]);
  });

  it('is frozen', () => {
    expect(typeof EMPTY_IDENTITY_RECORD).toBe('object');
    expect(Object.isFrozen(EMPTY_IDENTITY_RECORD)).toBe(true);
  });

  it('encodes as the hand-written record of zeros does', () => {
    const zeros: IdentityRecord = {
      lastActivityBlock: 0,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    };
    expect(bytesToHex(identityRecordBytes(EMPTY_IDENTITY_RECORD))).toBe(
      bytesToHex(identityRecordBytes(zeros)),
    );
  });

  it('is the record effectiveKarma values a null record as', () => {
    const cfg = decayCfgFor(profileFor('devnet'));
    const height = cfg.staleThresholdBlocks + 1000 * cfg.decayIntervalBlocks;
    expect(EMPTY_IDENTITY_RECORD.lastActivityBlock).toBe(0);
    expect(effectiveKarma(100n, null, height, cfg)).toBe(
      effectiveKarma(100n, EMPTY_IDENTITY_RECORD, height, cfg),
    );
    expect(effectiveKarma(100n, null, height, cfg)).toBe(cfg.karmaMinimum);
  });
});

describe('isHex64', () => {
  const ok = 'ab01'.repeat(16);

  it('accepts 64 lowercase hex characters', () => {
    expect(ok).toHaveLength(64);
    expect(isHex64(ok)).toBe(true);
  });

  it('refuses 63 and 65 characters', () => {
    expect(isHex64(ok.slice(1))).toBe(false);
    expect(isHex64(ok + '0')).toBe(false);
  });

  it('refuses an uppercase letter', () => {
    expect(isHex64('A' + ok.slice(1))).toBe(false);
  });

  it('refuses a non-hex letter', () => {
    expect(isHex64('g' + ok.slice(1))).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(isHex64(undefined)).toBe(false);
    expect(isHex64(null)).toBe(false);
    expect(isHex64(1n)).toBe(false);
    expect(isHex64(new Uint8Array(32))).toBe(false);
  });
});

describe('isBytes', () => {
  it('accepts a Uint8Array', () => {
    expect(isBytes(new Uint8Array(32))).toBe(true);
  });

  it('refuses a Uint32Array, an array and a DataView', () => {
    expect(isBytes(new Uint32Array(8))).toBe(false);
    expect(isBytes([1, 2, 3])).toBe(false);
    expect(isBytes(new DataView(new ArrayBuffer(8)))).toBe(false);
  });
});

describe('ED25519_PKCS8_PREFIX', () => {
  it("is what generateKeyPair's secretKey starts with", () => {
    const { secretKey } = generateKeyPair();
    expect(bytesToHex(secretKey.subarray(0, ED25519_PKCS8_PREFIX.length / 2))).toBe(
      ED25519_PKCS8_PREFIX,
    );
  });
});
