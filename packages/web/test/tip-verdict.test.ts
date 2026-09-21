import { describe, it, expect } from 'vitest';
import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import { tipVerdict } from '../src/model/tip-verdict';

// The tool's TipResult is a discriminated shape; the verdict reads only the
// index-0 result's refuseCode/verified, the winnerIndex, the splits and the
// tip's height (WEB_INTERFACE → The extension → "The verified tip"). The tests
// build TipResults by hand — nothing here calls into @dagsocial/nipopow.

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
  };
}

function nodeOk(url: string): NodeTipResult {
  return {
    url,
    verified: true,
    proof: null,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
  };
}

function nodeFail(url: string, code: NonNullable<NodeTipResult['refuseCode']>): NodeTipResult {
  return {
    url,
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: 'fixture',
    refuseCode: code,
  };
}

function verified(url: string, others: NodeTipResult[], tipHeight: number | null): TipResult {
  return {
    winner: url === others[0]?.url ? others[0] : null,
    winnerIndex: 0,
    nodes: [nodeOk(url), ...others],
    tip: tipHeight === null ? null : header(tipHeight),
    suffixHead: null,
    splits: [],
  };
}

describe('tipVerdict — the seven rows over hand-built TipResults', () => {
  it('row 1: index 0 refuseCode invalid → refused invalid-proof (by null)', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [nodeFail('n0', 'invalid'), nodeOk('n1')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: null });
  });

  it('row 2: index 0 refuseCode too-short → thin too-short', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [nodeFail('n0', 'too-short')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'too-short', height: null });
  });

  it('row 3a: index 0 refuseCode unreachable → thin no-proof', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [nodeFail('n0', 'unreachable'), nodeOk('n1')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('row 3b: index 0 refuseCode http → thin no-proof', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [nodeFail('n0', 'http')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('row 4: index 0 verified but winnerIndex !== 0 → refused outworked, by = winner url', () => {
    const r: TipResult = {
      winner: nodeOk('n1'),
      winnerIndex: 1,
      nodes: [nodeOk('n0'), nodeOk('https://node02.notis.fun/testnet/api')],
      tip: header(7766),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({
      kind: 'refused',
      reason: 'outworked',
      by: 'https://node02.notis.fun/testnet/api',
      height: 7766,
    });
  });

  it('row 5: index 0 verified, best, and a split names index 0 → thin split', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeOk('n1')],
      tip: header(7766),
      suffixHead: null,
      splits: [{ indexA: 0, indexB: 1, reason: 'incomparable' }],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'split', height: 7766 });
  });

  it('row 6: index 0 verified, best, no other verified → thin one-node', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeFail('n1', 'unreachable')],
      tip: header(7766),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'one-node', height: 7766 });
  });

  it('row 7: index 0 verified, best or tied, at least one other verified → verified with the count', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeOk('n1')],
      tip: header(7766),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'verified', nodes: 2, height: 7766 });
  });
});

describe('tipVerdict — the row order, first row that holds', () => {
  it('index 0 invalid while another node won → row 1 (refused invalid), not row 4', () => {
    const r: TipResult = {
      winner: nodeOk('n1'),
      winnerIndex: 1,
      nodes: [nodeFail('n0', 'invalid'), nodeOk('n1')],
      tip: header(500),
      suffixHead: null,
      splits: [],
    };
    // Row 1 fires first; the winnerIndex !== 0 never gets read.
    expect(tipVerdict(r)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: 500 });
  });

  it('index 0 verified, outworked AND a split naming it → row 4 (outworked), not row 5', () => {
    const r: TipResult = {
      winner: nodeOk('n1'),
      winnerIndex: 1,
      nodes: [nodeOk('n0'), nodeOk('https://other.example/api')],
      tip: header(7766),
      suffixHead: null,
      splits: [{ indexA: 0, indexB: 1, reason: 'incomparable' }],
    };
    expect(tipVerdict(r)).toEqual({
      kind: 'refused',
      reason: 'outworked',
      by: 'https://other.example/api',
      height: 7766,
    });
  });

  it('index 0 too-short, no verified nodes → row 2, not the empty-nodes fall-through', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [nodeFail('n0', 'too-short')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'too-short', height: null });
  });
});

describe('tipVerdict — edges', () => {
  it('an empty nodes array reads as thin no-proof, height null', () => {
    const r: TipResult = {
      winner: null,
      winnerIndex: -1,
      nodes: [],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'no-proof', height: null });
  });

  it('nodes counts verified nodes only — a failure among the seed list does not lower the count of the verified', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeOk('n1'), nodeFail('n2', 'unreachable'), nodeOk('n3')],
      tip: header(50),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'verified', nodes: 3, height: 50 });
  });

  it('a split whose indexB names 0 also fires row 5 (matches the contract\'s phrasing)', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeOk('n1'), nodeOk('n2')],
      tip: header(80),
      suffixHead: null,
      splits: [{ indexA: 2, indexB: 0, reason: 'incomparable' }],
    };
    // This shape does not arise from the fold (indexA carries the running
    // best), but the check widens to indexB per the contract's language and
    // stays correct in either shape.
    expect(tipVerdict(r)).toEqual({ kind: 'thin', reason: 'split', height: 80 });
  });

  // The verified variable is here to demonstrate the fixture shape stays exercised.
  it('the verified-fixture builder yields row 7', () => {
    const r = verified('n0', [nodeOk('n1')], 42);
    expect(tipVerdict(r)).toEqual({ kind: 'verified', nodes: 2, height: 42 });
  });
});

// The totality gate: rows 4–7 hold only for a reading node the result marks
// verified, beside the result's own tip; anything else reads refused ·
// invalid-proof (WEB_INTERFACE → The extension → "The verdict is total by
// itself"). These fixtures are shapes the tool does not build — the verdict
// decides for itself, never on what another package is known to fill.

function nodeUnverifiedNoCode(url: string): NodeTipResult {
  return {
    url,
    verified: false,
    proof: null,
    verifyResult: null,
    refuseReason: null,
    refuseCode: null,
  };
}

describe('tipVerdict — the totality gate', () => {
  it('reading.verified false under a null refuseCode → refused invalid-proof, never verified', () => {
    const r: TipResult = {
      winner: nodeOk('n1'),
      winnerIndex: 0,
      nodes: [nodeUnverifiedNoCode('n0'), nodeOk('n1')],
      tip: header(500),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: 500 });
  });

  it("reading.verified false, winnerIndex 1 → refused invalid-proof, not outworked (the reading node's state decides before the comparison)", () => {
    const r: TipResult = {
      winner: nodeOk('https://node02.notis.fun/testnet/api'),
      winnerIndex: 1,
      nodes: [nodeUnverifiedNoCode('n0'), nodeOk('https://node02.notis.fun/testnet/api')],
      tip: header(500),
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: 500 });
  });

  it('a verified reading node beside a null tip → refused invalid-proof', () => {
    const r: TipResult = {
      winner: nodeOk('n0'),
      winnerIndex: 0,
      nodes: [nodeOk('n0'), nodeOk('n1')],
      tip: null,
      suffixHead: null,
      splits: [],
    };
    expect(tipVerdict(r)).toEqual({ kind: 'refused', reason: 'invalid-proof', by: null, height: null });
  });
});
