// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { NodeClient } from '../src/api/client';
import { PendingLedger } from '../src/wallet/ledger';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import { jsonResponse } from './honest-page';
import { prefs, setNode } from '../src/prefs';

// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from
// its own fields" — a field a reader refuses leaves the client's catch
// returning early and the state unwritten, so the renders that follow a read
// draw whatever they would have drawn without the read.

const ME = 'aa'.repeat(32);
const B1 = '71'.repeat(32);

function identity(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: ME, locked: false }),
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };
}

function honestStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 0,
    pendingPosts: 0, totalKarma: '0', liquidKarma: '0', totalCredits: '0',
    inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
    inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
    ...over,
  };
}

function honestKarma(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: ME, total: '5', effective: '5',
    boxes: [{ boxId: B1, value: '5' }], boxCount: 1, next: null,
    lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
    memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0',
    invitesUsed: 0, member: false, invitesAvailable: 0, height: 100,
    ...over,
  };
}

function stubFetch(karma: unknown, status: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), 'http://node.test');
    const p = u.pathname;
    let body: unknown = {};
    let st = 200;
    if (p.startsWith('/karma/')) body = karma;
    else if (p === '/status') body = status;
    else if (p === '/blocks/current') body = { height: 100, hash: null };
    else if (p === '/posts') body = { posts: [], next: null, pending: [], pendingCount: 0 };
    else if (p === '/vouches') {
      body = u.searchParams.has('cooldowns')
        ? { cooldowns: [], count: 0, next: null }
        : { vouches: [], count: 0, next: null };
    } else if (p.startsWith('/invites/')) body = { bonds: [], bondCount: 0, next: null };
    else st = 404;
    return jsonResponse(body, st);
  }));
}

interface Drive {
  loadMembershipState(): Promise<void>;
  loadFeed(): Promise<void>;
}

function mount(): { app: App; drive: Drive; appbar: HTMLElement; feed: HTMLElement; panes: HTMLElement } {
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  const app = new App(
    new NodeClient(() => ''),
    {} as unknown as WriteClient,
    identity(),
    new PendingLedger(ME),
    undefined, undefined, null, null,
  );
  app.mount(appbar, feed, panes);
  return { app, drive: app as unknown as Drive, appbar, feed, panes };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a reader refusing one field leaves the renders that follow a read drawing", () => {
  it("a /karma whose `effective` is not a decimal lets the settings window draw", async () => {
    stubFetch(honestKarma({ effective: 'not-a-number' }), honestStatus());
    const { drive, appbar, panes } = mount();
    try { await drive.loadMembershipState(); } catch { /* the read's catch keeps the renders */ }
    try { await drive.loadFeed(); } catch { /* feed's own catch keeps the render */ }
    await flush();
    const control = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]');
    expect(control).not.toBeNull();
    try { control!.click(); } catch { /* opening a window never throws when state holds no malformed value */ }
    await flush();
    expect(panes.querySelector('.bar')).not.toBeNull();
  });

  it("a /status whose `inviteBondMin` is not a decimal lets the settings window draw", async () => {
    stubFetch(honestKarma(), honestStatus({ inviteBondMin: 'x' }));
    const { drive, appbar, panes } = mount();
    try { await drive.loadMembershipState(); } catch { /* the read's catch keeps the renders */ }
    try { await drive.loadFeed(); } catch { /* feed's own catch keeps the render */ }
    await flush();
    const control = appbar.querySelector<HTMLElement>('button[aria-label="open settings"]');
    expect(control).not.toBeNull();
    try { control!.click(); } catch { /* opening a window never throws when state holds no malformed value */ }
    await flush();
    expect(panes.querySelector('.bar')).not.toBeNull();
  });
});
