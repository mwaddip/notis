// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPublicKey as nodeCreatePublicKey, verify as nodeVerify } from 'node:crypto';
import { generateKeyPair, ED25519_SPKI_PREFIX } from '@dagsocial/types';
import { IdentityModule, IDENTITY_KEY, type Identity } from '../src/identity/identity';

// The identity module holds one key as an encrypted envelope, decrypts the seed on
// demand, and never lets the seed cross its boundary (WEB_INTERFACE → The identity
// module). Under vitest the vite alias routes @dagsocial/types' `crypto` through the
// shim, and Node's real `crypto.verify(null, …)` — the node's verifier path —
// confirms a signature the module makes, the way crypto-shim.test.ts reaches real
// Node crypto. scrypt runs at the production N here; each create/unlock pays it.

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// The common path: draft a key, then seal and store it under a passphrase.
function mint(m: IdentityModule, passphrase: string): Promise<Identity> {
  m.draft();
  return m.create(passphrase);
}

beforeEach(() => {
  localStorage.clear();
});

describe('identity module — create, export, import', () => {
  it('create → export → import round trips the key through an encrypted envelope', async () => {
    const a = new IdentityModule();
    const id = await mint(a, 'at-rest passphrase');
    expect(id.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);

    const text = await a.exportFile('file password');
    const env = JSON.parse(text);
    expect(env).toMatchObject({ version: 1, pubKeyHex: id.pubKeyHex, cipher: { name: 'chacha20-poly1305' } });
    // The exported file is encrypted — no clear private key in it.
    expect(env.privKeyBase64).toBeUndefined();

    // A fresh module with cleared storage has no identity, then imports that exact text.
    localStorage.clear();
    const b = new IdentityModule();
    expect(b.current()).toBeNull();
    const imported = await b.importFile(text, 'file password');
    expect(imported.pubKeyHex).toBe(id.pubKeyHex);
    // Import leaves it unlocked, so it can sign — the seed came across.
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: false });
    expect(b.sign('ab'.repeat(32))).toHaveLength(128);
  });

  it('a clear file imports under a set passphrase, stored as an envelope, and can sign', async () => {
    const kp = generateKeyPair();
    const pubKeyHex = toHex(kp.publicKey);
    const clear = JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(kp.secretKey) });
    const m = new IdentityModule();
    const id = await m.importFile(clear, 'chosen passphrase');
    expect(id.pubKeyHex).toBe(pubKeyHex);
    expect(m.current()).toEqual({ pubKeyHex, locked: false });
    expect(m.sign('cd'.repeat(32))).toHaveLength(128);

    // Storage never holds the clear shape — it is sealed on import.
    const stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) as string);
    expect(stored.ciphertext).toEqual(expect.any(String));
    expect(stored.privKeyBase64).toBeUndefined();
  });

  it('importFile refuses a clear file for a wrong length, prefix or mismatched key, and non-JSON', async () => {
    const kp = generateKeyPair();
    const pubKeyHex = toHex(kp.publicKey);
    const m = new IdentityModule();

    const short = JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(kp.secretKey.subarray(0, 47)) });
    await expect(m.importFile(short, 'x')).rejects.toThrow(/48-byte/);

    const badPrefix = new Uint8Array(kp.secretKey);
    badPrefix[0] = 0xff;
    await expect(m.importFile(JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(badPrefix) }), 'x')).rejects.toThrow(
      /PKCS8/,
    );

    const other = generateKeyPair();
    const mismatch = JSON.stringify({ pubKeyHex: toHex(other.publicKey), privKeyBase64: bytesToBase64(kp.secretKey) });
    await expect(m.importFile(mismatch, 'x')).rejects.toThrow(/does not produce/);

    await expect(m.importFile('not json at all', 'x')).rejects.toThrow(/valid identity file/);
    // A failed import loads nothing.
    expect(m.current()).toBeNull();
  });

  it('current() carries the public key and lock state alone — never the seed', async () => {
    const m = new IdentityModule();
    await mint(m, 'pw');
    const cur = m.current();
    expect(cur).not.toBeNull();
    expect(Object.keys(cur as object).sort()).toEqual(['locked', 'pubKeyHex']);
    const asRecord = cur as unknown as Record<string, unknown>;
    expect(asRecord.privKeyBase64).toBeUndefined();
    expect(asRecord.seed).toBeUndefined();
  });

  it('forget() drops the identity from memory, storage and the backup flag', async () => {
    const m = new IdentityModule();
    await mint(m, 'pw');
    await m.exportFile('file'); // sets the backup flag
    expect(m.backedUp()).toBe(true);

    m.forget();
    expect(m.current()).toBeNull();
    expect(localStorage.getItem(IDENTITY_KEY)).toBeNull();
    expect(m.backedUp()).toBe(false);
    expect(() => m.sign('ab'.repeat(32))).toThrow(/no identity/);
    await expect(m.exportFile('file')).rejects.toThrow(/no unlocked identity/);
  });
});

