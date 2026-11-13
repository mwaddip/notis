// MINING_INTERFACE → Consolidation. A client of a node, not part of one: this
// file is built beside `src/index.ts` so a miner's key-file branch can import
// it without loading the server (MINING_INTERFACE → Consolidation → "With a
// key file the script loads node's build; without one it loads nothing more").
// Imports `@dagsocial/types`, `@dagsocial/node-reads` and `node:crypto` alone.

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  computeTxId,
  encodeTx,
  isHex64,
  MAX_TX_BYTES,
  PAGE_LIMIT_MAX,
  txToJson,
  type CandidateOf,
  type CreditBox,
  type UtxoTransaction,
} from '@dagsocial/types';
import {
  fetchJson,
  isRecord,
  isBoxValue,
  isNonNegSafeInt,
  LISTING_PAGE_READ_BYTES,
  parsePage,
  STATUS_READ_BYTES,
  WRITE_ANSWER_READ_BYTES,
  type HttpFetch,
} from '@dagsocial/node-reads';

// MINING_INTERFACE → Consolidation → "A check runs every `CONSOLIDATE_MIN_BOXES` heights, never inside a work window." —
// the policy-tier figure as `contracts/CONSTANTS.md → Producer policy` holds
// it. A `(literal)` row there and nowhere in `@dagsocial/types` because a
// client's cadence reads it, not a block's apply.
const CONSOLIDATE_MIN_BOXES = 100;

// ------------------------------------------------------------------------
// The key file
// ------------------------------------------------------------------------

/** MINING_INTERFACE → Consolidation → "The key file is plaintext, in one of
 *  two forms" — the Ed25519 signer, read from the file and held for signing. */
export interface MinerKey {
  readonly publicKeyHex: string;
  readonly signingKey: KeyObject;
}

/**
 * MINING_INTERFACE → Consolidation → "The key file is plaintext, in one of
 * two forms". `filePath` names a file holding an Ed25519 key in either the
 * `gen-miner-key.mjs` shape (`publicKey`, `secretKeyHex`) or the web client's
 * clear shape (`pubKeyHex`, `privKeyBase64`, the same PKCS8 DER in base64);
 * the encrypted envelope (`kdf`/`cipher`/`ciphertext`), a file that parses as
 * neither, a secret that does not derive the public key the file names, and a
 * non-null `expectedPubKeyHex` naming another key each throw with `filePath`
 * in the message. Returns the public key hex and the signing key.
 */
export function readMinerKey(filePath: string, expectedPubKeyHex: string | null): MinerKey {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`Cannot read the miner key at ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`The miner key at ${filePath} is not JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`The miner key at ${filePath} is not a JSON object`);
  }
  // WEB_INTERFACE → The identity module — the encrypted envelope carries a
  // `kdf`, a `cipher` and a `ciphertext`; no process can ask its passphrase.
  if ('ciphertext' in parsed || 'kdf' in parsed || 'cipher' in parsed) {
    throw new Error(
      `The miner key at ${filePath} is an encrypted identity envelope — no passphrase is readable here`,
    );
  }

  const publicKeyHex = extractPublicKeyHex(parsed);
  const secretDer = extractSecretDer(parsed, filePath);
  if (publicKeyHex === null) {
    throw new Error(
      `The miner key at ${filePath} carries neither \`publicKey\` nor \`pubKeyHex\``,
    );
  }
  if (!isHex64(publicKeyHex)) {
    throw new Error(`The miner key at ${filePath} names a public key outside 64 lowercase hex`);
  }

  // The secret and the file's own public key must agree, or every signature
  // is attributed to a box this miner does not own. The decode error is
  // replaced rather than wrapped: it is raised over the secret bytes, and
  // nothing derived from them reaches the message.
  let signingKey: KeyObject;
  let derivedHex: string;
  try {
    signingKey = createPrivateKey({ key: secretDer, format: 'der', type: 'pkcs8' });
    const derivedDer = createPublicKey(signingKey).export({ format: 'der', type: 'spki' }) as Buffer;
    derivedHex = derivedDer.subarray(-32).toString('hex');
  } catch {
    throw new Error(`The miner key at ${filePath} is not an Ed25519 PKCS8 DER secret`);
  }
  if (derivedHex !== publicKeyHex) {
    throw new Error(
      `The miner key at ${filePath} holds a secret that does not derive the public key it names`,
    );
  }
  if (expectedPubKeyHex !== null && expectedPubKeyHex !== publicKeyHex) {
    throw new Error(
      `The miner key at ${filePath} names ${publicKeyHex}; MINER_PUBKEY names another`,
    );
  }
  return { publicKeyHex, signingKey };
}

function extractPublicKeyHex(obj: Record<string, unknown>): string | null {
  const a = obj['publicKey'];
  if (typeof a === 'string') return a;
  const b = obj['pubKeyHex'];
  if (typeof b === 'string') return b;
  return null;
}

