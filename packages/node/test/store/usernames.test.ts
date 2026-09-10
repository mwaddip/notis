// NODE_INTERFACE → Username records
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { initDb, closeDb, putUsername, getUsername, getUsernameByOwner, deleteUsername, countUsernames } from '../../src/store/index.js';
import { beginBlockJournal, finishBlockJournal } from '../../src/store/journal.js';
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
    beginBlockJournal(1);
    putUsername({ nameLower: 'alice', name: 'Alice', owner, boxId, claimedAtBlock: 1 });
    finishBlockJournal();
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
    beginBlockJournal(2);
    deleteUsername('alice');
    finishBlockJournal();
    expect(getUsername('alice')).toBeNull();
    expect(countUsernames()).toBe(0);
  });

  it('deleteUsername is a no-op for an absent name', () => {
    beginBlockJournal(3);
    deleteUsername('nobody');
    finishBlockJournal();
  });

  it('owner column is UNIQUE — a second name for the same owner replaces the first', () => {
    const owner = hexId();
    beginBlockJournal(4);
    putUsername({ nameLower: 'bob', name: 'Bob', owner, boxId: hexId(), claimedAtBlock: 4 });
    finishBlockJournal();
    beginBlockJournal(5);
    putUsername({ nameLower: 'charlie', name: 'Charlie', owner, boxId: hexId(), claimedAtBlock: 5 });
    finishBlockJournal();
    expect(getUsername('bob')).toBeNull();
    expect(getUsername('charlie')).not.toBeNull();
    expect(getUsernameByOwner(owner)).not.toBeNull();
    expect(getUsernameByOwner(owner)!.nameLower).toBe('charlie');
  });
});

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

  it('putUsername records both mutations', () => {
    beginBlockJournal(1);
    const owner = hexId();
    putUsername({ nameLower: 'dave', name: 'Dave', owner, boxId: hexId(), claimedAtBlock: 1 });
    const journal = finishBlockJournal();
    const kinds = journal.mutations.map(m => m.kind);
    expect(kinds).toContain('username');
    expect(kinds).toContain('holder');
  });

  it('deleteUsername records both removal mutations', () => {
    const owner = hexId();
    beginBlockJournal(2);
    putUsername({ nameLower: 'eve', name: 'Eve', owner, boxId: hexId(), claimedAtBlock: 2 });
    finishBlockJournal();

    beginBlockJournal(3);
    deleteUsername('eve');
    const journal = finishBlockJournal();
    const uMut = journal.mutations.find(m => m.kind === 'username');
    const hMut = journal.mutations.find(m => m.kind === 'holder');
    expect(uMut).toBeDefined();
    expect(hMut).toBeDefined();
    expect((uMut as any).row).toBeNull();
    expect((uMut as any).replaced).toBeDefined();
    expect((hMut as any).record).toBeNull();
    expect((hMut as any).replaced).toBeDefined();
  });

  it('rollback restores the prior row after a claim', () => {
    const owner = hexId();
    beginBlockJournal(4);
    putUsername({ nameLower: 'frank', name: 'Frank', owner, boxId: hexId(), claimedAtBlock: 4 });
    const journal = finishBlockJournal();

    // Manually reverse
    for (let i = journal.mutations.length - 1; i >= 0; i--) {
      const m = journal.mutations[i]!;
      if (m.kind === 'username') {
        if (m.replaced !== undefined) putUsername(m.replaced);
        else deleteUsername(m.nameLower);
      }
    }
    expect(getUsername('frank')).toBeNull();
  });

  it('rollback restores the prior row after a burn', () => {
    const owner = hexId();
    const boxId = hexId();
    beginBlockJournal(5);
    putUsername({ nameLower: 'grace', name: 'Grace', owner, boxId, claimedAtBlock: 5 });
    finishBlockJournal();

    beginBlockJournal(6);
    deleteUsername('grace');
    const journal = finishBlockJournal();

    // Manually reverse — no journal open, as fork-resolution does
    for (let i = journal.mutations.length - 1; i >= 0; i--) {
      const m = journal.mutations[i]!;
      if (m.kind === 'username') {
        if (m.replaced !== undefined) {
          putUsername(m.replaced);
        }
      }
    }
    const restored = getUsername('grace');
    expect(restored).not.toBeNull();
    expect(restored!.owner).toBe(owner);
    expect(restored!.boxId).toBe(boxId);
  });
});
