import { describe, it, expect } from 'vitest';
import { computeCandidateBoxId } from '@dagsocial/types';
import type { CandidateOf, KarmaBox } from '@dagsocial/types';
import { PendingChain } from '../src/pending.js';
import { buildInviteTx } from '../src/invite.js';
import { buildCreditTransferTx } from '../src/transfer.js';
import {
  C1, ERA, INCOME_ID, K1, OWN_ID,
  baseCfg as cfg, income, own, pubHex, recipient,
} from './fixture.js';

const confirmed = [{ boxId: K1, value: 1000n }];
const second = 'bb'.repeat(32);

describe('PendingChain', () => {
  it('passes the confirmed view through when nothing is pending', () => {
    expect(new PendingChain().view(confirmed)).toEqual(confirmed);
  });

  // ⛔ Without this the second invite in one block interval selects the box the
  // first one already spends, and the node refuses it as a double spend — so
  // the faucet serves one person per block.
  it('replaces the view with the change box after a submission', () => {
    const chain = new PendingChain();
    chain.advance(buildInviteTx(cfg, confirmed, recipient, 0, ERA));
    const view = chain.view(confirmed);
    expect(view).toHaveLength(1);
    expect(view[0]!.value).toBe(750n);
    expect(view[0]!.boxId).not.toBe(K1);
  });

  // The id must be the one block application will materialize, or the next
  // transaction names an input that never exists.
  it('holds the id block application derives for the karma change', () => {
    const built = buildInviteTx(cfg, confirmed, recipient, 0, ERA);
    // Typed rather than inline: `computeCandidateBoxId` takes the shared
    // `BoxCandidate` base, so an object literal carrying `owner` is an excess
    // property at the call site.
    const change: CandidateOf<KarmaBox> = {
      boxType: 'karma', value: 750n, createdAtBlock: 0, owner: Buffer.from(pubHex, 'hex'),
    };
    expect(built.change?.boxId).toBe(computeCandidateBoxId(change, built.txId, 0));
  });

  // The property the whole class exists for: the second transaction's input is
  // the first transaction's change output.
  it('chains a second invite onto the first one\'s change', () => {
    const chain = new PendingChain();
    const first = buildInviteTx(cfg, confirmed, recipient, 0, ERA);
    chain.advance(first);
    const next = buildInviteTx(cfg, chain.view(confirmed), second, 0, ERA);
    expect(next.tx.inputs).toEqual([first.change!.boxId]);
    expect(next.changeValue).toBe(500n);
  });

  it('chains a third time from its own tip', () => {
    const chain = new PendingChain();
    chain.advance(buildInviteTx(cfg, confirmed, recipient, 0, ERA));
    const secondTx = buildInviteTx(cfg, chain.view(confirmed), second, 0, ERA);
    chain.advance(secondTx);
    const view = chain.view(confirmed);
    expect(view[0]!.value).toBe(500n);
    expect(view[0]!.boxId).toBe(secondTx.change!.boxId);
  });

  it('falls back to the confirmed view after a reset', () => {
    const chain = new PendingChain();
    chain.advance(buildInviteTx(cfg, confirmed, recipient, 0, ERA));
    chain.reset();
    expect(chain.view(confirmed)).toEqual(confirmed);
  });

  // An exact spend emits no change output, so there is nothing to chain from
  // and the next request reads the confirmed set.
  it('holds no tip when the transaction emits no change', () => {
    const chain = new PendingChain();
    chain.advance(buildCreditTransferTx(cfg, [{ boxId: C1, value: 1n }], recipient, 0, ERA));
    expect(chain.view(confirmed)).toEqual(confirmed);
  });

  // NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes":
  // the invite consumed the own box and left the income box unspent, so the
  // next request sees the pending change beside that income.
  it('names the pending change and takes the income only when the change does not cover the bond', () => {
    const chain = new PendingChain();
    // The first invite spends an own box of 260 against a bond of 250 and
    // KARMA_MINIMUM of 10, leaving 10 as pending change (own, unmarked).
    const first = buildInviteTx(cfg, [own(OWN_ID, 260n)], recipient, 0, ERA);
    chain.advance(first);
    // The confirmed view still carries the income box the invite did not touch.
    const incomeBox = income(INCOME_ID, 500n);
    const second = buildInviteTx(cfg, chain.view([incomeBox]), 'bb'.repeat(32), 0, ERA);
    expect(second.tx.inputs).toEqual([first.change!.boxId, INCOME_ID]);
  });

  // The counter-case: the pending change alone covers the bond, so the next
  // invite names the change and leaves the income box alone.
  it('leaves the income box alone when the pending change covers the bond', () => {
    const chain = new PendingChain();
    const first = buildInviteTx(cfg, [own(OWN_ID, 1000n)], recipient, 0, ERA);
    chain.advance(first);
    const incomeBox = income(INCOME_ID, 500n);
    const second = buildInviteTx(cfg, chain.view([incomeBox]), 'bb'.repeat(32), 0, ERA);
    expect(second.tx.inputs).toEqual([first.change!.boxId]);
  });

  // The node confirmed the pending invite: the box the chain holds under its
  // tip id is now the own box the confirmed list reports. The view must name
  // that box once, not twice.
  it.fails('answers one own box when the confirmed list catches up with the tip', () => {
    const chain = new PendingChain();
    const first = buildInviteTx(cfg, [own(K1, 1000n)], recipient, 0, ERA);
    chain.advance(first);
    const incomeBox = income(INCOME_ID, 500n);
    const view = chain.view([own(first.change!.boxId, 750n), incomeBox]);
    expect(view).toHaveLength(2);
    expect(view.filter((b) => b.income !== true)).toHaveLength(1);
    expect(view.filter((b) => b.income === true)).toHaveLength(1);
    const next = buildInviteTx(cfg, view, second, 0, ERA);
    expect(next.tx.inputs).toContain(first.change!.boxId);
  });

  // The whole round, through the builder: invite 1 from a confirmed own box,
  // invite 2 while 1 is pending, then the confirmed list catches up with both
  // and invite 3 names 2's change.
  it.fails('names the latest change on a third invite after the confirmed list catches up with both', () => {
    const chain = new PendingChain();
    const start = [own(K1, 1000n)];
    const first = buildInviteTx(cfg, start, recipient, 0, ERA);
    chain.advance(first);
    const secondTx = buildInviteTx(cfg, chain.view(start), second, 0, ERA);
    expect(secondTx.tx.inputs).toEqual([first.change!.boxId]);
    chain.advance(secondTx);
    const confirmedBoth = [own(secondTx.change!.boxId, 500n)];
    const thirdTx = buildInviteTx(cfg, chain.view(confirmedBoth), 'cc'.repeat(32), 0, ERA);
    expect(thirdTx.tx.inputs).toEqual([secondTx.change!.boxId]);
  });

  // A zero-change invite consumes the own box exactly against the bond and
  // leaves no change — the tip stays null, and the confirmed list still listing
  // the spent box does not bring it back.
  it('keeps the spent box out of the view on a zero-change invite until confirmed drops it', () => {
    const chain = new PendingChain();
    const own250 = own(OWN_ID, 250n);
    const income10 = income(INCOME_ID, 10n);
    const first = buildInviteTx(cfg, [own250, income10], recipient, 0, ERA);
    expect(first.change).toBeNull();
    chain.advance(first);
    expect(chain.view([own250, income10])).toEqual([income10]);
    expect(chain.view([income10])).toEqual([income10]);
  });

  // The chain consumed the income box; while the confirmed list still carries
  // its old id, the view excludes it, and a new income under a new id — the
  // node paid the faucet again — joins the view beside the tip.
  it('keeps a consumed income out of the view and admits a new income under a new id', () => {
    const chain = new PendingChain();
    const own200 = own(OWN_ID, 200n);
    const incomeOld = income(INCOME_ID, 500n);
    const first = buildInviteTx(cfg, [own200, incomeOld], recipient, 0, ERA);
    expect(first.changeValue).toBe(450n);
    chain.advance(first);
    expect(chain.view([own200, incomeOld])).toEqual([first.change]);
    const incomeNew = income('77'.repeat(32), 300n);
    expect(chain.view([incomeNew])).toEqual([first.change, incomeNew]);
  });

  // The chain remembers only what the node still holds: once the confirmed
  // list no longer lists a consumed id, a later box reusing that id is not
  // filtered out.
  it.fails('forgets a consumed id once the confirmed list no longer lists it', () => {
    const chain = new PendingChain();
    const own250 = own(OWN_ID, 250n);
    const income10 = income(INCOME_ID, 10n);
    const first = buildInviteTx(cfg, [own250, income10], recipient, 0, ERA);
    chain.advance(first);
    chain.view([income10]);
    const reused = own(OWN_ID, 999n);
    expect(chain.view([reused, income10])).toEqual([reused, income10]);
  });
});
