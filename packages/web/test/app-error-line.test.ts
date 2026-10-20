// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { NodeClient } from '../src/api/client';
import { PendingLedger } from '../src/wallet/ledger';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import { jsonResponse } from './honest-page';
import { prefs, setNode } from '../src/prefs';

// HOUSE_STYLE → Voice: "Say what happens, not what went wrong." The feed's
// error line draws `feed.error`, which the App writes from the client's
// error — so the client's error carries no bytes a node chose, nothing a
// person sees except what happened and the status.

const ME = 'aa'.repeat(32);

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

function hostileBody(): string {
  // An ESC, a CR and a few kilobytes of text — the bytes a node might answer
  // beside a non-2xx status.
  return '\u001b\r' + 'x'.repeat(4096);
}

function stubFetchFeed500(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), 'http://node.test');
    const p = u.pathname;
    if (p === '/posts') return new Response(hostileBody(), { status: 500 });
    if (p === '/status') return jsonResponse({
      networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 0,
      pendingPosts: 0, totalKarma: '0', liquidKarma: '0', totalCredits: '0',
      inviteProbationBlocks: 0, vouchCooldownBlocks: 60,
      inviteBondMin: '100', inviteBondMax: '1000',
      membership: { memberCount: 2, memberBar: 1, memberLikesBar: 2 },
    });
    if (p === '/blocks/current') return jsonResponse({ height: 100, hash: null });
    if (p.startsWith('/karma/')) return jsonResponse({
      userId: ME, total: '0', effective: '0', boxes: [], boxCount: 0, next: null,
      lastActivityBlock: 0, lastDecayBlock: 0, lifetimeLikesReceived: '0',
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: '0',
      invitesUsed: 0, member: false, invitesAvailable: 0, height: 100,
    });
    if (p === '/vouches') {
      const body = u.searchParams.has('cooldowns')
        ? { cooldowns: [], count: 0, next: null }
        : { vouches: [], count: 0, next: null };
      return jsonResponse(body);
    }
    if (p.startsWith('/invites/')) return jsonResponse({ bonds: [], bondCount: 0, next: null });
    return jsonResponse({}, 404);
  }));
}

interface Drive {
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

describe("the error line carries what happened, not what the node sent", () => {
  it("a feed read answered 500 with ESC, CR and kilobytes of text — the feed's error line reads the client's own words and the status", async () => {
    stubFetchFeed500();
    const { drive, feed } = mount();
    await drive.loadFeed();
    await flush();
    const err = feed.querySelector<HTMLElement>('.error');
    expect(err).not.toBeNull();
    const text = err!.textContent ?? '';
    expect(text).toBe("can't reach the node right now — node answered 500");
  });
});
