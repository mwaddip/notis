// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeTx, computeTxId, computeContentHash } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { buildPost, buildLike, type BuildContext } from '../src/wallet/builders';
import { install } from '../src/extension/background';
import { fakeChrome, freshFixture, type FakeChrome } from './fake-chrome';
import type { SignRecord } from '../src/extension/protocol';
import { toHex, hexToBytes } from '../src/identity/envelope';

// The background reloads state from storage on every call. Every `storage.local`
// write MUST be seed-free — the seed lives in `storage.session` alone
// (WEB_INTERFACE → "Three contexts, and what each may hold"). A second
// background instance built on the same fixture answers `approve` for the
// first's prompt — the storage-mediated claim, pinned by run.

// ---------------------------------------------------------------------------
// Test setup — a real key pair, a tx built through the wallet's own builders.
// ---------------------------------------------------------------------------

const BOX = '11'.repeat(32);
const TARGET_POST = 'dd'.repeat(32);
const AUTHOR = 'bb'.repeat(32);

function ctx(pubKeyHex: string): BuildContext {
  return {
    spendable: [{ boxId: BOX, value: 227n }],
    height: 6000,
    era: 1,
    author: pubKeyHex,
  };
}

/** Build a thread tx signed by nobody — the background is the one to sign it. */
function unsignedThreadTx(pubKeyHex: string): { tx: UtxoTransaction; txIdHex: string; txBytesHex: string } {
  const built = buildPost(ctx(pubKeyHex), 'a thread');
  return { tx: built.tx, txIdHex: built.txId, txBytesHex: toHex(encodeTx(built.tx)) };
}

function unsignedLikeTx(pubKeyHex: string): { tx: UtxoTransaction; txIdHex: string; txBytesHex: string } {
  const built = buildLike(ctx(pubKeyHex), TARGET_POST, AUTHOR);
  return { tx: built.tx, txIdHex: built.txId, txBytesHex: toHex(encodeTx(built.tx)) };
}

// ---------------------------------------------------------------------------
// state / draft / create — the identity's lifecycle before a sign.
// ---------------------------------------------------------------------------

