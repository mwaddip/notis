import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeTxId,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  CandidateOf,
  CreditBox,
  UtxoTransaction,
} from '@dagsocial/types';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
import { rawPublicKey } from '../helpers.js';

/**
 * Two chains that differ only in `genesisProofPayload`.
 *
 * **A mint id opens with its chain's genesis proof** (TYPES_INTERFACE →
 * Mint identity; NODE_INTERFACE → Box Identity and Mint Provenance), and
 * **two chains share a genesis box only if they share a payload**: every
 * genesis box id is derived from a mint id whose preimage opens with the
 * chain's payload, so a transaction signed on one names inputs no other
 * holds — **that closes replay at the root** (TYPES_INTERFACE → Domain tags
 * are network-agnostic). The two profiles below name the same key as the
 * `faucetPublicKey`, so the mint subjects on both chains are byte-identical
 * and the only separator is the payload.
 */

interface FaucetKey {
  publicKey: Uint8Array;
  publicKeyHex: string;
  privateKey: KeyObject;
}

/** A fresh Ed25519 identity for the shared faucet role.
 *
 * The node's test tree carries no secret for either network's committed
 * faucet, so a case that spends the faucet's genesis credit box has to seed
 * one it already holds the secret for. The `faucetPublicKey` is one of the
 * two profile fields these cases override; the other is
 * `genesisProofPayload`. */
function makeFaucetKey(): FaucetKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = rawPublicKey(publicKey);
  return {
    publicKey: pub,
    publicKeyHex: Buffer.from(pub).toString('hex'),
    privateKey,
  };
}

async function importFresh() {
  const db = await import('../../src/store/db.js');
  const genesis = await import('../../src/services/genesis-state.js');
  const prover = await import('../../src/state/avl-prover.js');
  const utxo = await import('../../src/store/utxo.js');
  const mempool = await import('../../src/store/mempool.js');
  const idRecords = await import('../../src/store/identity-records.js');
  const credits = await import('../../src/services/credits.js');
  const karmaAdm = await import('../../src/services/karma-admission.js');
  const configMod = await import('../../src/config.js');
  return {
    ...db,
    genesis,
    prover,
    utxo,
    mempool,
    idRecords,
    credits,
    karmaAdm,
    config: configMod,
  };
}
type Modules = Awaited<ReturnType<typeof importFresh>>;

interface Chain {
  modules: Modules;
  boxes: AnyBox[];
  stateRoot: string;
}

function mockConfig(opts: {
  genesisProofPayload: string;
  faucetPublicKey: string;
  genesisStateRoot: string;
}): void {
  vi.doMock('../../src/config.js', async () => {
    const actual = await vi.importActual<typeof import('../../src/config.js')>(
      '../../src/config.js',
    );
    return {
      ...actual,
      config: {
        ...actual.config,
        profile: {
          ...actual.config.profile,
          genesisProofPayload: opts.genesisProofPayload,
          faucetPublicKey: opts.faucetPublicKey,
          genesisCommitteeKeys: [] as string[],
          genesisStateRoot: opts.genesisStateRoot,
        },
      },
    };
  });
}

/**
 * Seed a chain under devnet's profile with `genesisProofPayload` and
 * `faucetPublicKey` replaced.
 *
 * The profile pins `genesisStateRoot` and the seeder refuses a mismatched
 * one (`services/genesis-state.ts` → `assertGenesisRoot`). The root a profile
 * must pin depends on every seeded byte, so the pin is measured at run time:
 * the seeder is run once under a known-wrong placeholder and the actual
 * seeded root is read out of its refusal, then the config is remocked with
 * the measured value and the seeder runs again.
 */
