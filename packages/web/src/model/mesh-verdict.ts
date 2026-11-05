// The verdict over the mesh client's state — a pure function of `ClientState`
// after a check (WEB_INTERFACE → The extension → "The verified tip"). The
// table's first row that holds answers the verdict; a state whose counts are
// not non-negative integers reads as no check ended (thin · no-proof). The
// run lands the verdict beside the anchor and the chain name the extension
// build reads (→ "The verified figures" → "The anchor", → "The chain's
// name").

import type { ClientState } from '../mesh/mesh-client.js';
import type { TipRun } from './state.js';
import type { TipVerdict } from './tip-verdict.js';

/**
 * `true` where `value` is a non-negative integer — the totality rule's gate on
 * every count the verdict reads (WEB_INTERFACE → The extension → "The verified
 * tip" → "The verdict is total by itself"). A `NaN`, a non-finite, a negative
 * or a fractional number is total as no count — the verdict falls to thin no-proof.
 */
function isNonNegInt(value: number): boolean {
  if (!Number.isInteger(value)) return false;
  return value >= 0;
}

function proofsAreTotal(p: ClientState['proofs']): boolean {
  if (p === null) return true;
  return isNonNegInt(p.asked)
    && isNonNegInt(p.verified)
    && isNonNegInt(p.invalid)
    && isNonNegInt(p.tooShort);
}

function agreementIsTotal(a: ClientState['agreement']): boolean {
  if (a === null) return true;
  return isNonNegInt(a.onChain) && isNonNegInt(a.onChainAnchors) && isNonNegInt(a.offChain);
}

export function meshVerdict(s: ClientState): TipVerdict {
  const height = s.tip ? s.tip.height : null;

  // Totality — any count that is not a non-negative integer reads as no check
  // ended (WEB_INTERFACE → The extension → "The verified tip" → "The verdict is
  // total by itself"). Decided before the rows, so a check that moved the state
  // into an unusable shape never reads anything but thin no-proof.
  if (!proofsAreTotal(s.proofs) || !agreementIsTotal(s.agreement)) {
    return { kind: 'thin', reason: 'no-proof', height };
  }

  // Row 1a — no check has ended: `agreement` is `null` before the first
  // check's end (MESH_INTERFACE → No anchor reached → "The agreement counts").
  if (s.agreement === null) {
    return { kind: 'thin', reason: 'no-proof', height };
  }

  // Rows 1b–3 — the chain is not yet seated.
  if (!s.seated) {
    const p = s.proofs;
    const answered = p === null ? 0 : p.verified + p.invalid + p.tooShort;
    // Row 1b — no chain seated, and no node answered a proof.
    if (answered === 0) return { kind: 'thin', reason: 'no-proof', height };
    // Row 2 — a proof answered did not decode or did not verify.
    if (p !== null && p.invalid > 0) {
      return { kind: 'refused', reason: 'invalid-proof', height };
    }
    // Row 3 — every proof answered says its chain is shorter than m + k.
    // Anything no row above holds and that is not every answered proof as
    // too-short reads as no-proof — the totality rule.
    if (p !== null && p.tooShort === answered) {
      return { kind: 'thin', reason: 'too-short', height };
    }
    return { kind: 'thin', reason: 'no-proof', height };
  }

  // Row 4 — the chain is seated, and no anchor stands on it.
  if (!s.anchorReached) {
    return { kind: 'thin', reason: 'no-anchor', height };
  }

  // Row 5 — a node names a tip off the chain's last `k` headers.
  if (s.agreement.offChain > 0) {
    return { kind: 'thin', reason: 'split', height };
  }

  // Row 6 — fewer than two nodes name a tip on the chain.
  if (s.agreement.onChain < 2) {
    return { kind: 'thin', reason: 'one-node', height };
  }

  // Row 7 — two or more do. `verified`'s `nodes` is the agreement's `onChain`.
  const resolvedHeight = s.tip !== null ? s.tip.height : 0;
  return { kind: 'verified', nodes: s.agreement.onChain, height: resolvedHeight };
}

/**
 * The run the extension's tip verifier answers — the verdict beside the anchor
 * and the chain name. The anchor is the state's own anchor under `verified`
 * alone (WEB_INTERFACE → The extension → "The verified figures" → "The
 * anchor"); the chain name is the state's own and is non-null whenever the
 * chain is seated (→ "The chain's name").
 */
export function tipRunOf(s: ClientState): TipRun {
  const verdict = meshVerdict(s);
  return {
    verdict,
    anchor: verdict.kind === 'verified' ? s.anchor : null,
    chain: s.chain,
  };
}
