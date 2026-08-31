#!/usr/bin/env node
// Ensures a persistent Ed25519 miner keypair for the coinbase recipient
// (MINER_PUBKEY) and prints its public key to stdout, so a launcher captures the
// pubkey the same way whether or not the key already existed. Standalone —
// `crypto` only, no build and no @dagsocial/types import, like miner.mjs — and
// byte-compatible with `generateKeyPair` (TYPES_INTERFACE → Identity): a user
// identity IS the 32-byte raw Ed25519 public key, which the SPKI DER wraps at
// its tail. Idempotent: the keypair on disk is never overwritten.
import { generateKeyPairSync } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: gen-miner-key.mjs <out.json>');
  process.exit(2);
}

if (existsSync(out)) {
  console.log(JSON.parse(readFileSync(out, 'utf-8')).publicKey);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });
const publicKeyHex = Buffer.from(pubDer.subarray(pubDer.length - 32)).toString('hex');
const secretKeyHex = Buffer.from(privDer).toString('hex');

writeFileSync(out, JSON.stringify({ publicKey: publicKeyHex, secretKeyHex }, null, 2) + '\n');
console.log(publicKeyHex);
