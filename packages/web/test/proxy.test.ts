// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { bootstrapProxy, ExtensionProxy } from '../src/extension/proxy';
import { fakeChrome } from './fake-chrome';
import type { SignRecord, SignAnswer } from '../src/extension/protocol';

// The page-side identity, WEB_INTERFACE → The extension. current() is
// synchronous from a snapshot; sign waits out `pending` on
// storage.session.onChanged and never surfaces it to the wallet.

const PUB = 'aa'.repeat(32);
const KEY = '11'.repeat(32);

/** A fake background that answers a preset queue of message answers. */
function wireBackground(c: ReturnType<typeof fakeChrome>, answers: Record<string, unknown>): void {
  c.api.runtime.sendMessage = (async (message: unknown) => {
    const kind = (message as { kind?: string })?.kind ?? '';
    if (kind in answers) return answers[kind];
    return { error: 'unknown message kind' };
  }) as typeof chrome.runtime.sendMessage;
}

// ---------------------------------------------------------------------------
// bootstrapProxy — the snapshot is fetched once, and current() reads it back.
// ---------------------------------------------------------------------------

describe('bootstrapProxy — the snapshot from the background', () => {
  it('current() reads the pubKeyHex and lock state from the fetched snapshot', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'silent' } });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.current()).toEqual({ pubKeyHex: PUB, locked: false });
    expect(proxy.backedUp()).toBe(true);
    expect(proxy.policy?.()).toBe('silent');
  });

  it('current() is null when the background answers null', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.current()).toBeNull();
    expect(proxy.backedUp()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sign — signature, locked, refused pass through; pending waits on the record.
// ---------------------------------------------------------------------------

describe('proxy.sign — the SignResult vocabulary', () => {
  it('a signature answer becomes { signature }', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null, sign: { signature: 'ab'.repeat(64) } as SignAnswer });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const r = await proxy.sign(new Uint8Array([1, 2, 3]), 'cd'.repeat(32));
    expect(r).toEqual({ signature: 'ab'.repeat(64) });
  });

  it('a locked answer becomes { locked: true }', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null, sign: { locked: true } as SignAnswer });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const r = await proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    expect(r).toEqual({ locked: true });
  });

  it('a refused answer becomes { refused: <kind> }', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null, sign: { refused: 'busy' } as SignAnswer });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const r = await proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    expect(r).toEqual({ refused: 'busy' });
  });

  it('a pending answer waits on storage.session.onChanged, then translates the record\'s result', async () => {
    const c = fakeChrome();
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'ask' },
      sign: { pending: 'abcd1234abcd1234abcd1234abcd1234' } as SignAnswer,
      ack: 'ok',
    });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    // Start the sign; it awaits a pending resolution.
    const signPromise = proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    // The background then writes the record's result to session storage.
    const key = 'notis.sign.abcd1234abcd1234abcd1234abcd1234';
    const record: SignRecord = {
      id: 'abcd1234abcd1234abcd1234abcd1234',
      txIdHex: 'cd'.repeat(32),
      txBytesHex: '',
      summary: { kind: 'thread', spendRep: '5' },
      hint: {},
      createdAt: 0,
      pubKeyHex: PUB,
      result: { signature: 'ff'.repeat(64) },
    };
    c.storage.session.set(key, record);
    c.storage.fireChange('session', key, undefined, record);
    const r = await signPromise;
    expect(r).toEqual({ signature: 'ff'.repeat(64) });
  });

  it('a pending answer that resolves to declined becomes { declined: true }', async () => {
    const c = fakeChrome();
    wireBackground(c, {
      state: { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'ask' },
      sign: { pending: 'aabb' + '00'.repeat(14) } as SignAnswer,
      ack: 'ok',
    });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const p = proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    const key = 'notis.sign.aabb' + '00'.repeat(14);
    const record: SignRecord = {
      id: 'aabb' + '00'.repeat(14),
      txIdHex: 'cd'.repeat(32),
      txBytesHex: '',
      summary: { kind: 'like', targetHex: KEY, spendRep: '1' },
      hint: {},
      createdAt: 0,
      pubKeyHex: PUB,
      result: { declined: true },
    };
    c.storage.session.set(key, record);
    c.storage.fireChange('session', key, undefined, record);
    expect(await p).toEqual({ declined: true });
  });

  it('pending never surfaces from sign — the wallet only sees the four SignResult arms', async () => {
    // Even for a huge scenario, the answer set never includes `pending`.
    const c = fakeChrome();
    wireBackground(c, { state: null, sign: { pending: 'x' + '0'.repeat(31) } as SignAnswer });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    // Pre-populate a record with a result so the wait resolves at once.
    const key = 'notis.sign.x' + '0'.repeat(31);
    const record: SignRecord = {
      id: 'x' + '0'.repeat(31),
      txIdHex: 'cd'.repeat(32),
      txBytesHex: '',
      summary: { kind: 'thread', spendRep: '5' },
      hint: {},
      createdAt: 0,
      pubKeyHex: PUB,
      result: { signature: 'aa'.repeat(64) },
    };
    c.storage.session.set(key, record);
    const r = await proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    expect('pending' in (r as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// storage.onChanged → onChange fires only on identity delta.
// ---------------------------------------------------------------------------

describe('proxy.onChange — identity delta only', () => {
  it('onChange fires when the envelope arrives — no identity → identity', async () => {
    const c = fakeChrome();
    let state: unknown = null;
    c.api.runtime.sendMessage = (async (m: unknown) => {
      if ((m as { kind?: string }).kind === 'state') return state;
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const events: Array<{ pubKeyHex: string } | null> = [];
    proxy.onChange((id) => events.push(id));
    // The background flips state to a fresh key and fires onChanged.
    state = { pubKeyHex: PUB, locked: false, backedUp: false, policy: 'silent' };
    c.storage.fireChange('local', 'notis.identity', undefined, 'envelope');
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([{ pubKeyHex: PUB }]);
  });

  it('onChange fires on forget — identity → null', async () => {
    const c = fakeChrome();
    let state: unknown = { pubKeyHex: PUB, locked: false, backedUp: false, policy: 'silent' };
    c.api.runtime.sendMessage = (async (m: unknown) => {
      if ((m as { kind?: string }).kind === 'state') return state;
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const events: Array<{ pubKeyHex: string } | null> = [];
    proxy.onChange((id) => events.push(id));
    state = null;
    c.storage.fireChange('local', 'notis.identity', 'envelope', undefined);
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([null]);
  });

  it('onChange does NOT fire on a lock flip — same pubKeyHex; the App reads locked via current()', async () => {
    const c = fakeChrome();
    let locked = false;
    c.api.runtime.sendMessage = (async (m: unknown) => {
      if ((m as { kind?: string }).kind === 'state') {
        return { pubKeyHex: PUB, locked, backedUp: false, policy: 'silent' };
      }
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const events: Array<{ pubKeyHex: string } | null> = [];
    proxy.onChange((id) => events.push(id));
    expect(proxy.current()).toEqual({ pubKeyHex: PUB, locked: false });

    // The background locks: seed leaves storage.session, but the identity
    // pubKeyHex is the same, so onChange does not fire.
    locked = true;
    c.storage.fireChange('session', 'notis.seed', 'seedhex', undefined);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
    // current() reads the fresh lock state, though — the snapshot updated.
    expect(proxy.current()).toEqual({ pubKeyHex: PUB, locked: true });
  });
});

// ---------------------------------------------------------------------------
// ack — the page acknowledges the record so the background removes it.
// ---------------------------------------------------------------------------

describe('proxy — ack the record after reading a result', () => {
  it('after a pending resolution, an ack message is sent with the record\'s id', async () => {
    const c = fakeChrome();
    const sent: Array<{ kind: string; id?: string }> = [];
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const msg = m as { kind: string; id?: string };
      sent.push(msg);
      if (msg.kind === 'state') return null;
      if (msg.kind === 'sign') return { pending: 'de' + '00'.repeat(15) } as SignAnswer;
      return 'ok';
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    const p = proxy.sign(new Uint8Array(), 'cd'.repeat(32));
    const key = 'notis.sign.de' + '00'.repeat(15);
    const record: SignRecord = {
      id: 'de' + '00'.repeat(15),
      txIdHex: 'cd'.repeat(32),
      txBytesHex: '',
      summary: { kind: 'like', targetHex: KEY, spendRep: '1' },
      hint: {},
      createdAt: 0,
      pubKeyHex: PUB,
      result: { signature: '11'.repeat(64) },
    };
    c.storage.session.set(key, record);
    c.storage.fireChange('session', key, undefined, record);
    await p;
    await new Promise((r) => setImmediate(r));
    expect(sent.some((m) => m.kind === 'ack' && m.id === 'de' + '00'.repeat(15))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The proxy implements AppIdentity — passthrough operations reach the wire.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Snapshot refresh — every mutating call refreshes before it resolves, so the
// App reading current().locked (or policy(), backedUp()) after `await` sees
// the fresh state, not the pre-mutation snapshot.
// ---------------------------------------------------------------------------

describe('proxy — mutating calls refresh the snapshot before resolving', () => {
  it('await unlock() then current().locked is false — no round-trip through onChanged', async () => {
    const c = fakeChrome();
    let locked = true;
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const kind = (m as { kind: string }).kind;
      if (kind === 'state') return { pubKeyHex: PUB, locked, backedUp: true, policy: 'silent' };
      if (kind === 'unlock') { locked = false; return 'ok'; }
      if (kind === 'lock') { locked = true; return 'ok'; }
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.current()?.locked).toBe(true);
    await proxy.unlock('pw');
    expect(proxy.current()?.locked).toBe(false);
    await proxy.lock();
    expect(proxy.current()?.locked).toBe(true);
  });

  it('await forget() then current() is null immediately', async () => {
    const c = fakeChrome();
    let cur: unknown = { pubKeyHex: PUB, locked: false, backedUp: true, policy: 'silent' };
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const kind = (m as { kind: string }).kind;
      if (kind === 'state') return cur;
      if (kind === 'forget') { cur = null; return 'ok'; }
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.current()).not.toBeNull();
    await proxy.forget();
    expect(proxy.current()).toBeNull();
  });

  it('await setPolicy() then policy() answers the new value', async () => {
    const c = fakeChrome();
    let policy: 'silent' | 'ask' = 'silent';
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const kind = (m as { kind: string; karma?: 'silent' | 'ask' }).kind;
      if (kind === 'state') return { pubKeyHex: PUB, locked: false, backedUp: true, policy };
      if (kind === 'policy') { policy = (m as { karma: 'silent' | 'ask' }).karma; return 'ok'; }
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.policy?.()).toBe('silent');
    await proxy.setPolicy!('ask');
    expect(proxy.policy?.()).toBe('ask');
  });

  it('await exportFile() then backedUp() answers true', async () => {
    const c = fakeChrome();
    let backed = false;
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const kind = (m as { kind: string }).kind;
      if (kind === 'state') return { pubKeyHex: PUB, locked: false, backedUp: backed, policy: 'silent' };
      if (kind === 'exportFile') { backed = true; return { text: '{}' }; }
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.backedUp()).toBe(false);
    await proxy.exportFile('pw');
    expect(proxy.backedUp()).toBe(true);
  });
});

describe('proxy — the pass-through operations reach the background', () => {
  it('draft, create, unlock, exportFile pass through as messages', async () => {
    const c = fakeChrome();
    const sent: Array<{ kind: string }> = [];
    c.api.runtime.sendMessage = (async (m: unknown) => {
      const msg = m as { kind: string };
      sent.push(msg);
      if (msg.kind === 'state') return null;
      if (msg.kind === 'draft') return { pubKeyHex: KEY };
      if (msg.kind === 'create') return { pubKeyHex: KEY };
      if (msg.kind === 'unlock') return 'ok';
      if (msg.kind === 'exportFile') return { text: '{"envelope":true}' };
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = new ExtensionProxy(c.api, null);
    expect(await proxy.draft()).toEqual({ pubKeyHex: KEY });
    expect(await proxy.create('pw')).toEqual({ pubKeyHex: KEY });
    await proxy.unlock('pw');
    expect(await proxy.exportFile('file-pw')).toBe('{"envelope":true}');
    // Every mutating call now refreshes the snapshot from `state` before it
    // resolves — the App's post-mutation read sees the fresh value.
    expect(sent.map((m) => m.kind)).toEqual(['draft', 'create', 'state', 'unlock', 'state', 'exportFile', 'state']);
  });

  it('an { error } answer is thrown as a rejection', async () => {
    const c = fakeChrome();
    c.api.runtime.sendMessage = (async () => ({ error: 'no drafted key to create.' })) as typeof chrome.runtime.sendMessage;
    const proxy = new ExtensionProxy(c.api, null);
    await expect(proxy.create('pw')).rejects.toThrow(/no drafted key/);
  });
});

// ---------------------------------------------------------------------------
// The links preference — WEB_INTERFACE → The extension → "Links into the extension".
// Read from storage.local at bootstrap and on every local change carrying notis.links;
// set through the `links` message; carried on the proxy only when the build's
// publicBase is not empty.
// ---------------------------------------------------------------------------

const PUBLIC = 'https://notis.fun/web/';

describe('proxy.links — the preference read from storage.local', () => {
  it('bootstrap with nothing stored answers here (the default)', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('here');
  });

  it('bootstrap with "site" stored answers site', async () => {
    const c = fakeChrome();
    c.storage.local.set('notis.links', 'site');
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('site');
  });

  it('bootstrap with a junk value stored answers here (the default)', async () => {
    const c = fakeChrome();
    c.storage.local.set('notis.links', 'nonsense');
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('here');
  });

  it('with no identity and a non-empty publicBase, links() still answers the stored value', async () => {
    const c = fakeChrome();
    c.storage.local.set('notis.links', 'site');
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.current()).toBeNull();
    expect(proxy.links?.()).toBe('site');
  });

  it('with an empty publicBase both members are undefined — the settings row keys on their presence', async () => {
    const c = fakeChrome();
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: '' });
    expect(proxy.links).toBeUndefined();
    expect(proxy.setLinks).toBeUndefined();
  });
});

describe('proxy.setLinks — sends the links message, then holds the new value', () => {
  it('setLinks("site") sends { kind: "links", opens: "site" } and moves links() to site', async () => {
    const c = fakeChrome();
    const sent: unknown[] = [];
    c.api.runtime.sendMessage = (async (m: unknown) => {
      sent.push(m);
      if ((m as { kind: string }).kind === 'state') return null;
      if ((m as { kind: string }).kind === 'links') return 'ok';
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('here');
    await proxy.setLinks!('site');
    // Exactly the one links message the setter emitted — the state fetch is a
    // bootstrap read, filtered out here.
    const linksMsgs = sent.filter((m) => (m as { kind?: string }).kind === 'links');
    expect(linksMsgs).toEqual([{ kind: 'links', opens: 'site' }]);
    expect(proxy.links?.()).toBe('site');
  });

  it('a refused setLinks rejects and leaves links() as it was', async () => {
    const c = fakeChrome();
    c.api.runtime.sendMessage = (async (m: unknown) => {
      if ((m as { kind: string }).kind === 'state') return null;
      if ((m as { kind: string }).kind === 'links') return { error: 'nope' };
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('here');
    await expect(proxy.setLinks!('site')).rejects.toThrow(/nope/);
    expect(proxy.links?.()).toBe('here');
  });
});

describe('proxy — a storage.onChanged on local carrying notis.links moves the value silently', () => {
  it('the held value flips from the change\'s newValue, with NO message sent', async () => {
    const c = fakeChrome();
    const sent: unknown[] = [];
    c.api.runtime.sendMessage = (async (m: unknown) => {
      sent.push(m);
      if ((m as { kind: string }).kind === 'state') return null;
      return { error: 'unexpected' };
    }) as typeof chrome.runtime.sendMessage;
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('here');
    sent.length = 0; // clear the bootstrap `state` read
    c.storage.fireChange('local', 'notis.links', undefined, 'site');
    await new Promise((r) => setImmediate(r));
    expect(proxy.links?.()).toBe('site');
    // No refresh — the preference lives in storage, not in the state answer.
    expect(sent).toEqual([]);
  });

  it('a junk newValue collapses to the default (here)', async () => {
    const c = fakeChrome();
    c.storage.local.set('notis.links', 'site');
    wireBackground(c, { state: null });
    const proxy = await bootstrapProxy(c.api, { publicBase: PUBLIC });
    expect(proxy.links?.()).toBe('site');
    c.storage.fireChange('local', 'notis.links', 'site', 'garbage');
    await new Promise((r) => setImmediate(r));
    expect(proxy.links?.()).toBe('here');
  });
});
