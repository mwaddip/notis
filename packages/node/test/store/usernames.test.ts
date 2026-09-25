// NODE_INTERFACE → Username records
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { BlockEffects } from '@dagsocial/consensus';
import { initDb, closeDb, putUsername, getUsername, getUsernameByOwner, deleteUsername, countUsernames, insertBlockJournal } from '../../src/store/index.js';
import { writeBlockEffects } from '../../src/services/block-apply.js';
import { revertBlock } from '../../src/services/fork-resolution.js';
import type { UsernameRow } from '../../src/store/usernames.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function hexId(): string { return randomBytes(32).toString('hex'); }

describe('usernames store', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-uname-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getUsername returns null for absent name', () => {
    expect(getUsername('alice')).toBeNull();
  });

  it('putUsername inserts and getUsername reads it back', () => {
    const owner = hexId();
    const boxId = hexId();
    putUsername({ nameLower: 'alice', name: 'Alice', owner, boxId, claimedAtBlock: 1 });
    const row = getUsername('alice');
    expect(row).not.toBeNull();
    expect(row!.name).toBe('Alice');
    expect(row!.owner).toBe(owner);
    expect(row!.boxId).toBe(boxId);
    expect(row!.claimedAtBlock).toBe(1);
  });

  it('getUsernameByOwner finds the owner', () => {
    const row = getUsername('alice');
    expect(row).not.toBeNull();
    const byOwner = getUsernameByOwner(row!.owner);
    expect(byOwner).not.toBeNull();
    expect(byOwner!.nameLower).toBe('alice');
  });

  it('getUsernameByOwner accepts UserId (Uint8Array)', () => {
    const row = getUsername('alice');
    expect(row).not.toBeNull();
    const ownerBytes = Buffer.from(row!.owner, 'hex');
    const byOwner = getUsernameByOwner(ownerBytes);
    expect(byOwner).not.toBeNull();
    expect(byOwner!.nameLower).toBe('alice');
  });

  it('countUsernames counts the rows', () => {
    expect(countUsernames()).toBe(1);
  });

  it('deleteUsername removes the row', () => {
    deleteUsername('alice');
    expect(getUsername('alice')).toBeNull();
    expect(countUsernames()).toBe(0);
  });

  it('deleteUsername is a no-op for an absent name', () => {
    deleteUsername('nobody');
  });

  it('owner column is UNIQUE — a second name for the same owner replaces the first', () => {
    const owner = hexId();
    putUsername({ nameLower: 'bob', name: 'Bob', owner, boxId: hexId(), claimedAtBlock: 4 });
    putUsername({ nameLower: 'charlie', name: 'Charlie', owner, boxId: hexId(), claimedAtBlock: 5 });
    expect(getUsername('bob')).toBeNull();
    expect(getUsername('charlie')).not.toBeNull();
    expect(getUsernameByOwner(owner)).not.toBeNull();
    expect(getUsernameByOwner(owner)!.nameLower).toBe('charlie');
  });
});

/** A block's effects for one claim (`row`) or one burn of `row`'s name (`burn`). */
function nameEffects(row: UsernameRow, burn: boolean): BlockEffects {
  const owner = Buffer.from(row.owner, 'hex');
  return {
    mutations: [
      { kind: 'username', nameLower: row.nameLower, row: burn ? null : row, heldBefore: burn },
      { kind: 'holder', owner, record: burn ? null : { claimAvailable: false, boxId: row.boxId }, heldBefore: burn },
    ],
    posts: [],
    likeRecords: [],
    withdrawals: [],
    appliedTxs: [],
  };
}

describe('username journal round-trip', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-uname-journal-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('revertBlock removes the row a claim wrote', () => {
    const row = { nameLower: 'frank', name: 'Frank', owner: hexId(), boxId: hexId(), claimedAtBlock: 4 };
    insertBlockJournal(writeBlockEffects(nameEffects(row, false), 4));
    expect(getUsername('frank')).toEqual(row);

    revertBlock(4);
    expect(getUsername('frank')).toBeNull();
  });

  it('revertBlock restores the row a burn removed', () => {
    const row = { nameLower: 'grace', name: 'Grace', owner: hexId(), boxId: hexId(), claimedAtBlock: 5 };
    putUsername(row);
    insertBlockJournal(writeBlockEffects(nameEffects(row, true), 6));
    expect(getUsername('grace')).toBeNull();

    revertBlock(6);
    const restored = getUsername('grace');
    expect(restored).not.toBeNull();
    expect(restored!.owner).toBe(row.owner);
    expect(restored!.boxId).toBe(row.boxId);
  });
});
