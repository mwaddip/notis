// MESH_INTERFACE → The IP certificate — read a log file for lines past
// a byte offset captured earlier. Pure, no network.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFileSize, readSince, countMatchesSince,
} from '../stage/lib/log-watch.mjs';

describe('readFileSize', () => {
  it.fails('a missing file → null', () => {
    expect(readFileSize('/nowhere-under-sun-mesh-poc.log')).toBe(null);
  });
  it.fails('an empty file → 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, '');
      expect(readFileSize(p)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('a 12-byte file → 12', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'hello world!');
      expect(readFileSize(p)).toBe(12);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('readSince', () => {
  it.fails('reads the slice after offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'ABCDE');
      expect(readSince(p, 2)).toBe('CDE');
      expect(readSince(p, 0)).toBe('ABCDE');
      expect(readSince(p, 5)).toBe('');
      expect(readSince(p, 999)).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('missing file → empty string', () => {
    expect(readSince('/nowhere-under-sun-mesh-poc.log', 0)).toBe('');
  });
});

describe('countMatchesSince', () => {
  it.fails('counts a string pattern after offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'ABCDAB');
      const before = statSync(p).size;
      appendFileSync(p, 'DABAB');
      expect(countMatchesSince(p, before, 'AB')).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('counts a regex pattern after offset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'noise\n');
      const before = statSync(p).size;
      appendFileSync(p, 'Issued certificate for 10.100.0.11\nOrder finalized\nIssued certificate for 10.100.0.11\n');
      expect(countMatchesSince(p, before, /Issued certificate/g)).toBe(2);
      expect(countMatchesSince(p, before, /Order (?:finalized|valid)/)).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('a regex without /g still matches globally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-logwatch-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'aXaXa');
      expect(countMatchesSince(p, 0, /X/)).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
