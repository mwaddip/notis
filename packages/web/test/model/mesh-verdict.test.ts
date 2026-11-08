import { describe, it, expect } from 'vitest';
import type { BlockHeader } from '@dagsocial/types';
import type { Anchor } from '@dagsocial/nipopow-client';
import { meshVerdict, tipRunOf } from '../../src/model/mesh-verdict';
import type { ClientState, Disagreement } from '../../src/mesh/mesh-client';
import type { AgreementCounts } from '../../src/mesh/agreement';
import type { ClientTraffic } from '../../src/mesh/mesh-client';

// WEB_INTERFACE → The extension → "The verified tip" — the verdict is a pure
// function of the client's state after a check, the first row of the table
// that holds. The totality rule: a state whose counts are not non-negative
// integers reads as no check ended (thin · no-proof).

function header(height: number): BlockHeader {
  return {
    protocolVersion: 1,
    height,
    prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32),
    stateRoot: '00'.repeat(33),
    validatorId: new Uint8Array(32),
    powNonce: 0,
    powTargetBits: 0x1d00ffff,
    createdAt: 0,
    interlinkRoot: '00'.repeat(32),
    adProofsRoot: '00'.repeat(32),
  };
}

function emptyTraffic(): ClientTraffic {
  return {
    tipBytes: 0,
    proofBytes: 0,
    headerBytes: 0,
    gossipBytes: 0,
    proofReads: 0,
    forwarded: 0,
  };
}

interface StateShape {
  seated?: boolean;
  tipHeight?: number | null;
  agreement?: AgreementCounts | null;
  proofs?: ClientState['proofs'];
  anchor?: Anchor | null;
  chain?: string | null;
  notContinued?: boolean;
  disagreement?: Disagreement | null;
}

/** Build a ClientState for the verdict to read, with the fields the verdict
 *  does not read left at harmless defaults. */
function stateOf(s: StateShape): ClientState {
  const tipHeight = s.tipHeight === undefined ? null : s.tipHeight;
  return {
    nodeId: null,
    transport: null,
    path: null,
    lastLeft: null,
    tip: tipHeight === null ? null : { height: tipHeight, hash: 'aa'.repeat(32) },
    agreement: s.agreement ?? null,
    checks: 0,
    traffic: emptyTraffic(),
    nodes: [],
    seated: s.seated ?? false,
    proofs: s.proofs ?? null,
    anchor: s.anchor ?? null,
    chain: s.chain ?? null,
    notContinued: s.notContinued ?? false,
    disagreement: s.disagreement ?? null,
  };
}

const agreement = (onChain: number, offChain: number): AgreementCounts =>
  ({ onChain, offChain });

const DISAGREEMENT_MEMORY: Disagreement = {
  which: 'memory',
  yours: { height: 100, hash: 'bb'.repeat(32) },
  other: null,
  fork: 'cc'.repeat(32),
};
const DISAGREEMENT_HEAVIER: Disagreement = {
  which: 'heavier',
  yours: { height: 100, hash: 'bb'.repeat(32) },
  other: { height: 130, hash: 'dd'.repeat(32) },
  fork: 'cc'.repeat(32),
};

describe('meshVerdict — the rows of the table', () => {
  it('row 1a: no check has ended → thin no-proof, height null', () => {
    const s = stateOf({ seated: false, agreement: null, tipHeight: null });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('row 1b: not seated and no proof answered → thin no-proof', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0),
      proofs: { asked: 2, verified: 0, invalid: 0, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('row 2: not seated and a proof answered invalid → refused invalid-proof', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0),
      proofs: { asked: 2, verified: 0, invalid: 1, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'refused', reason: 'invalid-proof', height: null });
  });

  it('row 3: not seated and every proof answered too-short → thin too-short', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0),
      proofs: { asked: 2, verified: 0, invalid: 0, tooShort: 2 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'too-short', height: null });
  });

  it('row 3 only reads too-short when every answered proof is too-short — a verified-but-unseated state reads no-proof', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0),
      proofs: { asked: 2, verified: 1, invalid: 0, tooShort: 1 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('row 4: seated and a disagreement stands → refused your-node, naming which', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(2, 0),
      disagreement: DISAGREEMENT_MEMORY,
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({
      kind: 'refused',
      reason: 'your-node',
      which: 'memory',
      height: 7766,
    });
  });

  it('row 5: seated, no disagreement and notContinued → thin not-continued', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(0, 1),
      notContinued: true,
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'not-continued', height: 7766 });
  });

  it('row 6: seated and a node names a tip off the window → thin split', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(2, 1),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'split', height: 7766 });
  });

  it('row 7: seated and fewer than two nodes name a tip on it → thin one-node', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(1, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'one-node', height: 7766 });
  });

  it('row 8: seated and two or more → verified, with the count', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(3, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'verified', nodes: 3, height: 7766 });
  });
});

