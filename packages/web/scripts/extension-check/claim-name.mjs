#!/usr/bin/env node
// Claim a name for a devnet throwaway through the web's own claim flow — the
// extension proof's second identity S, whose handle step 29 sends to
// (WEB_INTERFACE → The extension → "The verified names"). ⛔ DEVNET ONLY: it
// refuses any node whose /status.networkType is not `devnet`.
//
// The flow is the web's own `submitClaimFlow`, bundled for Node with vite as
// promote.mjs bundles its builders: the reads before the write,
// `buildClaim`, the signature over the transaction id, `POST /usernames`, and
// the node's echoed id held to the built one — the code the extension's
// `claim` runs (WEB_INTERFACE → The username row, → The wallet). The landing is
// `GET /usernames?owner=<key>` answering the name, bounded by the claim's
// expiry height.
//
// The key file is `{ pubKeyHex, privKeyBase64 }` — the base64 of the 48-byte
// PKCS8 DER promote.mjs prints as hex — in a scratch path outside the repo; it
// never enters the repo, a log or a report.
//
// Usage:
//   node packages/web/scripts/extension-check/claim-name.mjs <apiBase> <keyFile> <name>
//
// Prints S_NAME, S_NAME_BOX and S_CLAIMED_AT. Exit 0 = the key holds <name>,
// claimed now or held already; 2 = setup or refusal.

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const [API_ARG, KEY_FILE, NAME] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error('claim-name: ' + msg);
  process.exit(2);
}

if (!API_ARG || !KEY_FILE || !NAME) die('usage: claim-name.mjs <apiBase> <keyFile> <name>');
const API = API_ARG.replace(/\/+$/, '');

// `GET path` → `{ status, body }`, the body parsed when the node sent JSON.
async function jget(path) {
  const res = await fetch(API + path);
  const text = await res.text();
  let body = null;
  if (text !== '') body = JSON.parse(text);
  return { status: res.status, body };
}

// The key's held name, or null on the 404 that says it holds none
// (NODE_INTERFACE → Usernames).
async function heldName(pubKeyHex) {
  const { status, body } = await jget(`/usernames?owner=${pubKeyHex}`);
  if (status === 404) return null;
  if (status !== 200) die(`GET /usernames?owner= answered ${status}`);
  return body;
}

// The web's claim flow, bundled for Node: @dagsocial/types and the web's own
// modules inlined, Node's builtins left to Node — promote.mjs's loadBuilders.
async function loadClaimFlow() {
  const outDir = mkdtempSync(join(tmpdir(), 'notis-claim-name-'));
  await build({
    root: WEB,
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    ssr: { noExternal: true },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: true,
      lib: { entry: join(HERE, 'claim-name', 'entry.ts'), formats: ['es'] },
      rollupOptions: { external: [/^node:/], output: { entryFileNames: 'claim.mjs' } },
    },
  });
  return import(pathToFileURL(join(outDir, 'claim.mjs')).href);
}

function printHeld(held) {
  console.log(`S_NAME=${held.name}`);
  console.log(`S_NAME_BOX=${held.boxId}`);
  console.log(`S_CLAIMED_AT=${held.claimedAtBlock}`);
}

async function main() {
  // ⛔ Devnet only.
  const status = await jget('/status');
  if (status.status !== 200) die(`cannot read ${API}/status: ${status.status}`);
  if (status.body.networkType !== 'devnet') die(`refusing a ${status.body.networkType} node — this script is devnet only`);

  const file = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  const pubKeyHex = file.pubKeyHex;
  if (typeof pubKeyHex !== 'string' || !/^[0-9a-f]{64}$/.test(pubKeyHex)) die('the key file holds no 64-hex pubKeyHex');
  const privateKey = createPrivateKey({ key: Buffer.from(file.privKeyBase64, 'base64'), format: 'der', type: 'pkcs8' });
  const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  if (derived !== pubKeyHex) die("the key file's secret does not derive its pubKeyHex");

  const before = await heldName(pubKeyHex);
  if (before !== null) {
    if (before.name !== NAME) die(`the key holds @${before.name} already — an identity holds one name`);
    console.log(`the key holds @${before.name} already`);
    printHeld(before);
    return;
  }

  const { submitClaimFlow, NodeClient, WriteClient } = await loadClaimFlow();
  const deps = {
    reads: new NodeClient(() => API),
    write: new WriteClient(() => API),
    // This process has no transaction pending, so the spendable view is the
    // confirmed boxes — the ledger's view with no entry (WEB_INTERFACE → The
    // wallet); the entry the flow adds is the one it answers.
    ledger: { spendable: (confirmed) => confirmed, add: () => {} },
    // Raw Ed25519 over the transaction id — the signature the identity module
    // makes (WEB_INTERFACE → The identity module).
    identity: {
      current: () => ({ pubKeyHex }),
      sign: async (_txBytes, txIdHex) => ({ signature: sign(null, Buffer.from(txIdHex, 'hex'), privateKey).toString('hex') }),
    },
  };
  const res = await submitClaimFlow(deps, NAME);
  if (!res.ok) {
    die('rejection' in res
      ? `claim rejected: ${res.rejection.status} ${res.rejection.message}`
      : `claim not signed: ${res.reason}`);
  }
  console.log(`claim submitted: tx ${res.entry.txId}, expires at height ${res.entry.expiresAtHeight}`);

  for (;;) {
    const held = await heldName(pubKeyHex);
    if (held !== null) {
      if (held.name !== NAME) die(`the key holds @${held.name}, not @${NAME}`);
      console.log(`claimed @${held.name} at block ${held.claimedAtBlock}`);
      printHeld(held);
      return;
    }
    const tip = await jget('/blocks/current');
    if (tip.status === 200 && typeof tip.body.height === 'number' && tip.body.height > res.entry.expiresAtHeight) {
      die(`no block took the claim by height ${res.entry.expiresAtHeight}`);
    }
    await sleep(1000);
  }
}

main().catch((e) => die(e.message));
