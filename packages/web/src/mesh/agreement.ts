// MESH_INTERFACE → What the client remembers → "The agreement counts" — after
// each check, how many nodes name a tip on the client's chain within its
// last `k` headers (`onChain`), and how many name one off those headers
// (`offChain`: on another chain, or further back than they reach — the
// client cannot tell them apart). A node that answered no tip is in no
// count. Pure, browser-safe (`MESH_INTERFACE → Place in the workspace`).

export interface AgreementCounts {
  onChain: number;
  offChain: number;
}

export interface AgreementEntry {
  verdict: 'on' | 'off' | 'none';
}

export function agreementCounts(
  entries: readonly AgreementEntry[],
): AgreementCounts {
  let onChain = 0;
  let offChain = 0;
  for (const e of entries) {
    if (e.verdict === 'on') {
      onChain += 1;
    } else if (e.verdict === 'off') {
      offChain += 1;
    }
  }
  return { onChain, offChain };
}
