// MESH_INTERFACE → Acceptance — the pure measurement helpers the
// scenarios share: nft counter sum over a parsed `nft -j list table`
// JSON, newline count over a file, pid lookup by description.
// `execIn`, `readDirect`, `readNftCounterSum`, `sigterm` and
// `restartFromEntry` are not pure (child processes); their cases run
// on the real stage, not here.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sumNftCounters,
  readLineCount,
  readMtimeMs,
  findPid,
} from '../stage/lib/measure.mjs';

describe('sumNftCounters', () => {
  it.fails('empty JSON → 0', () => {
    expect(sumNftCounters({ nftables: [] })).toBe(0);
  });
  it.fails('null-like → 0', () => {
    expect(sumNftCounters(null)).toBe(0);
    expect(sumNftCounters(undefined)).toBe(0);
    expect(sumNftCounters({})).toBe(0);
  });
  it.fails('sums every counter.packets across every rule in the ruleset', () => {
    const json = {
      nftables: [
        { table: { family: 'ip', name: 'dns_witness' } },
        { chain: { family: 'ip', table: 'dns_witness', name: 'out' } },
        { rule: { expr: [{ counter: { packets: 3, bytes: 300 } }] } },
        { rule: { expr: [{ counter: { packets: 5, bytes: 500 } }] } },
      ],
    };
    expect(sumNftCounters(json)).toBe(8);
  });
  it.fails('a rule with no counter contributes 0', () => {
    const json = {
      nftables: [
        { rule: { expr: [{ match: { left: {}, right: 'x' } }] } },
      ],
    };
    expect(sumNftCounters(json)).toBe(0);
  });
});

describe('readLineCount', () => {
  it.fails('a missing file → 0', () => {
    expect(readLineCount('/nowhere-under-sun-mesh-poc.log')).toBe(0);
  });
  it.fails('an empty file → 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-measure-'));
    try {
      const p = join(dir, 'empty.log');
      writeFileSync(p, '');
      expect(readLineCount(p)).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('three newline-terminated lines → 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-measure-'));
    try {
      const p = join(dir, 'three.log');
      writeFileSync(p, 'a\nb\nc\n');
      expect(readLineCount(p)).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.fails('a trailing partial line counts as a line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-measure-'));
    try {
      const p = join(dir, 'partial.log');
      writeFileSync(p, 'a\nb');
      expect(readLineCount(p)).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('readMtimeMs', () => {
  it.fails('a missing file → null', () => {
    expect(readMtimeMs('/nowhere-under-sun-mesh-poc.log')).toBe(null);
  });
  it.fails('a present file → a number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-measure-'));
    try {
      const p = join(dir, 'x.log');
      writeFileSync(p, 'x');
      const t = readMtimeMs(p);
      expect(typeof t).toBe('number');
      expect(t).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('findPid', () => {
  const pids = [
    { pid: 10, description: 'mesh:pub1', logPath: '/x', argv: ['a'] },
    { pid: 11, description: 'mesh:pub2', logPath: '/y', argv: ['b'] },
    { pid: 12, description: 'miner-steady', logPath: '/z', argv: ['c'] },
  ];
  it.fails('finds a matching description', () => {
    const r = findPid(pids, 'mesh:pub1');
    expect(r).not.toBeNull();
    expect(r!.pid).toBe(10);
  });
  it.fails('returns null for a description that is not present', () => {
    expect(findPid(pids, 'mesh:nowhere')).toBeNull();
  });
  it.fails('undefined or null input → null', () => {
    expect(findPid(undefined as unknown as typeof pids, 'anything')).toBeNull();
    expect(findPid(null as unknown as typeof pids, 'anything')).toBeNull();
  });
});
