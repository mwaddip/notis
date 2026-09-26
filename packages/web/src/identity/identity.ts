import { ed25519 } from '@noble/curves/ed25519.js';
import { generateKeyPair, bytesToHex, hexToBytes } from '@dagsocial/types';
import { readStore, writeStore, removeStore } from '../prefs';
import { seal, open, parseFile, IdentityError, type Envelope, type ParsedFile } from './envelope';
import type { SignResult } from '../wallet/submit';

// The identity machinery — WEB_INTERFACE → The identity module. One identity at a
// time, stored under `notis.identity` as an encrypted envelope; the seed is
// decrypted on demand and held in JS memory for the tab, never at rest in the
// clear. A page load restores the envelope and public key only, so a stored
// identity reads locked until an unlock; current() carries the public key and the
// lock state and nothing else. sign is the only path to the seed (WEB_INTERFACE →
// "sign is the only path to the seed") and throws while locked. Signing is
// @noble/curves, pure TS, so there is no Web Crypto and no secure-context
// requirement.

export { IdentityError } from './envelope';

/** The public view of a loaded identity — the seed is never in it. */
export interface Identity {
  pubKeyHex: string; // 64 hex — the Ed25519 public key
}

/** The localStorage key holding the one identity — WEB_INTERFACE → The identity module. */
export const IDENTITY_KEY = 'notis.identity';

/** The flag recording that the loaded key has been written to a file — unset by
 *  generate, set by import and by export, cleared by forget (WEB_INTERFACE → The
 *  profile window, the Create and Export operations). */
const BACKEDUP_KEY = 'notis.identity.backedup';

const HEX64 = /^[0-9a-f]{64}$/;

export class IdentityModule {
  // The seed sits in JS memory only while unlocked; it is never a return value,
  // and current() cannot reach it. The envelope is what storage holds and what an
  // unlock opens.
  private seed: Uint8Array | null = null;
  private pubKeyHex: string | null = null;
  private envelope: Envelope | null = null;
  // A key drafted but not yet sealed — held so the create form shows its prefix as
  // the username before the passphrase is typed (WEB_INTERFACE → The identity module).
  private draftKp: { pubKeyHex: string; seed: Uint8Array } | null = null;
  private listeners: Array<(id: Identity | null) => void> = [];

  constructor() {
    this.restore();
  }

  /** The loaded identity's public half and its lock state, or null — the read
   *  surface is unchanged when this is null, and a stored identity reads locked
   *  until an unlock (WEB_INTERFACE → The identity module). */
  current(): { pubKeyHex: string; locked: boolean } | null {
    return this.pubKeyHex === null ? null : { pubKeyHex: this.pubKeyHex, locked: this.seed === null };
  }

  /** Draft a fresh key — generated through @dagsocial/types and held privately,
   *  not stored; current() is unchanged until create seals it. A second draft
   *  replaces the first (WEB_INTERFACE → The identity module). Async so the same
   *  seam serves the extension's proxy, which routes it as a message; here it
   *  resolves at once. */
  async draft(): Promise<Identity> {
    const kp = generateKeyPair();
    const pubKeyHex = bytesToHex(kp.publicKey);
    this.draftKp = { pubKeyHex, seed: new Uint8Array(kp.secretKey.subarray(16)) }; // the DER's last 32 bytes
    return { pubKeyHex };
  }

  /** Seal the drafted key under the passphrase and store it unlocked — the created
   *  key is the drafted key, so a passphrase saved against the draft's prefix opens
   *  it later. A created key has no file yet, so the backup flag is unset. */
  async create(passphrase: string): Promise<Identity> {
    if (this.draftKp === null) throw new IdentityError('no drafted key to create.');
    const { pubKeyHex, seed } = this.draftKp;
    const envelope = await seal(seed, pubKeyHex, passphrase);
    this.draftKp = null;
    return this.adopt(envelope, seed, false);
  }

  /** Drop a drafted key the reader did not create. */
  discardDraft(): void {
    this.draftKp = null;
  }

  /** Say whether a file's text is the clear file shape or an encrypted
   *  envelope, and whose key it is. The seed parseFile derives for a clear file
   *  stays inside this module (WEB_INTERFACE → "sign is the only path to the
   *  seed"). Async so the same seam serves the extension's proxy. */
  async inspectFile(text: string): Promise<{ kind: 'clear' | 'encrypted'; pubKeyHex: string }> {
    const parsed = parseFile(text);
    return { kind: parsed.kind, pubKeyHex: parsed.pubKeyHex };
  }

  /** Adopt a file. A clear file is sealed under the passphrase the reader sets; an
   *  encrypted file's successful open admits it and it is stored verbatim. Either
   *  way the key already has a file, so the backup flag is set. */
  async importFile(text: string, passphrase: string): Promise<Identity> {
    const parsed = parseFile(text);
    if (parsed.kind === 'clear') {
      const envelope = await seal(parsed.seed, parsed.pubKeyHex, passphrase);
      return this.adopt(envelope, parsed.seed, true);
    }
    const seed = await open(parsed.envelope, passphrase); // throws IdentityError on a wrong passphrase
    return this.adopt(parsed.envelope, seed, true);
  }

