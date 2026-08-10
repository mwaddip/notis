// ---------------------------------------------------------------------------
// /status → bond commit: the served probation window and the window the engine
// requires are the same number, on a network where they are not 1000.
//
// The two halves of this unit only mean something together. Serving
// `inviteProbationBlocks` is inert if the UI keeps its own constant; making the
// UI read the field is inert if the node does not send it. So this walks the
// whole path the UI walks — serve `/status`, read the field off the JSON with
// `loadStatus()`'s own expression, do `buildCommitTx`'s
// `currentBlockHeight + INVITE_PROBATION_BLOCKS` arithmetic, submit — and runs
// it on devnet, the only network where the served value and the UI's former
// constant disagree.
//
// `utxo-engine` reads the config singleton at module scope, so each leg
// re-imports the module graph under its own NETWORK_TYPE.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import http from 'http';
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  computeTxId,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  InviteBox,
  UtxoTransaction,
} from '@dagsocial/types';

/** The window `public/index.html` shipped as a constant before it read /status. */
const UI_FORMER_CONSTANT = 1000;

interface TestKeys {
  pub: Uint8Array;
  priv: KeyObject;
}

/** One module universe, re-imported per leg under that leg's NETWORK_TYPE. */
async function importUniverse() {
  const [configModule, store, engine, blocksRoute, helpers] = await Promise.all([
    import('../../src/config.js'),
    import('../../src/store/index.js'),
    import('../../src/services/utxo-engine.js'),
    import('../../src/routes/blocks.js'),
    import('../helpers.js'),
  ]);
  return { config: configModule.config, store, engine, blocksRoute, helpers };
}

type Universe = Awaited<ReturnType<typeof importUniverse>>;

/**
 * Serve `/status` from this leg's config through the real router and return the
 * parsed JSON — the bytes the UI's `fetch(API + '/status')` receives.
 */
async function fetchStatus(u: Universe): Promise<Record<string, unknown>> {
  const app = express();
  app.use(
    u.blocksRoute.createRouter({
      getOrderingBlock: () => null,
      getCurrentHeight: () => 0,
      getPostCount: () => 0,
      getPendingPostCount: () => 0,
      getTotalKarma: () => 0n,
      getTotalCredits: () => 0n,
      // Wired exactly as `server.ts` wires it.
      networkType: u.config.networkType,
      inviteProbationBlocks: u.config.inviteProbationBlocks,
    }),
  );

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      http
        .request({ hostname: 'localhost', port, path: '/status', method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            server.close();
            try {
              resolve(JSON.parse(body) as Record<string, unknown>);
            } catch (err) {
              reject(err);
            }
          });
        })
        .end();
    });
  });
}

