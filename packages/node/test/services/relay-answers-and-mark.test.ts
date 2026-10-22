// NODE_INTERFACE → Relay handlers (mempool-based); NET_INTERFACE → Stage 1 →
// "A transaction's signatures are checked at Stage 1"; NODE_INTERFACE →
// Refused headers.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { MAX_BLOCK_BODY_BYTES } from '@dagsocial/types';
import type { OrderingBlock, UtxoTransaction } from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import {
  liveProver,
  makeApplicableBlock,
  makeCreditBox,
  makeCreditTx,
  makeTestConfig,
  makeTestIdentity,
} from '../helpers.js';

const testConfig = makeTestConfig({
  port: 3000,
  dbPath: ':memory:',
  networkType: 'testnet' as const,
  nodeRole: 'miner' as const,
  blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
  orderingBlockPowTargetBits: 3072,
  bootstrapPeers: [] as string[],
  listenAddrs: '/ip4/127.0.0.1/tcp/0',
  maxPeers: 50,
});
void testConfig;

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

/**
 * Deliver a block as a gossiped block through the intake and answer `true`
 * iff the apply moved the tip. The intake admits the header, binds, stages
 * and applies by extension; the verdict reaches the deliverer through the
 * intake's log and the applied-tip read (NODE_INTERFACE → Fork choice
 * decides on verified headers).
 */
async function deliverRelay(
  block: OrderingBlock,
  fromPeerId: string,
): Promise<boolean> {
  const { config } = await import('../../src/config.js');
  const intake = await import('../../src/services/intake.js');
  const headerPipeline = await import('../../src/services/header-pipeline.js');
  const difficulty = await import('../../src/services/difficulty.js');
  const { getCurrentHeight, getLowestJournalHeight } = await import('../../src/store/index.js');
  if (!intake.isIntakeInitialized()) {
    intake.initIntake(
      {
        penalize: () => {},
        chainMoved: () => {},
        needHeaders: () => {},
      },
      {
        params: difficulty.retargetParams(),
        schedule: config.protocolVersionSchedule,
        nowMs: difficulty.nowMs,
        maxReorgDepth: config.maxReorgDepth,
        genesisId: config.profile.genesisId,
        lowestJournalHeight: () => getLowestJournalHeight(),
        appliedTipHeight: () => getCurrentHeight(),
        canExtendAppliedTipAsBlockInHand: intake.canExtendAppliedTipAsBlockInHand,
      },
    );
  }
  void headerPipeline;
  const before = getCurrentHeight();
  await intake.deliverGossipedBlock(fromPeerId, block);
  return getCurrentHeight() > before;
}

async function importBlockApply() {
  return (await import('../../src/services/block-apply.js')) as unknown as {
    applyOrderingBlock: (block: OrderingBlock) => boolean;
    applyOrderingBlockVerdict: (block: OrderingBlock) => (
      | { applied: true; indexed: Array<{ postId: string; parentRefCount: number }> }
      | { applied: false; class: string; detail?: string }
    );
  };
}

async function importOrdering() {
  return (await import('../../src/store/ordering.js')) as {
    getCurrentHeight: () => number;
    getOrderingBlock: (height: number) => OrderingBlock | null;
    getOrderingBlockHash: (height: number) => string | null;
  };
}

async function importRefusedHeaders() {
  return await import('../../src/store/refused-headers.js');
}


async function initChainStore(): Promise<void> {
  const db = await importDb();
  db.initDb(':memory:');
  db.getDb()
    .prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)')
    .run();
}

async function storeWithCredit() {
  await initChainStore();
  const utxo = await import('../../src/store/utxo.js');
  const sender = makeTestIdentity();
  const box = makeCreditBox(10n * 10n ** 8n, sender.userId, 0, 1);
  utxo.insertBox(box);
  await liveProver();
  return { sender, box };
}

/** `handleRelayedTx` drive — the handler's return and the pool after. */
async function relay(tx: UtxoTransaction): Promise<{
  returned: unknown;
  pooled: number;
  warned: string[];
}> {
  const { handleRelayedTx } = await import('../../src/services/handle-tx.js');
  const warned: string[] = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warned.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const returned = handleRelayedTx(tx, undefined, 'peer-relay');
  const mempool = await import('../../src/store/mempool.js');
  return { returned, pooled: mempool.getPendingEntries(10).length, warned };
}

