// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import { PendingLedger } from '../src/wallet/ledger';
import type { Api } from '../src/api/client';
import type { AppIdentity, TipVerifier, Anchor } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { BlockCurrent, FeedResult, PostResult, KarmaResult, StatusResult } from '../src/api/dto';
import type { TipVerdict } from '../src/model/tip-verdict';
import type { HandNodeSeam } from '../src/view/settings';
import type { BlockHeader } from '@dagsocial/types';
import { karmaResult } from './karma-fixture';
import { setNode } from '../src/prefs';
import { meshVerdict } from '../src/model/mesh-verdict';
import type { ClientState } from '../src/mesh/mesh-client';

// WEB_INTERFACE → The settings window — the node row holds the reader's
// question while the verdict reads `refused` · *your-node*. The status
// corner's press opens the settings window at its `node` row instead of
// running a verification. The row's draw moves no other element in the page.

const PUB = 'aa'.repeat(32);
const AUTHOR = 'bb'.repeat(32);

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 6000, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}
function confirmedPost(id: string): PostResult {
  return {
    id, content: 'x', contentHash: '00'.repeat(32), author: AUTHOR, parentRefs: [], protocolVersion: 1,
    type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0, blockCreatedAt: 0,
    likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null, txId: 'ff'.repeat(32), confirmedAuthor: AUTHOR,
  };
}
const fakeHeader = (height: number, tag: string): BlockHeader => ({
  protocolVersion: 1,
  height,
  prevBlockHash: '00'.repeat(32),
  utxoTxRoot: '00'.repeat(32),
  stateRoot: '11'.repeat(31) + tag.padStart(2, '0'),
  validatorId: new Uint8Array(32),
  powNonce: 0,
  powTargetBits: 0x1d00ffff,
  createdAt: 0,
  interlinkRoot: '00'.repeat(32),
  adProofsRoot: '00'.repeat(32),
});
const anchorFor = (height: number, tag: string): Anchor => ({ tip: fakeHeader(height, tag), suffixHead: fakeHeader(height - 19, tag) });
const yourNodeMemory = (): TipVerdict => ({ kind: 'refused', reason: 'your-node', which: 'memory', height: 100 });

interface TipRunLike { verdict: TipVerdict; anchor: Anchor | null; chain: string | null }

interface Harness {
  app: App;
  tipRuns: Array<{ resolve: (v: TipRunLike) => void; promise: Promise<TipRunLike> }>;
  appbar: HTMLElement;
  panes: HTMLElement;
  handNodeSeam: HandNodeSeam & {
    offState(): boolean;
    answers: Array<'continue' | 'disable'>;
  };
  drive: {
    verifyInFlight: boolean;
    verifyGen: number;
    cornerEl: HTMLButtonElement | null;
    tipVerdict: TipVerdict | null | undefined;
  };
}

