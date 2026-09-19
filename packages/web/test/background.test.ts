// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeTx, computeTxId, computeContentHash } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { buildPost, buildLike, type BuildContext } from '../src/wallet/builders';
import { install } from '../src/extension/background';
import { fakeChrome, freshFixture, type FakeChrome } from './fake-chrome';
import type { SignRecord, Message } from '../src/extension/protocol';
import { KNOWN_KINDS } from '../src/extension/protocol';
import { toHex, hexToBytes } from '../src/identity/envelope';

// The background reloads state from storage on every call. Every `storage.local`
// write MUST be seed-free — the seed lives in `storage.session` alone
// (WEB_INTERFACE → "The contexts, and what each may hold"). A second
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
    install(c.api, { publicBase: '' });
    expect(await c.send({ kind: 'state' })).toBeNull();
  });

  it('draft + create seals the identity, unlocks it, and never writes the seed to storage.local', async () => {
    const c = fakeChrome();
    install(c.api, { publicBase: '' });
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
    install(c.api, { publicBase: '' });
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
    install(c.api, { publicBase: '' });
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

  // WEB_INTERFACE → The extension → "The prompt window" — 360 × 420, placed at
  // the top-right of the last-focused browser window (left + width - 360 - 16,
  // top + 80), focused; unplaced when the geometry is unknown.
  it('the prompt window opens at 360 × 420, focused, placed at the last-focused window\'s top-right', async () => {
    const c = await bootstrappedChrome();
    c.windows.setLastFocused({ left: 100, top: 50, width: 1200, height: 800 });
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    await c.send({ kind: 'sign', txBytesHex, txIdHex });
    expect(c.windows.created).toHaveLength(1);
    const props = c.windows.created[0]!;
    expect(props.width).toBe(360);
    expect(props.height).toBe(420);
    expect(props.focused).toBe(true);
    expect(props.type).toBe('popup');
    // left = 100 + 1200 - 360 - 16 = 924; top = 50 + 80 = 130
    expect(props.left).toBe(924);
    expect(props.top).toBe(130);
  });

  it('when the last-focused geometry is unknown the popup opens unplaced but at the same size', async () => {
    const c = await bootstrappedChrome();
    // A missing width — the placement drops.
    c.windows.setLastFocused({ left: 100, top: 50 });
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    await c.send({ kind: 'sign', txBytesHex, txIdHex });
    const props = c.windows.created[0]!;
    expect(props.width).toBe(360);
    expect(props.height).toBe(420);
    expect(props.focused).toBe(true);
    expect(props.left).toBeUndefined();
    expect(props.top).toBeUndefined();
  });

  it('when getLastFocused throws the popup opens unplaced', async () => {
    const c = await bootstrappedChrome();
    c.windows.setLastFocused(null); // the fake's arm for a thrown API call
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    await c.send({ kind: 'sign', txBytesHex, txIdHex });
    const props = c.windows.created[0]!;
    expect(props.width).toBe(360);
    expect(props.height).toBe(420);
    expect(props.left).toBeUndefined();
    expect(props.top).toBeUndefined();
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

  it('approve from an extension page that is not the prompt page is refused', async () => {
    const c = await bootstrappedChrome();
    await c.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
    const first = await c.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };
    // The App's page passes the outer guard; the narrower isFromPromptPage refuses.
    const answer = await c.send(
      { kind: 'approve', id: first.pending },
      { id: c.api.runtime.id, url: c.origin + 'index.html' },
    );
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
    install(first.api, { publicBase: '' });
    await first.send({ kind: 'draft' });
    await first.send({ kind: 'create', passphrase: 'pw' });
    await first.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(first));
    await first.send({ kind: 'sign', txBytesHex, txIdHex });
    expect(promptRecords(first).some(([, r]) => !r.result)).toBe(true);

    // A fresh instance over the same fixture — the worker restarted. install()
    // registers onStartup; the manual fire drives the sweep.
    const second = fakeChrome(fixture, first.origin);
    install(second.api, { publicBase: '' });
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
    install(first.api, { publicBase: '' });
    await first.send({ kind: 'draft' });
    await first.send({ kind: 'create', passphrase: 'pw' });
    await first.send({ kind: 'policy', karma: 'ask' });
    const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(first));
    const answer = await first.send({ kind: 'sign', txBytesHex, txIdHex }) as { pending: string };

    // The "worker restart" — a second instance is built on the same storage,
    // it has no globals from the first, and it answers `approve` for the
    // record the first wrote.
    const second = fakeChrome(fixture, first.origin);
    install(second.api, { publicBase: '' });
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
    install(c.api, { publicBase: '' });
    expect(await c.send({ kind: 'not-a-real-kind' })).toEqual({ error: 'unknown message kind' });
  });

  it('a shape with no kind is refused too', async () => {
    const c = fakeChrome();
    install(c.api, { publicBase: '' });
    expect(await c.send({ passphrase: 'x' })).toEqual({ error: 'unknown message kind' });
  });
});