describe('identity module — locked at rest, unlocked on demand', () => {
  it('a stored identity restores locked; unlock loads the seed, lock drops it', async () => {
    const id = await mint(new IdentityModule(), 'the passphrase');

    const b = new IdentityModule(); // reads the stored envelope
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: true });
    expect(() => b.sign('ab'.repeat(32))).toThrow(/locked/);

    await b.unlock('the passphrase');
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: false });
    expect(b.sign('ab'.repeat(32))).toHaveLength(128);

    b.lock();
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: true });
    expect(() => b.sign('ab'.repeat(32))).toThrow(/locked/);
  });

  it('unlock refuses a wrong passphrase and stays locked', async () => {
    const id = await mint(new IdentityModule(), 'right');
    const b = new IdentityModule();
    await expect(b.unlock('wrong')).rejects.toThrow(/does not open this key/);
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: true });
  });

  it('the backup flag: unset on create, set on export and import, cleared on forget', async () => {
    const m = new IdentityModule();
    await mint(m, 'pw');
    expect(m.backedUp()).toBe(false); // created — no file yet
    const text = await m.exportFile('file pw');
    expect(m.backedUp()).toBe(true); // exported — a file exists
    m.forget();
    expect(m.backedUp()).toBe(false); // cleared
    await m.importFile(text, 'file pw');
    expect(m.backedUp()).toBe(true); // imported — a file already existed
  });

  it('onChange fires on create, forget and import', async () => {
    const m = new IdentityModule();
    const events: Array<Identity | null> = [];
    m.onChange((id) => events.push(id));

    const gen = await mint(m, 'pw');
    expect(events.at(-1)).toEqual({ pubKeyHex: gen.pubKeyHex });

    const text = await m.exportFile('file pw');
    m.forget();
    expect(events.at(-1)).toBeNull();

    const imp = await m.importFile(text, 'file pw');
    expect(events.at(-1)).toEqual({ pubKeyHex: imp.pubKeyHex });
    expect(events).toHaveLength(3); // export does not fire onChange
  });
});

describe('identity module — persistence and storage guards', () => {
  it('a write that throws does not break a load — the identity lives for the session', async () => {
    const m = new IdentityModule();
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('storage blocked');
    };
    try {
      const id = await mint(m, 'pw');
      expect(m.current()).toEqual({ pubKeyHex: id.pubKeyHex, locked: false });
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('a read that throws yields no identity rather than an exception', () => {
    const orig = localStorage.getItem.bind(localStorage);
    localStorage.getItem = () => {
      throw new Error('storage blocked');
    };
    try {
      expect(new IdentityModule().current()).toBeNull();
    } finally {
      localStorage.getItem = orig;
    }
  });

  it('a corrupt stored value is left unloaded, not trusted', () => {
    localStorage.setItem(IDENTITY_KEY, '{ this is not valid json');
    expect(new IdentityModule().current()).toBeNull();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ pubKeyHex: 'ab'.repeat(32), privKeyBase64: 'notbase64!!' }));
    expect(new IdentityModule().current()).toBeNull();
  });

  it('a clear stored value reads as no identity and is left in place', () => {
    const kp = generateKeyPair();
    const clear = JSON.stringify({ pubKeyHex: toHex(kp.publicKey), privKeyBase64: bytesToBase64(kp.secretKey) });
    localStorage.setItem(IDENTITY_KEY, clear);
    const m = new IdentityModule();
    expect(m.current()).toBeNull();
    expect(localStorage.getItem(IDENTITY_KEY)).toBe(clear); // left in place, overwritten only by the next create or import
  });
});

