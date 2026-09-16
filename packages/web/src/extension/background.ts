import { ed25519 } from '@noble/curves/ed25519.js';
import { computeTxId, decodeTx, computeContentHash } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { seal, open, parseFile, toHex, hexToBytes, IdentityError, type Envelope } from '../identity/envelope';
import { generateKeyPair } from '@dagsocial/types';
import {
  isMessage, REFUSED_UNKNOWN,
  type AppSnapshot, type SignAnswer, type SignHint, type SignRecord,
} from './protocol';
import { summarise, classifyLedger } from './policy';

// The extension's identity service — WEB_INTERFACE → The extension. It holds
// the envelope in `storage.local` and the unlocked seed in `storage.session`,
// reloads what it needs from storage on every call, and never keeps state in a
// worker global. Records the prompt page reads live in `storage.session`, so a
// worker killed while the human reads the prompt loses nothing
// (WEB_INTERFACE → "Three contexts, and what each may hold").

// ---------------------------------------------------------------------------
// Storage keys — WEB_INTERFACE → "Three contexts, and what each may hold".
// ---------------------------------------------------------------------------

const K_ENVELOPE = 'notis.identity';
const K_BACKEDUP = 'notis.identity.backedup';
const K_POLICY = 'notis.signPolicy';
const K_SEED = 'notis.seed';
const K_DRAFT = 'notis.draft';
const K_SIGN_PREFIX = 'notis.sign.';

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// The dispatcher — one runtime.onMessage listener over the closed Message set;
// unknown kinds are refused with `{ error: 'unknown message kind' }`.
// ---------------------------------------------------------------------------

/** Wire the identity service into a `chrome`-shaped surface. `install()` is
 *  called at module load; the service reads back what it needs from storage on
 *  every message, so a worker restart mid-conversation is safe. */
export function install(api: typeof chrome): void {
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handle(api, message, sender).then((answer) => sendResponse(answer));
    return true; // keep the channel open until the async handler resolves
  });
  api.runtime.onInstalled.addListener(() => { void sweepOrphanedRecords(api); });
  api.runtime.onStartup.addListener(() => { void sweepOrphanedRecords(api); });
  api.action.onClicked.addListener(() => { void raiseOrOpenPage(api); });
  api.windows.onRemoved.addListener((windowId) => { void windowClosed(api, windowId); });
}

/** Dispatch one message to the identity service. `unknown` from the wire, so
 *  every branch reads from `Message`'s typed shape after `isMessage`. */
async function handle(api: typeof chrome, message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!isMessage(message)) return REFUSED_UNKNOWN;
  switch (message.kind) {
    case 'state': return await stateSnapshot(api);
    case 'draft': return await draft(api);
    case 'discardDraft': return await discardDraft(api);
    case 'create': return await create(api, message.passphrase);
    case 'inspectFile': return inspectFile(message.text);
    case 'importFile': return await importFile(api, message.text, message.passphrase);
    case 'exportFile': return await exportFile(api, message.password);
    case 'unlock': return await unlock(api, message.passphrase);
    case 'lock': return await lock(api);
    case 'forget': return await forget(api);
    case 'policy': return await setPolicy(api, message.karma);
    case 'sign': return await signMessage(api, message.txBytesHex, message.txIdHex, message.hint ?? {});
    case 'ack': return await ack(api, message.id);
    case 'approve': return await approve(api, message.id, sender);
    case 'decline': return await decline(api, message.id, sender);
  }
}

// ---------------------------------------------------------------------------
// state — the snapshot the proxy fetches once before the App constructs.
// ---------------------------------------------------------------------------

async function stateSnapshot(api: typeof chrome): Promise<AppSnapshot | null> {
  const [localGet, seedGet, policy] = await Promise.all([
    api.storage.local.get([K_ENVELOPE, K_BACKEDUP]),
    api.storage.session.get(K_SEED),
    readPolicy(api),
  ]);
  const envelope = parseEnvelope(localGet[K_ENVELOPE]);
  if (envelope === null) return null;
  const seed = seedGet[K_SEED];
  return {
    pubKeyHex: envelope.pubKeyHex,
    locked: typeof seed !== 'string',
    backedUp: localGet[K_BACKEDUP] === '1',
    policy,
  };
}

// ---------------------------------------------------------------------------
// draft / create — a drafted key rides `storage.session` under `notis.draft`
// so a worker restart between draft and create still finds it.
// ---------------------------------------------------------------------------

