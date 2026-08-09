import { describe, it, expect } from 'vitest';
import { computePruneEntryId, serializePruneEntry } from '../src/stump.js';
import type { PruneEntry } from '../src/stump.js';

function makeEntry(overrides?: Partial<PruneEntry>): PruneEntry {
  return {
    rootPostHash: 'a'.repeat(64),
    subtreePostIds: ['b'.repeat(64), 'c'.repeat(64)],
    subtreeMerkleRoot: new Uint8Array(32).fill(0xdd),
    authorId: new Uint8Array(32).fill(0xaa),
    authorSignature: new Uint8Array(64).fill(0xbb),
    trigger: 'author',
    ...overrides,
  };
}

describe('PruneEntry', () => {
  it('computePruneEntryId produces 64-char hex', () => {
    const entry = makeEntry();
    const id = computePruneEntryId(entry);
    expect(id).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(id)).toBe(true);
  });

  it('computePruneEntryId is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(computePruneEntryId(a)).toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId changes with different rootPostHash', () => {
    const a = makeEntry();
    const b = makeEntry({ rootPostHash: 'd'.repeat(64) });
    expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
  });

  it('serializePruneEntry lays the fields out in their normative order', () => {
    // Replaces a CBOR round-trip (`decode(bytes).rootPostHash === …`). There is
    // no map to look a key up in any more — field ORDER is the specification —
    // so the check is positional: read each field back out at its offset. Note
    // every id is 32 raw bytes here, not 64 characters of hex text; the entry
    // went from 428 bytes to 226.
    const entry = makeEntry();
    const hex = Buffer.from(serializePruneEntry(entry)).toString('hex');
    let at = 0;
    const take = (n: number): string => hex.slice(at * 2, (at += n) * 2);

    expect(take(32)).toBe(entry.rootPostHash);          // 1 — b32(rootPostHash)
    expect(take(1)).toBe('02');                          // 2 — arr count
    expect(take(32)).toBe(entry.subtreePostIds[0]);      //     b32(id)
    expect(take(32)).toBe(entry.subtreePostIds[1]);      //     b32(id)
    expect(take(32)).toBe('dd'.repeat(32));              // 3 — b32(subtreeMerkleRoot)
    expect(take(32)).toBe('aa'.repeat(32));              // 4 — b32(authorId)
    expect(take(64)).toBe('bb'.repeat(64));              // 5 — b64(authorSignature)
    expect(take(1)).toBe('00');                          // 6 — enum8(trigger) = author
    expect(at).toBe(226);                                // and nothing else
  });

  it('serializePruneEntry has no encoding for an out-of-domain field', () => {
    // Every field is fixed-width, so every writer throws rather than sentinels
    // (spec §2.5): at a fixed width there is no unreachable sentinel, and
    // padding a short id to 32 bytes would map a malformed entry onto a
    // well-formed one's Merkle leaf. `verifyOrderingBlockStructure` (Phase 1e)
    // is what keeps these throws unreachable in production.
    expect(() => serializePruneEntry(makeEntry({ rootPostHash: 'nope' })))
      .toThrow(/64 lowercase hex chars/);
    expect(() => serializePruneEntry(makeEntry({ subtreePostIds: ['b'.repeat(63)] })))
      .toThrow(/64 lowercase hex chars/);
    expect(() => serializePruneEntry(makeEntry({ authorId: new Uint8Array(31) })))
      .toThrow(/expected 32 bytes/);
    expect(() => serializePruneEntry(makeEntry({ authorSignature: new Uint8Array(63) })))
      .toThrow(/expected 64 bytes/);
  });

  it('an unknown trigger takes the reserved sentinel rather than throwing', () => {
    // `enum8` is the one tag writer that stays TOTAL: its tag set is narrower
    // than a byte, so `0xff` is unreachable from any table member and a
    // malformed trigger can never encode as a valid one.
    const bad = makeEntry({ trigger: 'nonsense' as PruneEntry['trigger'] });
    const bytes = serializePruneEntry(bad);
    expect(bytes[bytes.length - 1]).toBe(0xff);
    expect(Buffer.compare(bytes, serializePruneEntry(makeEntry()))).not.toBe(0);
  });

  it('serializePruneEntry is deterministic', () => {
    const a = makeEntry();
    const b = makeEntry();
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(true);
  });

  it('serializePruneEntry changes with different subtreePostIds', () => {
    const a = makeEntry();
    const b = makeEntry({ subtreePostIds: ['e'.repeat(64)] });
    expect(Buffer.from(serializePruneEntry(a)).equals(
      Buffer.from(serializePruneEntry(b)))).toBe(false);
  });
});
