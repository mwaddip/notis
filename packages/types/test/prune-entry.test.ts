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

  it('computePruneEntryId changes with different subtreeMerkleRoot', () => {
    const a = makeEntry();
    const b = makeEntry({ subtreeMerkleRoot: new Uint8Array(32).fill(0xee) });
    expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId changes with different authorId', () => {
    const a = makeEntry();
    const b = makeEntry({ authorId: new Uint8Array(32).fill(0xcc) });
    expect(computePruneEntryId(a)).not.toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId is invariant under authorSignature bytes', () => {
    const a = makeEntry({ authorSignature: new Uint8Array(64).fill(0x11) });
    const b = makeEntry({ authorSignature: new Uint8Array(64).fill(0x22) });
    expect(computePruneEntryId(a)).toBe(computePruneEntryId(b));
  });

  it('computePruneEntryId matches a fixed vector', () => {
    const entry = makeEntry();
    expect(computePruneEntryId(entry))
      .toBe('d44bbbe64f71b2ea5efd0595c9afd65993a6b1f21507a702529ad264bd6eda2f');
  });

  it('serializePruneEntry lays the fields out in their normative order', () => {
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
    expect(at).toBe(225);                                // five fields, nothing trailing
  });

  it('serializePruneEntry rejects a trailing sixth byte', () => {
    const entry = makeEntry();
    const bytes = serializePruneEntry(entry);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    padded[bytes.length] = 0xff;
    expect(padded.length).toBe(226);
    expect(bytes.length).toBe(225);
  });

  it('serializePruneEntry has no encoding for an out-of-domain field', () => {
    expect(() => serializePruneEntry(makeEntry({ rootPostHash: 'nope' })))
      .toThrow(/64 lowercase hex chars/);
    expect(() => serializePruneEntry(makeEntry({ subtreePostIds: ['b'.repeat(63)] })))
      .toThrow(/64 lowercase hex chars/);
    expect(() => serializePruneEntry(makeEntry({ authorId: new Uint8Array(31) })))
      .toThrow(/expected 32 bytes/);
    expect(() => serializePruneEntry(makeEntry({ authorSignature: new Uint8Array(63) })))
      .toThrow(/expected 64 bytes/);
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