async function draft(api: typeof chrome): Promise<{ pubKeyHex: string }> {
  const kp = generateKeyPair();
  const pubKeyHex = toHex(kp.publicKey);
  const seedHex = toHex(kp.secretKey.subarray(16)); // the DER's last 32 bytes
  await api.storage.session.set({ [K_DRAFT]: { pubKeyHex, seedHex } });
  return { pubKeyHex };
}

async function discardDraft(api: typeof chrome): Promise<'ok'> {
  await api.storage.session.remove(K_DRAFT);
  return 'ok';
}

async function create(api: typeof chrome, passphrase: string): Promise<{ pubKeyHex: string } | { error: string }> {
  const draftGet = await api.storage.session.get(K_DRAFT);
  const d = draftGet[K_DRAFT] as { pubKeyHex?: unknown; seedHex?: unknown } | undefined;
  if (!d || typeof d.pubKeyHex !== 'string' || typeof d.seedHex !== 'string' || !HEX64.test(d.pubKeyHex) || !HEX64.test(d.seedHex)) {
    return { error: 'no drafted key to create.' };
  }
  const seed = hexToBytes(d.seedHex);
  const envelope = await seal(seed, d.pubKeyHex, passphrase);
  await api.storage.local.set({ [K_ENVELOPE]: JSON.stringify(envelope) });
  await api.storage.local.remove(K_BACKEDUP);
  await api.storage.session.set({ [K_SEED]: d.seedHex });
  await api.storage.session.remove(K_DRAFT);
  return { pubKeyHex: d.pubKeyHex };
}

// ---------------------------------------------------------------------------
// inspectFile / importFile / exportFile — the identity module's file
// operations, unchanged in logic. A clear file's seed never leaves the
// background — parseFile derives it and importFile seals it under the
// passphrase before writing.
// ---------------------------------------------------------------------------

