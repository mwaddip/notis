// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type {
  FeedResult, BlockCurrent, KarmaResult, StatusResult,
} from '../src/api/dto';
import { prefs, setTheme } from '../src/prefs';
import { karmaResult } from './karma-fixture';
import type { AppIdentity } from '../src/model/state';
import { debugRow, type DebugSeam } from '../src/extension/debug-row';
import type {
  BuildFacts, SettingsFacts, SnapshotSeams,
} from '../src/extension/debug-snapshot';
import type { PostCacheStats } from '../src/extension/post-cache';
import type { DebugEvent, DebugLogStats } from '../src/extension/debug-log';
import type { NodeEntry } from '../src/mesh/node-list';
import type { ClientState, ClientTraffic, MeshDiagnostics } from '../src/mesh/mesh-client';

// The @settings window's debug row driven from the App — the row renders
// closed, `show` opens the snapshot's lines in place, each value is a copy
// control the clipboard takes (or falls back to selectable text when it
// refuses), the box is unticked at every open, `save as file` hands the file
// to the App's `download`, `clear log` asks in place, `refresh` re-takes the
// snapshot and a settings draw with no press does not, and the web build
// (no debug seam) renders no `debug` row at all.
// (WEB_INTERFACE → The settings window → "The debug row", → The extension →
// "The debug log", → "The snapshot", → "The debug file".)

