// The verdict — a pure function over the tool's TipResult
// (WEB_INTERFACE → The extension → "The verified tip"). The reading node is at
// index 0 of the tool's `nodes` array, so the fold's own rule gives the
// comparison its meaning: `winnerIndex === 0` says the reading node holds the
// best chain or ties for it (NIPOPOW_INTERFACE → compareProofs). The rows are
// the contract's table, the first that holds.

import type { TipResult, NodeTipResult } from '@dagsocial/nipopow-client';

export type TipVerdict =
  | { kind: 'verified'; nodes: number; height: number }
  | { kind: 'thin'; reason: 'no-proof' | 'too-short' | 'one-node' | 'split'; height: number | null }
  | { kind: 'refused'; reason: 'invalid-proof' | 'outworked'; by: string | null; height: number | null };

export function tipVerdict(result: TipResult): TipVerdict {
  const reading: NodeTipResult | undefined = result.nodes[0];
  const height = result.tip ? result.tip.height : null;

  // An empty nodes array — nothing was asked — reads as `no-proof`
  // (WEB_INTERFACE → The extension → "The verified tip", the row for a transport
  // failure).
  if (reading === undefined) {
    return { kind: 'thin', reason: 'no-proof', height };
  }

  // Row 1 — the reading node's own outcome decides first.
  if (reading.refuseCode === 'invalid') {
    return { kind: 'refused', reason: 'invalid-proof', by: null, height };
  }
  if (reading.refuseCode === 'too-short') {
    return { kind: 'thin', reason: 'too-short', height };
  }
  if (reading.refuseCode === 'unreachable' || reading.refuseCode === 'http') {
    return { kind: 'thin', reason: 'no-proof', height };
  }

  // Rows 4–7 apply only when the reading node verified. A `refuseCode` of null
  // on an unverified node cannot happen (the tool fills one on every non-ok
  // path), so this fall-through is safe.
  if (result.winnerIndex !== 0) {
    // Row 4 — another node's chain won the comparison; name its host by the
    // winner's `url` (the corner reads the host from it).
    const winner = result.nodes[result.winnerIndex];
    return {
      kind: 'refused',
      reason: 'outworked',
      by: winner ? winner.url : null,
      height,
    };
  }

  // Row 5 — the reading node verified, best or tied, but shares no block with
  // another node's proof. The contract phrases the check as any split naming
  // index 0 (`indexA` or `indexB`); with `winnerIndex === 0` and index 0
  // verified, `indexA` is the one that carries 0, but the wider check matches
  // the contract's language exactly and stays correct in either shape.
  if (result.splits.some((s) => s.indexA === 0 || s.indexB === 0)) {
    return { kind: 'thin', reason: 'split', height };
  }

  const verifiedCount = result.nodes.reduce((n, node) => n + (node.verified ? 1 : 0), 0);

  // Row 6 — no other node verified.
  if (verifiedCount < 2) {
    return { kind: 'thin', reason: 'one-node', height };
  }

  // Row 7 — verified, best or tied, at least one other verified. `height` is
  // non-null since `tip` accompanies any verified winner (tools/nipopow-client
  // → resolveTip).
  return { kind: 'verified', nodes: verifiedCount, height: height ?? 0 };
}