function harness(opts: { initialOff?: boolean } = {}): Harness {
  const identity: AppIdentity = {
    current: () => null,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    draft: async () => ({ pubKeyHex: PUB }),
    create: async () => ({ pubKeyHex: PUB }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
    importFile: async () => ({ pubKeyHex: PUB }),
    exportFile: async () => '{}',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => false,
    onChange: () => {},
  };
  const fakeApi: Api = {
    feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async (id) => confirmedPost(id),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
    karma: async (): Promise<KarmaResult> => karmaResult({ userId: PUB }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
  const writeClient = {} as unknown as WriteClient;
  const tipRuns: Array<{ resolve: (v: TipRunLike) => void; promise: Promise<TipRunLike> }> = [];
  const verifier: TipVerifier = {
    run: () => {
      let resolve!: (v: TipRunLike) => void;
      const promise = new Promise<TipRunLike>((r) => { resolve = r; });
      tipRuns.push({ resolve, promise });
      return promise;
    },
  };
  // The hand-added-node seam the extension would wire. The row reads these.
  let offState = opts.initialOff ?? false;
  const answers: Array<'continue' | 'disable'> = [];
  const handNodeSeam = {
    address: () => '/ip4/127.0.0.1/udp/9/webrtc-direct/p2p/x',
    commit: () => null,
    off: () => offState,
    setOff: (v: boolean) => { offState = v; },
    answer: (d: 'continue' | 'disable') => { answers.push(d); if (d === 'disable') offState = true; },
    offState: () => offState,
    answers,
  };
  const ledger = new PendingLedger(PUB);
  const app = new App(
    fakeApi, writeClient, identity, ledger, undefined, undefined,
    verifier, undefined, undefined, undefined, undefined, undefined,
    handNodeSeam,
  );
  const appbar = document.createElement('header');
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return {
    app, tipRuns, appbar, panes, handNodeSeam,
    drive: app as unknown as Harness['drive'],
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});
afterEach(() => { vi.useRealTimers(); });

async function seatYourNode(h: Harness): Promise<void> {
  // The App started a verification at mount; drain it with a your-node verdict.
  await flush();
  const run = h.tipRuns[h.tipRuns.length - 1]!;
  run.resolve({ verdict: yourNodeMemory(), anchor: null, chain: null });
  await flush();
}

describe('under your-node', () => {
  // AssertionError: expected undefined to be 'settings' — the corner's press
  // still runs the verification path and does not open @settings.
  it("the corner's press opens the settings window with the node row in view and runs no verification", async () => {
    const h = harness();
    await seatYourNode(h);
    // The verifier has started exactly one run so far (the mount's).
    const runsBefore = h.tipRuns.length;
    const corner = h.drive.cornerEl!;
    expect(corner).not.toBeNull();
    corner.click();
    await flush();
    // The settings window is open — the bar reads `settings`.
    const bar = h.panes.querySelector('.bar .bar-label .name');
    expect(bar?.textContent).toBe('settings');
    // The node row is drawn — the `node` label stands in the body.
    const body = h.panes.querySelector<HTMLElement>('.winbody')!;
    const nodeRow = [...body.querySelectorAll('.row')]
      .find((r) => r.querySelector('label')?.textContent === 'node');
    expect(nodeRow).toBeDefined();
    // No new verification run began — a press under your-node opens the
    // window instead.
    expect(h.tipRuns.length).toBe(runsBefore);
  });

  // TypeError: Cannot read properties of null (reading 'querySelectorAll') —
  // the settings window does not open and no .winbody stands.
  it('the question appears and leaves inside the node row alone', async () => {
    const h = harness();
    await seatYourNode(h);
    // Open the settings window.
    const corner = h.drive.cornerEl!;
    corner.click();
    await flush();
    // Watch the panes: no element outside the node row is removed when the
    // question comes in or goes out — the row's update alone owns the question
    // (HOUSE_STYLE → Motion). `MutationObserver` over the panes, as
    // `app-pane-forms.test.ts` holds its rule.
    const panes = h.panes;
    const body = panes.querySelector<HTMLElement>('.winbody')!;
    const nodeRow = [...body.querySelectorAll<HTMLElement>('.row')]
      .find((r) => r.querySelector('label')?.textContent === 'node')!;
    // Each MutationRecord names its `target` — the parent from which the
    // removal was made (still in the document when we inspect it after the
    // batch, since nothing is replaced wholesale). We check that every
    // removal's target is inside the node row.
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => { records.push(...batch); });
    observer.observe(panes, { subtree: true, childList: true });
    // Flip the verdict out of your-node: every tip run that returns a
    // non-your-node verdict ends the question.
    (h.app as unknown as { startVerification: () => void }).startVerification();
    await flush();
    const run2 = h.tipRuns[h.tipRuns.length - 1]!;
    run2.resolve({ verdict: { kind: 'verified', nodes: 2, height: 101 }, anchor: anchorFor(101, 'bb'), chain: '00'.repeat(32) });
    await flush();
    records.push(...observer.takeRecords());
    observer.disconnect();
    for (const rec of records) {
      if (rec.removedNodes.length === 0) continue;
      // Every removal's target — the parent from which a node left — stands
      // inside the node row.
      expect(nodeRow.contains(rec.target) || rec.target === nodeRow).toBe(true);
    }
    // The body, the bar and the other rows are the same nodes as before.
    expect(panes.querySelector<HTMLElement>('.winbody')).toBe(body);
    const laterRows = [...body.querySelectorAll<HTMLElement>('.row')]
      .filter((r) => r.querySelector('label')?.textContent !== 'node');
    for (const r of laterRows) expect(panes.contains(r)).toBe(true);
  });
});

// A client state with a question standing and no chain seated: the first check
// has ended, the reader has not answered (MESH_INTERFACE → Discovery → "A
// disagreement is the reader's question, never the client's choice").
const unseatedWithQuestion = (): ClientState => ({
  nodeId: null,
  transport: null,
  path: null,
  lastLeft: null,
  tip: null,
  agreement: { onChain: 0, offChain: 0 },
  checks: 1,
  traffic: { tipBytes: 0, proofBytes: 0, headerBytes: 0, gossipBytes: 0, proofReads: 0, forwarded: 0 },
  nodes: [],
  seated: false,
  proofs: { asked: 2, verified: 0, invalid: 0, tooShort: 0 },
  anchor: null,
  chain: null,
  notContinued: false,
  disagreement: {
    which: 'memory',
    yours: { height: 100, hash: 'bb'.repeat(32) },
    other: null,
    fork: 'cc'.repeat(32),
  },
});

describe('a question standing before any chain is seated', () => {
  it.fails("the extension's settings row shows the question while no chain is seated", async () => {
    const h = harness();
    await flush();
    const run = h.tipRuns[h.tipRuns.length - 1]!;
    run.resolve({ verdict: meshVerdict(unseatedWithQuestion()), anchor: null, chain: null });
    await flush();
    h.drive.cornerEl!.click();
    await flush();
    const body = h.panes.querySelector<HTMLElement>('.winbody')!;
    const nodeRow = [...body.querySelectorAll<HTMLElement>('.row')]
      .find((r) => r.querySelector('label')?.textContent === 'node')!;
    expect(nodeRow.querySelector('.question')).not.toBeNull();
    const labels = [...nodeRow.querySelectorAll<HTMLButtonElement>('button.word')].map((w) => w.textContent);
    expect(labels).toContain('continue on this node');
    expect(labels).toContain('disable it');
  });
});

describe("the web build's settings window", () => {
  it('has no question, no off state, and holds no write', async () => {
    // No HandNodeSeam, no verifier — the web build.
    const identity: AppIdentity = {
      current: () => null,
      sign: async () => ({ signature: 'ab'.repeat(64) }),
      draft: async () => ({ pubKeyHex: PUB }),
      create: async () => ({ pubKeyHex: PUB }),
      discardDraft: () => {},
      inspectFile: async () => ({ kind: 'clear', pubKeyHex: PUB }),
      importFile: async () => ({ pubKeyHex: PUB }),
      exportFile: async () => '{}',
      unlock: async () => {},
      lock: async () => {},
      forget: async () => {},
      backedUp: () => false,
      onChange: () => {},
    };
    const fakeApi: Api = {
      feed: async (): Promise<FeedResult> => ({ posts: [], next: null, pending: [], pendingCount: 0 }),
      thread: async () => null, post: async (id) => confirmedPost(id),
      status: async () => statusResult(),
      currentBlock: async (): Promise<BlockCurrent> => ({ height: 6001, hash: null }),
      karma: async (): Promise<KarmaResult> => karmaResult({ userId: PUB }),
      vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
      vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
      vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
      bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
      usernameByOwner: async () => null,
      credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
      usernameByName: async () => null,
    };
    const writeClient = {} as unknown as WriteClient;
    const ledger = new PendingLedger(PUB);
    // The web build hands no handNodeSeam.
    const app = new App(fakeApi, writeClient, identity, ledger);
    const appbar = document.createElement('header');
    const workspace = document.createElement('div'); workspace.className = 'workspace';
    const feed = document.createElement('section'); feed.id = 'feed';
    const panes = document.createElement('section'); panes.id = 'panes';
    workspace.append(feed, panes);
    document.body.append(appbar, workspace);
    app.mount(appbar, feed, panes);
    appbar.querySelector<HTMLButtonElement>('button[aria-label="open settings"]')!.click();
    await flush();
    const body = panes.querySelector<HTMLElement>('.winbody')!;
    const nodeRow = [...body.querySelectorAll('.row')]
      .find((r) => r.querySelector('label')?.textContent === 'node')!;
    expect(nodeRow.querySelector('.question')).toBeNull();
    expect(nodeRow.querySelector('.off')).toBeNull();
    // No `continue on this node` / `disable it` / `turn on` word stands.
    const words = [...nodeRow.querySelectorAll<HTMLButtonElement>('button.word')];
    for (const w of words) {
      expect(w.textContent).not.toBe('continue on this node');
      expect(w.textContent).not.toBe('disable it');
      expect(w.textContent).not.toBe('turn on');
    }
  });
});
