// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { WriteClient, SendSubmitResult, Rejection } from '../src/api/write';
import type { AppIdentity } from '../src/model/state';
import type {
  FeedResult, PostJson, KarmaResult, StatusResult, BlockCurrent, CreditsResult, UsernameResult,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
} from '../src/api/dto';
import type { CreditGrant } from '../src/api/faucet';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { prefs } from '../src/prefs';

// The balance and send rows driven through the App (WEB_INTERFACE → The wallet
// window): every ctx the row is rendered against is one the App produces — the
// state a fabricated ctx would hide.

const ME = 'aa'.repeat(32);
const REC = 'cd'.repeat(32);
const CHANGE_BOX = 'ee'.repeat(32);
const GRANT_BOX = 'ff'.repeat(32);
const CBOX = 'bb'.repeat(32); // the reader's own confirmed credit box

let idState: { pubKeyHex: string; locked: boolean } | null;
let blockHeight: number;
let creditsSelf: CreditsResult;
let creditsRecipient: CreditsResult;
let signCalls: string[];
let sendResp: (() => SendSubmitResult | Rejection) | null;
let sendDefer: { resolve: (v: SendSubmitResult | Rejection) => void } | null;
let signResp: 'signed' | 'declined' | 'locked' | 'refused';
let faucetCredits: (() => CreditGrant | Rejection) | null;
let creditsCalls: string[];
let creditsDefer: { resolve: (v: CreditsResult) => void } | null;
const last = (): string => signCalls[signCalls.length - 1]!;

function post(id: string, author: string): PostJson {
  return {
    id, content: 'hi', contentHash: contentHashHex('hi'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 10, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1, postCount: 1, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

function memberKarma(): KarmaResult {
  return karmaResult({
    userId: ME, member: true, invitesAvailable: 2, memberSinceBlock: 5,
    boxCount: 1, total: '250', effective: '250',
    boxes: [{ boxId: 'a1', value: '250' }],
    height: blockHeight,
  });
}

function fakeApi(): Api {
  return {
    feed: async () => ({ posts: [post('p1', 'bb'.repeat(32))], next: null, pending: [], pendingCount: 0 } as FeedResult),
    thread: async () => null,
    post: async (id) => ({ ...post(id, 'bb'.repeat(32)), confirmedAuthor: 'bb'.repeat(32) }),
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: blockHeight, hash: null }),
    karma: async () => memberKarma(),
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (): Promise<UsernameResult | null> => null,
    usernameByName: async (name: string) => {
      // A resolved handle for '@bob' → REC; every other name is a 404.
      if (name.toLowerCase() === 'bob') return { name: 'bob', owner: REC, boxId: 'c'.repeat(32), claimedAtBlock: 1 };
      return null;
    },
    credits: async (key) => {
      creditsCalls.push(key);
      if (creditsDefer && key === ME) {
        return new Promise<CreditsResult>((r) => { creditsDefer = { resolve: r }; });
      }
      return key === ME ? creditsSelf : creditsRecipient;
    },
  };
}

function fakeWrite(): WriteClient {
  return {
    submitSend: async () => {
      if (sendDefer) return new Promise<SendSubmitResult | Rejection>((r) => { sendDefer = { resolve: r }; });
      return sendResp ? sendResp() : ({ status: 'pending', txId: last(), expiresAtHeight: blockHeight + 720 });
    },
  } as unknown as WriteClient;
}

function fakeIdentity(opts: { withPolicy?: boolean } = {}): AppIdentity {
  const base: Record<string, unknown> = {
    current: () => idState,
    sign: async (_bytes: Uint8Array, t: string) => {
      signCalls.push(t);
      if (signResp === 'signed') return { signature: 'ab'.repeat(64) };
      if (signResp === 'declined') return { declined: true } as unknown as { signature: string };
      if (signResp === 'locked') return { locked: true } as unknown as { signature: string };
      return { refused: 'nope' } as unknown as { signature: string };
    },
    onChange: (_cb: () => void) => {},
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '',
    unlock: async () => {},
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
  };
  // The extension arm — the proxy exposes policy/setPolicy; the in-page
  // module does not (WEB_INTERFACE → The wallet window → "The `send` row").
  // ctx.confirmInRow reads on `!this.idm.policy`, so the presence of the method
  // here is what turns the confirm row off.
  if (opts.withPolicy) {
    base.policy = (): 'silent' | 'ask' => 'silent';
    base.setPolicy = async (_p: 'silent' | 'ask'): Promise<void> => {};
  }
  return base as unknown as AppIdentity;
}

interface Drive {
  loadFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  send(toHex: string, toName: string | null, amount: bigint): Promise<void>;
  askFaucetCredits(): Promise<void>;
  pollTick(): Promise<void>;
  ledger: { all(): Array<{ kind: string; postId: string; txId: string; send?: { boxId: string } }>; size: number };
  walletCredits: CreditsResult | null;
  creditGrantView: unknown;
  sendFlight: { stage: string; reason?: string | null } | null;
  faucetClient: { askCredits: (key: string) => Promise<CreditGrant | Rejection> };
}

function harness(opts: { withPolicy?: boolean; requestFaucetOrigin?: (o: string) => Promise<boolean> } = {}) {
  idState = { pubKeyHex: ME, locked: false };
  blockHeight = 100;
  signCalls = [];
  sendResp = null;
  sendDefer = null;
  signResp = 'signed';
  faucetCredits = null;
  creditsCalls = [];
  creditsDefer = null;
  creditsSelf = {
    userId: ME, total: '10000000000',
    boxes: [{ boxId: CBOX, value: '10000000000' }],
    boxCount: 1, next: null,
  };
  creditsRecipient = { userId: REC, total: '0', boxes: [], boxCount: 0, next: null };

  const app = new App(fakeApi(), fakeWrite(), fakeIdentity(opts), undefined, undefined, opts.requestFaucetOrigin);
  // Swap the faucet client for a controllable one, so tests drive the credits
  // grant without touching fetch.
  (app as unknown as { faucetClient: unknown }).faucetClient = {
    askCredits: async (_key: string): Promise<CreditGrant | Rejection> => {
      if (faucetCredits) return faucetCredits();
      return { txId: '11'.repeat(32), status: 'pending', expiresAtHeight: blockHeight + 720, boxId: GRANT_BOX };
    },
  };
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return { app, appbar, feed, panes, drive: app as unknown as Drive };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  prefs.faucet = '/faucet';
});
afterEach(() => { vi.useRealTimers(); });