describe('the relay handler answers whether it admitted the transaction', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importDb()).closeDb();
    vi.doUnmock('../../src/config.js');
    vi.doUnmock('../../src/store/mempool.js');
    vi.doUnmock('../../src/services/admit-tx.js');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('an admitted transaction answers true', async () => {
    const { sender, box } = await storeWithCredit();
    const tx = makeCreditTx(sender, [box], 1n);

    const run = await relay(tx);

    expect(run.pooled).toBe(1);
    expect(run.returned).toBe(true);
  });

  it('a rules refusal answers false', async () => {
    const { sender } = await storeWithCredit();
    // An input the store has never seen — the rules refuse admission.
    const absent = makeCreditBox(1n * 10n ** 8n, sender.userId, 0, 999);
    const tx = makeCreditTx(sender, [absent], 1n);

    const run = await relay(tx);

    expect(run.pooled).toBe(0);
    expect(run.returned).toBe(false);
  });

  it('a full pool answers false', async () => {
    vi.doMock('../../src/services/admit-tx.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/services/admit-tx.js')>();
      const { MempoolFullError } = await import('../../src/store/mempool.js');
      return {
        ...actual,
        admitTx: () => {
          throw new MempoolFullError(0);
        },
      };
    });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1n));

    expect(run.pooled).toBe(0);
    expect(run.returned).toBe(false);
  });

  it('a pending-spend conflict answers false', async () => {
    vi.doMock('../../src/services/admit-tx.js', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../../src/services/admit-tx.js')>();
      const { PendingSpendConflictError } = await import('../../src/store/mempool.js');
      return {
        ...actual,
        admitTx: () => {
          throw new PendingSpendConflictError('pending spend');
        },
      };
    });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1n));

    expect(run.pooled).toBe(0);
    expect(run.returned).toBe(false);
  });

  it('a policy refusal answers false', async () => {
    vi.doMock('../../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../src/config.js')>();
      return {
        ...actual,
        config: Object.freeze({ ...actual.config, minFeeRatePerByte: 10n ** 6n }),
      };
    });
    const { sender, box } = await storeWithCredit();

    const run = await relay(makeCreditTx(sender, [box], 1n));

    expect(run.pooled).toBe(0);
    expect(run.warned.some((l) => l.startsWith('Relayed tx refused: Fee rate below'))).toBe(
      true,
    );
    expect(run.returned).toBe(false);
  });

  it('a conflicting relayed arrival at a full credit class leaves the pool unchanged', async () => {
    // MEMPOOL_INTERFACE → insertUtxoTx → "The conflict gate runs before the
    // capacity gate.". The relay reaches the pool with the arrival (its
    // validation reads only the confirmed set), the credit class is full,
    // and the arrival outbids the cheapest resident — the conflict gate
    // refuses before anything moves.
    const { sender, box } = await storeWithCredit();
    const mempool = await import('../../src/store/mempool.js');
    mempool.setMempoolCap(2); // one credit slot

    const resident = makeCreditTx(sender, [box], 1n);
    mempool.insertUtxoTx(resident, 100);

    const before = mempool.getPendingEntries(10);
    expect(before).toHaveLength(1);
    const residentRowid = before[0]!.rowid;

    // Controls: credit class full with one resident.
    const db = (await importDb()).getDb();
    const row = db.prepare('SELECT COUNT(*) AS n FROM mempool WHERE tx_fee IS NOT NULL')
      .get() as { n: number };
    expect(row.n).toBe(1);

    const arrival = makeCreditTx(sender, [box], 2n);
    const run = await relay(arrival);

    // Control: the arrival passed the relay's validation and reached the
    // pool's insert — the handler's dropped-for-conflict log says so.
    expect(run.warned.some((l) => l.includes('input spent by a pending entry'))).toBe(true);

    expect(run.returned).toBe(false);
    const after = mempool.getPendingEntries(10);
    expect(after).toHaveLength(1);
    expect(after[0]!.rowid).toBe(residentRowid);
  });
});

