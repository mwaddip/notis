import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

async function importDb() {
  return (await import('../../src/store/db.js')) as {
    initDb: (path: string) => void;
    getDb: () => Database.Database;
    closeDb: () => void;
  };
}

async function importRefusedHeaders() {
  return (await import('../../src/store/refused-headers.js')) as {
    insertRefusedHeader: (hash: string, height: number, refusedAt: number) => void;
    anyRefusedHeader: (hashes: string[]) => boolean;
    purgeRefusedHeaders: (belowHeight: number) => void;
  };
}

describe('refused-headers store (NODE_INTERFACE → Refused headers)', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  it('insert → anyRefusedHeader observes the mark', async () => {
    const db = await importDb();
    const rh = await importRefusedHeaders();
    db.initDb(':memory:');

    expect(rh.anyRefusedHeader(['hash-a'])).toBe(false);

    rh.insertRefusedHeader('hash-a', 5, 10);

    expect(rh.anyRefusedHeader(['hash-a'])).toBe(true);
    expect(rh.anyRefusedHeader(['hash-b'])).toBe(false);
    expect(rh.anyRefusedHeader(['hash-b', 'hash-a'])).toBe(true);
  });

  it('insert is idempotent on hash', async () => {
    const db = await importDb();
    const rh = await importRefusedHeaders();
    db.initDb(':memory:');

    rh.insertRefusedHeader('hash-dup', 5, 10);
    rh.insertRefusedHeader('hash-dup', 5, 20);

    expect(rh.anyRefusedHeader(['hash-dup'])).toBe(true);
  });

  it('anyRefusedHeader returns false for an empty array', async () => {
    const db = await importDb();
    const rh = await importRefusedHeaders();
    db.initDb(':memory:');

    rh.insertRefusedHeader('hash-x', 5, 10);
    expect(rh.anyRefusedHeader([])).toBe(false);
  });

  it('purgeRefusedHeaders removes marks below the bound', async () => {
    const db = await importDb();
    const rh = await importRefusedHeaders();
    db.initDb(':memory:');

    rh.insertRefusedHeader('at-3', 3, 10);
    rh.insertRefusedHeader('at-5', 5, 10);
    rh.insertRefusedHeader('at-7', 7, 10);

    rh.purgeRefusedHeaders(5);

    expect(rh.anyRefusedHeader(['at-3'])).toBe(false);
    expect(rh.anyRefusedHeader(['at-5'])).toBe(true);
    expect(rh.anyRefusedHeader(['at-7'])).toBe(true);
  });

  it('purge boundary: height equal to bound is kept', async () => {
    const db = await importDb();
    const rh = await importRefusedHeaders();
    db.initDb(':memory:');

    rh.insertRefusedHeader('at-10', 10, 20);
    rh.purgeRefusedHeaders(10);
    expect(rh.anyRefusedHeader(['at-10'])).toBe(true);

    rh.purgeRefusedHeaders(11);
    expect(rh.anyRefusedHeader(['at-10'])).toBe(false);
  });

  it('the mark outlives a DB close-and-reopen', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-'));
    const dbPath = path.join(tmpDir, 'test.db');

    try {
      {
        vi.resetModules();
        const db = await importDb();
        const rh = await importRefusedHeaders();
        db.initDb(dbPath);
        rh.insertRefusedHeader('persist-hash', 12, 20);
        expect(rh.anyRefusedHeader(['persist-hash'])).toBe(true);
        db.closeDb();
      }

      {
        vi.resetModules();
        const db = await importDb();
        const rh = await importRefusedHeaders();
        db.initDb(dbPath);
        expect(rh.anyRefusedHeader(['persist-hash'])).toBe(true);
        db.closeDb();
      }
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
      try { fs.rmdirSync(tmpDir); } catch {}
    }
  });
});