describe('identity module — signing interop with the node verifier', () => {
  it('a signature verifies under Node crypto.verify(null, …) with the SPKI-wrapped key', async () => {
    const m = new IdentityModule();
    const { pubKeyHex } = await mint(m, 'pw');
    const txIdHex = '9a'.repeat(32);
    const sigHex = m.sign(txIdHex);
    expect(sigHex).toHaveLength(128);

    // The node wraps the 32-byte key in the fixed SPKI prefix and verifies raw
    // Ed25519 over the 32 id bytes.
    const spki = hexToBytes(ED25519_SPKI_PREFIX + pubKeyHex);
    const key = nodeCreatePublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(nodeVerify(null, hexToBytes(txIdHex), key, hexToBytes(sigHex))).toBe(true);
    // A different message does not verify against that signature.
    expect(nodeVerify(null, hexToBytes('00'.repeat(32)), key, hexToBytes(sigHex))).toBe(false);
  });

  it('sign refuses anything but 64 lowercase hex — it is the one path to the seed', async () => {
    const m = new IdentityModule();
    await mint(m, 'pw');
    for (const bad of ['', 'abc', 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), 'AB'.repeat(32), `${'ab'.repeat(32)} `]) {
      expect(() => m.sign(bad), bad).toThrow(/64 hex/);
    }
    expect(m.sign('ab'.repeat(32))).toHaveLength(128);
  });
});

describe('identity module — the draft split', () => {
  it('draft() holds a key privately — not stored, current() unchanged', () => {
    const m = new IdentityModule();
    const d = m.draft();
    expect(d.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(m.current()).toBeNull();
    expect(localStorage.getItem(IDENTITY_KEY)).toBeNull();
  });

  it('create() seals and stores the drafted key, loaded unlocked; the created key is the drafted one', async () => {
    const m = new IdentityModule();
    const d = m.draft();
    const id = await m.create('pw');
    expect(id.pubKeyHex).toBe(d.pubKeyHex);
    expect(m.current()).toEqual({ pubKeyHex: d.pubKeyHex, locked: false });
    expect(m.sign('ab'.repeat(32))).toHaveLength(128);
  });

  it('a second draft replaces the first', async () => {
    const m = new IdentityModule();
    const d1 = m.draft();
    const d2 = m.draft();
    expect(d2.pubKeyHex).not.toBe(d1.pubKeyHex);
    expect((await m.create('pw')).pubKeyHex).toBe(d2.pubKeyHex);
  });

  it('discardDraft drops the draft, and create with no draft throws', async () => {
    const m = new IdentityModule();
    m.draft();
    m.discardDraft();
    await expect(m.create('pw')).rejects.toThrow(/no drafted key/);
    await expect(new IdentityModule().create('pw')).rejects.toThrow(/no drafted key/);
  });

  it('draft and discardDraft do not fire onChange; create does', async () => {
    const m = new IdentityModule();
    const events: Array<Identity | null> = [];
    m.onChange((id) => events.push(id));
    m.draft();
    m.discardDraft();
    expect(events).toHaveLength(0);
    m.draft();
    const id = await m.create('pw');
    expect(events).toEqual([{ pubKeyHex: id.pubKeyHex }]);
  });
});