describe("the relay's signature check answers from the transaction's own map", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importDb()).closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it(
    'a relayed transaction with a signature that would fail Ed25519 verification is admitted',
    async () => {
      // Net's Stage 1 verified every entry of the map before the handler sees
      // it (NET_INTERFACE → Stage 1 → "A transaction's signatures are checked
      // at Stage 1"), so the handler trusts the map and runs no second
      // Ed25519 check (CONSENSUS_INTERFACE → The overlay). A tx whose map
      // carries a signature the real check would refuse therefore admits — if
      // a second verification ran, admission would refuse here.
      const { sender, box } = await storeWithCredit();
      const tx = makeCreditTx(sender, [box], 1n);
      // Replace the signature's bytes with a byte string that no key will
      // verify against this message. Length stays 64 — the envelope's shape
      // check still passes.
      const senderHex = Buffer.from(sender.userId).toString('hex');
      tx.signatures[senderHex] = new Uint8Array(64).fill(0xcc);

      const run = await relay(tx);

      // Admission accepted the transaction — one row in the pool.
      expect(run.pooled).toBe(1);
      expect(run.returned).toBe(true);
    },
  );
});

describe('the funnel answers with a class', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importDb()).closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('a block with an invalid structure gets class unbound', async () => {
    await initChainStore();
    await liveProver();
    const blockApply = await importBlockApply();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // `verifyOrderingBlockStructure` refuses a block whose `utxoTxTree` is
    // not an object — the funnel's first guard, before any field of the
    // block is read.
    const bad = {
      header: null,
      utxoTxTree: null,
      validatorSignature: null,
    } as unknown as OrderingBlock;
    const verdict = blockApply.applyOrderingBlockVerdict(bad);

    expect(verdict.applied).toBe(false);
    expect((verdict as { class: string }).class).toBe('unbound');
  });

  it(
    'a block whose validator signature does not verify gets class unbound',
    async () => {
      await initChainStore();
      const blockApply = await importBlockApply();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const forger = makeTestIdentity();
      const bad = await makeApplicableBlock({ signWith: forger.privateKey });
      const verdict = blockApply.applyOrderingBlockVerdict(bad);

      expect(verdict.applied).toBe(false);
      expect((verdict as { class: string }).class).toBe('unbound');
    },
  );

  it('a block whose body is not its utxoTxRoot gets class unbound', async () => {
    await initChainStore();
    const blockApply = await importBlockApply();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const bad = await makeApplicableBlock({});
    const other = await makeApplicableBlock({});
    const swapped: OrderingBlock = { ...bad, utxoTxTree: other.utxoTxTree };
    const verdict = blockApply.applyOrderingBlockVerdict(swapped);

    expect(verdict.applied).toBe(false);
    expect((verdict as { class: string }).class).toBe('unbound');
  });

  it('a block beyond the future bound gets class acceptance', async () => {
    await initChainStore();
    const blockApply = await importBlockApply();
    const { MAX_FUTURE_DRIFT_MS } = await import('@dagsocial/types');
    const { setClock, nowMs } = await import('../../src/services/difficulty.js');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const now = Date.now();
      setClock(() => now);
      const future = nowMs() + MAX_FUTURE_DRIFT_MS + 60_000;
      const bad = await makeApplicableBlock({ createdAt: future });

      // The clock is captured at the funnel entry; nothing drifts between
      // helper build and apply, so the acceptance verdict is deterministic.
      const verdict = blockApply.applyOrderingBlockVerdict(bad);
      expect(verdict.applied).toBe(false);
      expect((verdict as { class: string }).class).toBe('acceptance');
    } finally {
      setClock(null);
    }
  });
});

