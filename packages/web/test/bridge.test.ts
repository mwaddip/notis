// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { bridge, type BridgeEnv } from '../src/extension/bridge';
import { fakeChrome } from './fake-chrome';

// The bridge — WEB_INTERFACE → The extension → "A takeover needs a tab
// created for the link" and → "The website's control offers the thread to the
// extension". The tests drive `bridge()` over fakes: the `chrome` fake, a
// fresh EventTarget as the document, and shaped-in-place `location`,
// `history`, `navigator` and `performance`. Every guard test asserts what a
// deleted guard would let through — the offer arms assert `defaultPrevented`
// is false where an event exists, and the all-holding arm is each's control.

const HEX = 'a'.repeat(64);
const HEX_UPPER = 'A'.repeat(64);
const HEX_63 = 'a'.repeat(63);
const HEX_B = 'b'.repeat(64);

const PUBLIC = 'https://notis.fun/web/';
const BASE_PATH = '/web/';
const PATH_THREAD = BASE_PATH + 'p/' + HEX;
const PATH_THREAD_UPPER = BASE_PATH + 'p/' + HEX_UPPER;
const PATH_ROOT = BASE_PATH;

class FakeDoc extends EventTarget {
  prerendering: boolean | undefined;
  constructor(prerendering?: boolean) {
    super();
    this.prerendering = prerendering;
  }
}

interface Opts {
  chrome?: 'default' | 'dead' | 'incognito';
  pathname?: string;
  historyLength?: number;
  prerendering?: boolean;
  navType?: 'navigate' | 'reload' | 'back_forward';
  hasNavEntry?: boolean;
  userActivationIsActive?: boolean;
  pref?: 'here' | 'site';
  publicBase?: string;
}

interface Built {
  env: BridgeEnv;
  doc: FakeDoc;
  messages: unknown[];
  localGets: () => number;
}