function extractSecretDer(obj: Record<string, unknown>, filePath: string): Buffer {
  const hex = obj['secretKeyHex'];
  if (typeof hex === 'string') {
    try {
      return Buffer.from(hex, 'hex');
    } catch {
      throw new Error(`The miner key at ${filePath}'s \`secretKeyHex\` is not hex`);
    }
  }
  const b64 = obj['privKeyBase64'];
  if (typeof b64 === 'string') {
    return Buffer.from(b64, 'base64');
  }
  throw new Error(
    `The miner key at ${filePath} carries neither \`secretKeyHex\` nor \`privKeyBase64\``,
  );
}

// ------------------------------------------------------------------------
// The check
// ------------------------------------------------------------------------

/** The value a check returns to the caller: whether it posted a transaction,
 *  how many inputs it carried, and whether the byte bound stopped it (full)
 *  rather than the listing's end. */
export interface ConsolidateOutcome {
  readonly sent: boolean;
  readonly inputCount: number;
  readonly full: boolean;
}

/** One log line, the only thing a failing check writes — the seam the caller
 *  injects to route it through the miner's own log format. */
export type Logger = (line: string) => void;

export interface CheckOptions {
  readonly nodeUrl: string;
  readonly key: MinerKey;
  readonly httpFetch: HttpFetch;
  readonly logger: Logger;
}

interface Spendable {
  readonly boxId: string;
  readonly value: bigint;
}

/**
 * MINING_INTERFACE → Consolidation → "A check spends what the pending view
 * leaves spendable". Reads `/status`, pages `GET /credits/:userId?pending=1`
 * until `one transaction's worth` of spendable boxes is held or the listing
 * ends, and posts one transaction to `POST /credits/transfer` with at least
 * `CONSOLIDATE_MIN_BOXES` spendable; with fewer it sends nothing. A read
 * refused or cut, a submit refused or a malformed listing each log one line
 * and the check returns an idle outcome without throwing.
 */
export async function runConsolidateCheck(opts: CheckOptions): Promise<ConsolidateOutcome> {
  const idle: ConsolidateOutcome = { sent: false, inputCount: 0, full: false };
  try {
    return await runCheckInner(opts);
  } catch (err) {
    opts.logger(`consolidation check refused: ${errMsg(err)}`);
    return idle;
  }
}

