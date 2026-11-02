// MESH_INTERFACE → No anchor reached → "The agreement counts" — after
// each check, how many nodes name a tip on the client's chain within
// its last `k` headers (`onChain`), how many of those are anchors, and
// how many name one off those headers (`offChain`: on another chain,
// or further back than they reach — the client cannot tell them
// apart). A node that answered no tip is in no count. Pure,
// browser-safe (`MESH_INTERFACE → Place in the workspace`).

export interface AgreementCounts {
  onChain: number;
  onChainAnchors: number;
  offChain: number;
}

export interface AgreementEntry {
  verdict: 'on' | 'off' | 'none';
  anchor: boolean;
}

export function agreementCounts(
  entries: readonly AgreementEntry[],
): AgreementCounts {
  let onChain = 0;
  let onChainAnchors = 0;
  let offChain = 0;
  for (const e of entries) {
    if (e.verdict === 'on') {
      onChain += 1;
      if (e.anchor) onChainAnchors += 1;
    } else if (e.verdict === 'off') {
      offChain += 1;
    }
  }
  return { onChain, onChainAnchors, offChain };
}