// ---------------------------------------------------------------------------
// links / arrived / offered / takeOpen — WEB_INTERFACE → "Links into the
// extension". The bridge sends `arrived` and `offered`; the page sends
// `takeOpen`; the background writes `notis.open.<id>` under `storage.session`
// and lands the thread in the workspace.
// ---------------------------------------------------------------------------

const HEX = 'a'.repeat(64);
const PUBLIC = 'https://notis.fun/web/';

function bridgeChrome(publicBase = PUBLIC): FakeChrome {
  const c = fakeChrome();
  install(c.api, { publicBase });
  return c;
}

function bridgeSender(
  c: FakeChrome,
  tabId: number,
  opts: { active?: boolean; url?: string; id?: string; windowId?: number } = {},
): chrome.runtime.MessageSender {
  return {
    id: opts.id ?? c.api.runtime.id,
    tab: { id: tabId, active: opts.active ?? true, windowId: opts.windowId ?? 500 },
    url: opts.url ?? PUBLIC + 'p/' + HEX,
  };
}

function pageSender(c: FakeChrome, tabId = 200, windowId = 500): chrome.runtime.MessageSender {
  return { id: c.api.runtime.id, url: c.origin + 'index.html', tab: { id: tabId, windowId } };
}

/** After a refusal, no `notis.open.<id>` write and no tab call must have
 *  happened — the guard proves it did not run past the check. */
function assertNoLandingSideEffects(c: FakeChrome): void {
  const openKeys = Array.from(c.storage.session.keys()).filter((k) => k.startsWith('notis.open.'));
  expect(openKeys).toEqual([]);
  expect(c.tabs.updated).toEqual([]);
  expect(c.tabs.created).toEqual([]);
  expect(c.tabs.removed).toEqual([]);
}

describe('background — links preference', () => {
  it('links { opens: "site" } writes storage.local under notis.links', async () => {
    const c = bridgeChrome();
    expect(await c.send({ kind: 'links', opens: 'site' })).toBe('ok');
    expect(c.storage.local.get('notis.links')).toBe('site');
  });

  it('links { opens: "here" } writes "here"', async () => {
    const c = bridgeChrome();
    expect(await c.send({ kind: 'links', opens: 'here' })).toBe('ok');
    expect(c.storage.local.get('notis.links')).toBe('here');
  });

  it('links with a value outside the two answers { error } and does not write', async () => {
    const c = bridgeChrome();
    const answer = await c.send({ kind: 'links', opens: 'other' });
    expect(answer).toMatchObject({ error: expect.any(String) });
    expect(c.storage.local.has('notis.links')).toBe(false);
  });
});