describe('the send flow', () => {
  it('a send press writes the transaction and adds a `send` ledger entry', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    // 1 $NOTIS = 100_000_000 base units.
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send');
    expect(entry).toBeDefined();
    expect(entry!.postId).toBe(REC); // the recipient key is the subject
    expect(entry!.send?.boxId).toBeDefined();
    // No transient flight ending — the pending line is the ledger's entry.
    expect(h.drive.sendFlight).toBeNull();
  });

  it('a decline leaves sendFlight rejected with *send not sent.*', async () => {
    const h = harness();
    signResp = 'declined';
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    // No ledger entry — nothing was spent.
    expect(h.drive.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    // The row's flight reads *send not sent.* through stageLine.
    expect(h.drive.sendFlight?.stage).toBe('rejected');
    expect(h.drive.sendFlight?.reason).toContain('send not sent.');
  });

  it('a node rejection sets sendFlight rejected with the reason', async () => {
    const h = harness();
    sendResp = () => ({ status: 400, message: 'too small' });
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    expect(h.drive.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    expect(h.drive.sendFlight?.stage).toBe('rejected');
    expect(h.drive.sendFlight?.reason).toContain('too small');
  });

  it('a send landing sets sendFlight landed, re-reads the sender /credits and drops the entry (READ-1 defect 4)', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send')!;
    expect(h.drive.sendFlight).toBeNull();
    // The recipient's /credits now lists the payment box (matching the entry's boxId);
    // the sender's /credits shows the change.
    creditsRecipient = { userId: REC, total: '100000000', boxes: [{ boxId: entry.send!.boxId, value: '100000000' }], boxCount: 1, next: null };
    creditsSelf = {
      userId: ME, total: '9900000000',
      boxes: [{ boxId: CHANGE_BOX, value: '9900000000' }],
      boxCount: 1, next: null,
    };
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    // The entry cleared; the row's flight reads *sent* (stage: 'landed').
    expect(h.drive.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    expect(h.drive.sendFlight?.stage).toBe('landed');
    // The sender's /credits reflect the move — the row's balance updates in place.
    expect(h.drive.walletCredits?.boxes[0]?.boxId).toBe(CHANGE_BOX);
    expect(h.drive.walletCredits?.boxes[0]?.value).toBe('9900000000');
  });

  it('a send expiry sets sendFlight expired', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send')!;
    // The recipient never lists the box, and the tip advances past expiresAtHeight.
    blockHeight = 10_000; // way past expiresAtHeight (submitted at 100 + 720)
    await h.drive.pollTick();
    await flush();
    expect(h.drive.ledger.all().find((e) => e.kind === 'send' && e.txId === entry.txId)).toBeUndefined();
    expect(h.drive.sendFlight?.stage).toBe('expired');
  });
});