async function runCheckInner(opts: CheckOptions): Promise<ConsolidateOutcome> {
  const idle: ConsolidateOutcome = { sent: false, inputCount: 0, full: false };
  const { nodeUrl, key, httpFetch, logger } = opts;
  const base = nodeUrl.replace(/\/+$/, '');

  // /status: the tip and the era, read before every check — a client signs
  // the era the node reports (NODE_INTERFACE → Status).
  const statusUrl = `${base}/status`;
  const statusRead = await fetchJson<unknown>(httpFetch, statusUrl, STATUS_READ_BYTES);
  if (!statusRead.ok) {
    logger(`consolidation status read refused (${statusRead.status}): ${statusRead.body}`);
    return idle;
  }
  const status = readStatus(statusRead.data);
  if (status === null) {
    logger('consolidation status answer missing blockHeight or protocolVersion');
    return idle;
  }
  const tip = status.blockHeight;
  const protocolVersion = status.protocolVersion;

  // Page the credit listing under `pending=1` until one transaction's worth
  // is held or the listing ends. Each page reads at most PAGE_LIMIT_MAX rows.
  // A spendable box has no `lockedUntilBlock` or one at most `tip + 1`
  // (NODE_INTERFACE → Spend timing).
  let after: string | null = null;
  const spendable: Spendable[] = [];
  // How many inputs still fit under MAX_TX_BYTES — the stop that says the
  // byte bound, not the listing's end, ended the read. Measured at the
  // sum-so-far after every addition.
  let fullAtByteBound = false;
  let listingEnded = false;
  const owner = Buffer.from(key.publicKeyHex, 'hex');

  while (!listingEnded && !fullAtByteBound) {
    const pageUrl = buildListingUrl(base, key.publicKeyHex, after);
    const read = await fetchJson<unknown>(httpFetch, pageUrl, LISTING_PAGE_READ_BYTES);
    if (!read.ok) {
      logger(`consolidation listing refused (${read.status}): ${read.body}`);
      return idle;
    }
    const page = parsePage<Record<string, unknown>>(read.data, 'boxes', PAGE_LIMIT_MAX);
    if (!page.ok) {
      logger(`consolidation listing malformed: ${page.reason}`);
      return idle;
    }

    for (const row of page.rows) {
      const boxId = row['boxId'];
      const value = row['value'];
      const lock = row['lockedUntilBlock'];
      if (!isHex64(boxId)) {
        logger('consolidation listing row carried no 64-hex box id');
        return idle;
      }
      if (!isBoxValue(value)) {
        logger('consolidation listing row carried a bad value');
        return idle;
      }
      if (lock !== undefined && !isNonNegSafeInt(lock)) {
        logger('consolidation listing row carried a bad lockedUntilBlock');
        return idle;
      }
      if (lock !== undefined && lock > tip + 1) continue;
      const next: Spendable = { boxId, value: BigInt(value) };
      // Measure the encoding with this next input, by candidate-tx shape.
      const candidateLen = measureTxLen([...spendable, next], owner, tip, protocolVersion, key.publicKeyHex);
      if (candidateLen > MAX_TX_BYTES) {
        // The byte bound, not the listing's end, stopped the read.
        fullAtByteBound = true;
        break;
      }
      spendable.push(next);
    }

    if (page.next === null) {
      listingEnded = true;
      break;
    }
    after = page.next;
  }

  if (spendable.length < CONSOLIDATE_MIN_BOXES) {
    return idle;
  }

  // Build, sign and post.
  const sum = spendable.reduce((s, b) => s + b.value, 0n);
  const output: CandidateOf<CreditBox> = {
    boxType: 'credit',
    value: sum,
    createdAtBlock: tip,
    owner,
  };
  const unsigned: UtxoTransaction = {
    inputs: spendable.map((b) => b.boxId),
    outputs: [output],
    signatures: {},
    protocolVersion,
  };
  const txId = computeTxId(unsigned);
  const signature = cryptoSign(null, Buffer.from(txId, 'hex'), key.signingKey);
  const signed: UtxoTransaction = {
    ...unsigned,
    signatures: { [key.publicKeyHex]: new Uint8Array(signature) },
  };
  const body = JSON.stringify({ tx: txToJson(signed) });
  const transferUrl = `${base}/credits/transfer`;
  const postFetch: HttpFetch = (u, init) => httpFetch(u, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const postRead = await fetchJson<unknown>(postFetch, transferUrl, WRITE_ANSWER_READ_BYTES);
  if (!postRead.ok) {
    logger(`consolidation submit refused (${postRead.status}): ${postRead.body}`);
    return idle;
  }
  if (!isRecord(postRead.data)) {
    logger('consolidation submit answer is not an object');
    return idle;
  }
  if (postRead.data['status'] !== 'pending') {
    logger(`consolidation submit answer has status=${String(postRead.data['status'])}`);
    return idle;
  }
  return { sent: true, inputCount: spendable.length, full: fullAtByteBound };
}

function buildListingUrl(base: string, pubKeyHex: string, after: string | null): string {
  const q = `pending=1&limit=${PAGE_LIMIT_MAX}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`;
  return `${base}/credits/${pubKeyHex}?${q}`;
}

function measureTxLen(
  spendable: readonly Spendable[],
  owner: Uint8Array,
  tip: number,
  protocolVersion: number,
  pubKeyHex: string,
): number {
  const sum = spendable.reduce((s, b) => s + b.value, 0n);
  const output: CandidateOf<CreditBox> = { boxType: 'credit', value: sum, createdAtBlock: tip, owner };
  const candidate: UtxoTransaction = {
    inputs: spendable.map((b) => b.boxId),
    outputs: [output],
    // The signature map rides in the wire codec (TYPES_INTERFACE → Layout —
    // UtxoTransaction), so the 64 placeholder bytes stand in for the real
    // signature at measure time. The entry's bytes equal the real bytes'
    // length — a pubkey hex and a 64-byte value — so the measure equals the
    // signed body's size exactly.
    signatures: { [pubKeyHex]: new Uint8Array(64) },
    protocolVersion,
  };
  return encodeTx(candidate).length;
}

function readStatus(data: unknown): { blockHeight: number; protocolVersion: number } | null {
  if (!isRecord(data)) return null;
  const height = data['blockHeight'];
  const version = data['protocolVersion'];
  if (!isNonNegSafeInt(height) || !isNonNegSafeInt(version)) return null;
  return { blockHeight: height, protocolVersion: version };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------------
// The cadence
// ------------------------------------------------------------------------

/** MINING_INTERFACE → Consolidation → "A check runs every `CONSOLIDATE_MIN_BOXES` heights, never inside a work window." —
 *  the stateful cadence. */
export interface Cadence {
  tick(templateHeight: number): Promise<void>;
}

interface CadenceState {
  readonly lastCheckHeight: number;
  readonly lastCheckFull: boolean;
}

/**
 * MINING_INTERFACE → Consolidation → "A check runs every `CONSOLIDATE_MIN_BOXES` heights, never inside a work window."
 * The cadence runs a check at the first template height it is called with,
 * then at the first template height `CONSOLIDATE_MIN_BOXES` above the last
 * check's, or at the next template height where the last check was full. A
 * failing check moves the cadence forward the same as a passing one; a
 * subsequent due height checks again.
 */
export function createCadence(opts: CheckOptions): Cadence {
  let state: CadenceState | null = null;
  return {
    async tick(templateHeight: number): Promise<void> {
      if (state !== null) {
        const due = state.lastCheckFull
          ? state.lastCheckHeight + 1
          : state.lastCheckHeight + CONSOLIDATE_MIN_BOXES;
        if (templateHeight < due) return;
      }
      const outcome = await runConsolidateCheck(opts);
      state = { lastCheckHeight: templateHeight, lastCheckFull: outcome.full };
    },
  };
}