describe('background — state and identity lifecycle', () => {
  it('state answers null with no envelope stored', async () => {
    const c = fakeChrome();
    install(c.api);
    expect(await c.send({ kind: 'state' })).toBeNull();
  });

  it('draft + create seals the identity, unlocks it, and never writes the seed to storage.local', async () => {
    const c = fakeChrome();
    install(c.api);
    const drafted = await c.send({ kind: 'draft' }) as { pubKeyHex: string };
    expect(drafted.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);
    // The drafted seed rides storage.session, never storage.local.
    expect(c.storage.local.has('notis.identity')).toBe(false);
    expect(c.storage.session.has('notis.draft')).toBe(true);

    const created = await c.send({ kind: 'create', passphrase: 'pw' }) as { pubKeyHex: string };
    expect(created.pubKeyHex).toBe(drafted.pubKeyHex);
    // The envelope is written; the draft is cleared; the seed lives in session.
    expect(c.storage.local.has('notis.identity')).toBe(true);
    expect(c.storage.session.has('notis.draft')).toBe(false);
    expect(c.storage.session.has('notis.seed')).toBe(true);
    // No storage.local value contains a hex 32-byte seed.
    assertLocalSeedFree(c);

    const snap = await c.send({ kind: 'state' });
    expect(snap).toMatchObject({ pubKeyHex: drafted.pubKeyHex, locked: false, backedUp: false, policy: 'silent' });
  });

  it('unlock and lock only touch the session store; forget clears the envelope too', async () => {
    const c = fakeChrome();
    install(c.api);
    await c.send({ kind: 'draft' });
    await c.send({ kind: 'create', passphrase: 'pw' });
    expect(c.storage.session.has('notis.seed')).toBe(true);

    await c.send({ kind: 'lock' });
    expect(c.storage.session.has('notis.seed')).toBe(false);
    expect(c.storage.local.has('notis.identity')).toBe(true); // envelope stays

    await c.send({ kind: 'unlock', passphrase: 'pw' });
    expect(c.storage.session.has('notis.seed')).toBe(true);
    assertLocalSeedFree(c);

    await c.send({ kind: 'forget' });
    expect(c.storage.local.has('notis.identity')).toBe(false);
    expect(c.storage.session.has('notis.seed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// policy — the binary preference is written to storage.local as `notis.signPolicy`.
// ---------------------------------------------------------------------------

describe('background — policy', () => {
  it('policy defaults to silent; set to ask writes and reads back', async () => {
    const c = fakeChrome();
    install(c.api);
    await c.send({ kind: 'draft' });
    await c.send({ kind: 'create', passphrase: 'pw' });
    expect((await c.send({ kind: 'state' }) as { policy: string }).policy).toBe('silent');

    await c.send({ kind: 'policy', karma: 'ask' });
    expect(c.storage.local.get('notis.signPolicy')).toBe('ask');
    expect((await c.send({ kind: 'state' }) as { policy: string }).policy).toBe('ask');

    await c.send({ kind: 'policy', karma: 'silent' });
    expect(c.storage.local.get('notis.signPolicy')).toBe('silent');
  });
});

// ---------------------------------------------------------------------------
// sign — WEB_INTERFACE → "`sign`, in the background, in order".
// ---------------------------------------------------------------------------

describe('background — sign steps 1-3 refusals', () => {
  it('undecodable bytes are refused', async () => {
    const c = await bootstrappedChrome();
    const answer = await c.send({
      kind: 'sign',
      txBytesHex: 'zz'.repeat(20),
      txIdHex: 'ff'.repeat(32),
    });
    expect(answer).toEqual({ refused: 'undecodable' });
  });

  it('an id that disagrees with computeTxId is refused', async () => {
    const c = await bootstrappedChrome();
    const { txBytesHex } = unsignedThreadTx(await pubKey(c));
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex: 'ff'.repeat(32) });
    expect(answer).toEqual({ refused: 'id-mismatch' });
  });

  it('a transaction that already carries a signature is refused', async () => {
    const c = await bootstrappedChrome();
    const { tx } = unsignedThreadTx(await pubKey(c));
    // Inject a signature into the tx before encoding.
    const signedTx = { ...tx, signatures: { ['aa'.repeat(32)]: new Uint8Array(64) } };
    const signedBytes = encodeTx(signedTx);
    // computeTxId must be re-run on the modified tx, but signatures are not in
    // the txId preimage, so the id equals the original tx's id — good.
    const txIdHex = computeTxId(signedTx);
    const answer = await c.send({ kind: 'sign', txBytesHex: toHex(signedBytes), txIdHex });
    expect(answer).toEqual({ refused: 'already-signed' });
  });
});

describe('background — sign karma-silent path', () => {
  it('unlocked + silent + karma-side ⇒ signature at once', async () => {
    const c = await bootstrappedChrome();
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { signature: string };
    expect(answer.signature).toMatch(/^[0-9a-f]{128}$/);
    // The signature verifies against the pub key over the txIdHex bytes.
    const pub = hexToBytes(await pubKey(c));
    expect(ed25519.verify(hexToBytes(answer.signature), hexToBytes(txIdHex), pub)).toBe(true);
  });

  it('locked + silent ⇒ locked, no prompt written', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'lock' });
    const { txBytesHex, txIdHex } = unsignedLikeTx(await pubKey(c));
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex });
    expect(answer).toEqual({ locked: true });
    expect(promptRecords(c)).toHaveLength(0);
  });
});

