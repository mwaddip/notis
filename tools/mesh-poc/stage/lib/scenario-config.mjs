// MESH_INTERFACE → Acceptance — "Every scenario writes the config it
// needs at its start — the stage's default when it needs no variant —
// and never reads a previous scenario's". `up.mjs` writes two files
// side by side: `stage/out/browser/config.json` (the one the page
// fetches) and `stage/out/browser/config.default.json` (a canonical
// copy a scenario can restore from). A scenario calls
// `writeStageDefault(outDir)` for no-variant scenarios and
// `writeConfigVariant(outDir, variant)` for variant scenarios. Neither
// renames: every scenario starts with a fresh write.

import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Copy `config.default.json` to `config.json`. Throws when the default
 * is missing (`up.mjs` writes it in exec mode — a missing file means
 * `up.mjs` did not run against this `outDir`).
 */
export function writeStageDefault(_outDir) {
  throw new Error('writeStageDefault: not implemented');
}

/**
 * Write `variant` as `config.json`. The variant is pure JSON; the
 * writer does nothing with it beyond `JSON.stringify` + file write
 * (`JSON.stringify(variant, null, 2)` — same shape as `up.mjs`'s own
 * writes).
 */
export function writeConfigVariant(_outDir, _variant) {
  throw new Error('writeConfigVariant: not implemented');
}