  /** A fresh envelope under a password the reader types, for download — needs the
   *  seed, so the profile unlocks first. The at-rest envelope is untouched; the
   *  backup flag is set. */
  async exportFile(password: string): Promise<string> {
    if (this.seed === null || this.pubKeyHex === null) {
      throw new IdentityError('no unlocked identity is loaded to export.');
    }
    const envelope = await seal(this.seed, this.pubKeyHex, password);
    writeStore(BACKEDUP_KEY, '1');
    return JSON.stringify(envelope, null, 2);
  }

  /** Load the seed into memory from the stored envelope — a wrong passphrase is
   *  refused with the envelope's own reason. */
  async unlock(passphrase: string): Promise<void> {
    if (this.envelope === null) throw new IdentityError('no identity is loaded to unlock.');
    if (this.seed !== null) return; // already unlocked
    this.seed = await open(this.envelope, passphrase);
  }

  /** Drop the seed from memory; current() then reads locked. Async so the same
   *  seam serves the extension's proxy, which refreshes its snapshot from
   *  storage before resolving; here it resolves at once. */
  async lock(): Promise<void> {
    this.seed = null;
  }

  /** Drop the identity from memory, storage and the backup flag. The key's pending
   *  ledger is left, so a key re-imported later resumes it (WEB_INTERFACE → The
   *  profile window). Async for the same reason as `lock`. */
  async forget(): Promise<void> {
    this.seed = null;
    this.pubKeyHex = null;
    this.envelope = null;
    removeStore(IDENTITY_KEY);
    removeStore(BACKEDUP_KEY);
    this.notify(null);
  }

  /** Ed25519 over the 32 transaction-id bytes, 128 hex out — the only path to the
   *  seed (WEB_INTERFACE → "sign is the only path to the seed"). The App checks
   *  locked before a flight starts, so `locked` here is a race the wallet ends in
   *  the notSigned arm rather than a stuck state (WEB_INTERFACE → The wallet).
   *  A transaction id is exactly 64 lowercase hex; anything else comes back as
   *  `refused` rather than signed over garbage. The in-page module never answers
   *  `declined` — that is the extension proxy's arm (WEB_INTERFACE → The identity
   *  module). `txBytes` is ignored here; the extension's background needs it,
   *  since it re-derives the id it signs over. */
  async sign(_txBytes: Uint8Array, txIdHex: string, _hint?: { content?: string }): Promise<SignResult> {
    if (this.seed === null) return { locked: true };
    if (!HEX64.test(txIdHex)) return { refused: 'a transaction id to sign must be 64 hex characters.' };
    return { signature: bytesToHex(ed25519.sign(hexToBytes(txIdHex), this.seed)) };
  }

  /** Whether the loaded key has been written to a file. */
  backedUp(): boolean {
    return readStore(BACKEDUP_KEY) === '1';
  }

  /** Subscribe to identity changes — create, import and forget fire it (WEB_INTERFACE
   *  → "An identity change takes effect at once"). */
  onChange(listener: (id: Identity | null) => void): void {
    this.listeners.push(listener);
  }

  // -------------------------------------------------------------------------

  /** Store an envelope, hold its seed, set the backup flag, and announce it. */
  private adopt(envelope: Envelope, seed: Uint8Array, backedUp: boolean): Identity {
    this.envelope = envelope;
    this.pubKeyHex = envelope.pubKeyHex;
    this.seed = seed;
    writeStore(IDENTITY_KEY, JSON.stringify(envelope));
    if (backedUp) writeStore(BACKEDUP_KEY, '1');
    else removeStore(BACKEDUP_KEY);
    const id = { pubKeyHex: envelope.pubKeyHex };
    this.notify(id);
    return id;
  }

  /** Load a stored envelope at construction — the envelope and public key only,
   *  never the seed, so current() reads locked (WEB_INTERFACE → The identity
   *  module). The clear shape is a file shape only (WEB_INTERFACE → The identity
   *  module, the Import row), so a clear stored value reads as no identity and is
   *  left in place; a value that does not parse is left too. localStorage is
   *  untrusted input, guarded like prefs.ts guards its reads. */
  private restore(): void {
    const raw = readStore(IDENTITY_KEY);
    if (raw === null) return;
    let parsed: ParsedFile;
    try {
      parsed = parseFile(raw);
    } catch {
      return;
    }
    if (parsed.kind !== 'encrypted') return; // a clear stored value is no identity, left in place
    this.envelope = parsed.envelope;
    this.pubKeyHex = parsed.pubKeyHex;
  }

  private notify(id: Identity | null): void {
    for (const listener of this.listeners) listener(id);
  }
}

/** The single identity module the app loads. */
export const identity = new IdentityModule();