describe('a consensus refusal marks the header, nothing else does', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importDb()).closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it(
    'a bound-body consensus refusal marks the header, and a second delivery is a no-op',
    async () => {
      await initChainStore();
      
      const refused = await importRefusedHeaders();
      const warned: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warned.push(args.map(String).join(' '));
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // The body is honest and its root commits it; the stateRoot the header
      // claims is not the digest the body produces — a 'consensus' refusal
      // over a body the root has bound (NODE_INTERFACE → "The funnel answers
      // with a class"). The override must match the header-domain length
      // (`EMPTY_STATE_ROOT` is 33 bytes = 66 hex chars).
      const bad = await makeApplicableBlock({ stateRoot: 'ab'.repeat(33) });
      const hash = blockHash(bad.header);
      if (hash === null) throw new Error('block has an unencodable header');

      const first = await deliverRelay(bad, 'peer-a');
      expect(first).toBe(false);
      expect(refused.anyRefusedHeader([hash])).toBe(true);
      const warnedAfterFirst = warned.filter((l) =>
        l.includes('stateRoot mismatch'),
      ).length;
      expect(warnedAfterFirst).toBe(1);

      // The second delivery — the funnel is not entered. The warn count for
      // the stateRoot mismatch stays at 1.
      const second = await deliverRelay(bad, 'peer-a');
      expect(second).toBe(false);
      const warnedAfterSecond = warned.filter((l) =>
        l.includes('stateRoot mismatch'),
      ).length;
      expect(warnedAfterSecond).toBe(1);
    },
  );

  it(
    'a validator-signature refusal and a body-root refusal are not marked, and the honest block then applies',
    async () => {
      await initChainStore();
      
      const refused = await importRefusedHeaders();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { removeHeaderSubtree } = await import('../../src/store/header-tree.js');

      // Validator signature refusal: forger does the PoW and signs under
      // their own key, which is not the one `validatorId` names.
      const forger = makeTestIdentity();
      const forged = await makeApplicableBlock({ signWith: forger.privateKey });
      const forgedHash = blockHash(forged.header);
      if (forgedHash === null) throw new Error('block has an unencodable header');
      expect(await deliverRelay(forged, 'peer-a')).toBe(false);
      expect(refused.anyRefusedHeader([forgedHash])).toBe(false);
      // The admitted header stays in the tree without a mark; the binding's
      // refusal persists nothing beyond the per-peer penalty. Clear it so
      // the next delivery's header admits as height 1's first (the test's
      // old entry re-ran the funnel directly, which held no header tree).
      removeHeaderSubtree(forgedHash);

      // Body-root refusal: a body belonging to another header rides under
      // this one — `verifyUtxoTxRoot` refuses.
      const bad = await makeApplicableBlock({});
      const other = await makeApplicableBlock({});
      const swapped: OrderingBlock = { ...bad, utxoTxTree: other.utxoTxTree };
      const swappedHash = blockHash(swapped.header);
      if (swappedHash === null) throw new Error('block has an unencodable header');
      expect(await deliverRelay(swapped, 'peer-a')).toBe(false);
      expect(refused.anyRefusedHeader([swappedHash])).toBe(false);
      removeHeaderSubtree(swappedHash);

      // The honest version of this header's own block applies.
      const good = await makeApplicableBlock({});
      expect(await deliverRelay(good, 'peer-a')).toBe(true);
      const ordering = await importOrdering();
      expect(ordering.getCurrentHeight()).toBe(1);
    },
  );

  it(
    'a block beyond the future bound is refused and nothing is marked',
    async () => {
      await initChainStore();
      
      const refused = await importRefusedHeaders();
      const { MAX_FUTURE_DRIFT_MS } = await import('@dagsocial/types');
      const { setClock, nowMs } = await import('../../src/services/difficulty.js');
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const now = Date.now();
        setClock(() => now);
        const future = nowMs() + MAX_FUTURE_DRIFT_MS + 60_000;
        const bad = await makeApplicableBlock({ createdAt: future });
        const hash = blockHash(bad.header);
        if (hash === null) throw new Error('block has an unencodable header');

        expect(await deliverRelay(bad, 'peer-a')).toBe(false);
        expect(refused.anyRefusedHeader([hash])).toBe(false);
      } finally {
        setClock(null);
      }
    },
  );
});

describe('headerStanding answers from the store', () => {
  beforeEach(async () => {
    vi.resetModules();
  });
  afterEach(async () => {
    (await importDb()).closeDb();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it(
    'held for a stored block, refused for a marked hash, null otherwise',
    async () => {
      await initChainStore();
      
      const ordering = await importOrdering();
      const refused = await importRefusedHeaders();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const good = await makeApplicableBlock({});
      expect(await deliverRelay(good, 'peer-a')).toBe(true);
      const heldHash = ordering.getOrderingBlockHash(1);
      expect(heldHash).not.toBeNull();

      const refusedMod = refused as unknown as {
        headerStanding?: (hash: string, height: number) => 'held' | 'refused' | null;
      };
      const headerStanding = refusedMod.headerStanding;
      if (typeof headerStanding !== 'function') {
        throw new Error('headerStanding is not exported');
      }

      // Held at its own height, null at another.
      expect(headerStanding(heldHash!, 1)).toBe('held');
      expect(headerStanding(heldHash!, 2)).toBeNull();
      // Unknown hash → null.
      const unknown = 'ab'.repeat(32);
      expect(headerStanding(unknown, 1)).toBeNull();
      // Marked → 'refused'.
      refused.insertRefusedHeader(unknown, 7, 1);
      expect(headerStanding(unknown, 7)).toBe('refused');
    },
  );
});
