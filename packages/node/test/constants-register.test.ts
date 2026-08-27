// The first test in this repo to read contracts/. CONSTANTS → The drift test
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Types from '@dagsocial/types';
import * as Net from '@dagsocial/net';
import * as Nipopow from '@dagsocial/nipopow';

const REGISTER_PATH = fileURLToPath(
  new URL('../../../contracts/CONSTANTS.md', import.meta.url),
);

// --- Register parser (CONSTANTS → Reading a row) ---

interface ParsedValue {
  raw: string;
  parsed: number | bigint;
  isBigint: boolean;
}

interface PinnedRow {
  name: string;
  kind: 'screaming' | 'camel';
  values: ParsedValue[];
}

function parseValueCell(cell: string): ParsedValue | null {
  const m = cell.match(/^`(\d[\d_]*n?)`$/);
  if (!m) return null;
  const raw = m[1]!;
  const isBigint = raw.endsWith('n');
  const digits = raw.replace(/[_n]/g, '');
  return {
    raw,
    parsed: isBigint ? BigInt(digits) : Number(digits),
    isBigint,
  };
}

function parseRegister(text: string): {
  pinned: PinnedRow[];
  excluded: Set<string>;
} {
  const lines = text.split('\n');
  let heading = '';
  const pinned: PinnedRow[] = [];
  const excluded = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('## ')) {
      heading = line.slice(3).trim();
      continue;
    }

    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;

    const first = cells[0]!;

    // CONSTANTS → Excluded
    if (heading === 'Excluded') {
      for (const match of first.matchAll(/`([^`]+)`/g)) excluded.add(match[1]!);
      continue;
    }

    // Pinned rows: first cell is exactly `NAME`, nothing after the backtick
    const pin = first.match(/^`([A-Za-z_]\w*)`$/);
    if (!pin) continue;

    const name: string = pin[1]!;
    const kind: 'screaming' | 'camel' =
      /^[A-Z][A-Z0-9_]*$/.test(name) ? 'screaming' : 'camel';

    const rawCells = kind === 'camel' ? cells.slice(1, 4) : [cells[1]!];
    const values: ParsedValue[] = [];
    for (const vc of rawCells) {
      const v = parseValueCell(vc);
      if (!v) {
        throw new Error(
          `Value grammar failure: ${name} cell ${JSON.stringify(vc)} (line ${i + 1})`,
        );
      }
      values.push(v);
    }

    pinned.push({ name, kind, values });
  }

  return { pinned, excluded };
}

// --- Setup ---

const register = readFileSync(REGISTER_PATH, 'utf8');
const { pinned, excluded } = parseRegister(register);
const pinnedNames = new Set(pinned.map(r => r.name));

const barrels: { label: string; ns: Record<string, unknown> }[] = [
  { label: '@dagsocial/types', ns: Types as Record<string, unknown> },
  { label: '@dagsocial/net', ns: Net as Record<string, unknown> },
  { label: '@dagsocial/nipopow', ns: Nipopow as Record<string, unknown> },
];

// --- Tests ---

describe('constants register drift', () => {
  it('parser found rows and exclusions', () => {
    expect(pinned.length).toBeGreaterThan(0);
    expect(excluded.size).toBeGreaterThan(0);
  });

  // Rule 1 — SCREAMING_CASE exports pinned to exactly one barrel
  describe('SCREAMING_CASE', () => {
    for (const row of pinned.filter(r => r.kind === 'screaming')) {
      it(row.name, () => {
        const sources = barrels.filter(
          b =>
            Object.hasOwn(b.ns, row.name) &&
            (typeof b.ns[row.name] === 'number' ||
              typeof b.ns[row.name] === 'bigint'),
        );

        expect(
          sources.length,
          `${row.name}: found in ${sources.map(s => s.label).join(', ') || 'none'}`,
        ).toBe(1);

        const val = sources[0]!.ns[row.name];
        const rv = row.values[0]!;
        const wantType = rv.isBigint ? 'bigint' : 'number';
        expect(typeof val, `${row.name}: expected ${wantType}`).toBe(wantType);
        expect(val, row.name).toStrictEqual(rv.parsed);
      });
    }
  });

  // Rule 2 — camelCase NetworkProfile fields, three cells
  describe('NetworkProfile', () => {
    const nets = ['mainnet', 'testnet', 'devnet'] as const;
    const profiles = Types.NETWORK_PROFILES;

    for (const row of pinned.filter(r => r.kind === 'camel')) {
      for (const [i, net] of nets.entries()) {
        it(`${row.name}.${net}`, () => {
          const profile = profiles[net] as unknown as Record<string, unknown>;
          expect(
            Object.hasOwn(profile, row.name),
            `${row.name} absent from ${net}`,
          ).toBe(true);

          const val = profile[row.name];
          const rv = row.values[i]!;
          const wantType = rv.isBigint ? 'bigint' : 'number';
          expect(typeof val, `${row.name}.${net}: expected ${wantType}`).toBe(
            wantType,
          );
          expect(val, `${row.name}.${net}`).toStrictEqual(rv.parsed);
        });
      }
    }
  });

  // Rule 3 — converse: every numeric export is pinned or excluded
  describe('converse', () => {
    for (const barrel of barrels) {
      it(`${barrel.label}`, () => {
        const missing: string[] = [];
        for (const key of Object.keys(barrel.ns)) {
          const val = barrel.ns[key];
          if (typeof val !== 'number' && typeof val !== 'bigint') continue;
          if (pinnedNames.has(key) || excluded.has(key)) continue;
          missing.push(key);
        }
        expect(missing, `unregistered exports in ${barrel.label}`).toEqual([]);
      });
    }

    it('profile fields', () => {
      const missing: string[] = [];
      const seen = new Set<string>();
      for (const net of ['mainnet', 'testnet', 'devnet'] as const) {
        const profile = Types.NETWORK_PROFILES[net] as unknown as Record<string, unknown>;
        for (const key of Object.keys(profile)) {
          if (seen.has(key)) continue;
          seen.add(key);
          const val = profile[key];
          if (typeof val !== 'number' && typeof val !== 'bigint') continue;
          if (pinnedNames.has(key) || excluded.has(key)) continue;
          missing.push(key);
        }
      }
      expect(missing, 'unregistered profile fields').toEqual([]);
    });
  });
});
