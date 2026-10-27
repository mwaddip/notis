import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeTxId, profileFor } from '@dagsocial/types';
import type { CreditBox } from '@dagsocial/types';
import { applyBlock } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  candidateBlock,
  creditSendTx,
  identityRecord,
  karmaBox,
  protocolBox,
  seedProvenance,
  seededIdentity,
} from './helpers.js';

/**
 * `CONSENSUS_INTERFACE → Applying a block → "A transaction's id is hashed once,
 * where its bytes are proven."` The loop hashes each decoded body entry once at
 * `decodeBodyEntry` and the rules the loop runs over the entry read that id;
 * `applyBlock` over N user transactions and its settlement makes N + 1 calls.
 */

const { bumpTxIdCount, readTxIdCount, resetTxIdCount } = vi.hoisted(() => {
  let n = 0;
  return {
    bumpTxIdCount: () => { n += 1; },
    readTxIdCount: () => n,
    resetTxIdCount: () => { n = 0; },
  };
});

vi.mock('@dagsocial/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/types')>();
  return {
    ...actual,
    computeTxId: (tx: unknown): string => {
      bumpTxIdCount();
      return (actual.computeTxId as (tx: unknown) => string)(tx);
    },
  };
});

const CTX = applyContextFor(profileFor('devnet'));
const CREDIT = 10n ** 8n;
const miner = seededIdentity('one-id/miner');
const sa = seededIdentity('one-id/sender-a');
const sb = seededIdentity('one-id/sender-b');
const rcpt = seededIdentity('one-id/recipient');

function viewOf(): { view: MemoryStateView; ca: CreditBox; cb: CreditBox } {
  const view = new MemoryStateView({ memberCount: 0 });
  const ca = seedProvenance<CreditBox>(
    { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: sa.userId },
    0,
    1,
  );
  const cb = seedProvenance<CreditBox>(
    { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: sb.userId },
    0,
    2,
  );
  view.insertBox(ca);
  view.insertBox(cb);
  view.insertBox(karmaBox(sa.userId, 1n, 3, 0));
  view.insertBox(karmaBox(sb.userId, 1n, 4, 0));
  view.putIdentityRecord(sa.userId, identityRecord());
  view.putIdentityRecord(sb.userId, identityRecord());
  view.insertBox(protocolBox('emission', profileFor('devnet').creditEmissionTotal, 5));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, 6));
  return { view, ca, cb };
}

describe('applyBlock hashes each body entry once', () => {
  beforeEach(() => resetTxIdCount());

  it.fails('a block of 2 user transactions and its settlement makes 3 calls under applyBlock', () => {
    const { view, ca, cb } = viewOf();
    const height = 1;
    const txs = [
      creditSendTx(sa, ca, 10n * CREDIT, rcpt.userId, CREDIT, height),
      creditSendTx(sb, cb, 10n * CREDIT, rcpt.userId, CREDIT, height),
    ];
    const block = candidateBlock(view, height, txs, miner.userId, CTX);

    resetTxIdCount();
    computeTxId(txs[0]!.tx);
    expect(readTxIdCount()).toBe(1);
    resetTxIdCount();

    const result = applyBlock(view, block, CTX);
    expect(result.ok).toBe(true);
    expect(readTxIdCount()).toBe(txs.length + 1);
  });
});
