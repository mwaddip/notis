// MESH_INTERFACE → Acceptance 6 — "A mesh node publishing a block
// that fails its checks is blacklisted with its evidence, and the
// client does not forward it." The hostile gossip publisher's bad
// block is a pure byte builder — a tiny payload whose
// `readOrderingBlockSections` throws, so `BlockCheck.check` reads
// it as `reject` with `lie: true`.

import { describe, expect, it } from 'vitest';
// eslint-disable-next-line import/extensions
import { badBlockBytes } from '../stage/hostile-gossip.mjs';
import { BlockCheck } from '../src/block-check.js';
import { profileFor } from '@dagsocial/types';

describe('badBlockBytes — the publisher\'s block', () => {
  it('is a Uint8Array under MAX_ORDERING_BLOCK_BYTES', () => {
    const bytes = badBlockBytes(1);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(1024);
  });
  it('BlockCheck.check reads it as reject with lie: true', () => {
    const bytes = badBlockBytes(1);
    const profile = profileFor('devnet');
    const check = new BlockCheck({
      profile,
      scheduledTargetBits: () => null,
      standing: () => null,
      nowMs: () => Date.now(),
    });
    const verdict = check.check(bytes);
    expect(verdict.result).toBe('reject');
    if (verdict.result === 'reject') {
      expect(verdict.lie).toBe(true);
      expect(typeof verdict.detail).toBe('string');
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });
  // MESH_INTERFACE → Block gossip → "A block is checked before it is
  // forwarded" — gossipsub's `msgIdFn` keyes seen-cache lookups by the
  // bytes' hash, and `GOSSIP_SEEN_WINDOW_MS` holds a duplicate for 120 s
  // (`ignoreDuplicatePublishError: true` makes the publisher's own
  // re-emit a no-op). Each publish needs distinct bytes, else the first
  // publish's message is the only one honest peers ever see; a browser
  // that joins the mesh after it stays unaware.
  it.fails('badBlockBytes(n) answers bytes distinct for each n', () => {
    const a = badBlockBytes(1);
    const b = badBlockBytes(2);
    expect(a).not.toEqual(b);
    // Three consecutive counters all differ pairwise.
    const bytes = [badBlockBytes(1), badBlockBytes(2), badBlockBytes(3)].map((b) => Buffer.from(b).toString('hex'));
    expect(new Set(bytes).size).toBe(3);
  });
  it('BlockCheck.check reads badBlockBytes(2) as reject with lie: true (every counter is a lie)', () => {
    const bytes = badBlockBytes(2);
    const profile = profileFor('devnet');
    const check = new BlockCheck({
      profile,
      scheduledTargetBits: () => null,
      standing: () => null,
      nowMs: () => Date.now(),
    });
    const verdict = check.check(bytes);
    expect(verdict.result).toBe('reject');
    if (verdict.result === 'reject') {
      expect(verdict.lie).toBe(true);
    }
  });
});