describe('meshVerdict — the row order, first row that holds wins', () => {
  it('a state meeting rows 1a and 2 reads row 1a (no check ended)', () => {
    const s = stateOf({
      seated: false,
      agreement: null,
      proofs: { asked: 2, verified: 0, invalid: 1, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('a state meeting rows 6 and 7 reads row 6 (split wins over one-node)', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(1, 2),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'split', height: 7766 });
  });

  it('your-node ranks first among seated rows; not-continued ranks before split; no row reads anchors', () => {
    // Row 4 — your-node — outranks every seated row. Even with
    // notContinued true and offChain > 0 (which would otherwise fire
    // not-continued or split), a standing disagreement wins.
    const sYN = stateOf({
      seated: true,
      agreement: agreement(0, 1),
      notContinued: true,
      disagreement: DISAGREEMENT_HEAVIER,
      tipHeight: 7766,
    });
    expect(meshVerdict(sYN)).toEqual({
      kind: 'refused',
      reason: 'your-node',
      which: 'heavier',
      height: 7766,
    });

    // Row 5 — not-continued — ranks before split (row 6). offChain > 0
    // alone would fire split, but with notContinued true the earlier
    // row wins.
    const sNC = stateOf({
      seated: true,
      agreement: agreement(0, 1),
      notContinued: true,
      tipHeight: 7766,
    });
    expect(meshVerdict(sNC)).toEqual({ kind: 'thin', reason: 'not-continued', height: 7766 });

    // No row reads an anchor count: an agreement with no `onChainAnchors`
    // field answers the same verdict as any other with the same `onChain`
    // and `offChain` (`AgreementCounts` carries neither).
    const sNoAnchorField = stateOf({
      seated: true,
      agreement: agreement(3, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(sNoAnchorField)).toEqual({ kind: 'verified', nodes: 3, height: 7766 });
  });
});

describe('meshVerdict — totality on the counts', () => {
  it('a NaN proofs.verified reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(3, 0),
      proofs: { asked: 3, verified: Number.NaN, invalid: 0, tooShort: 0 },
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });

  it('a negative agreement.onChain reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(-1, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });

  it('a fractional agreement.offChain reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      agreement: { onChain: 2, offChain: 1.5 },
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });
});

describe('tipRunOf — anchor is non-null only under verified', () => {
  const anchorHdr: Anchor = { tip: header(7766), suffixHead: header(7747) };

  it('verified → anchor equals state.anchor and chain equals state.chain', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(2, 0),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    const run = tipRunOf(s);
    expect(run.verdict.kind).toBe('verified');
    expect(run.anchor).toEqual(anchorHdr);
    expect(run.chain).toBe('ab'.repeat(32));
  });

  it('thin one-node → anchor is null even when state.anchor is present', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(1, 0),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    const run = tipRunOf(s);
    expect(run.verdict.kind).toBe('thin');
    expect(run.anchor).toBeNull();
    expect(run.chain).toBe('ab'.repeat(32));
  });

  it('thin split → anchor is null', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(2, 1),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    expect(tipRunOf(s).anchor).toBeNull();
  });

  it('thin not-continued → anchor is null', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(0, 1),
      notContinued: true,
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    expect(tipRunOf(s).anchor).toBeNull();
  });

  it('refused your-node → anchor is null', () => {
    const s = stateOf({
      seated: true,
      agreement: agreement(2, 0),
      disagreement: DISAGREEMENT_MEMORY,
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    expect(tipRunOf(s).anchor).toBeNull();
  });

  it('row 1 (no check ended) → anchor and chain are null', () => {
    const s = stateOf({
      seated: false,
      agreement: null,
      anchor: null,
      chain: null,
      tipHeight: null,
    });
    const run = tipRunOf(s);
    expect(run.anchor).toBeNull();
    expect(run.chain).toBeNull();
  });
});
