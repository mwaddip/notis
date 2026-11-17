// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { encodeTx, bytesToHex } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import { buildPost, buildSend, type RepBuildContext } from '../src/wallet/builders';
import { install } from '../src/extension/background';
import { fakeChrome, fakeLockManager, type FakeChrome } from './fake-chrome';
import type { SignRecord } from '../src/extension/protocol';

// The record holds the prompt tab's id where `windows` is absent, and the
// id of the tab that sent `sign` for reactivation on every ending
// (WEB_INTERFACE → The extension → "The contexts, and what each may hold").
type TabSignRecord = SignRecord & { tabId?: number; senderTabId?: number };

// WEB_INTERFACE → The extension → "The contexts, and what each may hold" —
// where the browser offers no `windows` API the prompt opens as a tab,
// the record holds the tab's id, the record's open-or-gone check reads
// `tabs.get`, a tab's close is a decline, and every ending removes the
// tab and makes the tab that sent `sign` active again where it is still
// open. WEB_INTERFACE → The extension → "A raise focuses a window only
// where the browser offers `windows`" — the action button's raise and
// the landing's each make the tab active alone.

const BOX = '11'.repeat(32);

function ctx(pubKeyHex: string): RepBuildContext {
  return {
    spendable: [{ boxId: BOX, value: 227n }],
    height: 6000,
    era: 1,
    author: pubKeyHex,
    effective: 227n,
  };
}

function unsignedThreadTx(pubKeyHex: string): { tx: UtxoTransaction; txIdHex: string; txBytesHex: string } {
  const built = buildPost(ctx(pubKeyHex), 'a thread');
  return { tx: built.tx, txIdHex: built.txId, txBytesHex: bytesToHex(encodeTx(built.tx)) };
}

function unsignedCreditSendTx(
  pubKeyHex: string,
  recipient: string = '44'.repeat(32),
  boxId: string = '55'.repeat(32),
): { tx: UtxoTransaction; txIdHex: string; txBytesHex: string } {
  const built = buildSend(
    { spendable: [{ boxId, value: 10_000_000_000n }], height: 6000, era: 1, author: pubKeyHex },
    recipient,
    1_000_000_000n,
  );
  return { tx: built.tx, txIdHex: built.txId, txBytesHex: bytesToHex(encodeTx(built.tx)) };
}