// WEB_INTERFACE → The faucet step → "In the extension the press asks the
// browser for the faucet's origin first" — the extension arm carries the
// permission hook; the web arm carries none.
describe('the App faucet permission — the extension arm ($NOTIS step)', () => {
  const FAUCET_ORIGIN = 'https://faucet.example';

  async function pressAskCredits(h: ReturnType<typeof harness>): Promise<HTMLButtonElement> {
    // No credits yet — the wallet's step shows.
    creditsSelf = { userId: ME, total: '0', boxes: [], boxCount: 0, next: null };
    prefs.faucet = FAUCET_ORIGIN;
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.winbody .row .word')]
      .find((b) => b.textContent === 'ask the faucet for $NOTIS')!;
    return btn;
  }

  it('the hook is invoked synchronously from the ask press, before any await; the faucet request has not left when the hook is held', async () => {
    const hookCalls: string[] = [];
    const hook = (o: string): Promise<boolean> => {
      hookCalls.push(o);
      return new Promise(() => {}); // held for ever
    };
    const h = harness({ requestFaucetOrigin: hook });
    let creditsAskCalls = 0;
    (h.app as unknown as { faucetClient: { askCredits: (k: string) => Promise<unknown> } }).faucetClient = {
      askCredits: async () => { creditsAskCalls++; return { txId: '11'.repeat(32), status: 'pending', expiresAtHeight: 820, boxId: GRANT_BOX }; },
    };
    const btn = await pressAskCredits(h);
    btn.click();
    expect(hookCalls).toEqual([FAUCET_ORIGIN]);
    expect(creditsAskCalls).toBe(0);
    await flush();
    await flush();
    expect(creditsAskCalls).toBe(0);
  });

  it('a refused permission reports on the wallet window and no faucet request leaves', async () => {
    const h = harness({ requestFaucetOrigin: async () => false });
    let creditsAskCalls = 0;
    (h.app as unknown as { faucetClient: { askCredits: (k: string) => Promise<unknown> } }).faucetClient = {
      askCredits: async () => { creditsAskCalls++; return { txId: '11'.repeat(32), status: 'pending', expiresAtHeight: 820, boxId: GRANT_BOX }; },
    };
    const btn = await pressAskCredits(h);
    btn.click();
    await flush();
    await flush();
    expect(creditsAskCalls).toBe(0);
    // The report line is the wallet column's — "the browser refused access to
    // that origin." — rendered as the .report node of the focused column.
    const report = document.querySelector('.report');
    expect(report?.textContent).toContain('the browser refused access to that origin.');
  });

  it('a granted permission lets the faucet request leave and the ledger holds the creditGrant', async () => {
    const h = harness({ requestFaucetOrigin: async () => true });
    let creditsAskCalls = 0;
    (h.app as unknown as { faucetClient: { askCredits: (k: string) => Promise<unknown> } }).faucetClient = {
      askCredits: async () => { creditsAskCalls++; return { txId: '11'.repeat(32), status: 'pending', expiresAtHeight: 820, boxId: GRANT_BOX }; },
    };
    const btn = await pressAskCredits(h);
    btn.click();
    await flush();
    await flush();
    expect(creditsAskCalls).toBe(1);
    const entry = h.drive.ledger.all().find((e) => e.kind === 'creditGrant');
    expect(entry).toBeDefined();
    expect(entry!.postId).toBe(GRANT_BOX);
  });

  it('with no hook (the web build), the ask leaves as today', async () => {
    const h = harness(); // no requestFaucetOrigin
    let creditsAskCalls = 0;
    (h.app as unknown as { faucetClient: { askCredits: (k: string) => Promise<unknown> } }).faucetClient = {
      askCredits: async () => { creditsAskCalls++; return { txId: '11'.repeat(32), status: 'pending', expiresAtHeight: 820, boxId: GRANT_BOX }; },
    };
    const btn = await pressAskCredits(h);
    btn.click();
    await flush();
    await flush();
    expect(creditsAskCalls).toBe(1);
    expect(h.drive.ledger.all().find((e) => e.kind === 'creditGrant')).toBeDefined();
  });
});

