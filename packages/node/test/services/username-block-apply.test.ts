// NODE_INTERFACE → Username transition rules: the block-level rules that
// validateTx alone cannot see — the double claim and the settlement's price leg.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  USERNAME_BURN_PRICE,
} from '@dagsocial/types';
import type { KarmaBox, UsernameBox, UtxoTransaction } from '@dagsocial/types';
import {
  makeKarmaBox,
  makeTestIdentity,
  signTransaction,
  makeApplicableBlock,
  seedKarmaPoolBox,
  activateProverOverStore,
  type TestIdentity,
} from '../helpers.js';

const hex = (id: Uint8Array): string => Buffer.from(id).toString('hex');

async function importDb() { return import('../../src/store/db.js'); }
async function importUtxo() { return import('../../src/store/utxo.js'); }
async function importUsernames() { return import('../../src/store/usernames.js'); }

function claimTx(
  holder: TestIdentity,
  karmaBox: KarmaBox,
  name: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { boxType: 'karma', value: karmaBox.value, createdAtBlock: 0, owner: holder.userId } as never,
      { boxType: 'username', value: 0n, createdAtBlock: 0, owner: holder.userId, name: Buffer.from(name, 'utf8') } as never,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, holder.privateKey, hex(holder.userId));
  return tx;
}

function burnTx(
  holder: TestIdentity,
  karmaBox: KarmaBox,
  usernameBox: { id?: string; owner: Uint8Array; name: Uint8Array },
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!, usernameBox.id!],
    outputs: [
      { boxType: 'karma', value: karmaBox.value - USERNAME_BURN_PRICE, createdAtBlock: 0, owner: holder.userId } as never,
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 0 } as never,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, holder.privateKey, hex(holder.userId));
  return tx;
}

describe('username block-level rules', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  // NODE_INTERFACE → Username transition rules: "the first claim of a canonical
  // name wins. A second claim of the same name — or a second claim by the same
  // identity — fails its absence check and the block is invalid."

  it('two claims of the same canonical name in one block — the block is invalid', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const a = makeTestIdentity();
    const b = makeTestIdentity();
    const karmaA = makeKarmaBox(100n, a.userId, 0, 1);
    const karmaB = makeKarmaBox(100n, b.userId, 0, 2);
    utxo.insertBox(karmaA);
    utxo.insertBox(karmaB);
    await activateProverOverStore();

    const blockApply = await import('../../src/services/block-apply.js');

    const block = await makeApplicableBlock({
      utxoTxs: [claimTx(a, karmaA, 'Alice'), claimTx(b, karmaB, 'alice')],
    });

    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Neither applied: both karma boxes still unspent.
    expect(utxo.getBox(karmaA.id!)).not.toBeNull();
    expect(utxo.getBox(karmaB.id!)).not.toBeNull();
  });

  it('one identity claiming two different names in one block — the block is invalid', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const a = makeTestIdentity();
    const karmaA = makeKarmaBox(100n, a.userId, 0, 3);
    const karmaA2 = makeKarmaBox(100n, a.userId, 0, 4);
    utxo.insertBox(karmaA);
    utxo.insertBox(karmaA2);
    await activateProverOverStore();

    const blockApply = await import('../../src/services/block-apply.js');

    const block = await makeApplicableBlock({
      utxoTxs: [claimTx(a, karmaA, 'First'), claimTx(a, karmaA2, 'Second')],
    });

    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    expect(utxo.getBox(karmaA.id!)).not.toBeNull();
    expect(utxo.getBox(karmaA2.id!)).not.toBeNull();
  });

  // NODE_INTERFACE → The settlement transaction: the settlement consumes a
  // burn's KarmaPriceBox and returns its value to the pool.

  it('a burn\'s KarmaPriceBox is consumed by the settlement and its value returned to the pool', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();
    const utxo = await importUtxo();
    const usernames = await importUsernames();

    const holder = makeTestIdentity();

    // Step 1: claim a name in a real applied block so the box, the record and
    // the prover all agree.
    const karmaForClaim = makeKarmaBox(200n, holder.userId, 0, 5);
    utxo.insertBox(karmaForClaim);
    await activateProverOverStore();
    const blockApply = await import('../../src/services/block-apply.js');

    const claimBlock = await makeApplicableBlock({
      utxoTxs: [claimTx(holder, karmaForClaim, 'Burnable')],
    });
    expect(blockApply.applyOrderingBlock(claimBlock)).toBe(true);

    // Verify the claim applied.
    const row = usernames.getUsername('burnable');
    expect(row).not.toBeNull();

    // Find the username box and the karma change from the claim.
    const { getKarmaPoolBox } = await import('../../src/store/utxo.js');
    const poolBefore = getKarmaPoolBox()!.value;

    // The owner's karma after the claim (the change box).
    const karmaAfterClaim = utxo.getKarmaBox(holder.userId)!;
    const uBox = utxo.getBox(row!.boxId)! as UsernameBox;

    // Step 2: burn the name in the next block.
    const burnBlock = await makeApplicableBlock({
      height: 2,
      utxoTxs: [burnTx(holder, karmaAfterClaim, uBox)],
    });
    expect(blockApply.applyOrderingBlock(burnBlock)).toBe(true);

    const poolAfter = getKarmaPoolBox()!.value;
    expect(poolAfter - poolBefore).toBe(USERNAME_BURN_PRICE);

    expect(usernames.getUsername('burnable')).toBeNull();
    expect(usernames.getUsernameByOwner(holder.userId)).toBeNull();
  });
});