async function openChain(opts: {
  genesisProofPayload: string;
  faucetPublicKey: string;
}): Promise<Chain> {
  vi.doUnmock('../../src/config.js');
  vi.resetModules();
  mockConfig({
    genesisProofPayload: opts.genesisProofPayload,
    faucetPublicKey: opts.faucetPublicKey,
    genesisStateRoot: 'ab'.repeat(33),
  });

  let measuredRoot: string;
  {
    const m = await importFresh();
    m.initDb(':memory:');
    try {
      m.prover.createAvlProver();
      let message = '';
      try {
        m.genesis.seedGenesisState();
      } catch (err) {
        message = String(err);
      }
      const match = message.match(/seeded ([0-9a-f]+)[,\s]/);
      if (!match) {
        throw new Error(
          `openChain: expected a genesis state root mismatch to report the ` +
            `seeded root, got: ${message}`,
        );
      }
      measuredRoot = match[1]!;
    } finally {
      m.closeDb();
    }
  }

  vi.doUnmock('../../src/config.js');
  vi.resetModules();
  mockConfig({
    genesisProofPayload: opts.genesisProofPayload,
    faucetPublicKey: opts.faucetPublicKey,
    genesisStateRoot: measuredRoot,
  });

  const modules = await importFresh();
  modules.initDb(':memory:');
  modules.prover.createAvlProver();
  modules.genesis.seedGenesisState();
  const boxes = modules.utxo.getUnspentBoxes();
  const digest = modules.prover.getAvlProver().prover.digest();
  if (!digest) throw new Error('openChain: null digest after seeding');
  const stateRoot = Buffer.from(digest).toString('hex');
  return { modules, boxes, stateRoot };
}

function closeChain(chain: Chain): void {
  chain.modules.closeDb();
}

/** `UtxoEngineDeps` built over the chain's fresh module graph — the shape
 *  `server.ts` wires for the HTTP routes, slimmed to what a credit transfer
 *  reads. */
function engineDepsOf(chain: Chain): UtxoEngineDeps {
  const m = chain.modules;
  const decayCfg = {
    staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
    decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  };
  return {
    getBox: m.mempool.getBoxWithPending,
    insertBox: m.utxo.insertBox,
    consumeBox: m.utxo.consumeBox,
    getKarmaValue: m.utxo.getKarmaValue,
    getKarmaOwed: m.karmaAdm.admissionOwed(decayCfg),
    getOwnKarmaBoxIds: (owner: Uint8Array) =>
      m.utxo
        .getKarmaBoxes(owner)
        .filter((b) => b.income !== true)
        .map((b) => b.id!),
    getIdentityRecord: m.idRecords.getIdentityRecord,
    hasActiveVouchEscrow: () => false,
    vouchCooldownBlocks: m.config.config.vouchCooldownBlocks,
    inviteBondMin: m.config.config.inviteBondMin,
    inviteBondMax: m.config.config.inviteBondMax,
    decayCfg,
    storageRentPeriodBlocks: m.config.config.storageRentPeriodBlocks,
    getBoxProvenance: () => null,
    getTopologyAuthor: () => null,
    getPendingPostAuthor: () => null,
    runInTransaction: (fn) => fn(),
    getVouchBox: () => null,
    getNetworkRecord: () => ({ memberCount: 1 }),
    membershipBarMultiplier: m.config.config.membershipBarMultiplier,
    putIdentityRecord: () => {},
    protocolVersionSchedule: m.config.config.protocolVersionSchedule,
    getUsername: () => null,
    getUsernameByOwner: () => null,
  };
}

/**
 * Build and sign a one-input one-output credit transfer of the faucet's
 * genesis credit box.
 *
 * The transaction conserves exactly (NODE_INTERFACE → `validateTx` step 7):
 * one credit input, one credit output of the same value, no fee box. A
 * client could build this; what the signature covers is `computeTxId(tx)`
 * (TYPES_INTERFACE → UtxoTransaction).
 */
function buildSignedCreditTransfer(opts: {
  faucet: FaucetKey;
  creditBox: CreditBox;
  recipient: Uint8Array;
}): UtxoTransaction {
  // `createdAtBlock` is the OUTPUT's declared creation height. A transaction's
  // outputs may not be older than its oldest input (TYPES_INTERFACE →
  // Monotonic creation height), and a genesis box is created at height 1
  // (NODE_INTERFACE → The genesis state root is checked fail-stop), so a
  // transfer that keeps that height is not older than its input.
  const output: CandidateOf<CreditBox> = {
    boxType: 'credit',
    value: opts.creditBox.value,
    createdAtBlock: opts.creditBox.createdAtBlock,
    owner: opts.recipient,
  };
  const tx: UtxoTransaction = {
    inputs: [opts.creditBox.id!],
    outputs: [output],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), opts.faucet.privateKey);
  tx.signatures[opts.faucet.publicKeyHex] = new Uint8Array(sig);
  return tx;
}

/** The whole refusal `sendCredits` throws for an input no store holds. */
function inputNotFound(boxId: string): RegExp {
  return new RegExp(
    'Invalid credit transfer: Input box not found or already spent: ' + boxId,
  );
}