describe('background — arrived refusals, one guard per condition', () => {
  it('empty publicBase refuses and does nothing', async () => {
    const c = bridgeChrome('');
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a foreign sender.id refuses and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42, { id: 'not-this-extension' }));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a sender without a tab refuses and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send(
      { kind: 'arrived', id: HEX },
      { id: c.api.runtime.id, url: PUBLIC + 'p/' + HEX },
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a URL outside publicBase refuses and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send(
      { kind: 'arrived', id: HEX },
      bridgeSender(c, 42, { url: 'https://elsewhere.example/p/' + HEX }),
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('the publicBase without "p/" refuses and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send(
      { kind: 'arrived', id: HEX },
      bridgeSender(c, 42, { url: PUBLIC + 'other/' + HEX }),
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('an id that is not 64 hex refuses and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    const answer = await c.send({ kind: 'arrived', id: 'not-hex' }, bridgeSender(c, 42));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('arrived under the "site" preference answers "ok" silently and does nothing', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'site' });
    const answer = await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(answer).toBe('ok');
    assertNoLandingSideEffects(c);
  });
});

describe('background — offered refusals, one guard per condition', () => {
  it('empty publicBase refuses and does nothing', async () => {
    const c = bridgeChrome('');
    const answer = await c.send({ kind: 'offered', id: HEX }, bridgeSender(c, 42));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a foreign sender.id refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send({ kind: 'offered', id: HEX }, bridgeSender(c, 42, { id: 'not-this-extension' }));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a sender without a tab refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send(
      { kind: 'offered', id: HEX },
      { id: c.api.runtime.id, url: PUBLIC + 'p/' + HEX },
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('a URL outside publicBase refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send(
      { kind: 'offered', id: HEX },
      bridgeSender(c, 42, { url: 'https://elsewhere.example/p/' + HEX }),
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('the publicBase without "p/" refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send(
      { kind: 'offered', id: HEX },
      bridgeSender(c, 42, { url: PUBLIC + 'other/' + HEX }),
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('an id that is not 64 hex refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send({ kind: 'offered', id: 'not-hex' }, bridgeSender(c, 42));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });

  it('offered from a tab that is not the window\'s active refuses and does nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send({ kind: 'offered', id: HEX }, bridgeSender(c, 42, { active: false }));
    expect(answer).toMatchObject({ error: expect.any(String) });
    assertNoLandingSideEffects(c);
  });
});

describe('background — openInWorkspace outcomes', () => {
  it('an upper-case id lands under its lower-cased key', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([]);
    const upper = 'A'.repeat(64);
    await c.send({ kind: 'arrived', id: upper }, bridgeSender(c, 42));
    expect(c.storage.session.has('notis.open.' + 'a'.repeat(64))).toBe(true);
    expect(c.storage.session.has('notis.open.' + upper)).toBe(false);
  });

  it('a live page tab + arrived writes a record and removes the arrived tab', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: false }]);
    await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(c.storage.session.get('notis.open.' + HEX)).toEqual({ raise: true });
    // The query is narrowed to the App's own pages — no unrelated tab is fetched.
    expect(c.tabs.queried).toEqual([{ url: c.origin + 'index.html*' }]);
    expect(c.tabs.removed).toEqual([42]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.created).toEqual([]);
  });

  it('a live page tab + offered writes a record and calls no tab function', async () => {
    const c = bridgeChrome();
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: false }]);
    await c.send({ kind: 'offered', id: HEX }, bridgeSender(c, 42));
    expect(c.storage.session.get('notis.open.' + HEX)).toEqual({ raise: true });
    expect(c.tabs.removed).toEqual([]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.created).toEqual([]);
  });

  it('only a discarded page tab is treated as no live page tab', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: true }]);
    await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(c.tabs.updated).toEqual([[42, { url: c.origin + 'index.html' }]]);
    expect(c.tabs.removed).toEqual([]);
    expect(c.tabs.created).toEqual([]);
  });

  it('no page tab + arrived updates the arriving tab to the page URL', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([]);
    await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(c.tabs.updated).toEqual([[42, { url: c.origin + 'index.html' }]]);
    expect(c.tabs.created).toEqual([]);
    expect(c.tabs.removed).toEqual([]);
  });

  it('no page tab + offered creates a page tab', async () => {
    const c = bridgeChrome();
    c.tabs.setQueryResult([]);
    await c.send({ kind: 'offered', id: HEX }, bridgeSender(c, 42));
    expect(c.tabs.created).toEqual([{ url: c.origin + 'index.html' }]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.removed).toEqual([]);
  });

  it('the arrived tab is never counted as a live page tab', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([{ id: 42, url: c.origin + 'index.html', discarded: false }]);
    await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42));
    expect(c.tabs.updated).toEqual([[42, { url: c.origin + 'index.html' }]]);
    expect(c.tabs.removed).toEqual([]);
    expect(c.tabs.created).toEqual([]);
  });

  it('two ids arriving are two records', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: false }]);
    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    await c.send({ kind: 'arrived', id: idA }, bridgeSender(c, 42));
    await c.send({ kind: 'arrived', id: idB }, bridgeSender(c, 43));
    expect(c.storage.session.get('notis.open.' + idA)).toEqual({ raise: true });
    expect(c.storage.session.get('notis.open.' + idB)).toEqual({ raise: true });
  });

  it('arrived from a background tab writes { raise: false }', async () => {
    const c = bridgeChrome();
    await c.send({ kind: 'links', opens: 'here' });
    c.tabs.setQueryResult([{ id: 99, url: c.origin + 'index.html', discarded: false }]);
    await c.send({ kind: 'arrived', id: HEX }, bridgeSender(c, 42, { active: false }));
    expect(c.storage.session.get('notis.open.' + HEX)).toEqual({ raise: false });
  });
});

