// MESH_INTERFACE → What the client remembers → "The agreement counts" —
// after each check the page shows how many nodes name a tip on the client's
// chain within its last k headers (`onChain`), and how many name one off
// those headers (`offChain`: on another chain, or further back than they
// reach — the client cannot tell them apart). A node that answered no tip
// is in no count.

import { describe, it, expect } from 'vitest';
import { agreementCounts, type AgreementEntry } from '../../src/mesh/agreement.js';

describe('agreementCounts', () => {
  it('counts on-chain nodes and the off-chain tally', () => {
    // Five nodes:
    // - idA: verdict `on` → onChain
    // - idB: verdict `on` → onChain
    // - idC: verdict `on` → onChain
    // - idD: verdict `off` → offChain
    // - idE: verdict `none` → in no count
    const entries: AgreementEntry[] = [
      { verdict: 'on' },
      { verdict: 'on' },
      { verdict: 'on' },
      { verdict: 'off' },
      { verdict: 'none' },
    ];
    expect(agreementCounts(entries)).toEqual({
      onChain: 3,
      offChain: 1,
    });
  });

  it('an empty entry list reads zero on both counts', () => {
    expect(agreementCounts([])).toEqual({
      onChain: 0,
      offChain: 0,
    });
  });
});