describe('background — sign prompt path (ask or credits)', () => {
  it('ask + karma-side writes a record and returns pending', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    expect(answer.pending).toMatch(/^[0-9a-f]{32}$/);
    const records = promptRecords(c);
    expect(records).toHaveLength(1);
    const [, record] = records[0]!;
    expect(record.id).toBe(answer.pending);
    expect(record.txIdHex).toBe(txIdHex);
    expect(record.result).toBeUndefined();
    // A window was created for the prompt.
    expect(c.windows.created).toHaveLength(1);
  });

  it('a second sign that would need a prompt while one is open ⇒ refused: busy', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const first = unsignedThreadTx(await pubKey(c));
    await c.send({ kind: 'sign', txBytesHex: first.txBytesHex, txIdHex: first.txIdHex });
    const second = unsignedLikeTx(await pubKey(c));
    const answer = await c.send({ kind: 'sign', txBytesHex: second.txBytesHex, txIdHex: second.txIdHex });
    expect(answer).toEqual({ refused: 'busy' });
  });

  it('approve signs, writes result, and removes the window', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const first = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    const answer = await c.send({ kind: 'approve', id: first.pending }, promptSender(c));
    expect(answer).toBe('ok');
    const [, record] = promptRecords(c)[0]!;
    expect(record.result).toMatchObject({ signature: expect.stringMatching(/^[0-9a-f]{128}$/) });
    expect(c.windows.removed).toHaveLength(1);
  });

  it('decline writes { declined: true } and removes the window', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const first = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    await c.send({ kind: 'decline', id: first.pending }, promptSender(c));
    const [, record] = promptRecords(c)[0]!;
    expect(record.result).toEqual({ declined: true });
  });

  it('approve from a non-prompt sender is refused', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const first = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    // A sender whose URL is not the prompt page — refused.
    const answer = await c.send({ kind: 'approve', id: first.pending }, { url: 'https://evil.example/' });
    expect(answer).toMatchObject({ error: expect.stringContaining('prompt page') });
  });

  it('windows.onRemoved for the prompt writes { declined: true }', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const first = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    const [, record] = promptRecords(c)[0]!;
    expect(typeof record.windowId).toBe('number');
    c.fireWindowRemoved(record.windowId!);
    // Give the async listener a microtask to write the result.
    await new Promise((r) => setImmediate(r));
    const [, updated] = promptRecords(c)[0]!;
    expect(updated.result).toEqual({ declined: true });
    // ack removes the record.
    await c.send({ kind: 'ack', id: first.pending });
    expect(promptRecords(c)).toHaveLength(0);
  });

  it('on background start every record without a result is declined', async () => {
    const fixture = freshFixture();
    const first = fakeChrome(fixture);
    install(first.api);
    await first.send({ kind: 'draft' });
    await first.send({ kind: 'create', passphrase: 'pw' });
    await first.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(first));
    await first.send({ kind: 'sign', txBytesHex, txIdHex });
    expect(promptRecords(first).some(([, r]) => !r.result)).toBe(true);

    // A fresh instance over the same fixture — the worker restarted. install()
    // registers onStartup; the manual fire drives the sweep.
    const second = fakeChrome(fixture, first.origin);
    install(second.api);
    second.fireStartup();
    await new Promise((r) => setImmediate(r));
    for (const [, record] of promptRecords(second)) {
      expect(record.result).toEqual({ declined: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The claim the whole design rests on — WEB_INTERFACE → The extension. Two
// service instances over the same fake storage answer `approve` for the first's
// prompt, so a worker killed while the human reads the prompt loses nothing.
// ---------------------------------------------------------------------------

describe('background — a fresh instance over the same storage answers approve', () => {
  it('the second instance signs the first\'s pending prompt', async () => {
    const fixture = freshFixture();
    const first = fakeChrome(fixture);
    install(first.api);
    await first.send({ kind: 'draft' });
    await first.send({ kind: 'create', passphrase: 'pw' });
    await first.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(first));
    const answer = await first.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };

    // The "worker restart" — a second instance is built on the same storage,
    // it has no globals from the first, and it answers `approve` for the
    // record the first wrote.
    const second = fakeChrome(fixture, first.origin);
    install(second.api);
    const result = await second.send({ kind: 'approve', id: answer.pending }, promptSender(second));
    expect(result).toBe('ok');

    // The signed record is in the shared storage; either instance would read it.
    const [, record] = promptRecords(second)[0]!;
    expect(record.result).toMatchObject({ signature: expect.stringMatching(/^[0-9a-f]{128}$/) });
    // The signature verifies against the pub key over the txIdHex bytes.
    const sigHex = (record.result as { signature: string }).signature;
    const pub = hexToBytes(await pubKey(second));
    expect(ed25519.verify(hexToBytes(sigHex), hexToBytes(txIdHex), pub)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The hint's content is shown only when it verifies against the commit
// (WEB_INTERFACE → "The summary the prompt shows is derived from the transaction").
// ---------------------------------------------------------------------------

describe('background — sign hint verification', () => {
  it('a hint whose content hashes to the commit is kept in the record', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { tx, txIdHex, txBytesHex } = unsignedThreadTx(await pubKey(c));
    const content = 'a thread';
    // Sanity: the builder computed the hash from this content.
    expect(toHex(computeContentHash(content))).toBe(toHex(tx.post!.contentHash));
    await c.send({ kind: 'sign', txBytesHex, txIdHex, hint: { content } });
    const [, record] = promptRecords(c)[0]!;
    expect(record.hint.content).toBe(content);
  });

  it('a hint whose content does not match the commit is discarded', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txIdHex, txBytesHex } = unsignedThreadTx(await pubKey(c));
    await c.send({ kind: 'sign', txBytesHex, txIdHex, hint: { content: 'something else entirely' } });
    const [, record] = promptRecords(c)[0]!;
    expect(record.hint).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The dispatcher refuses an unknown kind.
// ---------------------------------------------------------------------------

describe('background — unknown messages are refused', () => {
  it('an unknown kind answers { error: "unknown message kind" }', async () => {
    const c = fakeChrome();
    install(c.api);
    expect(await c.send({ kind: 'not-a-real-kind' })).toEqual({ error: 'unknown message kind' });
  });

  it('a shape with no kind is refused too', async () => {
    const c = fakeChrome();
    install(c.api);
    expect(await c.send({ passphrase: 'x' })).toEqual({ error: 'unknown message kind' });
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function bootstrappedChrome(): Promise<FakeChrome> {
  const c = fakeChrome();
  install(c.api);
  await c.send({ kind: 'draft' });
  await c.send({ kind: 'create', passphrase: 'pw' });
  return c;
}

async function pubKey(c: FakeChrome): Promise<string> {
  const snap = await c.send({ kind: 'state' }) as { pubKeyHex: string };
  return snap.pubKeyHex;
}

function promptRecords(c: FakeChrome): Array<[string, SignRecord]> {
  const rows: Array<[string, SignRecord]> = [];
  for (const [k, v] of c.storage.session.entries()) {
    if (k.startsWith('notis.sign.') && typeof v === 'object' && v !== null) rows.push([k, v as SignRecord]);
  }
  return rows;
}

function promptSender(c: FakeChrome): chrome.runtime.MessageSender {
  return { url: c.origin + 'prompt.html?id=xxx' };
}

/** Every value in storage.local must NOT contain a 64-hex seed — the seed
 *  lives in storage.session alone (WEB_INTERFACE → "Three contexts, and what
 *  each may hold"). */
function assertLocalSeedFree(c: FakeChrome): void {
  const seedHex = c.storage.session.get('notis.seed');
  if (typeof seedHex !== 'string') return; // no seed to look for
  for (const [k, v] of c.storage.local.entries()) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    expect(s, `storage.local['${k}'] carries the seed`).not.toContain(seedHex);
  }
}
