#!/usr/bin/env node
// MESH_INTERFACE → Acceptance — reads every `stage/out/scenarios/<name>.json`
// and writes `stage/out/summary.md`: per scenario and step, the verdict and
// what was measured; per browser × path, connected or not and in what
// time; recovery times; the DNS witness. Rows for Firefox are left for
// the hand pass, marked as such.
//
// Pure build from fixture files: the stage's cases drive this with a
// directory of scenario JSON files and compare the output to the
// expected `summary.md` shape.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIOS_DIR = join(HERE, 'out', 'scenarios');
const DEFAULT_SUMMARY_PATH = join(HERE, 'out', 'summary.md');

/**
 * Build the summary from a list of scenario result objects (as written
 * by `stage/run.mjs`). Pure: no file I/O.
 */
export function buildSummary(scenarios) {
  const lines = [];
  lines.push('# mesh-poc stage — scenario summary');
  lines.push('');
  lines.push('Chromium is the one browser the stage measures. Rows for Firefox are left for the hand pass, marked as such.');
  lines.push('');
  for (const scenario of scenarios) {
    lines.push(`## ${scenario.scenario}`);
    lines.push('');
    const started = new Date(scenario.startedAt).toISOString();
    const ended = new Date(scenario.endedAt).toISOString();
    const durationMs = scenario.endedAt - scenario.startedAt;
    lines.push(`- started: ${started}`);
    lines.push(`- ended:   ${ended}`);
    lines.push(`- duration: ${durationMs} ms`);
    lines.push('');
    lines.push('| # | step | verdict | time | measurement |');
    lines.push('|---|------|---------|------|-------------|');
    for (let i = 0; i < scenario.steps.length; i += 1) {
      const s = scenario.steps[i];
      const stepName = s.name;
      const verdict = s.verdict;
      const timeStr = typeof s.timeMs === 'number' ? `${s.timeMs} ms` : '-';
      const m = formatMeasurement(s.measurement);
      lines.push(`| ${i + 1} | ${escapePipe(stepName)} | ${verdict} | ${timeStr} | ${escapePipe(m)} |`);
    }
    lines.push('');
    lines.push('### Firefox');
    lines.push('');
    lines.push('(hand pass — this stage measures Chromium alone)');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function formatMeasurement(m) {
  if (m === null || m === undefined) return '-';
  if (typeof m !== 'object') return String(m);
  try {
    return JSON.stringify(m);
  } catch {
    return '<unserialisable>';
  }
}

function escapePipe(s) {
  return String(s).replace(/\|/g, '\\|');
}

/**
 * Read every `<name>.json` under `scenariosDir` (default
 * `stage/out/scenarios/`), build the summary and write it to
 * `summaryPath` (default `stage/out/summary.md`).
 */
export function writeSummaryFromDir(scenariosDir = DEFAULT_SCENARIOS_DIR, summaryPath = DEFAULT_SUMMARY_PATH) {
  if (!existsSync(scenariosDir)) {
    throw new Error(`scenarios directory ${scenariosDir} does not exist — run stage:run first`);
  }
  const names = readdirSync(scenariosDir).filter((f) => f.endsWith('.json')).sort();
  const scenarios = names.map((f) => JSON.parse(readFileSync(join(scenariosDir, f), 'utf8')));
  const summary = buildSummary(scenarios);
  writeFileSync(summaryPath, summary);
  return { summaryPath, scenarios: scenarios.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const r = writeSummaryFromDir();
    process.stdout.write(`[report] wrote ${r.summaryPath} (${r.scenarios} scenario(s))\n`);
  } catch (err) {
    process.stderr.write(`[report] ${err?.message ?? err}\n`);
    process.exit(1);
  }
}