describe('the faucet credits step', () => {
  it('a 202 adds a `creditGrant` entry and lands on the read that lists its box', async () => {
    const h = harness();
    // No credits yet — the faucet step shows.
    creditsSelf = { userId: ME, total: '0', boxes: [], boxCount: 0, next: null };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.askFaucetCredits();
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'creditGrant');
    expect(entry).toBeDefined();
    expect(entry!.postId).toBe(GRANT_BOX);
    // The landing: /credits now lists the box the faucet named.
    creditsSelf = { userId: ME, total: '10000000000', boxes: [{ boxId: GRANT_BOX, value: '10000000000' }], boxCount: 1, next: null };
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    expect(h.drive.ledger.all().find((e) => e.kind === 'creditGrant')).toBeUndefined();
    expect(h.drive.creditGrantView).toBeNull();
    expect(h.drive.walletCredits?.boxes[0]?.boxId).toBe(GRANT_BOX);
  });

  it('a 202 whose box never lists expires past expiresAtHeight', async () => {
    const h = harness();
    creditsSelf = { userId: ME, total: '0', boxes: [], boxCount: 0, next: null };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await h.drive.askFaucetCredits();
    await flush();
    expect(h.drive.creditGrantView).toEqual({ state: 'pending' });
    blockHeight = 10_000;
    await h.drive.pollTick();
    await flush();
    // The entry cleared and the grant view reads expired at the height it was submitted with.
    expect(h.drive.ledger.all().find((e) => e.kind === 'creditGrant')).toBeUndefined();
    expect((h.drive.creditGrantView as { state: string; atHeight: number }).state).toBe('expired');
  });
});

