import { describe, it, expect } from 'vitest';
import { computeCandidateBoxId } from '@dagsocial/types';
import type { CandidateOf, KarmaBox } from '@dagsocial/types';
import { PendingChain } from '../src/pending.js';
import { buildInviteTx } from '../src/invite.js';
import { buildCreditTransferTx } from '../src/transfer.js';
import { C1, ERA, K1, baseCfg as cfg, pubHex, recipient } from './fixture.js';

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
});
