import { describe, it, expect } from 'vitest';
import { serializeBox, deserializeBox, deserializeBoxWithId } from '../../src/state/serialize-box.js';
import { seedProvenance } from '../helpers.js';
import type { AnyBox, KarmaBox, CreditBox, InviteBox, BondBox, PostLockBox } from '@dagsocial/types';

/**
 * Every fixture below is a GENUINE box: `seedProvenance` gives it real
 * `txId`/`index` and an `id` that derives from them, so `computeBoxId(box) ===
 * box.id` holds. Before, they carried a hand-written `id` — several of them not
 * even hex (`'gh'.repeat(32)`) — and no provenance at all, which meant the
 * round-trip never covered the two fields the box type most recently gained.
 * A codec test whose fixtures omit fields is a codec test that does not cover
 * them.
 */

/**
 * Helper: strip `id` from a box for comparison against deserializeBox output.
 */
function withoutId(box: AnyBox) {
  const { id: _id, ...rest } = box;
  return rest;
}

describe('serializeBox', () => {
  it('roundtrips a KarmaBox', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 100n,
      owner: new Uint8Array(32).fill(0xaa),
      guard: 'owner_signature' as const,
      proofSource: 'mint-1',
    });
    const serialized = serializeBox(box);
    const deserialized = deserializeBoxWithId(box.id, serialized);
    expect(deserialized).toEqual(box);
  });

  it('roundtrips a CreditBox', () => {
    const box = seedProvenance<CreditBox>({
      boxType: 'credit' as const,
      value: 50n,
      owner: new Uint8Array(32).fill(0xbb),
      guard: 'owner_signature' as const,
      proofSource: 10,
      lockedUntilBlock: 20,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('the retired like tag byte 0x03 stays reserved — decode rejects it', () => {
    // T2b: the 'like' box type is deleted and its AVL tag byte reserved, so
    // bytes carrying it must fail loudly rather than decode as some other type.
    const bytes = new Uint8Array([0x03, 0xa0]); // reserved tag + empty CBOR map
    expect(() => deserializeBox(bytes)).toThrow(/Unknown box type tag/);
  });

  it('roundtrips an InviteBox', () => {
    const box = seedProvenance<InviteBox>({
      boxType: 'invite' as const,
      value: 10n,
      secretHash: new Uint8Array(32).fill(0x22),
      inviterId: new Uint8Array(32).fill(0x33),
      guard: 'hash_preimage_with_bond' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a BondBox', () => {
    const box = seedProvenance<BondBox>({
      boxType: 'bond' as const,
      value: 5n,
      inviterId: new Uint8Array(32).fill(0x33),
      inviteOutputIndex: 0,
      inviteePublicKey: new Uint8Array(32),
      probationStartBlock: 0,
      probationEndBlock: 0,
      guard: 'bond_dual' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('roundtrips a PostLockBox', () => {
    const box = seedProvenance<PostLockBox>({
      boxType: 'post_lock' as const,
      value: 5n,
      originalValue: 5n,
      owner: new Uint8Array(32).fill(0x44),
      targetPostId: 'post-2',
      guard: 'block_apply' as const,
    });
    expect(deserializeBoxWithId(box.id, serializeBox(box))).toEqual(box);
  });

  it('is deterministic — same input produces identical bytes', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 42n,
      owner: new Uint8Array(32).fill(0x55),
      guard: 'owner_signature' as const,
      proofSource: 'mint-0',
    });
    const a = serializeBox(box);
    const b = serializeBox({ ...box });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('deserializeBox returns fields without id', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
      proofSource: '',
    });
    const fields = deserializeBox(serializeBox(box));
    expect(fields).not.toHaveProperty('id');
    expect(fields).toEqual(withoutId(box));
  });

  it('deserializeBox throws on truncated bytes', () => {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value: 1n,
      owner: new Uint8Array(32),
      guard: 'owner_signature' as const,
      proofSource: '',
    });
    const bytes = serializeBox(box);
    expect(() => deserializeBox(bytes.slice(0, 3))).toThrow();
  });

  it('deserializeBox throws on unknown box type byte', () => {
    expect(() => deserializeBox(new Uint8Array([0xff, ...new Array(100).fill(0)]))).toThrow();
  });
});