describe('background — takeOpen', () => {
  it('takeOpen from a non-page sender is refused and the standing record survives', async () => {
    const c = bridgeChrome();
    c.storage.session.set('notis.open.' + HEX, { raise: true });
    // An extension-origin URL that is not the App page — the outer guard
    // passes, takeOpen's own URL prefix check against getURL('index.html')
    // refuses; the standing record survives untouched.
    const answer = await c.send(
      { kind: 'takeOpen' },
      { id: c.api.runtime.id, url: c.origin + 'prompt.html' },
    );
    expect(answer).toMatchObject({ error: expect.any(String) });
    expect(c.storage.session.get('notis.open.' + HEX)).toEqual({ raise: true });
  });

  it('takeOpen answers every id and leaves no notis.open. key behind', async () => {
    const c = bridgeChrome();
    c.storage.session.set('notis.open.' + 'a'.repeat(64), { raise: true });
    c.storage.session.set('notis.open.' + 'b'.repeat(64), { raise: false });
    const answer = await c.send({ kind: 'takeOpen' }, pageSender(c)) as { ids: string[] };
    expect(answer.ids.sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)].sort());
    const remaining = Array.from(c.storage.session.keys()).filter((k) => k.startsWith('notis.open.'));
    expect(remaining).toEqual([]);
  });

  it('the raise happens on the sender\'s tab and window when any record said so', async () => {
    const c = bridgeChrome();
    c.storage.session.set('notis.open.' + HEX, { raise: true });
    await c.send({ kind: 'takeOpen' }, pageSender(c, 200, 500));
    expect(c.tabs.updated).toEqual([[200, { active: true }]]);
    expect(c.windows.focused).toEqual([[500, { focused: true }]]);
  });

  it('the raise does not happen when no record said so', async () => {
    const c = bridgeChrome();
    c.storage.session.set('notis.open.' + HEX, { raise: false });
    await c.send({ kind: 'takeOpen' }, pageSender(c, 200, 500));
    expect(c.tabs.updated).toEqual([]);
    expect(c.windows.focused).toEqual([]);
  });

  it('takeOpen with nothing standing answers { ids: [] } and raises nothing', async () => {
    const c = bridgeChrome();
    const answer = await c.send({ kind: 'takeOpen' }, pageSender(c));
    expect(answer).toEqual({ ids: [] });
    expect(c.tabs.updated).toEqual([]);
    expect(c.windows.focused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The extension-page guard — WEB_INTERFACE → The extension → "The messages".
// Every kind but arrived and offered is taken from the extension's own pages
// alone, checked first; a bridge-shaped sender, an absent url, or a foreign
// id refuses each and leaves the storage byte-for-byte untouched.
// ---------------------------------------------------------------------------

const KINDS_GUARDED = Array.from(KNOWN_KINDS).filter((k) => k !== 'arrived' && k !== 'offered');

async function buildMessageTable(c: FakeChrome): Promise<Record<string, Message>> {
  const { txBytesHex, txIdHex } = unsignedThreadTx(await pubKey(c));
  const HEX32 = 'a'.repeat(32);
  return {
    state: { kind: 'state' },
    draft: { kind: 'draft' },
    discardDraft: { kind: 'discardDraft' },
    create: { kind: 'create', passphrase: 'pw' },
    inspectFile: { kind: 'inspectFile', text: '{}' },
    importFile: { kind: 'importFile', text: '{}', passphrase: 'pw' },
    exportFile: { kind: 'exportFile', password: 'pw' },
    unlock: { kind: 'unlock', passphrase: 'pw' },
    lock: { kind: 'lock' },
    forget: { kind: 'forget' },
    policy: { kind: 'policy', karma: 'ask' },
    links: { kind: 'links', opens: 'here' },
    takeOpen: { kind: 'takeOpen' },
    sign: { kind: 'sign', txBytesHex, txIdHex },
    ack: { kind: 'ack', id: HEX32 },
    approve: { kind: 'approve', id: HEX32 },
    decline: { kind: 'decline', id: HEX32 },
  };
}

function snapshotStorage(c: FakeChrome): { local: Array<[string, unknown]>; session: Array<[string, unknown]> } {
  return {
    local: Array.from(c.storage.local.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v ?? null))]),
    session: Array.from(c.storage.session.entries()).map(([k, v]) => [k, JSON.parse(JSON.stringify(v ?? null))]),
  };
}

