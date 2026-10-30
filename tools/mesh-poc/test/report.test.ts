// MESH_INTERFACE → Acceptance — `report.mjs` reads
// `stage/out/scenarios/<name>.json` files and writes `summary.md`:
// per scenario and step, the verdict and what was measured; rows for
// Firefox are left for the hand pass, marked as such.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSummary, writeSummaryFromDir } from '../stage/report.mjs';

import type { ScenarioResult } from '../stage/report.mjs';

function sampleScenarios(): ScenarioResult[] {
  return [
    {
      scenario: 's1',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_060_000,
      steps: [
        { name: 'nodeId is an anchor within 60 s', verdict: 'PASS', measurement: { nodeId: 'a'.repeat(64), isAnchor: true, timeMs: 10_000 }, timeMs: 10_000 },
        { name: 'probe matches node direct', verdict: 'PASS', measurement: { probe: { sha256: 'ab', bytes: 123 }, direct: { sha256: 'ab', bytes: 123 } }, timeMs: 20 },
        { name: 'DNS silent', verdict: 'skipped', measurement: null, timeMs: 0 },
      ],
    },
    {
      scenario: 's6',
      startedAt: 1_700_000_120_000,
      endedAt: 1_700_000_180_000,
      steps: [
        { name: 'no anchor reached, page shows banner', verdict: 'FAIL', measurement: { anchorReached: true, bannerText: null }, timeMs: 5_000 },
      ],
    },
  ];
}

describe('report/buildSummary — pure', () => {
  it.fails('writes one `## <scenario>` section per scenario', () => {
    const md = buildSummary(sampleScenarios());
    expect(md).toContain('## s1');
    expect(md).toContain('## s6');
  });

  it.fails("every step's verdict appears in its row", () => {
    const md = buildSummary(sampleScenarios());
    expect(md).toMatch(/\|.*nodeId is an anchor.*\|\s*PASS\s*\|/);
    expect(md).toMatch(/\|.*DNS silent.*\|\s*skipped\s*\|/);
    expect(md).toMatch(/\|.*no anchor reached.*\|\s*FAIL\s*\|/);
  });

  it.fails('skipped measurements render as "-" (no PASS by mistake)', () => {
    const md = buildSummary(sampleScenarios());
    const skippedLine = md.split('\n').find((l) => l.includes('DNS silent'));
    expect(skippedLine, 'DNS silent row').toBeDefined();
    expect(skippedLine!.endsWith('| - |') || skippedLine!.includes('| - |'), `the row's measurement cell is "-"; got: ${skippedLine}`).toBe(true);
    expect(skippedLine, 'skipped row does not show PASS').not.toContain('| PASS |');
  });

  it.fails('marks Firefox rows as the hand pass', () => {
    const md = buildSummary(sampleScenarios());
    expect(md).toContain('### Firefox');
    expect(md).toContain('(hand pass — this stage measures Chromium alone)');
  });

  it.fails('an empty list of scenarios produces a well-formed summary', () => {
    const md = buildSummary([]);
    expect(md).toContain('# mesh-poc stage — scenario summary');
    expect(md).toContain('Chromium is the one browser');
  });
});

describe('report/writeSummaryFromDir — reads a fixture directory', () => {
  it.fails('reads every <name>.json in the directory and writes summary.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-report-'));
    try {
      for (const s of sampleScenarios()) {
        writeFileSync(join(dir, `${(s as { scenario: string }).scenario}.json`), JSON.stringify(s));
      }
      const summaryPath = join(dir, 'summary.md');
      const r = writeSummaryFromDir(dir, summaryPath);
      expect(r.scenarios).toBe(2);
      const md = readFileSync(summaryPath, 'utf8');
      expect(md).toContain('## s1');
      expect(md).toContain('## s6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the scenarios directory does not exist', () => {
    expect(() => writeSummaryFromDir('/nowhere-under-sun-mesh-poc', '/nowhere/summary.md')).toThrow();
  });
});
