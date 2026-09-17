import type { Api } from '../api/client';
import type { PendingLedger } from './ledger';
import type { BuildContext } from './builders';
import type { SpendableBox } from './types';
import type { CreditBoxRow } from '../api/dto';

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
    spendable: ledger.spendable(confirmed, 'karma'),
    height: status.blockHeight,
    era: status.protocolVersion,
    author,
  };
}

/** The spendable-at-height filter, shared by the credits read and the `$NOTIS`
 *  row's balance — WEB_INTERFACE → The wallet ("A send reads the other ledger
 *  by the same rule ... a credit row whose `lockedUntilBlock` is above the
 *  `/status` height is left out of the view"). `=== height` stays (the node
 *  judges a spend at tip + 1, so the client is conservative by one block). */
export function spendableCreditBoxes(
  boxes: readonly CreditBoxRow[],
  height: number,
): CreditBoxRow[] {
  return boxes.filter((b) => b.lockedUntilBlock === undefined || b.lockedUntilBlock <= height);
}

/** The locked complement of `spendableCreditBoxes` — the sum of values not yet
 *  spendable and the latest `lockedUntilBlock` among them; null when nothing is
 *  locked at this height. Feeds the row's *N $NOTIS more unlock by block H*
 *  hint (WEB_INTERFACE → The profile window). */
export function lockedCreditSummary(
  boxes: readonly CreditBoxRow[],
  height: number,
): { value: bigint; height: number } | null {
  let value = 0n;
  let latest = 0;
  for (const b of boxes) {
    if (b.lockedUntilBlock === undefined || b.lockedUntilBlock <= height) continue;
    value += BigInt(b.value);
    if (b.lockedUntilBlock > latest) latest = b.lockedUntilBlock;
  }
  return value === 0n ? null : { value, height: latest };
}

/** The credit-side counterpart — WEB_INTERFACE → The wallet ("A send reads the
 *  other ledger by the same rule: `GET /credits/:key` following `next`, then
 *  `GET /status`"). A row whose `lockedUntilBlock` is above `status.blockHeight`
 *  is left out — the node judges a spend at tip + 1, so the client is
 *  conservative by one block. The filter runs after the height is known. */
export async function readCreditContext(
  reads: Pick<Api, 'credits' | 'status'>,
  ledger: PendingLedger,
  author: string,
): Promise<BuildContext> {
  const rows: CreditBoxRow[] = [];
  let after: string | null = null;
  do {
    const page = await reads.credits(author, after === null ? {} : { after });
    for (const b of page.boxes) rows.push(b);
    after = page.next;
  } while (after !== null);

  const status = await reads.status();

  const confirmed: SpendableBox[] = spendableCreditBoxes(rows, status.blockHeight)
    .map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));

  return {
    spendable: ledger.spendable(confirmed, 'credits'),
    height: status.blockHeight,
    era: status.protocolVersion,
    author,
  };
}
