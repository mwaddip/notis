// MESH_INTERFACE → No anchor reached → "The agreement counts" — after
// each check the page shows how many nodes name a tip on the client's
// chain within its last k headers (`onChain`), how many of those are
// anchors, and how many name one off those headers (`offChain`: on
// another chain, or further back than they reach — the client cannot
// tell them apart). A node that answered no tip is in no count.

import { describe, it, expect } from 'vitest';
import { agreementCounts, type AgreementEntry } from '@dagsocial/web/mesh';

describe('agreementCounts', () => {
  it('counts on-chain nodes, their anchors, and the off-chain tally', () => {
    // Five nodes:
    // - idA (anchor): verdict `on` → onChain (anchor)
    // - idB (anchor): verdict `on` → onChain (anchor)
    // - idC         : verdict `on` → onChain
    // - idD (anchor): verdict `off` → offChain
    // - idE         : verdict `none` → in no count
    const entries: AgreementEntry[] = [
      { verdict: 'on', anchor: true },
      { verdict: 'on', anchor: true },
      { verdict: 'on', anchor: false },
      { verdict: 'off', anchor: true },
      { verdict: 'none', anchor: false },
    ];
    expect(agreementCounts(entries)).toEqual({
      onChain: 3,
      onChainAnchors: 2,
      offChain: 1,
    });
  });

  it('an empty entry list reads zero on all counts', () => {
    expect(agreementCounts([])).toEqual({
      onChain: 0,
      onChainAnchors: 0,
      offChain: 0,
    });
  });
});
