import { describe, it, expect } from 'vitest';
import type { BlockHeader } from '@dagsocial/types';
import type { Anchor } from '@dagsocial/nipopow-client';
import { meshVerdict, tipRunOf } from '../../src/model/mesh-verdict';
import type { ClientState } from '../../src/mesh/mesh-client';
import type { AgreementCounts } from '../../src/mesh/agreement';
import type { ClientTraffic } from '../../src/mesh/mesh-client';

// WEB_INTERFACE → The extension → "The verified tip" — the verdict is a pure
// function of the client's state after a check, the first row of the table that
// holds. The totality rule: a state whose counts are not non-negative integers
// reads as no check ended (thin · no-proof).

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
  anchorReached?: boolean;
  proofs?: ClientState['proofs'];
  anchor?: Anchor | null;
  chain?: string | null;
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
    anchorReached: s.anchorReached ?? false,
    tip: tipHeight === null ? null : { height: tipHeight, hash: 'aa'.repeat(32) },
    agreement: s.agreement ?? null,
    checks: 0,
    traffic: emptyTraffic(),
    nodes: [],
    seated: s.seated ?? false,
    proofs: s.proofs ?? null,
    anchor: s.anchor ?? null,
    chain: s.chain ?? null,
  };
}

const agreement = (onChain: number, onChainAnchors: number, offChain: number): AgreementCounts =>
  ({ onChain, onChainAnchors, offChain });

describe('meshVerdict — the seven rows of the table', () => {
  it.fails('row 1a: no check has ended → thin no-proof, height null', () => {
    const s = stateOf({ seated: false, agreement: null, tipHeight: null });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it.fails('row 1b: not seated and no proof answered → thin no-proof', () => {
    // A check ran (agreement non-null, proofs { asked: 2, verified: 0 ... } — the
    // two nodes asked both failed as unreachable, so no proof was answered.
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0, 0),
      proofs: { asked: 2, verified: 0, invalid: 0, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it.fails('row 2: not seated and a proof answered invalid → refused invalid-proof', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0, 0),
      proofs: { asked: 2, verified: 0, invalid: 1, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: null });
  });

  it.fails('row 3: not seated and every proof answered too-short → thin too-short', () => {
    const s = stateOf({
      seated: false,
      agreement: agreement(0, 0, 0),
      proofs: { asked: 2, verified: 0, invalid: 0, tooShort: 2 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'too-short', height: null });
  });

  it.fails('row 4: seated and no anchor stands on it → thin no-anchor', () => {
    // The chain is seated; `anchorReached` is false — every anchor's latest
    // event is a failure or a lie (MESH_INTERFACE → No anchor reached).
    const s = stateOf({
      seated: true,
      anchorReached: false,
      agreement: agreement(0, 0, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-anchor', height: 7766 });
  });

  it.fails('row 5: seated and a node names a tip off the window → thin split', () => {
    // offChain > 0 — a node named a tip not on the client's chain's last k headers.
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(2, 2, 1),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'split', height: 7766 });
  });

  it.fails('row 6: seated and fewer than two nodes name a tip on it → thin one-node', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(1, 1, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'one-node', height: 7766 });
  });

  it.fails('row 7: seated and two or more → verified, with the count', () => {
    // `verified`'s `nodes` is the agreement's `onChain` (the brief's row 7
    // mapping).
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(3, 2, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'verified', nodes: 3, height: 7766 });
  });
});

describe('meshVerdict — the row order, first row that holds wins', () => {
  it.fails('a state meeting rows 1a and 2 reads row 1a (no check ended)', () => {
    // agreement null means the check has not ended; row 1 fires first even if
    // the proofs field somehow carries a nonzero invalid count (a shape the
    // client does not build but totality covers).
    const s = stateOf({
      seated: false,
      agreement: null,
      proofs: { asked: 2, verified: 0, invalid: 1, tooShort: 0 },
      tipHeight: null,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it.fails('a state meeting rows 5 and 6 reads row 5 (split wins over one-node)', () => {
    // onChain is 1 (would fire row 6), but offChain > 0 so row 5 fires first.
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(1, 1, 2),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'split', height: 7766 });
  });

  it.fails('a state meeting rows 4 and 5 reads row 4 (no-anchor wins over split)', () => {
    const s = stateOf({
      seated: true,
      anchorReached: false,
      agreement: agreement(0, 0, 1),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-anchor', height: 7766 });
  });
});

describe('meshVerdict — totality on the counts', () => {
  it.fails('a NaN proofs.verified reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(3, 2, 0),
      proofs: { asked: 3, verified: Number.NaN, invalid: 0, tooShort: 0 },
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });

  it.fails('a negative agreement.onChain reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(-1, 0, 0),
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });

  it.fails('a fractional agreement.offChain reads as no check ended → thin no-proof', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: { onChain: 2, onChainAnchors: 2, offChain: 1.5 },
      tipHeight: 7766,
    });
    expect(meshVerdict(s)).toEqual({ kind: 'thin', reason: 'no-proof', height: 7766 });
  });
});

describe('tipRunOf — anchor is non-null only under verified', () => {
  const anchorHdr: Anchor = { tip: header(7766), suffixHead: header(7747) };

  it.fails('verified → anchor equals state.anchor and chain equals state.chain', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(2, 2, 0),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    const run = tipRunOf(s);
    expect(run.verdict.kind).toBe('verified');
    expect(run.anchor).toEqual(anchorHdr);
    expect(run.chain).toBe('ab'.repeat(32));
  });

  it.fails('thin one-node → anchor is null even when state.anchor is present', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(1, 1, 0),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    const run = tipRunOf(s);
    expect(run.verdict.kind).toBe('thin');
    expect(run.anchor).toBeNull();
    expect(run.chain).toBe('ab'.repeat(32));
  });

  it.fails('thin split → anchor is null', () => {
    const s = stateOf({
      seated: true,
      anchorReached: true,
      agreement: agreement(2, 2, 1),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    expect(tipRunOf(s).anchor).toBeNull();
  });

  it.fails('thin no-anchor → anchor is null', () => {
    const s = stateOf({
      seated: true,
      anchorReached: false,
      agreement: agreement(0, 0, 0),
      anchor: anchorHdr,
      chain: 'ab'.repeat(32),
      tipHeight: 7766,
    });
    expect(tipRunOf(s).anchor).toBeNull();
  });

  it.fails('row 1 (no check ended) → anchor and chain are null', () => {
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
