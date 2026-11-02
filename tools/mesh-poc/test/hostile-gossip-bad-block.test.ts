// MESH_INTERFACE → Acceptance 6 → "A mesh node publishing a block
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
    const bytes = badBlockBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(1024);
  });
  it('BlockCheck.check reads it as reject with lie: true', () => {
    const bytes = badBlockBytes();
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
});