const PAYLOAD_A = Buffer.from(
  'dagsocial/notis/genesis-proof-binding/case/a',
  'utf8',
).toString('hex');
const PAYLOAD_B = Buffer.from(
  'dagsocial/notis/genesis-proof-binding/case/b',
  'utf8',
).toString('hex');

describe('two chains differ in genesisProofPayload — the mint id opens with it', () => {
  afterEach(() => {
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  it('seeding twice under one profile gives the same genesis box ids', async () => {
    const faucet = makeFaucetKey();

    const first = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });
    const firstIds = first.boxes.map((b) => b.id!).sort();
    closeChain(first);

    const second = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });
    const secondIds = second.boxes.map((b) => b.id!).sort();
    closeChain(second);

    expect(firstIds.length).toBeGreaterThan(0);
    expect(secondIds).toEqual(firstIds);
  });

  it('a transaction spending a genesis credit box, signed on chain A, is admitted on chain A', async () => {
    const faucet = makeFaucetKey();
    const chain = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });

    const credits = chain.modules.utxo.getCreditBoxes(faucet.publicKey);
    expect(credits).toHaveLength(1);

    const tx = buildSignedCreditTransfer({
      faucet,
      creditBox: credits[0]!,
      recipient: faucet.publicKey,
    });
    // `currentBlockHeight` is the height this would be admitted at; genesis
    // is state at height 0, so block 1 is the next inclusion height
    // (`services/genesis-state.ts` → GENESIS_HEIGHT), and an output of the
    // credit box's own height is not ahead of it.
    const result = chain.modules.credits.sendCredits(engineDepsOf(chain), tx, 1);
    expect(result.status).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));

    closeChain(chain);
  });

  it('a transaction naming a box no store holds is refused — input not found', async () => {
    const faucet = makeFaucetKey();
    const chain = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });
    try {
      const credits = chain.modules.utxo.getCreditBoxes(faucet.publicKey);
      expect(credits).toHaveLength(1);
      const unheldId = 'ab'.repeat(32);
      expect(chain.boxes.map((b) => b.id)).not.toContain(unheldId);

      const tx = buildSignedCreditTransfer({
        faucet,
        creditBox: { ...credits[0]!, id: unheldId },
        recipient: faucet.publicKey,
      });
      expect(() =>
        chain.modules.credits.sendCredits(engineDepsOf(chain), tx, 1),
      ).toThrow(inputNotFound(unheldId));
    } finally {
      closeChain(chain);
    }
  });

  it('chains A and B share no genesis box id', async () => {
    const faucet = makeFaucetKey();

    const a = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });
    const aIds = a.boxes.map((b) => b.id!);
    expect(aIds.length).toBeGreaterThan(0);
    closeChain(a);

    const b = await openChain({
      genesisProofPayload: PAYLOAD_B,
      faucetPublicKey: faucet.publicKeyHex,
    });
    const bIds = b.boxes.map((b) => b.id!);
    expect(bIds.length).toBeGreaterThan(0);
    closeChain(b);

    const aSet = new Set(aIds);
    const shared = bIds.filter((id) => aSet.has(id));
    expect(shared).toEqual([]);
  });

  it('the same transaction, byte for byte, is refused on chain B — input not found', async () => {
    const faucet = makeFaucetKey();

    const a = await openChain({
      genesisProofPayload: PAYLOAD_A,
      faucetPublicKey: faucet.publicKeyHex,
    });
    const aCredits = a.modules.utxo.getCreditBoxes(faucet.publicKey);
    expect(aCredits).toHaveLength(1);
    const tx = buildSignedCreditTransfer({
      faucet,
      creditBox: aCredits[0]!,
      recipient: faucet.publicKey,
    });
    closeChain(a);

    const b = await openChain({
      genesisProofPayload: PAYLOAD_B,
      faucetPublicKey: faucet.publicKeyHex,
    });
    try {
      // The id names a box no store on chain B holds — `validateTx` step 2
      // (NODE_INTERFACE → `validateTx` step 2), wrapped by `sendCredits` as
      // "Invalid credit transfer: ...". The case asserts that refusal, by its
      // whole text.
      expect(() =>
        b.modules.credits.sendCredits(engineDepsOf(b), tx, 1),
      ).toThrow(inputNotFound(tx.inputs[0]!));
    } finally {
      closeChain(b);
    }
  });
});
