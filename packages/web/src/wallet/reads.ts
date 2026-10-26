import { KARMA_LISTING_MAX, LEDGER_READ_MAX } from '@dagsocial/node-reads';
import type { Api } from '../api/client';
import { readWholeList } from '../api/whole-list';
import type { BuildContext, RepBuildContext } from './builders';
import type { SpendableBox } from './types';
import type { CreditBoxRow, KarmaBoxRow } from '../api/dto';

// WEB_INTERFACE → The wallet → "Reads before a write, in this order: `GET /karma/:key?pending=1` following `next`, then `GET /status`".
// The spendable view is the node's pending view, and the ledger chooses no
// input and gates no spend (WEB_INTERFACE → The wallet → "The spendable views
// are the node's pending view", → "The client keeps no model of the pool").
// The /karma listing holds at most KARMA_LISTING_MAX boxes (WEB_INTERFACE →
// Reading a node's answer → "A whole-list read is bounded", NODE_INTERFACE →
// Karma transition rules → "An identity holds at most two karma boxes"), and
// the whole-list rule refuses the listing past it.

export async function readBuildContext(
  reads: Pick<Api, 'karma' | 'status'>,
  author: string,
): Promise<RepBuildContext> {
  // The first page carries the view's `effective` — the number the floor is
  // held against (WEB_INTERFACE → The wallet → "The floor is the client's to
  // know"). KARMA_LISTING_MAX is 2 and PAGE_LIMIT_MAX reads up to 100 rows a
  // page, so the first page carries every box; the whole-list wrapper refuses
  // past the bound either way.
  let effective: bigint | null = null;
  const boxes = await readWholeList<KarmaBoxRow, Awaited<ReturnType<Api['karma']>>>({
    readPage: async (page) => {
      const answer = await reads.karma(author, page, { pending: true });
      if (effective === null) effective = BigInt(answer.effective);
      return answer;
    },
    pick: (answer) => ({ rows: answer.boxes, next: answer.next }),
    keyOf: (b) => b.boxId,
    bound: KARMA_LISTING_MAX,
  });
  const confirmed: SpendableBox[] = [];
  for (const b of boxes) {
    // The /karma reader rebuilds a row's `income` as `true` or absent, so
    // the mark's domain is held before a box reaches here (WEB_INTERFACE →
    // Reading a node's answer → "Every answer is rebuilt from its own
    // fields", TYPES_INTERFACE → KarmaBox).
    const box: SpendableBox = { boxId: b.boxId, value: BigInt(b.value) };
    if (b.income === true) box.income = true;
    confirmed.push(box);
  }

  const status = await reads.status();

  return {
    spendable: confirmed,
    height: status.blockHeight,
    era: status.protocolVersion,
    author,
    effective: effective ?? 0n,
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
 *  hint (WEB_INTERFACE → The wallet window → "The `balance` row"). */
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
 *  other ledger by the same rule: `GET /credits/:key?pending=1` following
 *  `next`, then `GET /status`"). A row whose `lockedUntilBlock` is above
 *  `status.blockHeight` is left out — the node judges a spend at tip + 1, so
 *  the client is conservative by one block. The filter runs after the height
 *  is known. The whole-list rule bounds the listing by LEDGER_READ_MAX
 *  (WEB_INTERFACE → Reading a node's answer → "A whole-list read is bounded"). */
export async function readCreditContext(
  reads: Pick<Api, 'credits' | 'status'>,
  author: string,
): Promise<BuildContext> {
  const rows = await readWholeList<CreditBoxRow, Awaited<ReturnType<Api['credits']>>>({
    readPage: (page) => reads.credits(author, page, { pending: true }),
    pick: (answer) => ({ rows: answer.boxes, next: answer.next }),
    keyOf: (b) => b.boxId,
    bound: LEDGER_READ_MAX,
  });

  const status = await reads.status();

  const confirmed: SpendableBox[] = spendableCreditBoxes(rows, status.blockHeight)
    .map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));

  return {
    spendable: confirmed,
    height: status.blockHeight,
    era: status.protocolVersion,
    author,
  };
}
