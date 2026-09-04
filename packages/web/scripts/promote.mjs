#!/usr/bin/env node
// Promote a throwaway key to a member on a LOCAL DEVNET — the setup for the web
// membership actions' proof (docs/specs → the proof). ⛔ DEVNET ONLY: it refuses
// any node whose /status.networkType is not `devnet`, because it drives the
// public DEVNET_FAUCET key, which is a secret nowhere else.
//
// The faucet is a root (ARCHITECTURE → Membership: devnet k=1). This grants a
// throwaway R karma through the faucet service, has R post two threads, then has
// the faucet vouch R and like both posts — the earned-membership path
// (NODE_INTERFACE → Membership pass). Every step is counted against /karma.
//
// Usage:
//   node packages/web/scripts/promote.mjs [apiBase] [faucetBase]
//   node packages/web/scripts/promote.mjs http://localhost:3000 http://localhost:3100
//
// R's PUBLIC key and secret (pkcs8 hex) are printed on success — the secret so the
// CDP proof run can load R; it is a throwaway and never enters the repo.
//
// Exit 0 = R is a member; 2 = setup/refusal.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const API = process.argv[2] ?? 'http://localhost:3000';
const FAUCET = process.argv[3] ?? 'http://localhost:3100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny HTTP helpers (fetch wrappers; the consensus/identity bits are imported) ---
const node = { url: API };
async function jget(path) {
  const res = await fetch(node.url + path);
  const body = await res.json();
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}
async function jpost(path, body) {
  const res = await fetch(node.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const boxesOf = (k) => k.boxes.map((b) => ({ boxId: b.boxId, value: BigInt(b.value) }));
async function waitFor(what, pred, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await sleep(1000);
  }
}
function die(msg) {
  console.error('promote: ' + msg);
  process.exit(2);
}

// --- bundle the e2e builders for Node (they are unbuilt TS with .js specifiers) ---
async function loadBuilders() {
  const outDir = mkdtempSync(join(tmpdir(), 'notis-promote-'));
  await build({
    root: WEB,
    configFile: false,
    logLevel: 'warn',
    publicDir: false, // no fonts/favicon copy into the temp bundle
    // Inline @dagsocial/types and the npm deps so the bundle imports only node:
    // builtins — otherwise a bare `@dagsocial/types` in the output is unresolvable
    // from the temp dir it is imported from.
    ssr: { noExternal: true },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      ssr: true,
      lib: { entry: join(HERE, 'promote', 'entry.ts'), formats: ['es'] },
      // A .mjs name so Node reads the bundle as ESM from a dir with no package.json.
      rollupOptions: { external: [/^node:/], output: { entryFileNames: 'builders.mjs' } },
    },
  });
  return import(pathToFileURL(join(outDir, 'builders.mjs')).href);
}

async function main() {
  // ⛔ Devnet only.
  const status = await jget('/status').catch((e) => die(`cannot reach the node at ${API}: ${e.message}`));
  if (status.networkType !== 'devnet') die(`refusing a ${status.networkType} node — this script is devnet only`);
  const version = status.protocolVersion;
  console.log(`node ${API} is devnet at height ${status.blockHeight}, era ${version}`);

  const { DEVNET_FAUCET, fresh, buildVouchTx, buildLikeTx, buildThreadTx } = await loadBuilders();

  // The faucet is the one root.
  const fKarma0 = await jget(`/karma/${DEVNET_FAUCET.publicKeyHex}`);
  if (!(fKarma0.member && fKarma0.invitesAvailable === null)) die('the faucet is not a devnet root — is this a fresh devnet?');

  const R = fresh();
  console.log(`throwaway R = ${R.publicKeyHex}`);

  // 1. R asks the faucet (a resident) — the faucet invites and grants karma.
  console.log('asking the faucet for R…');
  await fetch(FAUCET + '/faucet/karma', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pubkey: R.publicKeyHex }) })
    .then(async (r) => { if (!r.ok) die(`faucet refused: ${r.status} ${await r.text()}`); });
  await waitFor('R to receive karma', async () => (await jget(`/karma/${R.publicKeyHex}`)).boxCount > 0);
  let rK = await jget(`/karma/${R.publicKeyHex}`);
  console.log(`R is a resident: member=${rK.member}, karma boxes=${rK.boxCount}`);

  // 2. R posts two threads.
  console.log('R posts two threads…');
  const t1 = buildThreadTx(R, boxesOf(rK), 'promote thread 1', rK.height, version);
  const t1Res = await jpost('/posts', { tx: t1.json, content: t1.content });
  const t2 = buildThreadTx(R, [t1.outputs[0]], 'promote thread 2', rK.height, version);
  const t2Res = await jpost('/posts', { tx: t2.json, content: t2.content });
  await waitFor('R\'s posts to confirm', async () => {
    const p = await jget(`/posts/${t2Res.postId}`).catch(() => null);
    return p && p.status === 'confirmed';
  });

  // 3. The faucet vouches R (memberBar = 1 on devnet).
  console.log('the faucet vouches R…');
  let fK = await jget(`/karma/${DEVNET_FAUCET.publicKeyHex}`);
  const vouch = buildVouchTx(DEVNET_FAUCET, boxesOf(fK), R, fK.height, version);
  await jpost('/vouches', { tx: vouch.json });
  await waitFor('the vouch to count', async () => (await jget(`/karma/${R.publicKeyHex}`)).memberVouches >= 1);

  // 4. The faucet likes each of R's posts once (memberLikesBar = 2 on devnet).
  console.log('the faucet likes both of R\'s posts…');
  fK = await jget(`/karma/${DEVNET_FAUCET.publicKeyHex}`);
  const like1 = buildLikeTx(DEVNET_FAUCET, boxesOf(fK), t1Res.postId, R.publicKeyHex, fK.height, version);
  await jpost('/likes', { tx: like1.json });
  const like2 = buildLikeTx(DEVNET_FAUCET, [like1.outputs[0]], t2Res.postId, R.publicKeyHex, fK.height, version);
  await jpost('/likes', { tx: like2.json });

  // 5. The membership pass sets R.
  await waitFor('R to be set a member', async () => (await jget(`/karma/${R.publicKeyHex}`)).member);
  rK = await jget(`/karma/${R.publicKeyHex}`);
  console.log('');
  console.log(`✓ R is a member since block ${rK.memberSinceBlock} — vouches ${rK.memberVouches}, likes ${rK.memberLikes}`);
  console.log(`R_PUBLIC=${R.publicKeyHex}`);
  console.log(`R_SECRET_PKCS8_HEX=${R.secretKey.toString('hex')}`);
}

main().catch((e) => die(e.message));
