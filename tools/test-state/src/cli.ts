#!/usr/bin/env node
// TEST_STATE_INTERFACE → The fingerprint. Command-line surface: prints the
// fingerprint of a repo root, and with `--list` prints every input path one
// per line in the order the digest reads them.
import { resolve } from 'node:path';
import { computeFingerprint, fingerprintInputs } from './fingerprint.js';

function usage(): never {
  console.error('usage: dagsocial-test-state [--list] [<repo-root>]');
  process.exit(2);
}

const args = process.argv.slice(2);
let listFlag = false;
let rootArg: string | undefined;
for (const a of args) {
  if (a === '--list') listFlag = true;
  else if (a === '--help' || a === '-h') usage();
  else if (a.startsWith('--')) usage();
  else if (rootArg === undefined) rootArg = a;
  else usage();
}
const root = resolve(rootArg ?? process.cwd());

if (listFlag) {
  for (const { path } of fingerprintInputs(root)) {
    console.log(path);
  }
} else {
  console.log(computeFingerprint(root));
}