function inspectFile(text: string): { kind: 'clear' | 'encrypted'; pubKeyHex: string } | { error: string } {
  try {
    const parsed = parseFile(text);
    return { kind: parsed.kind, pubKeyHex: parsed.pubKeyHex };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}

async function importFile(api: typeof chrome, text: string, passphrase: string): Promise<{ pubKeyHex: string } | { error: string }> {
  let seed: Uint8Array;
  let envelope: Envelope;
  try {
    const parsed = parseFile(text);
    if (parsed.kind === 'clear') {
      envelope = await seal(parsed.seed, parsed.pubKeyHex, passphrase);
      seed = parsed.seed;
    } else {
      envelope = parsed.envelope;
      seed = await open(parsed.envelope, passphrase);
    }
  } catch (e) {
    return { error: errorMessage(e) };
  }
  await api.storage.local.set({ [K_ENVELOPE]: JSON.stringify(envelope), [K_BACKEDUP]: '1' });
  await api.storage.session.set({ [K_SEED]: toHex(seed) });
  return { pubKeyHex: envelope.pubKeyHex };
}

async function exportFile(api: typeof chrome, password: string): Promise<{ text: string } | { error: string }> {
  const seed = await readSeed(api);
  const env = await readEnvelope(api);
  if (seed === null || env === null) return { error: 'no unlocked identity is loaded to export.' };
  const envelope = await seal(seed, env.pubKeyHex, password);
  await api.storage.local.set({ [K_BACKEDUP]: '1' });
  return { text: JSON.stringify(envelope, null, 2) };
}

// ---------------------------------------------------------------------------
// unlock / lock / forget — the seed's lifecycle. `lock` deletes the session
// value; `forget` deletes everything.
// ---------------------------------------------------------------------------

async function unlock(api: typeof chrome, passphrase: string): Promise<'ok' | { error: string }> {
  const env = await readEnvelope(api);
  if (env === null) return { error: 'no identity is loaded to unlock.' };
  let seed: Uint8Array;
  try {
    seed = await open(env, passphrase);
  } catch (e) {
    return { error: errorMessage(e) };
  }
  await api.storage.session.set({ [K_SEED]: toHex(seed) });
  return 'ok';
}

async function lock(api: typeof chrome): Promise<'ok'> {
  await api.storage.session.remove(K_SEED);
  return 'ok';
}

async function forget(api: typeof chrome): Promise<'ok'> {
  await api.storage.local.remove([K_ENVELOPE, K_BACKEDUP]);
  await api.storage.session.remove(K_SEED);
  return 'ok';
}

// ---------------------------------------------------------------------------
// policy — the extension's binary preference for karma-side signs.
// ---------------------------------------------------------------------------

async function readPolicy(api: typeof chrome): Promise<'silent' | 'ask'> {
  const got = await api.storage.local.get(K_POLICY);
  return got[K_POLICY] === 'ask' ? 'ask' : 'silent';
}

async function setPolicy(api: typeof chrome, karma: 'silent' | 'ask'): Promise<'ok'> {
  await api.storage.local.set({ [K_POLICY]: karma });
  return 'ok';
}

// ---------------------------------------------------------------------------
// sign — WEB_INTERFACE → "`sign`, in the background, in order".
// ---------------------------------------------------------------------------

async function signMessage(api: typeof chrome, txBytesHex: string, txIdHex: string, hint: SignHint): Promise<SignAnswer> {
  // 1. Decode. A failure ⇒ undecodable.
  let tx: UtxoTransaction;
  try {
    tx = decodeTx(hexToBytes(txBytesHex));
  } catch {
    return { refused: 'undecodable' };
  }
  // 2. The page's id is a claim; the background's is the truth.
  if (computeTxId(tx) !== txIdHex) return { refused: 'id-mismatch' };
  // 3. The signature rides after the id — the tx we sign over must carry none.
  if (Object.keys(tx.signatures).length > 0) return { refused: 'already-signed' };
  // 4. Classify.
  const ledger = classifyLedger(tx);
  const policy = await readPolicy(api);
  // 5. Karma with 'silent' — sign at once or refuse locked.
  if (ledger === 'karma' && policy === 'silent') {
    const seed = await readSeed(api);
    if (seed === null) return { locked: true };
    return { signature: toHex(ed25519.sign(hexToBytes(txIdHex), seed)) };
  }
  // 6. Otherwise, the prompt. One at a time.
  if (await hasOpenPromptRecord(api)) return { refused: 'busy' };
  const env = await readEnvelope(api);
  if (env === null) return { locked: true };
  const summary = summarise(tx, env.pubKeyHex);
  const record: SignRecord = {
    id: randomId(),
    txIdHex,
    txBytesHex,
    summary,
    hint: verifiedHint(tx, hint),
    createdAt: Date.now(),
  };
  const key = K_SIGN_PREFIX + record.id;
  await api.storage.session.set({ [key]: record });
  const w = await api.windows.create({
    type: 'popup',
    url: api.runtime.getURL('prompt.html') + '?id=' + record.id,
    width: 420,
    height: 320,
  });
  if (typeof w.id === 'number') {
    record.windowId = w.id;
    await api.storage.session.set({ [key]: record });
  }
  return { pending: record.id };
}

/** approve is checked by the sender's URL — an approval message may come only
 *  from the prompt page (WEB_INTERFACE → "The messages"). */
async function approve(api: typeof chrome, id: string, sender: chrome.runtime.MessageSender): Promise<'ok' | { error: string }> {
  if (!isFromPromptPage(api, sender)) return { error: 'approve is only accepted from the prompt page' };
  const record = await readRecord(api, id);
  if (record === null || record.result) return { error: 'no open prompt for that id' };
  const seed = await readSeed(api);
  if (seed === null) return { error: 'locked' };
  const signature = toHex(ed25519.sign(hexToBytes(record.txIdHex), seed));
  const updated: SignRecord = { ...record, result: { signature } };
  await api.storage.session.set({ [K_SIGN_PREFIX + id]: updated });
  if (typeof record.windowId === 'number') {
    try { await api.windows.remove(record.windowId); } catch { /* already gone */ }
  }
  return 'ok';
}

async function decline(api: typeof chrome, id: string, sender: chrome.runtime.MessageSender): Promise<'ok' | { error: string }> {
  if (!isFromPromptPage(api, sender)) return { error: 'decline is only accepted from the prompt page' };
  const record = await readRecord(api, id);
  if (record === null || record.result) return { error: 'no open prompt for that id' };
  const updated: SignRecord = { ...record, result: { declined: true } };
  await api.storage.session.set({ [K_SIGN_PREFIX + id]: updated });
  if (typeof record.windowId === 'number') {
    try { await api.windows.remove(record.windowId); } catch { /* already gone */ }
  }
  return 'ok';
}

async function ack(api: typeof chrome, id: string): Promise<'ok'> {
  await api.storage.session.remove(K_SIGN_PREFIX + id);
  return 'ok';
}

/** A prompt window that closes without an answer writes `{ declined: true }` —
 *  the record's `windowId` was recorded at write. */
async function windowClosed(api: typeof chrome, windowId: number): Promise<void> {
  const records = await readAllRecords(api);
  for (const [key, record] of records) {
    if (record.windowId === windowId && !record.result) {
      const updated: SignRecord = { ...record, result: { declined: true } };
      await api.storage.session.set({ [key]: updated });
    }
  }
}

/** On background start, every record without a result is declined — a window
 *  that vanished with the browser (WEB_INTERFACE → "`sign`, in the background,
 *  in order"). Records are removed on `ack`, so a lingering result-less record
 *  is a crash. */
async function sweepOrphanedRecords(api: typeof chrome): Promise<void> {
  const records = await readAllRecords(api);
  for (const [key, record] of records) {
    if (!record.result) {
      const updated: SignRecord = { ...record, result: { declined: true } };
      await api.storage.session.set({ [key]: updated });
    }
  }
}

// ---------------------------------------------------------------------------
// The action button — WEB_INTERFACE → "The action button opens or focuses the
// page". No default_popup, since one suppresses onClicked.
// ---------------------------------------------------------------------------

async function raiseOrOpenPage(api: typeof chrome): Promise<void> {
  const pageUrl = api.runtime.getURL('index.html');
  const tabs = await api.tabs.query({ url: pageUrl + '*' });
  const first = tabs.find((t) => typeof t.id === 'number');
  if (first && typeof first.id === 'number') {
    await api.tabs.update(first.id, { active: true });
    if (typeof first.windowId === 'number') await api.windows.update(first.windowId, { focused: true });
    return;
  }
  await api.tabs.create({ url: pageUrl });
}

// ---------------------------------------------------------------------------
// Storage readers — every message reloads from storage on every call. Nothing
// is cached in a global.
// ---------------------------------------------------------------------------

async function readSeed(api: typeof chrome): Promise<Uint8Array | null> {
  const got = await api.storage.session.get(K_SEED);
  const v = got[K_SEED];
  if (typeof v !== 'string' || !HEX64.test(v)) return null;
  return hexToBytes(v);
}

async function readEnvelope(api: typeof chrome): Promise<Envelope | null> {
  const got = await api.storage.local.get(K_ENVELOPE);
  return parseEnvelope(got[K_ENVELOPE]);
}

function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = parseFile(raw);
    return parsed.kind === 'encrypted' ? parsed.envelope : null;
  } catch {
    return null;
  }
}