async function bootstrappedNoWindows(): Promise<FakeChrome> {
  const c = fakeChrome(undefined, undefined, { noWindows: true });
  install(c.api, { publicBase: '' }, { locks: fakeLockManager() });
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

function pageSender(c: FakeChrome, tabId: number, windowId?: number): chrome.runtime.MessageSender {
  const tab: chrome.runtime.MessageSender['tab'] = { id: tabId };
  if (windowId !== undefined) tab.windowId = windowId;
  return { id: c.api.runtime.id, url: c.origin + 'index.html', tab };
}

describe('background on the no-windows shape — the prompt as a tab', () => {
  it('install returns without throwing and state answers the loaded identity', async () => {
    const c = fakeChrome(undefined, undefined, { noWindows: true });
    expect(() => install(c.api, { publicBase: '' }, { locks: fakeLockManager() })).not.toThrow();
    await c.send({ kind: 'draft' });
    await c.send({ kind: 'create', passphrase: 'pw' });
    const snap = await c.send({ kind: 'state' }) as { locked: boolean };
    expect(snap.locked).toBe(false);
  });

  it('a credits sign opens one active tab at the prompt page and the record holds its id', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    const { txBytesHex, txIdHex } = unsignedCreditSendTx(pub);
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex, pubKeyHex: pub }) as { pending: string };
    expect(answer.pending).toMatch(/^[0-9a-f]{32}$/);
    expect(c.tabs.created).toHaveLength(1);
    const promptTab = c.tabs.created[0]!;
    expect(promptTab.url).toContain('prompt.html?id=' + answer.pending);
    expect(promptTab.active).toBe(true);
    expect(c.windows.created).toEqual([]);
    const [, record] = promptRecords(c)[0]! as [string, TabSignRecord];
    expect(typeof record.tabId).toBe('number');
    expect(record.windowId).toBeUndefined();
  });

  it('approve signs, removes the prompt tab, and activates the sending tab', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    const SENDER_TAB = 200;
    const { txBytesHex, txIdHex } = unsignedCreditSendTx(pub);
    const answer = await c.send(
      { kind: 'sign', txBytesHex, txIdHex, pubKeyHex: pub },
      pageSender(c, SENDER_TAB),
    ) as { pending: string };
    const [, record] = promptRecords(c)[0]! as [string, TabSignRecord];
    const promptTabId = record.tabId!;
    expect(typeof promptTabId).toBe('number');
    const ok = await c.send({ kind: 'approve', id: answer.pending }, promptSender(c));
    expect(ok).toBe('ok');
    const [, after] = promptRecords(c)[0]! as [string, TabSignRecord];
    expect(after.result).toMatchObject({ signature: expect.stringMatching(/^[0-9a-f]{128}$/) });
    expect(c.tabs.removed).toContain(promptTabId);
    expect(c.tabs.updated).toContainEqual([SENDER_TAB, { active: true }]);
    expect(c.windows.removed).toEqual([]);
  });

  it('decline writes { declined: true }, removes the prompt tab, and activates the sending tab', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    const SENDER_TAB = 201;
    const { txBytesHex, txIdHex } = unsignedCreditSendTx(pub);
    const answer = await c.send(
      { kind: 'sign', txBytesHex, txIdHex, pubKeyHex: pub },
      pageSender(c, SENDER_TAB),
    ) as { pending: string };
    const [, record] = promptRecords(c)[0]! as [string, TabSignRecord];
    const promptTabId = record.tabId!;
    await c.send({ kind: 'decline', id: answer.pending }, promptSender(c));
    const [, after] = promptRecords(c)[0]! as [string, TabSignRecord];
    expect(after.result).toEqual({ declined: true });
    expect(c.tabs.removed).toContain(promptTabId);
    expect(c.tabs.updated).toContainEqual([SENDER_TAB, { active: true }]);
  });

  it('the prompt tab\'s close writes { declined: true }', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    const { txBytesHex, txIdHex } = unsignedCreditSendTx(pub);
    const answer = await c.send({ kind: 'sign', txBytesHex, txIdHex, pubKeyHex: pub }) as { pending: string };
    expect(answer.pending).toMatch(/^[0-9a-f]{32}$/);
    const [, record] = promptRecords(c)[0]! as [string, TabSignRecord];
    const promptTabId = record.tabId!;
    c.fireTabRemoved(promptTabId);
    await new Promise((r) => setImmediate(r));
    const [, after] = promptRecords(c)[0]! as [string, TabSignRecord];
    expect(after.result).toEqual({ declined: true });
  });

  it('a record whose tab is gone is declined at the next sign and the next sign opens its own prompt tab', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    await c.send({ kind: 'policy', karma: 'ask' });
    const first = unsignedThreadTx(pub);
    const r1 = await c.send({ kind: 'sign', txBytesHex: first.txBytesHex, txIdHex: first.txIdHex, pubKeyHex: pub }) as { pending: string };
    const firstRec = promptRecords(c).find(([, r]) => r.id === r1.pending)! as [string, TabSignRecord];
    const firstTabId = firstRec[1].tabId!;
    expect(typeof firstTabId).toBe('number');
    c.tabs.closeSilently(firstTabId);
    const second = unsignedCreditSendTx(pub);
    const r2 = await c.send({ kind: 'sign', txBytesHex: second.txBytesHex, txIdHex: second.txIdHex, pubKeyHex: pub }) as { pending: string };
    const stale = promptRecords(c).find(([, r]) => r.id === r1.pending)!;
    expect(stale[1].result).toEqual({ declined: true });
    expect(r2.pending).toMatch(/^[0-9a-f]{32}$/);
    expect(c.tabs.created).toHaveLength(2);
  });

  it('a second sign while a prompt tab is open answers refused: busy', async () => {
    const c = await bootstrappedNoWindows();
    const pub = await pubKey(c);
    await c.send({ kind: 'policy', karma: 'ask' });
    const a = unsignedCreditSendTx(pub, '11'.repeat(32), '55'.repeat(32));
    const b = unsignedThreadTx(pub);
    const [ra, rb] = await Promise.all([
      c.send({ kind: 'sign', txBytesHex: a.txBytesHex, txIdHex: a.txIdHex, pubKeyHex: pub }),
      c.send({ kind: 'sign', txBytesHex: b.txBytesHex, txIdHex: b.txIdHex, pubKeyHex: pub }),
    ]);
    const pending = [ra, rb].filter((r) => r !== null && typeof r === 'object' && 'pending' in (r as object));
    const busy = [ra, rb].filter((r) => r !== null && typeof r === 'object' && 'refused' in (r as object) && (r as { refused?: string }).refused === 'busy');
    expect(pending).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(c.tabs.created).toHaveLength(1);
    expect(c.windows.created).toEqual([]);
  });

  it('the action button raises the page\'s tab with no window call', async () => {
    const c = await bootstrappedNoWindows();
    c.tabs.setQueryResult([{ id: 42, url: c.origin + 'index.html', discarded: false, windowId: 500 }]);
    c.fireActionClicked();
    await new Promise((r) => setImmediate(r));
    expect(c.tabs.updated).toContainEqual([42, { active: true }]);
    expect(c.windows.focused).toEqual([]);
  });

  it('the landing raises the page\'s tab with no window call', async () => {
    const c = await bootstrappedNoWindows();
    const HEX = 'a'.repeat(64);
    c.storage.session.set('notis.open.' + HEX, { raise: true });
    const PAGE_TAB = 300;
    await c.send(
      { kind: 'takeOpen' },
      pageSender(c, PAGE_TAB, 500),
    );
    expect(c.tabs.updated).toContainEqual([PAGE_TAB, { active: true }]);
    expect(c.windows.focused).toEqual([]);
  });
});
