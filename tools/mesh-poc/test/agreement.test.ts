// MESH_INTERFACE → No anchor reached → "The agreement counts" — after
// each check the page shows how many nodes verified a proof on the
// tip's chain within its last k headers (agreeing), how many of those
// are anchors (agreeingAnchors), and how many verified a proof off
// those headers (notAgreeing — on another chain, or further back).
// A node that did not verify is in no count.

import { describe, it, expect } from 'vitest';
import { agreementCounts } from '../src/client/agreement.js';
import { meshBaseUrl } from '../src/mesh-url.js';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

const idA = 'a'.repeat(64);
const idB = 'b'.repeat(64);
const idC = 'c'.repeat(64);
const idD = 'd'.repeat(64);
const idE = 'e'.repeat(64);

function node(id: string, overrides: Partial<NodeTipResult>): NodeTipResult {
  return {
    url: meshBaseUrl(id) + '/',
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
    behind: null,
    genesisHash: null,
    ...overrides,
  };
}

function result(nodes: NodeTipResult[], splits: TipResult['splits'] = []): TipResult {
  return {
    winner: nodes.find((n) => n.verified && n.behind === 0) ?? null,
    winnerIndex: nodes.findIndex((n) => n.verified && n.behind === 0),
    nodes,
    tip: null,
    suffixHead: null,
    splits,
  };
}

describe('agreementCounts', () => {
  it('counts agreeing, agreeing anchors, and verified nodes off the tip suffix', () => {
    // Five nodes:
    // - idA (anchor): winner, behind = 0 → agreeing (anchor)
    // - idB (anchor): tied at behind = 0 → agreeing (anchor)
    // - idC: trailing at behind = 1 → agreeing (not anchor)
    // - idD (anchor): verified but off the suffix (behind = null, on a
    //   split with the winner) → notAgreeing
    // - idE: not verified at all → in no count
    const splits: TipResult['splits'] = [{ indexA: 0, indexB: 3, reason: 'incomparable' }];
    const r = result(
      [
        node(idA, { verified: true, behind: 0 }),
        node(idB, { verified: true, behind: 0 }),
        node(idC, { verified: true, behind: 1 }),
        node(idD, { verified: true, behind: null }),
        node(idE, { verified: false, refuseCode: 'unreachable', refuseReason: 'nope' }),
      ],
      splits,
    );
    const anchorIds = new Set([idA, idB, idD]);
    expect(agreementCounts(r, anchorIds)).toEqual({
      agreeing: 3,
      agreeingAnchors: 2,
      notAgreeing: 1,
    });
  });
});