async function readRecord(api: typeof chrome, id: string): Promise<SignRecord | null> {
  const got = await api.storage.session.get(K_SIGN_PREFIX + id);
  const v = got[K_SIGN_PREFIX + id];
  return isRecord(v) ? v : null;
}

async function readAllRecords(api: typeof chrome): Promise<Array<[string, SignRecord]>> {
  const all = await api.storage.session.get(null);
  const rows: Array<[string, SignRecord]> = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(K_SIGN_PREFIX)) continue;
    if (isRecord(v)) rows.push([k, v]);
  }
  return rows;
}

async function hasOpenPromptRecord(api: typeof chrome): Promise<boolean> {
  const rows = await readAllRecords(api);
  return rows.some(([, r]) => !r.result);
}

function isRecord(v: unknown): v is SignRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { id?: unknown; txIdHex?: unknown; txBytesHex?: unknown; summary?: unknown };
  return typeof r.id === 'string' && typeof r.txIdHex === 'string' && typeof r.txBytesHex === 'string' && typeof r.summary === 'object';
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isFromPromptPage(api: typeof chrome, sender: chrome.runtime.MessageSender): boolean {
  const url = typeof sender.url === 'string' ? sender.url : '';
  return url.startsWith(api.runtime.getURL('prompt.html'));
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function verifiedHint(tx: UtxoTransaction, hint: SignHint): SignHint {
  // Content is shown only when its hash matches the commit — WEB_INTERFACE →
  // "The summary the prompt shows is derived from the transaction". Any other
  // field the page might sneak in is dropped.
  if (typeof hint.content === 'string' && tx.post) {
    const computed = toHex(computeContentHash(hint.content));
    if (computed === toHex(tx.post.contentHash)) return { content: hint.content };
  }
  return {};
}

function errorMessage(e: unknown): string {
  if (e instanceof IdentityError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// Auto-install at module load — the background is loaded by the browser's own
// runtime, so listeners must register before the first event. Tests build the
// module through a fake `chrome` and call install(api) themselves; the guard
// keeps them from double-installing here.
if (typeof globalThis !== 'undefined' && typeof (globalThis as { chrome?: unknown }).chrome !== 'undefined') {
  install((globalThis as unknown as { chrome: typeof chrome }).chrome);
}