describe('background — a non-bridge kind from an outside sender refuses with no trace', () => {
  it('the message table covers every KNOWN_KINDS entry but arrived and offered', async () => {
    const c = await bootstrappedChrome();
    const table = await buildMessageTable(c);
    const kinds = new Set(Object.keys(table));
    // A missing kind in the table trips this size assertion; a stray extra one trips it too.
    expect(kinds.size).toBe(KNOWN_KINDS.size - 2);
    for (const k of KINDS_GUARDED) expect(kinds.has(k)).toBe(true);
  });

  // WEB_INTERFACE → The extension → "The messages". The bridge sends only arrived
  // and offered; any other kind arriving under a bridge-shaped sender is refused.
  it.each(KINDS_GUARDED)('a bridge-shaped sender: %s refuses and touches nothing', async (kind) => {
    const c = await bootstrappedChrome();
    const table = await buildMessageTable(c);
    const before = snapshotStorage(c);
    const bridge: chrome.runtime.MessageSender = {
      id: c.api.runtime.id,
      tab: { id: 42, active: true, windowId: 500 } as chrome.tabs.Tab,
      url: 'https://notis.fun/web/p/' + HEX,
    };
    const answer = await c.send(table[kind]!, bridge);
    expect(answer).toMatchObject({ error: expect.any(String) });
    // sign under a silent unlocked identity would be signed without the guard —
    // the answer must carry no signature.
    if (kind === 'sign') expect('signature' in (answer as object)).toBe(false);
    expect(snapshotStorage(c)).toEqual(before);
    expect(c.windows.created).toEqual([]);
    expect(c.tabs.created).toEqual([]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.removed).toEqual([]);
  });

  it.each(KINDS_GUARDED)('a sender with no url: %s refuses and touches nothing', async (kind) => {
    const c = await bootstrappedChrome();
    const table = await buildMessageTable(c);
    const before = snapshotStorage(c);
    const noUrl: chrome.runtime.MessageSender = { id: c.api.runtime.id };
    const answer = await c.send(table[kind]!, noUrl);
    expect(answer).toMatchObject({ error: expect.any(String) });
    if (kind === 'sign') expect('signature' in (answer as object)).toBe(false);
    expect(snapshotStorage(c)).toEqual(before);
    expect(c.windows.created).toEqual([]);
    expect(c.tabs.created).toEqual([]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.removed).toEqual([]);
  });

  it.each(KINDS_GUARDED)('a foreign sender.id with an extension-page URL: %s refuses and touches nothing', async (kind) => {
    const c = await bootstrappedChrome();
    const table = await buildMessageTable(c);
    const before = snapshotStorage(c);
    const foreign: chrome.runtime.MessageSender = { id: 'not-this-extension', url: c.origin + 'index.html' };
    const answer = await c.send(table[kind]!, foreign);
    expect(answer).toMatchObject({ error: expect.any(String) });
    if (kind === 'sign') expect('signature' in (answer as object)).toBe(false);
    expect(snapshotStorage(c)).toEqual(before);
    expect(c.windows.created).toEqual([]);
    expect(c.tabs.created).toEqual([]);
    expect(c.tabs.updated).toEqual([]);
    expect(c.tabs.removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function bootstrappedChrome(): Promise<FakeChrome> {
  const c = fakeChrome();
  install(c.api, { publicBase: '' });
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
  return { id: c.api.runtime.id, url: c.origin + 'prompt.html?id=xxx' };
}

/** Every value in storage.local must NOT contain a 64-hex seed — the seed
 *  lives in storage.session alone (WEB_INTERFACE → "The contexts, and what
 *  each may hold"). */
function assertLocalSeedFree(c: FakeChrome): void {
  const seedHex = c.storage.session.get('notis.seed');
  if (typeof seedHex !== 'string') return; // no seed to look for
  for (const [k, v] of c.storage.local.entries()) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    expect(s, `storage.local['${k}'] carries the seed`).not.toContain(seedHex);
  }
}