function build(o: Opts = {}): Built {
  const c = fakeChrome();
  // `chrome.extension.inIncognitoContext` is a real-window fact — the fake
  // defaults it to false; the tests override where they need it.
  (c.api.extension as unknown as { inIncognitoContext: boolean }).inIncognitoContext = o.chrome === 'incognito';
  if (o.chrome === 'dead') {
    (c.api.runtime as unknown as { id: string | undefined }).id = undefined;
  }
  const messages: unknown[] = [];
  c.api.runtime.sendMessage = (async (m: unknown) => {
    messages.push(m);
    return 'ok';
  }) as typeof chrome.runtime.sendMessage;
  let localGets = 0;
  const origGet = c.api.storage.local.get.bind(c.api.storage.local);
  c.api.storage.local.get = (async (
    keys?: string | string[] | Record<string, unknown> | null,
  ) => {
    localGets += 1;
    return origGet(keys);
  }) as typeof chrome.storage.local.get;
  if (o.pref !== undefined) c.storage.local.set('notis.links', o.pref);

  const doc = new FakeDoc(o.prerendering);
  const hasEntry = o.hasNavEntry !== false;
  const navEntry = hasEntry ? { type: o.navType ?? 'navigate' } : undefined;

  const env: BridgeEnv = {
    chrome: c.api,
    location: { pathname: o.pathname ?? PATH_THREAD },
    history: { length: o.historyLength ?? 1 },
    document: doc,
    navigator: {
      userActivation: o.userActivationIsActive !== undefined ? { isActive: o.userActivationIsActive } : undefined,
    },
    performance: {
      getEntriesByType: (type: string) => (type === 'navigation' && navEntry ? [navEntry] : []),
    },
    publicBase: o.publicBase ?? PUBLIC,
  };

  return { env, doc, messages, localGets: () => localGets };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Dispatch a synchronous `notis:open` on `doc` and return the event so the
 *  caller can read `defaultPrevented` on it. */
function dispatchOpen(
  doc: FakeDoc,
  detail: unknown,
  opts: { cancelable?: boolean; plain?: boolean } = {},
): Event {
  const cancelable = opts.cancelable ?? true;
  const ev = opts.plain
    ? new Event('notis:open', { cancelable })
    : new CustomEvent('notis:open', { detail, cancelable });
  doc.dispatchEvent(ev);
  return ev;
}

// ---------------------------------------------------------------------------
// Arrival — every predicate failing alone must send nothing.
// ---------------------------------------------------------------------------

describe('bridge — on arrival', () => {
  it('a path outside the base sends nothing, reads no storage, and registers no listener', async () => {
    const b = build({ pathname: '/other/page', pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
    // A later notis:open reaches no listener — the event stands.
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    expect(b.messages).toEqual([]);
  });

  it('a path that is not p/<64hex> sends nothing and registers no listener', async () => {
    const b = build({ pathname: BASE_PATH + 'p/foo', pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    expect(b.messages).toEqual([]);
  });

  it('history.length 2 sends no arrived and reads no storage', async () => {
    const b = build({ historyLength: 2, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
  });

  it('navigation type "reload" sends no arrived', async () => {
    const b = build({ navType: 'reload', pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
  });

  it('navigation type "back_forward" sends no arrived', async () => {
    const b = build({ navType: 'back_forward', pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
  });

  it('no navigation entry sends no arrived', async () => {
    const b = build({ hasNavEntry: false, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
  });

  it('document.prerendering === true sends no arrived', async () => {
    const b = build({ prerendering: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    expect(b.localGets()).toBe(0);
  });

  it('preference "site": exactly one storage.local read and no sendMessage at all', async () => {
    const b = build({ pref: 'site' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.localGets()).toBe(1);
    expect(b.messages).toEqual([]);
  });

  it('document.prerendering undefined with everything else holding: arrived leaves', async () => {
    const b = build({ prerendering: undefined, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([{ kind: 'arrived', id: HEX }]);
  });

  it('all holding: exactly one arrived, id lower-cased from an upper-case path', async () => {
    const b = build({ pathname: PATH_THREAD_UPPER, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([{ kind: 'arrived', id: HEX }]);
    expect(b.localGets()).toBe(1);
  });

  it('a private window: no arrived, and a later notis:open is neither cancelled nor sent', async () => {
    const b = build({ chrome: 'incognito', pref: 'here', userActivationIsActive: true });
    bridge(b.env);
    await flush();
    await flush();
    expect(b.messages).toEqual([]);
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    expect(b.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The offer — a control arm, then the guards, each alone.
// ---------------------------------------------------------------------------

describe('bridge — on the offer', () => {
  it('under activation: defaultPrevented is true when dispatchEvent returns; one offered with the detail lower-cased', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    // Wait for arrival to complete before dispatching the offer.
    await flush();
    await flush();
    const before = b.messages.length; // arrival landed once above
    const ev = new CustomEvent('notis:open', { detail: HEX_UPPER, cancelable: true });
    const notPrevented = b.doc.dispatchEvent(ev);
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(b.messages.slice(before)).toEqual([{ kind: 'offered', id: HEX }]);
  });

  it('no activation: not cancelled, no message', async () => {
    const b = build({ userActivationIsActive: false, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('a non-string detail: not cancelled, no message', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, 42);
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('a 63-hex detail: not cancelled, no message', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX_63);
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('a non-cancelable event: not cancelled, no message', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX, { cancelable: false });
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('a plain Event named notis:open: not cancelled, no message', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, undefined, { plain: true });
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('a dead context (chrome.runtime.id undefined): not cancelled, no message', async () => {
    const b = build({ chrome: 'dead', userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages.slice(before)).toEqual([]);
  });

  it('the id is the event detail, not the path: an offer with a detail id different from the path id is sent as the detail\'s id', async () => {
    const b = build({ userActivationIsActive: true, pref: 'here', pathname: PATH_THREAD });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX_B);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(b.messages.slice(before)).toEqual([{ kind: 'offered', id: HEX_B }]);
  });

  it('the preference does not gate the offer: under "site" the offer is taken', async () => {
    const b = build({ userActivationIsActive: true, pref: 'site' });
    bridge(b.env);
    await flush();
    await flush();
    const before = b.messages.length;
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(b.messages.slice(before)).toEqual([{ kind: 'offered', id: HEX }]);
  });

  it('on a page that is not a thread page, notis:open is neither cancelled nor sent', async () => {
    const b = build({ pathname: PATH_ROOT, userActivationIsActive: true, pref: 'here' });
    bridge(b.env);
    await flush();
    await flush();
    const ev = dispatchOpen(b.doc, HEX);
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(b.messages).toEqual([]);
  });
});
