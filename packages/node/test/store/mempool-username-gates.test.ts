// MEMPOOL_INTERFACE → Correctness gates — hasPendingClaim, hasPendingClaimBy
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/store/index.js';
import { hasPendingClaim, hasPendingClaimBy } from '../../src/store/mempool.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('mempool username claim gates', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notis-mpool-uname-'));
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hasPendingClaim returns false for empty pool', () => {
    expect(hasPendingClaim('alice')).toBe(false);
  });

  it('hasPendingClaimBy returns false for empty pool', () => {
    expect(hasPendingClaimBy('aa'.repeat(32))).toBe(false);
  });

  it('finds a pending claim by canonical name', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO mempool (entry_type, expires_at_height, username_lower, username_claimant)
       VALUES ('utxo_tx', 100, 'alice', ?)`,
    ).run('aa'.repeat(32));

    expect(hasPendingClaim('alice')).toBe(true);
    expect(hasPendingClaim('bob')).toBe(false);
  });

  it('finds a pending claim by claimant id', () => {
    const claimant = 'aa'.repeat(32);
    expect(hasPendingClaimBy(claimant)).toBe(true);
    expect(hasPendingClaimBy('bb'.repeat(32))).toBe(false);
  });
});