const KEY = 'a'.repeat(64);

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 1, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function fakeApi(): Api {
  const feed: FeedResult = { posts: [], next: null, pending: [], pendingCount: 0 };
  return {
    feed: async () => feed,
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 1, hash: null }),
    karma: async (key): Promise<KarmaResult> => karmaResult({ userId: key }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

const BUILD: BuildFacts = {
  version: '0.7.0',
  commit: 'abcdef1',
  network: 'testnet',
  userAgent: 'Mozilla/5.0 (X11) Firefox/141',
};

const SETTINGS: SettingsFacts = {
  serve: false,
  links: 'here',
  signPolicy: 'silent',
  handNode: { address: '', off: false, key: null },
};

const CACHE: PostCacheStats = {
  database: null, entries: 0, bytes: 0, own: 0, kept: 0, unavailable: false,
};

const LOG_STATS: DebugLogStats = {
  events: 0, bytes: 0, oldestT: null, dropped: 0, open: true, unavailable: false,
};

function emptyTraffic(): ClientTraffic {
  return { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 };
}

function emptyState(overrides: Partial<ClientState> = {}): ClientState {
  return {
    nodeId: null, transport: null, path: null, lastLeft: null, tip: null,
    agreement: null, checks: 0, traffic: emptyTraffic(), nodes: [],
    seated: false, proofs: null, anchor: null, chain: null,
    notContinued: false, disagreement: null,
    localLookup: { reads: 0, last: null }, firstCheckEnded: false,
    ...overrides,
  };
}

function emptyDiagnostics(): MeshDiagnostics {
  return { connections: [], gossip: { meshPeers: 0, directPeers: 0 }, iceServers: [] };
}

interface Stub {
  downloads: Array<{ filename: string; text: string }>;
  clears: number;
  events: DebugEvent[];
  readerCalls: number;
}

function makeDebugSeam(
  stub: Stub,
  mesh: { state: () => ClientState; diagnostics: () => MeshDiagnostics } = {
    state: () => emptyState(),
    diagnostics: () => emptyDiagnostics(),
  },
): DebugSeam {
  const seams: Omit<SnapshotSeams, 'reader'> = {
    build: () => ({ ...BUILD }),
    settings: () => ({ ...SETTINGS }),
    mesh,
    postCache: { stats: () => Promise.resolve({ ...CACHE }) },
    debugLog: { stats: () => Promise.resolve({ ...LOG_STATS, events: stub.events.length }) },
  };
  return {
    seams,
    log: {
      clear: () => { stub.clears += 1; stub.events = []; return Promise.resolve(); },
      list: () => Promise.resolve([...stub.events]),
    },
    download: (filename, text) => { stub.downloads.push({ filename, text }); },
  };
}

function freshStub(): Stub {
  return { downloads: [], clears: 0, events: [], readerCalls: 0 };
}

function loadedIdm(): AppIdentity {
  return {
    current: () => ({ pubKeyHex: KEY, locked: false }),
    sign: async () => ({ signature: '' }),
    draft: async () => ({ pubKeyHex: KEY }),
    create: async () => ({ pubKeyHex: KEY }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    importFile: async () => ({ pubKeyHex: KEY }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    onChange: () => {},
  };
}

function mountWithDebug(seam: DebugSeam, idm?: AppIdentity): {
  app: App; appbar: HTMLElement; feed: HTMLElement; panes: HTMLElement;
} {
  document.body.innerHTML = '';
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  let appRef: App;
  const builder = (): HTMLElement => debugRow({
    seam,
    reader: () => appRef.readerFacts(),
    now: () => Date.now(),
  });
  const app = new App(
    fakeApi(), undefined, idm, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, builder,
  );
  appRef = app;
  app.mount(appbar, feed, panes);
  return { app, appbar, feed, panes };
}

const flush = async (): Promise<void> => {
  // settle every microtask queued by takeSnapshot (two awaited stats calls)
  // and the DOM paint that follows.
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

const openSettings = async (appbar: HTMLElement): Promise<void> => {
  appbar.querySelector<HTMLElement>('button[aria-label="open settings"]')!.click();
  await flush();
};

const debugRowEl = (panes: HTMLElement): HTMLElement | undefined =>
  [...panes.querySelectorAll<HTMLElement>('.winbody .row')]
    .find((r) => r.querySelector('label')?.textContent === 'debug');

const toggleWord = (row: HTMLElement): HTMLButtonElement =>
  row.querySelector<HTMLButtonElement>('.field > button.word')!;

const debugBody = (row: HTMLElement): HTMLElement | null =>
  row.querySelector<HTMLElement>('.debug-body');

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
  setTheme('light');
});

afterEach(() => {
  if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  else Object.defineProperty(navigator, 'clipboard', originalClipboard);
});

describe('the settings window debug row', () => {
  it('the row stands closed at the window\'s open, the word reading show', async () => {
    const stub = freshStub();
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub));
    await openSettings(appbar);
    const row = debugRowEl(panes);
    expect(row).toBeDefined();
    expect(toggleWord(row!).textContent).toBe('show');
    expect(debugBody(row!)).toBeNull();
  });

  it('a show press opens the lines from a snapshot and the word reads hide', async () => {
    const stub = freshStub();
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    expect(toggleWord(row).textContent).toBe('hide');
    const body = debugBody(row);
    expect(body).not.toBeNull();
    // the build line names the three build facts: version, commit, network.
    const text = body!.textContent ?? '';
    expect(text).toContain(BUILD.version);
    expect(text).toContain(BUILD.commit);
    expect(text).toContain(BUILD.network);
    // the log line names its bytes bound.
    expect(text).toMatch(/0 \/ 2000000 bytes/);
  });

  it('a value press writes the clipboard and reads copied, muted, beside the value', async () => {
    const stub = freshStub();
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (s: string): Promise<void> => { writes.push(s); return Promise.resolve(); } },
      writable: true, configurable: true,
    });
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const body = debugBody(row)!;
    const press = body.querySelector<HTMLButtonElement>('button.debug-copy')!;
    const value = press.textContent ?? '';
    press.click();
    await flush();
    expect(writes).toContain(value);
    expect(press.querySelector('.debug-copy-note')?.textContent?.trim()).toBe('copied');
    expect(press.querySelector('.debug-copy-note')?.classList.contains('inkmute')).toBe(true);
  });

  it('a refused clipboard leaves the value as selectable text followed by — copy it by hand', async () => {
    const stub = freshStub();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (): Promise<void> => Promise.reject(new Error('refused')) },
      writable: true, configurable: true,
    });
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const body = debugBody(row)!;
    const press = body.querySelector<HTMLButtonElement>('button.debug-copy')!;
    const value = press.textContent ?? '';
    const parent = press.parentElement!;
    press.click();
    await flush();
    // The button is gone, and its value stands as selectable mono text next to the handwritten-copy line.
    expect(parent.querySelector('button.debug-copy')).toBeNull();
    const mono = parent.querySelector('.mono');
    expect(mono?.textContent).toBe(value);
    expect(parent.textContent).toContain('— copy it by hand');
  });

  it('the include box is unticked on a second show after it was ticked', async () => {
    const stub = freshStub();
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const box1 = debugBody(row)!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box1.checked).toBe(false);
    box1.checked = true;
    box1.dispatchEvent(new Event('change'));
    // Close and reopen.
    toggleWord(row).click(); // hide
    await flush();
    expect(debugBody(row)).toBeNull();
    toggleWord(row).click(); // show again
    await flush();
    const box2 = debugBody(row)!.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(box2.checked).toBe(false);
  });

  it('save as file unticked hands download a text that does not carry the reader\'s key', async () => {
    const stub = freshStub();
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const body = debugBody(row)!;
    const save = [...body.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'save as file')!;
    save.click();
    await flush();
    expect(stub.downloads.length).toBe(1);
    expect(stub.downloads[0]!.filename).toMatch(/^notis-debug-\d{8}-\d{6}\.json$/);
    expect(stub.downloads[0]!.text).not.toContain(KEY);
  });

  it('save as file ticked hands download a text that carries the reader\'s key', async () => {
    const stub = freshStub();
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const body = debugBody(row)!;
    const box = body.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const save = [...body.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'save as file')!;
    save.click();
    await flush();
    expect(stub.downloads.length).toBe(1);
    expect(stub.downloads[0]!.text).toContain(KEY);
  });

  it('clear log asks in place, keep keeps the log, Esc keeps, clear empties it', async () => {
    const stub = freshStub();
    stub.events = [
      { t: 1, page: 'ab12cd34', kind: 'page', version: '0.7.0' },
      { t: 2, page: 'ab12cd34', kind: 'page', version: '0.7.0' },
    ];
    const { appbar, panes } = mountWithDebug(makeDebugSeam(stub), loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    const body = debugBody(row)!;
    const findClear = (): HTMLButtonElement => [...body.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'clear log')!;

    // First press — the question stands in place with `clear` and `keep`.
    findClear().click();
    let ask = body.querySelector<HTMLElement>('.debug-clear-ask');
    expect(ask).not.toBeNull();
    expect(ask!.textContent).toContain('clear the log?');
    const keep1 = [...ask!.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'keep')!;
    expect(document.activeElement).toBe(keep1);
    keep1.click();
    expect(body.querySelector('.debug-clear-ask')).toBeNull();
    expect(stub.clears).toBe(0);

    // Esc closes the question too.
    findClear().click();
    ask = body.querySelector<HTMLElement>('.debug-clear-ask');
    expect(ask).not.toBeNull();
    ask!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(body.querySelector('.debug-clear-ask')).toBeNull();
    expect(stub.clears).toBe(0);

    // A `clear` press reaches log.clear and the snapshot re-takes on return.
    findClear().click();
    ask = body.querySelector<HTMLElement>('.debug-clear-ask');
    const clearWord = [...ask!.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'clear')!;
    clearWord.click();
    await flush();
    expect(stub.clears).toBe(1);
    // the log line re-reads as 0 events once the stub's events are empty.
    expect(debugBody(row)!.textContent).toMatch(/0 events/);
  });

  it('refresh re-takes the snapshot, and a settings draw with no press does not', async () => {
    const stub = freshStub();
    const seam = makeDebugSeam(stub);
    let buildCalls = 0;
    seam.seams.build = () => { buildCalls += 1; return { ...BUILD }; };
    const { appbar, panes } = mountWithDebug(seam, loadedIdm());
    await openSettings(appbar);
    const row = debugRowEl(panes)!;
    toggleWord(row).click();
    await flush();
    expect(buildCalls).toBe(1);

    // A theme press re-renders the settings body; the row's internals stand.
    const themeBtn = panes.querySelector<HTMLButtonElement>('.winbody .row button.theme-btn')!;
    themeBtn.click();
    await flush();
    expect(buildCalls).toBe(1);

    // A refresh press re-takes the snapshot.
    const refresh = [...debugBody(row)!.querySelectorAll<HTMLButtonElement>('button.word')]
      .find((b) => b.textContent === 'refresh')!;
    refresh.click();
    await flush();
    expect(buildCalls).toBe(2);
  });

  it('an App built with no debug seam carries no debug row', async () => {
    document.body.innerHTML = '';
    const appbar = document.createElement('header');
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    workspace.append(feed, panes);
    document.body.append(appbar, workspace);
    const app = new App(fakeApi());
    app.mount(appbar, feed, panes);
    await openSettings(appbar);
    expect(debugRowEl(panes)).toBeUndefined();
  });

  it('a snapshot whose reader part names a tip verdict shows it in the chain lines', async () => {
    const row = debugRow({
      seam: makeDebugSeam(freshStub(), {
        state: () => emptyState({ tip: { height: 12, hash: 'c'.repeat(64) } }),
        diagnostics: () => emptyDiagnostics(),
      }),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [],
        lastTipRun: { verdict: 'verified', chain: null },
        lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    toggleWord(row).click();
    await flush();
    const chain = [...row.querySelectorAll<HTMLElement>('.debug-block')]
      .find((b) => b.querySelector('.debug-head')?.textContent === 'chain')!;
    expect(chain.textContent).toContain('verified');
  });

  it('a node with addresses, an API base and no connection reads its API base and no address', async () => {
    const addr = '/ip4/203.0.113.7/udp/9000/webrtc-direct/certhash/uEiAAA';
    const node = {
      notisId: KEY, addrs: [addr], api: 'https://node.example', status: 'candidate', readMs: null,
    } as unknown as NodeEntry;
    const row = debugRow({
      seam: makeDebugSeam(freshStub(), {
        state: () => emptyState({ nodes: [node] }),
        diagnostics: () => emptyDiagnostics(),
      }),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    toggleWord(row).click();
    await flush();
    const text = row.querySelector('.debug-body')!.textContent ?? '';
    expect(text).toContain('https://node.example');
    expect(text).not.toContain('203.0.113.7');
  });

  it('a node whose read took 6.199999988079071 ms reads 6 ms', async () => {
    const node = {
      notisId: KEY, addrs: [], api: 'https://node.example', status: 'candidate', readMs: 6.199999988079071,
    } as unknown as NodeEntry;
    const row = debugRow({
      seam: makeDebugSeam(freshStub(), {
        state: () => emptyState({ nodes: [node] }),
        diagnostics: () => emptyDiagnostics(),
      }),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    toggleWord(row).click();
    await flush();
    const text = row.querySelector('.debug-body')!.textContent ?? '';
    expect(text).toContain(' · 6 ms');
    expect(text).not.toContain('6.19');
  });

  it("a local node's line reads found on this network", async () => {
    // WEB_INTERFACE → The settings window → "The debug row" — "a node found
    // at an access point reading `found on this network`".
    const node = {
      notisId: KEY, addrs: [], api: 'https://node.example', status: 'ok', readMs: 12,
      local: true,
    } as unknown as NodeEntry;
    const row = debugRow({
      seam: makeDebugSeam(freshStub(), {
        state: () => emptyState({ nodes: [node] }),
        diagnostics: () => emptyDiagnostics(),
      }),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    toggleWord(row).click();
    await flush();
    const text = row.querySelector('.debug-body')!.textContent ?? '';
    expect(text).toContain('found on this network');
  });

  it('the lookup line reads one of the four states — not looked up / nothing answered / refused / found', async () => {
    // WEB_INTERFACE → The settings window → "The debug row" — "the last read
    // of the access point's identity URL — `not looked up`, `nothing
    // answered`, `refused` or `found`".
    const states: Array<{ last: ClientState['localLookup']['last']; expected: string }> = [
      { last: null, expected: 'not looked up' },
      { last: { check: 1, result: 'failed' }, expected: 'nothing answered' },
      { last: { check: 1, result: 'refused' }, expected: 'refused' },
      { last: { check: 1, result: 'answered' }, expected: 'found' },
    ];
    for (const s of states) {
      document.body.innerHTML = '';
      const row = debugRow({
        seam: makeDebugSeam(freshStub(), {
          state: () => emptyState({ localLookup: { reads: s.last === null ? 0 : 1, last: s.last } }),
          diagnostics: () => emptyDiagnostics(),
        }),
        reader: () => ({
          identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
          pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
        }),
        now: () => 0,
      });
      document.body.appendChild(row);
      toggleWord(row).click();
      await flush();
      const text = row.querySelector('.debug-body')!.textContent ?? '';
      expect(text, `state ${s.last?.result ?? 'null'}`).toContain(s.expected);
    }
  });

  it('a node\'s copy control writes the whole 64-hex key to the clipboard', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string): Promise<void> => { writes.push(t); return Promise.resolve(); } },
      writable: true, configurable: true,
    });
    const node = {
      notisId: KEY, addrs: [], api: 'https://node.example', status: 'candidate', readMs: null,
    } as unknown as NodeEntry;
    const row = debugRow({
      seam: makeDebugSeam(freshStub(), {
        state: () => emptyState({ nodes: [node] }),
        diagnostics: () => emptyDiagnostics(),
      }),
      reader: () => ({
        identityLoaded: false, unlocked: false, pubKeyHex: null, name: null,
        pending: [], waiting: [], lastTipRun: null, lastFiguresRun: null, lastNamesRun: null,
      }),
      now: () => 0,
    });
    document.body.appendChild(row);
    toggleWord(row).click();
    await flush();
    const nodes = [...row.querySelectorAll<HTMLElement>('.debug-block')]
      .find((b) => b.querySelector('.debug-head')?.textContent === 'nodes')!;
    nodes.querySelector<HTMLButtonElement>('button.debug-copy')!.click();
    await flush();
    expect(writes).toEqual([KEY]);
  });
});