describe('devnet: the probation window /status serves is the one utxo-engine requires', () => {
  let universe: Universe;
  let inviter: TestKeys;
  let invitee: TestKeys;
  let secret: Uint8Array;
  let secretHash: Uint8Array;

  function makeKeys(): TestKeys {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { pub: universe.helpers.rawPublicKey(publicKey), priv: privateKey };
  }

  function addSignature(tx: UtxoTransaction, keys: TestKeys): void {
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(keys.pub).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, keys.priv),
    );
  }

  /**
   * An invite + uncommitted bond as outputs 0 and 1 of one synthetic tx. The
   * nonce separates independent pairs: `seedAsOneTx` derives one deterministic
   * txId per call, so two pairs at the same nonce collide on
   * `(tx_id, output_index)`.
   */
  function seedInviteAndUncommittedBond(nonce: number): BondBox {
    const [invite, bond] = universe.helpers.seedAsOneTx(
      [
        {
          boxType: 'invite' as const,
          value: INVITE_KARMA_AMOUNT,
          secretHash,
          inviterId: inviter.pub,
          guard: 'hash_preimage_with_bond' as const,
        },
        {
          boxType: 'bond' as const,
          value: INVITE_BOND_KARMA,
          inviterId: inviter.pub,
          inviteOutputIndex: 0,
          inviteePublicKey: new Uint8Array(0),
          probationStartBlock: 0,
          probationEndBlock: 0,
          guard: 'bond_dual' as const,
        },
      ],
      1,
      nonce,
    );
    universe.store.insertBox(invite as InviteBox);
    universe.store.insertBox(bond as BondBox);
    return bond as BondBox;
  }

  /** `buildCommitTx` (index.html), with the window the UI would compute. */
  function uiCommitTx(bond: BondBox, currentBlockHeight: number, window: number): UtxoTransaction {
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: INVITE_BOND_KARMA,
      inviterId: inviter.pub,
      inviteOutputIndex: 0,
      inviteePublicKey: invitee.pub,
      probationStartBlock: currentBlockHeight,
      probationEndBlock: currentBlockHeight + window,
      guard: 'bond_dual',
    };
    const tx: UtxoTransaction = {
      inputs: [bond.id!],
      outputs: [bondOut],
      signatures: {},
      preimages: { [bond.id!]: secret },
      protocolVersion: 1,
    };
    addSignature(tx, invitee);
    return tx;
  }

  function makeDeps() {
    const db = universe.store.getDb();
    return {
      getBox: (id: string): AnyBox | null => {
        const box = universe.store.getBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getBoxByProvenance: universe.store.getBoxByProvenance,
      insertBox: (box: AnyBox) => universe.store.insertBox(box),
      consumeBox: (id: string, atBlock: number) => universe.store.consumeBox(id, atBlock),
      getKarmaBox: universe.store.getKarmaBox,
      getKarmaValue: (owner: Uint8Array): bigint =>
        universe.store.getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: universe.store.hasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  /** Bring up a leg on `networkType`: fresh module graph, fresh in-memory DB. */
  async function bootNetwork(networkType: string): Promise<void> {
    process.env['NETWORK_TYPE'] = networkType;
    vi.resetModules();
    universe = await importUniverse();
    universe.store.initDb(':memory:');
    inviter = makeKeys();
    invitee = makeKeys();
    secret = new Uint8Array(Buffer.from('c'.repeat(64), 'hex'));
    secretHash = new Uint8Array(
      createHash('blake2b512').update(Buffer.from(secret)).digest().subarray(0, 32),
    );
  }

  beforeEach(() => {
    delete process.env['NETWORK_TYPE'];
    vi.resetModules();
  });

  afterEach(() => {
    universe?.store.closeDb();
    delete process.env['NETWORK_TYPE'];
    vi.resetModules();
  });

  it('a commit built from the served window is accepted, and the UI\'s former constant is not', async () => {
    await bootNetwork('devnet');

    // What the UI receives, and the expression `loadStatus()` assigns with.
    const status = await fetchStatus(universe);
    const served = (status['inviteProbationBlocks'] as number) || UI_FORMER_CONSTANT;

    // Devnet is the network the two disagree on — without that this test would
    // pass on a UI that never read the field.
    expect(status['networkType']).toBe('devnet');
    expect(served).toBe(10);
    expect(served).not.toBe(UI_FORMER_CONSTANT);

    const height = 10;

    const accepted = universe.engine.validateTx(
      makeDeps(),
      uiCommitTx(seedInviteAndUncommittedBond(0), height, served),
      height,
    );
    expect(accepted.valid).toBe(true);
    expect(accepted.error).toBeUndefined();

    // The same transaction, differing only in the window: what a UI still
    // holding the constant would have sent to this node.
    const rejected = universe.engine.validateTx(
      makeDeps(),
      uiCommitTx(seedInviteAndUncommittedBond(1), height, UI_FORMER_CONSTANT),
      height,
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.error).toContain('Invalid bond commit');
    // The engine names the window it wants, and it is the number /status
    // served — which is the agreement, stated by the two halves independently.
    expect(rejected.error).toContain(`exactly ${served} blocks`);
  });

  it('testnet serves 1000, so its commits are unaffected', async () => {
    // The profile change is devnet-only: testnet inherits these five fields
    // from mainnet by spread, so the served value equals the former constant
    // and a UI on either source agrees with the node.
    await bootNetwork('testnet');

    const status = await fetchStatus(universe);
    const served = (status['inviteProbationBlocks'] as number) || UI_FORMER_CONSTANT;
    expect(served).toBe(UI_FORMER_CONSTANT);

    const height = 10;
    const result = universe.engine.validateTx(
      makeDeps(),
      uiCommitTx(seedInviteAndUncommittedBond(0), height, served),
      height,
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
