import type { Api } from '../api/client';
import type { PendingLedger } from './ledger';
import type { BuildContext } from './builders';
import type { SpendableBox } from './types';

// The reads before a write, in the ONE function that assembles a BuildContext —
// WEB_INTERFACE → The wallet. The order is a correctness rule, not a preference:
// /karma following `next` to the end, THEN /status. Every output declares
// createdAtBlock, which may not be below any input's, and a /karma row carries
// none — so the client declares the /status height, and reading it AFTER the
// boxes guarantees no selected box is newer than the height declared. Left to
// call sites the order could be got wrong with no visible error; it lives here so
// it cannot.

export async function readBuildContext(
  reads: Pick<Api, 'karma' | 'status'>,
  ledger: PendingLedger,
  author: string,
): Promise<BuildContext> {
  const confirmed: SpendableBox[] = [];
  let after: string | null = null;
  do {
    const page = await reads.karma(author, after === null ? {} : { after });
    for (const b of page.boxes) confirmed.push({ boxId: b.boxId, value: BigInt(b.value) });
    after = page.next;
  } while (after !== null);

  const status = await reads.status();

  return {
    spendable: ledger.spendable(confirmed),
    height: status.blockHeight,
    era: status.protocolVersion,
    author,
  };
}
