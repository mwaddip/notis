// @vitest-environment node
import { describe, it, expect } from 'vitest';

// WEB_INTERFACE → Invariants → "A per-network number is read, never assumed" —
// the one place that answers the four is `src/model/network-numbers.ts`, and
// the wallet's flows reach it through `src/wallet/submit.ts`. Neither module
// imports anything that reads the document when it loads, so both can be
// imported under Node — the bundle `scripts/extension-check/claim-name.mjs`
// builds and runs with the signing seam the extension's `claim` runs.

describe('the wallet flows and the per-network numbers load with no DOM', () => {
  it('src/wallet/submit.ts imports under Node and names every flow', async () => {
    let mod: typeof import('../src/wallet/submit') | null = null;
    let err: unknown = null;
    try {
      mod = await import('../src/wallet/submit');
    } catch (e) {
      err = e;
    }
    expect(err).toBeNull();
    expect(mod).not.toBeNull();
    expect(typeof mod!.submitPostFlow).toBe('function');
    expect(typeof mod!.submitLikeFlow).toBe('function');
    expect(typeof mod!.submitVouchFlow).toBe('function');
    expect(typeof mod!.submitUnvouchFlow).toBe('function');
    expect(typeof mod!.submitInviteFlow).toBe('function');
    expect(typeof mod!.submitWithdrawFlow).toBe('function');
    expect(typeof mod!.submitClaimFlow).toBe('function');
    expect(typeof mod!.submitBurnFlow).toBe('function');
    expect(typeof mod!.submitSendFlow).toBe('function');
  });

  it('src/model/network-numbers.ts imports under Node and names its one function', async () => {
    let mod: typeof import('../src/model/network-numbers') | null = null;
    let err: unknown = null;
    try {
      mod = await import('../src/model/network-numbers');
    } catch (e) {
      err = e;
    }
    expect(err).toBeNull();
    expect(mod).not.toBeNull();
    expect(typeof mod!.networkNumbers).toBe('function');
  });
});