describe('the row after a landed send', () => {
  it('the DOM reads *sent* after the landing without a full re-render', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    // The @wallet window is mounted — reach the credits row through the DOM.
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    // The App has rendered the wallet window; the credits row's field exists.
    const field = document.querySelector<HTMLElement>('.credits-field');
    expect(field).not.toBeNull();
    // Submit a send.
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send')!;
    creditsRecipient = { userId: REC, total: '100000000', boxes: [{ boxId: entry.send!.boxId, value: '100000000' }], boxCount: 1, next: null };
    creditsSelf = {
      userId: ME, total: '9900000000',
      boxes: [{ boxId: CHANGE_BOX, value: '9900000000' }],
      boxCount: 1, next: null,
    };
    blockHeight = 101;
    await h.drive.pollTick();
    await flush();
    const flight = document.querySelector<HTMLElement>('.credits-flight');
    // *sent* — the row's own render on landing.
    expect(flight?.textContent).toBe('sent');
    // The balance moves — 99 $NOTIS in gold, in place.
    const gold = document.querySelector<HTMLElement>('.credits-line .mono.gold');
    expect(gold?.textContent).toBe('99');
  });

  it('a declined send leaves both inputs holding their values and the flight reads *send not sent.* (READ-1 defect 3)', async () => {
    const h = harness();
    signResp = 'declined';
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    // Fill the form.
    const form = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = REC;
    inputs[1]!.value = '1';
    // Press send — the confirm row appears.
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // Press the confirm's send button.
    const confirmSend = [...document.querySelectorAll<HTMLButtonElement>('.pf-confirm .word')]
      .find((b) => b.textContent === 'send')!;
    confirmSend.click();
    await flush();
    // The form is back with its values, the flight reads *send not sent.*
    const backForm = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const backInputs = backForm.querySelectorAll<HTMLInputElement>('input');
    expect(backInputs[0]!.value).toBe(REC);
    expect(backInputs[1]!.value).toBe('1');
    const flight = document.querySelector<HTMLElement>('.credits-flight');
    expect(flight?.textContent).toContain('send not sent.');
  });

  it('an accepted submission clears the form (READ-1 defect 3)', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    const form = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = '@bob'; // resolveRecipient → REC, toName 'bob'
    inputs[1]!.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const confirmSend = [...document.querySelectorAll<HTMLButtonElement>('.pf-confirm .word')]
      .find((b) => b.textContent === 'send')!;
    confirmSend.click();
    await flush();
    // A pending line reads *<amount> $NOTIS to @bob · submitted*.
    const flight = document.querySelector<HTMLElement>('.credits-flight');
    expect(flight?.textContent).toContain('1 $NOTIS to @bob · submitted');
    // The form is cleared on the accepted submission.
    const clearForm = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const clearInputs = clearForm.querySelectorAll<HTMLInputElement>('input');
    expect(clearInputs[0]!.value).toBe('');
    expect(clearInputs[1]!.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The extension arm — the App builds ctx with confirmInRow: false when the
// identity module implements `policy`, so no .pf-confirm renders and the send
// fires at once (WEB_INTERFACE → The wallet window → "in the extension there is no confirm row").
// ---------------------------------------------------------------------------

describe('the send flow — the extension arm (confirmInRow: false)', () => {
  it('the send goes straight to the flow — no confirm row is ever built; the resolved key stands beneath the field; the decline keeps the values', async () => {
    // A `declined` signResp exercises the "prompt says no" ending on the App
    // side, where the ledger's send entry is never added and the form's
    // values stay put — every ending but an accepted submission (WEB_INTERFACE
    // → The wallet). harness() resets signResp to 'signed' at line 147, so
    // 'declined' is set AFTER the harness build.
    const h = harness({ withPolicy: true });
    signResp = 'declined';
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    const form = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = '@bob'; // resolves to REC, name 'bob'
    inputs[1]!.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // No confirm row is ever built on the extension arm.
    expect(document.querySelector('.pf-confirm')).toBeNull();
    // The resolved key rendered beneath the recipient, in mono, whole.
    const key = form.querySelector<HTMLElement>('.resolved-key');
    expect(key?.hidden).toBe(false);
    expect(key?.textContent).toBe(REC);
    // signCalls carries one — send() called at once, the signer answered
    // declined, so the ledger has no send entry.
    expect(signCalls).toHaveLength(1);
    expect(h.drive.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    // The form keeps its values (every ending but an accepted submission).
    expect((form.querySelectorAll<HTMLInputElement>('input'))[0]!.value).toBe('@bob');
    expect((form.querySelectorAll<HTMLInputElement>('input'))[1]!.value).toBe('1');
    expect(h.drive.sendFlight?.stage).toBe('rejected');
    expect(h.drive.sendFlight?.reason).toContain('send not sent.');
  });

  it('an accepted submission clears the form and the resolved-key hint', async () => {
    const h = harness({ withPolicy: true });
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    await flush();
    await (h.app as unknown as { openWallet: () => Promise<void> }).openWallet();
    await flush();
    const form = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = '@bob';
    inputs[1]!.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // No confirm row is ever built.
    expect(document.querySelector('.pf-confirm')).toBeNull();
    // A pending send: the ledger has the entry; the row's pending line reads
    // the recipient by handle.
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send');
    expect(entry).toBeDefined();
    const flight = document.querySelector<HTMLElement>('.credits-flight');
    expect(flight?.textContent).toContain('1 $NOTIS to @bob · submitted');
    // The form and the resolved-key hint cleared on the accepted submission.
    const clearForm = document.querySelector<HTMLFormElement>('form.credits-form')!;
    const clearInputs = clearForm.querySelectorAll<HTMLInputElement>('input');
    expect(clearInputs[0]!.value).toBe('');
    expect(clearInputs[1]!.value).toBe('');
    const clearKey = clearForm.querySelector<HTMLElement>('.resolved-key');
    expect(clearKey?.hidden).toBe(true);
    expect(clearKey?.textContent).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The wallet's reads — the wallet window owns /credits, and the profile's ↻
// re-reads /karma and the reader's name (WEB_INTERFACE → The profile window,
// → The wallet window).
// ---------------------------------------------------------------------------

describe('the wallet reads', () => {
  it('identity load reads no /credits — the wallet owns the read (WEB_INTERFACE → The wallet window)', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    expect(creditsCalls.filter((k) => k === ME).length).toBe(0);
  });

  it('a fresh wallet open reads /credits; a raise does not (WEB_INTERFACE → The wallet window)', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    // First open — a fresh window mounts and /credits is read.
    (h.app as unknown as { openWallet: () => void }).openWallet();
    await flush();
    const afterOpen = creditsCalls.filter((k) => k === ME).length;
    expect(afterOpen).toBe(1);
    // Second open — the raise; no new /credits call.
    (h.app as unknown as { openWallet: () => void }).openWallet();
    await flush();
    expect(creditsCalls.filter((k) => k === ME).length).toBe(afterOpen);
  });

  it("openWallet fires and moves at once — the window is mounted and the view moved BEFORE /credits answers", async () => {
    // Hold the /credits read open by hand: the fake defers the promise until
    // the test resolves it. If openWallet awaited it, the window would not
    // mount and the view would not move before release (WEB_INTERFACE → The
    // wallet window; openProfile's pattern for /karma).
    const h = harness();
    creditsDefer = { resolve: () => {} }; // seat the defer before openWallet fires
    let moved: string | null = null;
    (h.app as unknown as { moveView: (id: string) => void }).moveView = (id: string) => { moved = id; };
    (h.app as unknown as { openWallet: () => void }).openWallet();
    await flush();
    // The /credits read fired (the counter rose) but has not answered yet
    // (creditsDefer holds the promise). The wallet's bar is in the DOM and
    // the App's moveView was called with '@wallet' — the press moved on.
    expect(creditsCalls.filter((k) => k === ME).length).toBe(1);
    const bar = document.querySelector('.bars .bar .bar-label .name');
    expect(bar?.textContent).toBe('wallet');
    expect(moved).toBe('@wallet');
    // Release the read — the balance lands in place, nothing else moves.
    creditsDefer!.resolve({ userId: ME, total: '10000000000', boxes: [{ boxId: CBOX, value: '10000000000' }], boxCount: 1, next: null });
    creditsDefer = null;
    await flush();
    await flush();
    expect(h.drive.walletCredits?.boxes[0]?.boxId).toBe(CBOX);
  });

  it("the wallet's ↻ re-reads /credits and moves the balance in place", async () => {
    const h = harness();
    creditsSelf = { userId: ME, total: '10000000000', boxes: [{ boxId: CBOX, value: '10000000000' }], boxCount: 1, next: null };
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    (h.app as unknown as { openWallet: () => void }).openWallet();
    await flush();
    await flush();
    const before = creditsCalls.filter((k) => k === ME).length;
    // The node's answer changes: fewer $NOTIS.
    creditsSelf = { userId: ME, total: '500000000', boxes: [{ boxId: 'dd'.repeat(32), value: '500000000' }], boxCount: 1, next: null };
    await (h.app as unknown as { refreshWalletCredits: () => Promise<void> }).refreshWalletCredits();
    await flush();
    expect(creditsCalls.filter((k) => k === ME).length).toBe(before + 1);
    // The balance moves in place — the gold reads the new spendable sum (5 $NOTIS).
    const gold = document.querySelector<HTMLElement>('.credits-line .mono.gold');
    expect(gold?.textContent).toBe('5');
  });

  it("the profile's ↻ (refreshProfileKarma) issues no /credits request", async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    const before = creditsCalls.filter((k) => k === ME).length;
    await (h.app as unknown as { refreshProfileKarma: () => Promise<void> }).refreshProfileKarma();
    await flush();
    expect(creditsCalls.filter((k) => k === ME).length).toBe(before);
  });

  it('a send landing with the wallet closed reconciles the ledger and throws nothing', async () => {
    const h = harness();
    await h.drive.loadFeed();
    await h.drive.loadMembershipState();
    // The wallet is not opened — .credits-field is absent from the DOM.
    expect(document.querySelector('.credits-field')).toBeNull();
    await h.drive.send(REC, 'bob', 100_000_000n);
    await flush();
    const entry = h.drive.ledger.all().find((e) => e.kind === 'send')!;
    expect(entry).toBeDefined();
    // The recipient's /credits now lists the payment box; the sender's /credits shows the change.
    creditsRecipient = { userId: REC, total: '100000000', boxes: [{ boxId: entry.send!.boxId, value: '100000000' }], boxCount: 1, next: null };
    creditsSelf = { userId: ME, total: '9900000000', boxes: [{ boxId: CHANGE_BOX, value: '9900000000' }], boxCount: 1, next: null };
    blockHeight = 101;
    // The landing must not throw when the wallet has no field mounted.
    await h.drive.pollTick();
    await flush();
    expect(h.drive.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    expect(h.drive.sendFlight?.stage).toBe('landed');
    // The App still updated walletCredits — a later open renders the moved balance.
    expect(h.drive.walletCredits?.boxes[0]?.boxId).toBe(CHANGE_BOX);
  });
});
