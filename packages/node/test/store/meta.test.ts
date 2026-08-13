import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../../src/store/db.js';
import { metaGet, metaPut, getReorgFloor, setReorgFloor } from '../../src/store/meta.js';

describe('dag_meta', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('stores and retrieves a metadata key', () => {
    const key = 'test_key';
    const value = new Uint8Array([1, 2, 3, 4]);
    metaPut(key, value);
    const result = metaGet(key);
    expect(result).not.toBeNull();
    expect(result!).toEqual(value);
  });

  it('returns null for unknown keys', () => {
    expect(metaGet('nonexistent')).toBeNull();
  });

  it('overwrites existing keys', () => {
    metaPut('test_key', new Uint8Array([1, 2, 3]));
    metaPut('test_key', new Uint8Array([4, 5, 6]));
    const result = metaGet('test_key');
    expect(result!).toEqual(new Uint8Array([4, 5, 6]));
  });
});

describe('reorg floor', () => {
  const dbPath = ':memory:';

  beforeEach(() => {
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('returns 0 when not set (default)', () => {
    expect(getReorgFloor()).toBe(0);
  });

  it('stores and retrieves a non-zero floor', () => {
    setReorgFloor(42);
    expect(getReorgFloor()).toBe(42);
  });

  it('overwrites existing floor', () => {
    setReorgFloor(10);
    setReorgFloor(20);
    expect(getReorgFloor()).toBe(20);
  });

  it('handles zero explicitly (disables floor)', () => {
    setReorgFloor(100);
    expect(getReorgFloor()).toBe(100);
    setReorgFloor(0);
    expect(getReorgFloor()).toBe(0);
  });
});
