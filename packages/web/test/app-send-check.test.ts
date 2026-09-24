// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Anchor, NameClaim, NameResult, NameStatus } from '@dagsocial/nipopow-client';
import type { BlockHeader } from '@dagsocial/types';
import { App } from '../src/app';
import type { Api } from '../src/api/client';
import type { WriteClient, SendSubmitResult, Rejection } from '../src/api/write';
import type { AppIdentity, NamesVerifier, TipVerifier } from '../src/model/state';
import type { SignResult } from '../src/wallet/submit';
import type { CreditsResult, FeedResult, PostJson, StatusResult, UsernameResult } from '../src/api/dto';
import type { TipVerdict } from '../src/model/tip-verdict';
import { karmaResult } from './karma-fixture';
import { contentHashHex } from '../src/integrity';
import { setNode } from '../src/prefs';

// The send's check at the press (WEB_INTERFACE → The extension → "The verified
// names", → The wallet window → "The `send` row"), driven through the App as the
// extension build holds it: the identity module with a policy — no confirm row —
// a tip verifier and a names verifier, every run of each answered by the test. A
// typed handle is checked against the anchor standing, or the one a tip run
// writes; the send goes to the key the proven box names and never the node's
// word; every other ending refuses in the row, the form keeping its values and
// nothing signed.

const NODE_A = 'https://a.example';
const NODE_B = 'https://b.example';

const ME = 'aa'.repeat(32);   // the reader
const REC = 'cd'.repeat(32);  // the key the proven box names
const EVE = 'e7'.repeat(32);  // another holder, for a second press
const EVIL = 'e5'.repeat(32); // the key the node's own /usernames/:name answers — the App never asks
const OTHER = '0f'.repeat(32); // a second identity the reader loads
const CBOX = 'bb'.repeat(32); // the reader's spendable credit box

const CANT = "@bob can't be checked — the chain is not verified.";
const CANT_CHECKED = "@bob can't be checked."; // a check that ends without an answer

function post(): PostJson {
  return {
    id: '1'.repeat(64), content: 'hi', contentHash: contentHashHex('hi'), author: 'f1'.repeat(32), parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 90, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, descendantCount: 0, authorName: null, likedByViewer: null,
  };
}

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 1, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

/** What the fake node and the fake signer answer, changeable by a test, and
 *  what they were asked. */
interface World {
  ownName: UsernameResult | null;
  sign: 'signed' | 'declined' | 'held';
  signCalls: string[];
  usernameByName: string[];
  // While true the node holds each /usernames/:name answer until a test
  // releases its waiter — the web build's read at the press.
  holdNames: boolean;
  nameWaiters: Array<() => void>;
  // The loaded identity — its key, whether it is locked, the passphrases an
  // unlock was asked with (`pw` opens it), and the App's change listeners.
  me: string;
  locked: boolean;
  unlocks: string[];
  identityListeners: Array<(id: { pubKeyHex: string } | null) => void>;
}

function world(): World {
  return {
    ownName: null, sign: 'signed', signCalls: [], usernameByName: [], holdNames: false, nameWaiters: [],
    me: ME, locked: false, unlocks: [], identityListeners: [],
  };
}

function fakeApi(w: World): Api {
  return {
    feed: async (): Promise<FeedResult> => ({ posts: [post()], next: null, pending: [], pendingCount: 0 }),
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async () => ({ height: 100, hash: null }),
    karma: async (key) => karmaResult({
      userId: key, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1,
      total: '250', effective: '250', boxes: [{ boxId: '11'.repeat(32), value: '250' }], height: 100,
    }),
    credits: async (key): Promise<CreditsResult> => (key === w.me
      ? { userId: key, total: '10000000000', boxes: [{ boxId: CBOX, value: '10000000000' }], boxCount: 1, next: null }
      : { userId: key, total: '0', boxes: [], boxCount: 0, next: null }),
    vouchesByTarget: async () => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async () => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async () => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async (key) => (key === ME ? w.ownName : null),
    // The node's own word for a handle names another key — read, it would send
    // there. The extension never reads it.
    usernameByName: async (name) => {
      w.usernameByName.push(name);
      if (w.holdNames) await new Promise<void>((release) => { w.nameWaiters.push(release); });
      return { name, owner: EVIL, boxId: '5e'.repeat(32), claimedAtBlock: 1 };
    },
  };
}

function fakeWrite(w: World): WriteClient {
  return {
    submitSend: async (): Promise<SendSubmitResult | Rejection> =>
      ({ status: 'pending', txId: w.signCalls[w.signCalls.length - 1]!, expiresAtHeight: 820 }),
  } as unknown as WriteClient;
}

function identity(w: World): AppIdentity {
  return {
    current: () => ({ pubKeyHex: w.me, locked: w.locked }),
    sign: (_bytes: Uint8Array, txIdHex: string): Promise<SignResult> => {
      w.signCalls.push(txIdHex);
      if (w.sign === 'held') return new Promise(() => {});
      return Promise.resolve(w.sign === 'declined' ? { declined: true } : { signature: 'ab'.repeat(64) });
    },
    onChange: (listener) => { w.identityListeners.push(listener); },
    draft: async () => ({ pubKeyHex: ME }),
    create: async () => ({ pubKeyHex: ME }),
    discardDraft: () => {},
    inspectFile: async () => ({ kind: 'clear' as const, pubKeyHex: ME }),
    importFile: async () => ({ pubKeyHex: ME }),
    exportFile: async () => '',
    unlock: async (passphrase) => {
      w.unlocks.push(passphrase);
      if (passphrase !== 'pw') throw new Error('that passphrase does not open this key.');
      w.locked = false;
    },
    lock: async () => {},
    forget: async () => {},
    backedUp: () => true,
    // The extension's proxy carries the policy, and the App reads its presence
    // as the build with no confirm row (WEB_INTERFACE → The wallet window).
    policy: () => 'silent',
    setPolicy: async () => {},
  };
}

/** The in-page module the web build holds — no policy, so the confirm row
 *  stands (WEB_INTERFACE → The wallet window). */
function webIdentity(w: World): AppIdentity {
  const id = identity(w);
  delete id.policy;
  delete id.setPolicy;
  return id;
}

function header(height: number, tag: string): BlockHeader {
  return {
    protocolVersion: 1, height, prevBlockHash: '00'.repeat(32), utxoTxRoot: '00'.repeat(32),
    stateRoot: '11'.repeat(31) + tag, validatorId: new Uint8Array(32), powNonce: 0,
    powTargetBits: 0x1d00ffff, createdAt: 0, interlinkRoot: '00'.repeat(32),
  };
}

function anchorFor(h: number): Anchor {
  return { tip: header(h, 'aa'), suffixHead: { header: header(h - 19, 'bb'), interlinks: [] } };
}

interface TipRunHandle {
  resolve: (run: { verdict: TipVerdict; anchor: Anchor | null }) => void;
  reject: (e: unknown) => void;
}

interface NameCall {
  base: string;
  claim: NameClaim;
  anchor: Anchor;
  resolve: (r: NameResult) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

interface Drive {
  loadFeed(): Promise<void>;
  loadMembershipState(): Promise<void>;
  openWallet(): void;
  openThread(id: string, origin: { from: 'pane'; ci: number }): void;
  refreshWalletCredits(): Promise<void>;
  changeNode(origin: string): Promise<void>;
  ledger: { all(): Array<{ kind: string; postId: string; send?: { toHex: string; toName: string | null } }> };
  cornerEl: HTMLButtonElement | null;
}

interface Harness {
  drive: Drive;
  world: World;
  tipRuns: TipRunHandle[];
  nameCalls: NameCall[];
}

/** The App over fakes as a build holds it — by default the extension's, whose
 *  mount starts the first tip run, held until the test answers it; the web
 *  build's holds the in-page identity and no verifier. */
function harness(w: World = world(), build: 'extension' | 'web' = 'extension'): Harness {
  const tipRuns: TipRunHandle[] = [];
  const tipVerifier: TipVerifier = {
    run: () => new Promise((resolve, reject) => { tipRuns.push({ resolve, reject }); }),
  };
  const nameCalls: NameCall[] = [];
  const namesVerifier: NamesVerifier = {
    run: (base, claim, anchor) => new Promise((resolve, reject) => {
      nameCalls.push({ base, claim, anchor, resolve, reject, settled: false });
    }),
  };
  const app = build === 'extension'
    ? new App(fakeApi(w), fakeWrite(w), identity(w), undefined, undefined, undefined, tipVerifier, undefined, namesVerifier)
    : new App(fakeApi(w), fakeWrite(w), webIdentity(w));
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return { drive: app as unknown as Drive, world: w, tipRuns, nameCalls };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The feed, the reader's own state, and the wallet window open on its send form. */
async function ready(h: Harness): Promise<void> {
  await h.drive.loadFeed();
  await h.drive.loadMembershipState();
  h.drive.openWallet();
  await flush();
  await flush();
  expect(document.querySelector('form.credits-form')).not.toBeNull();
}

/** Answer tip run `i` with a verdict — verified with its anchor, or none. */
async function endRun(h: Harness, i: number, verdict: TipVerdict, anchor: Anchor | null = null): Promise<void> {
  h.tipRuns[i]!.resolve({ verdict, anchor });
  await flush();
}
const verified = (anchor: Anchor): TipVerdict => ({ kind: 'verified', nodes: 2, height: anchor.tip.height });
const THIN: TipVerdict = { kind: 'thin', reason: 'one-node', height: 100 };

/** Type a recipient and an amount into the send form and press `send`. */
async function press(to: string, amount = '1'): Promise<HTMLFormElement> {
  const form = document.querySelector<HTMLFormElement>('form.credits-form')!;
  const inputs = form.querySelectorAll<HTMLInputElement>('input');
  inputs[0]!.value = to;
  inputs[1]!.value = amount;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  return form;
}

function result(status: NameStatus, owner: string | null = null, name: string | null = null): NameResult {
  return { status, owner, name, boxId: '5f'.repeat(32), heightAfter: null, verdict: status };
}

const isPress = (c: NameCall): boolean => !('key' in c.claim);
const isLabel = (c: NameCall): boolean => 'key' in c.claim;

/** Answer the one waiting check the predicate picks — by default the one
 *  waiting at all. */
async function answer(h: Harness, r: NameResult, which: (c: NameCall) => boolean = () => true): Promise<NameCall> {
  const waiting = h.nameCalls.filter((c) => !c.settled && which(c));
  expect(waiting).toHaveLength(1);
  const c = waiting[0]!;
  c.settled = true;
  c.resolve(r);
  await flush();
  return c;
}

/** What the flight's place of the row on screen reads. */
function flightLine(): string {
  return document.querySelector<HTMLElement>('.credits-flight')!.textContent ?? '';
}
function sendButton(form: HTMLFormElement): HTMLButtonElement {
  return form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
}

/** The refusals and the keys beneath the field that the send forms on screen show. */
function shownRefusals(): string[] {
  return [...document.querySelectorAll<HTMLElement>('form.credits-form .pf-refusal')]
    .filter((r) => !r.hidden).map((r) => r.textContent ?? '');
}
function shownKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>('form.credits-form .resolved-key')]
    .filter((k) => !k.hidden).map((k) => k.textContent ?? '');
}

/** Load another identity, as create, import or forget does: the module's key
 *  moves and the App's listeners hear it. */
function changeIdentity(h: Harness, key: string): void {
  h.world.me = key;
  for (const listener of h.world.identityListeners) listener({ pubKeyHex: key });
}

type Rebuild = 'the wallet raised' | 'a window opened beside it';
/** Rebuild the wallet window's body: a raise re-renders its region, a window
 *  opened in a new column re-renders every region. */
function rebuild(h: Harness, how: Rebuild): void {
  if (how === 'the wallet raised') h.drive.openWallet();
  else h.drive.openThread('1'.repeat(64), { from: 'pane', ci: 0 });
}

/** Type a passphrase into an unlock row and submit it. */
async function unlockWith(row: HTMLElement, passphrase: string): Promise<void> {
  const unlock = row.querySelector<HTMLFormElement>('form.pf')!;
  unlock.querySelector<HTMLInputElement>('input[type="password"]')!.value = passphrase;
  unlock.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
}
function refusalLine(form: HTMLFormElement): HTMLElement {
  return form.querySelector<HTMLElement>('.pf-refusal')!;
}
function keyLine(form: HTMLFormElement): HTMLElement {
  return form.querySelector<HTMLElement>('.resolved-key')!;
}
function values(form: HTMLFormElement): string[] {
  return [...form.querySelectorAll<HTMLInputElement>('input')].map((i) => i.value);
}
function sendEntries(h: Harness): Array<{ postId: string; send?: { toHex: string; toName: string | null } }> {
  return h.drive.ledger.all().filter((e) => e.kind === 'send');
}

/** The row refused with `text`: the line shown, no key beneath the field, the
 *  form's values as typed, nothing signed and nothing pending. */
function expectRefused(h: Harness, form: HTMLFormElement, text: string, typed: string): void {
  expect(refusalLine(form).hidden).toBe(false);
  expect(refusalLine(form).textContent).toBe(text);
  expect(keyLine(form).hidden).toBe(true);
  expect(values(form)).toEqual([typed, '1']);
  expect(h.world.signCalls).toEqual([]);
  expect(sendEntries(h)).toEqual([]);
}

beforeEach(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode(NODE_A);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the send check — the table, against the anchor standing', () => {
  it.each<NameStatus>(['proven', 'young'])('%s — the key beneath the field and the key signed for are the proven owner; the node\'s own answer is never read', async (status) => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    const call = await answer(h, result(status, REC, 'Bob'));
    // The check: the typed name, at the reading node, against the anchor standing.
    expect(call.claim).toEqual({ name: 'bob' });
    expect(call.base).toBe(NODE_A);
    expect(call.anchor).toBe(a1);
    expect(keyLine(form).hidden).toBe(false);
    expect(keyLine(form).textContent).toBe(REC);
    expect(refusalLine(form).hidden).toBe(true);
    // The flow went to the signer at once — the prompt is the confirmation.
    expect(h.world.signCalls).toHaveLength(1);
    expect(document.querySelector('.pf-confirm')).toBeNull();
    expect(h.world.usernameByName).toEqual([]);
    expect(h.tipRuns).toHaveLength(1);
  });

  it('the ledger entry and the pending line carry the proven key and the name as committed, not as typed', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const entries = sendEntries(h);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.postId).toBe(REC);
    expect(entries[0]!.send).toMatchObject({ toHex: REC, toName: 'Bob' });
    expect(document.querySelector('.credits-flight')!.textContent).toBe('1 $NOTIS to @Bob · submitted');
    expect(h.world.usernameByName).toEqual([]);
  });

  it('none — *no one holds that name.*', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('none'));
    expectRefused(h, form, 'no one holds that name.', '@bob');
  });

  it.each<NameStatus>(['absent', 'unproven'])('%s — *this node\'s answer for @bob did not verify.*', async (status) => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result(status));
    expectRefused(h, form, "this node's answer for @bob did not verify.", '@bob');
    expect(h.world.usernameByName).toEqual([]);
  });

  it('no-proof — *the node served no proof for @bob.*', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('no-proof'));
    expectRefused(h, form, 'the node served no proof for @bob.', '@bob');
  });

  it('a refusal names the handle as the reader typed it — its case kept, its `@` added where none was typed', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    let form = await press('@BoB');
    const first = await answer(h, result('absent'));
    expect(first.claim).toEqual({ name: 'BoB' });
    expectRefused(h, form, "this node's answer for @BoB did not verify.", '@BoB');
    form = await press('bob');
    const second = await answer(h, result('no-proof'));
    expect(second.claim).toEqual({ name: 'bob' });
    expectRefused(h, form, 'the node served no proof for @bob.', 'bob');
  });

  it('a proven owner that is the reader\'s own key refuses as the key typed would — *that is your own key.*', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@me');
    await answer(h, result('proven', ME, 'Me'));
    expectRefused(h, form, 'that is your own key.', '@me');
  });

  it('a press that refuses takes away the key a press before it left beneath the field', async () => {
    const h = harness();
    h.world.sign = 'declined';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    // The prompt declined: the values and the proven key stand.
    expect(keyLine(form).hidden).toBe(false);
    expect(keyLine(form).textContent).toBe(REC);
    expect(values(form)).toEqual(['@bob', '1']);
    h.world.signCalls.length = 0;
    await press('@eve');
    await answer(h, result('unproven'));
    expectRefused(h, form, "this node's answer for @eve did not verify.", '@eve');
    expect(keyLine(form).textContent).toBe('');
  });
});

describe('the send check — `unchecked` takes one tip run', () => {
  it('a second check against the anchor of one fresh run decides — proven goes to the flow with the second result\'s key', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    // One tip run started; no second check until it ends.
    expect(h.tipRuns).toHaveLength(2);
    expect(h.nameCalls.filter((c) => !c.settled)).toHaveLength(0);
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    const second = await answer(h, result('young', EVE, 'bob'));
    expect(second.claim).toEqual({ name: 'bob' });
    expect(second.anchor).toBe(a2);
    expect(keyLine(form).textContent).toBe(EVE);
    expect(h.world.signCalls).toHaveLength(1);
    expect(h.tipRuns).toHaveLength(2);
  });

  it('a second `unchecked` refuses — *@bob is too new to check yet.* — after exactly one run', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    await answer(h, result('unchecked'));
    expectRefused(h, form, '@bob is too new to check yet.', '@bob');
    expect(h.tipRuns).toHaveLength(2);
    expect(h.nameCalls).toHaveLength(2);
  });

  it('the run after `unchecked` ending with no anchor refuses — *@bob can\'t be checked* — with no second check', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    await endRun(h, 1, THIN);
    expectRefused(h, form, CANT, '@bob');
    expect(h.nameCalls).toHaveLength(1);
  });

  it('a run already in flight is the one the second check waits on — no run more', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    // A press of the corner starts run 1 before the press's check ends.
    h.drive.cornerEl!.dispatchEvent(new Event('click'));
    await flush();
    expect(h.tipRuns).toHaveLength(2);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    expect(h.tipRuns).toHaveLength(2);
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    const second = await answer(h, result('none'));
    expect(second.anchor).toBe(a2);
    expectRefused(h, form, 'no one holds that name.', '@bob');
  });
});

describe('the send check — no anchor standing', () => {
  it('the run in flight is joined — no second run — and the check waits for its anchor', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const form = await press('@bob');
    expect(h.tipRuns).toHaveLength(1);
    expect(h.nameCalls).toHaveLength(0);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const call = await answer(h, result('proven', REC, 'Bob'));
    expect(call.anchor).toBe(a1);
    expect(keyLine(form).textContent).toBe(REC);
    expect(h.world.signCalls).toHaveLength(1);
    expect(h.tipRuns).toHaveLength(1);
  });

  it('with no run in flight the press starts one, and a verified end checks against the anchor it wrote', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    await endRun(h, 0, THIN);
    const form = await press('@bob');
    expect(h.tipRuns).toHaveLength(2);
    expect(h.nameCalls).toHaveLength(0);
    const a1 = anchorFor(100);
    await endRun(h, 1, verified(a1), a1);
    const call = await answer(h, result('proven', REC, 'Bob'));
    expect(call.anchor).toBe(a1);
    expect(keyLine(form).textContent).toBe(REC);
  });

  const UNVERIFIED: TipVerdict[] = [
    { kind: 'thin', reason: 'no-proof', height: null },
    { kind: 'thin', reason: 'too-short', height: 12 },
    { kind: 'thin', reason: 'one-node', height: 100 },
    { kind: 'thin', reason: 'split', height: 100 },
    { kind: 'refused', reason: 'invalid-proof', by: null, height: 100 },
    { kind: 'refused', reason: 'outworked', by: NODE_B, height: 100 },
  ];

  it.each(UNVERIFIED)('a run the press started that ends $kind · $reason refuses — *@bob can\'t be checked* — and asks no check', async (verdict) => {
    const h = harness();
    await ready(h);
    await endRun(h, 0, THIN);
    const form = await press('@bob');
    // The press waits on the run it started.
    expect(h.tipRuns).toHaveLength(2);
    expect(refusalLine(form).hidden).toBe(true);
    await endRun(h, 1, verdict);
    expectRefused(h, form, CANT, '@bob');
    expect(h.nameCalls).toHaveLength(0);
  });

  it.each(UNVERIFIED)('a joined run that ends $kind · $reason refuses the same', async (verdict) => {
    const h = harness();
    await ready(h);
    const form = await press('@bob');
    expect(refusalLine(form).hidden).toBe(true);
    await endRun(h, 0, verdict);
    expectRefused(h, form, CANT, '@bob');
    expect(h.nameCalls).toHaveLength(0);
    expect(h.tipRuns).toHaveLength(1);
  });

  it('a run that ends without a verdict refuses — *@bob can\'t be checked*', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await ready(h);
    const form = await press('@bob');
    expect(refusalLine(form).hidden).toBe(true);
    h.tipRuns[0]!.reject(new Error('the run threw'));
    await flush();
    expectRefused(h, form, CANT, '@bob');
    expect(h.nameCalls).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('a hidden tab starts no run, and the press refuses at once', async () => {
    const h = harness();
    await ready(h);
    await endRun(h, 0, THIN);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const form = await press('@bob');
    expectRefused(h, form, CANT, '@bob');
    expect(h.tipRuns).toHaveLength(1);
    expect(h.nameCalls).toHaveLength(0);
  });

  it('an empty reading base starts no run, and the press refuses at once', async () => {
    const h = harness();
    await ready(h);
    await endRun(h, 0, THIN);
    setNode('');
    const form = await press('@bob');
    expectRefused(h, form, CANT, '@bob');
    expect(h.tipRuns).toHaveLength(1);
    expect(h.nameCalls).toHaveLength(0);
  });
});

describe('the send check — a node change, and a check that throws', () => {
  it('a node change drops the run the press waits on: the press ends, answering nowhere, and does not join the new node\'s run', async () => {
    const h = harness();
    await ready(h);
    const form = await press('@bob');
    expect(refusalLine(form).hidden).toBe(true);
    await h.drive.changeNode(NODE_B);
    await flush();
    // The new node's run is under way; the press ended without it, and its
    // answer lands neither on the form it was made on nor on the row.
    expect(h.tipRuns).toHaveLength(2);
    expect(refusalLine(form).hidden).toBe(true);
    expect(shownRefusals()).toEqual([]);
    expect(flightLine()).toBe('');
    expect(h.nameCalls).toHaveLength(0);
    const a1 = anchorFor(100);
    await endRun(h, 1, verified(a1), a1);
    expect(h.nameCalls.filter(isPress)).toHaveLength(0);
    expect(h.world.signCalls).toEqual([]);
    expect(sendEntries(h)).toEqual([]);
  });

  it('a check a node change moved past is dropped, proven or not: the press ends, answering nowhere', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    expect(h.nameCalls).toHaveLength(1);
    await h.drive.changeNode(NODE_B);
    await answer(h, result('proven', REC, 'Bob'));
    expect(refusalLine(form).hidden).toBe(true);
    expect(shownRefusals()).toEqual([]);
    expect(shownKeys()).toEqual([]);
    expect(keyLine(form).hidden).toBe(true);
    expect(h.world.signCalls).toEqual([]);
    expect(sendEntries(h)).toEqual([]);
  });

  it('a check that throws is logged once and the press refuses — *@bob can\'t be checked*', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    const c = h.nameCalls[0]!;
    c.settled = true;
    c.reject(new Error('the seam threw'));
    await flush();
    expectRefused(h, form, CANT_CHECKED, '@bob');
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('the send check — a run the press starts is a run a name check asks for', () => {
  it('the handles\' spent ask does not hold the press\'s run back, and the press\'s run does not give the handles another', async () => {
    const w = world();
    w.ownName = { name: 'Me_1', owner: ME, boxId: '51'.repeat(32), claimedAtBlock: 40 };
    w.sign = 'held';
    const h = harness(w);
    await ready(h);
    // The reader's own name is on screen: a verified run checks it, `unchecked`
    // asks for its one run, and a second `unchecked` asks for none.
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await answer(h, result('unchecked'), isLabel);
    expect(h.tipRuns).toHaveLength(2);
    const a2 = anchorFor(101);
    await endRun(h, 1, verified(a2), a2);
    await answer(h, result('unchecked'), isLabel);
    expect(h.tipRuns).toHaveLength(2);
    // The press's own `unchecked` still gets its run.
    const form = await press('@bob');
    await answer(h, result('unchecked'), isPress);
    expect(h.tipRuns).toHaveLength(3);
    const a3 = anchorFor(104);
    await endRun(h, 2, verified(a3), a3);
    // The run checks every pair on screen, and the press checks once more.
    const second = await answer(h, result('proven', REC, 'Bob'), isPress);
    expect(second.anchor).toBe(a3);
    expect(keyLine(form).textContent).toBe(REC);
    // The name's third `unchecked` asks for nothing: the press's run left the
    // handles' ask spent.
    await answer(h, result('unchecked'), isLabel);
    expect(h.tipRuns).toHaveLength(3);
  });
});

// While a press's check runs the row's flight place reads *checking @bob…* — `@`
// and the name as typed — and a press during it does nothing, so one press is
// one check and at most one prompt; the answer replaces the line (WEB_INTERFACE
// → The wallet window → "The `send` row").

describe('the send check — the row reads *checking @bob…* from the press to its answer', () => {
  it('a proof: the line from the press until the proven key goes to the flow, whose own stage then reads', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    expect(flightLine()).toBe('');
    const form = await press('@bob');
    const line = document.querySelectorAll<HTMLElement>('.credits-flight > *');
    expect(line).toHaveLength(1);
    expect(line[0]!.className).toBe('stage');
    expect(line[0]!.textContent).toBe('checking @bob…');
    expect(h.world.signCalls).toEqual([]);
    await answer(h, result('proven', REC, 'Bob'));
    expect(flightLine()).toBe('submitting…');
    expect(keyLine(form).textContent).toBe(REC);
    expect(h.world.signCalls).toHaveLength(1);
  });

  it('the handle as typed — its case kept, its `@` added where none was typed', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('BoB');
    expect(flightLine()).toBe('checking @BoB…');
  });

  it.each<[NameStatus, string]>([
    ['none', 'no one holds that name.'],
    ['absent', "this node's answer for @bob did not verify."],
    ['unproven', "this node's answer for @bob did not verify."],
    ['no-proof', 'the node served no proof for @bob.'],
  ])('%s: the line while the check runs, then the refusal in its line and the flight\'s place empty', async (status, text) => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    expect(refusalLine(form).hidden).toBe(true);
    await answer(h, result(status));
    expect(flightLine()).toBe('');
    expectRefused(h, form, text, '@bob');
  });

  it('the reader\'s own key: the line gone with the answer, and *that is your own key.*', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@me');
    expect(flightLine()).toBe('checking @me…');
    await answer(h, result('proven', ME, 'Me'));
    expect(flightLine()).toBe('');
    expectRefused(h, form, 'that is your own key.', '@me');
  });

  it('a tip run awaited: the line from the press, through the run, and through the check the run lets run', async () => {
    const h = harness();
    await ready(h);
    const form = await press('@bob');
    expect(h.nameCalls).toHaveLength(0);
    expect(flightLine()).toBe('checking @bob…');
    const a1 = anchorFor(100);
    // The verified run re-reads the wallet and moves its row in place.
    await endRun(h, 0, verified(a1), a1);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    expect(flightLine()).toBe('checking @bob…');
    await answer(h, result('none'));
    expect(flightLine()).toBe('');
    expectRefused(h, form, 'no one holds that name.', '@bob');
  });

  it('`unchecked`: the line through the one tip run and the second check, gone as the answer goes to the flow', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('unchecked'));
    expect(flightLine()).toBe('checking @bob…');
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    expect(flightLine()).toBe('checking @bob…');
    await answer(h, result('young', EVE, 'bob'));
    expect(flightLine()).toBe('submitting…');
  });

  it('a second `unchecked`: the line gone, and *@bob is too new to check yet.*', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    expect(flightLine()).toBe('checking @bob…');
    await answer(h, result('unchecked'));
    expect(flightLine()).toBe('');
    expectRefused(h, form, '@bob is too new to check yet.', '@bob');
  });

  it.each(['started', 'joined'] as const)('no anchor, on a run the press %s: the line while it waits, then *… — the chain is not verified.*', async (how) => {
    const h = harness();
    await ready(h);
    if (how === 'started') await endRun(h, 0, THIN);
    const form = await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    await endRun(h, how === 'started' ? 1 : 0, { kind: 'refused', reason: 'invalid-proof', by: null, height: 100 });
    expect(flightLine()).toBe('');
    expectRefused(h, form, CANT, '@bob');
  });

  it('no run to wait on — a hidden tab — refuses at the press with no line standing', async () => {
    const h = harness();
    await ready(h);
    await endRun(h, 0, THIN);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    const form = await press('@bob');
    expect(flightLine()).toBe('');
    expectRefused(h, form, CANT, '@bob');
  });

  it('a check that throws: the line gone and *@bob can\'t be checked.*', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    const c = h.nameCalls[0]!;
    c.settled = true;
    c.reject(new Error('the seam threw'));
    await flush();
    expect(flightLine()).toBe('');
    expectRefused(h, form, CANT_CHECKED, '@bob');
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('the second check throwing, after `unchecked` and its run: *@bob can\'t be checked.*', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('unchecked'));
    const a2 = anchorFor(103);
    await endRun(h, 1, verified(a2), a2);
    const c = h.nameCalls[1]!;
    c.settled = true;
    c.reject(new Error('the seam threw'));
    await flush();
    expect(flightLine()).toBe('');
    expectRefused(h, form, CANT_CHECKED, '@bob');
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('the send check — one press is one check', () => {
  it('a second press while the check runs — a click on `send`, the submission an Enter makes — checks nothing more, and the proof opens one flow', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    sendButton(form).click();
    await flush();
    // Enter in either field is the form's implicit submission; happy-dom makes
    // none from a keydown, so the submission itself stands in for it.
    form.requestSubmit();
    await flush();
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    expect(flightLine()).toBe('checking @bob…');
    await answer(h, result('proven', REC, 'Bob'));
    expect(h.world.signCalls).toHaveLength(1);
    expect(sendEntries(h)).toHaveLength(1);
    expect(flightLine()).toBe('1 $NOTIS to @Bob · submitted');
  });

  it('a press while the press before it waits on a tip run starts no run and no check', async () => {
    const h = harness();
    await ready(h);
    await endRun(h, 0, THIN);
    const form = await press('@bob');
    expect(h.tipRuns).toHaveLength(2);
    sendButton(form).click();
    await flush();
    expect(h.tipRuns).toHaveLength(2);
    expect(h.nameCalls).toHaveLength(0);
    const a1 = anchorFor(100);
    await endRun(h, 1, verified(a1), a1);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
  });

  it('a press while the check runs does nothing whatever the fields hold — a key goes to no flow, a bad amount reads no refusal — and leaves the fields as typed', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    const [to, amount] = [...form.querySelectorAll<HTMLInputElement>('input')];
    to!.value = 'ff'.repeat(32);
    sendButton(form).click();
    await flush();
    expect(h.world.signCalls).toEqual([]);
    amount!.value = 'x';
    sendButton(form).click();
    await flush();
    expect(refusalLine(form).hidden).toBe(true);
    expect(values(form)).toEqual(['ff'.repeat(32), 'x']);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    expect(flightLine()).toBe('checking @bob…');
    // The answer is the press's: the key its handle proved goes to the one flow.
    await answer(h, result('proven', REC, 'Bob'));
    expect(keyLine(form).textContent).toBe(REC);
    expect(h.world.signCalls).toHaveLength(1);
  });

  it('a press after the answer checks again', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('none'));
    expectRefused(h, form, 'no one holds that name.', '@bob');
    await press('@bob');
    expect(h.nameCalls.filter(isPress)).toHaveLength(2);
    expect(flightLine()).toBe('checking @bob…');
    expect(refusalLine(form).hidden).toBe(true);
    await answer(h, result('proven', REC, 'Bob'));
    expect(h.world.signCalls).toHaveLength(1);
  });
});

describe('the send check — a render of the row while the check runs', () => {
  it('in place — the wallet\'s ↻ — the line stands, and the pressed form stands with its values and takes the answer', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await h.drive.refreshWalletCredits();
    await flush();
    expect(flightLine()).toBe('checking @bob…');
    expect(document.querySelector('form.credits-form')).toBe(form);
    expect(values(form)).toEqual(['@bob', '1']);
    await answer(h, result('none'));
    expect(flightLine()).toBe('');
    expectRefused(h, form, 'no one holds that name.', '@bob');
  });

  it.each<Rebuild>(['the wallet raised', 'a window opened beside it'])('a rebuild — %s — mounts a fresh form under the line, and a press on it does nothing', async (how) => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const pressed = await press('@bob');
    rebuild(h, how);
    await flush();
    const fresh = document.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(fresh).not.toBe(pressed);
    expect(flightLine()).toBe('checking @bob…');
    expect(await press('@bob')).toBe(fresh);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    await answer(h, result('proven', REC, 'Bob'));
    expect(h.world.signCalls).toHaveLength(1);
    expect(sendEntries(h)).toHaveLength(1);
    expect(flightLine()).toBe('1 $NOTIS to @Bob · submitted');
  });

  it('a node change ends the press\'s check: no line on the rebuilt row, a press there checks at the new node, and the node before\'s answer opens no flow', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    expect(h.nameCalls.filter(isPress).map((c) => c.base)).toEqual([NODE_A]);
    await h.drive.changeNode(NODE_B);
    await flush();
    expect(flightLine()).toBe('');
    // The new node's run is under way; a press on the rebuilt row joins it.
    expect(h.tipRuns).toHaveLength(2);
    await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    expect(h.tipRuns).toHaveLength(2);
    // The node before's check answers: dropped, the new press's line standing —
    // in what the App holds as on screen: a render draws it, a press does nothing.
    await answer(h, result('proven', REC, 'Bob'), (c) => c.base === NODE_A);
    expect(flightLine()).toBe('checking @bob…');
    expect(h.world.signCalls).toEqual([]);
    await h.drive.refreshWalletCredits();
    await flush();
    expect(flightLine()).toBe('checking @bob…');
    const tipRunsBefore = h.tipRuns.length;
    await press('@bob');
    expect(h.tipRuns).toHaveLength(tipRunsBefore);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    const a2 = anchorFor(200);
    await endRun(h, 1, verified(a2), a2);
    const second = await answer(h, result('proven', EVE, 'bob'), (c) => c.base === NODE_B);
    expect(second.anchor).toBe(a2);
    expect(h.world.signCalls).toHaveLength(1);
    expect(sendEntries(h).map((e) => e.postId)).toEqual([EVE]);
  });
});

describe('the send check — the web build', () => {
  it('the node\'s answer is read at the press with no *checking* line, a press during the read reads again, and the confirm row is the second step', async () => {
    const w = world();
    w.holdNames = true;
    const h = harness(w, 'web');
    await ready(h);
    const form = await press('@bob');
    expect(h.world.usernameByName).toEqual(['bob']);
    expect(flightLine()).toBe('');
    sendButton(form).click();
    await flush();
    expect(h.world.usernameByName).toEqual(['bob', 'bob']);
    expect(flightLine()).toBe('');
    for (const release of w.nameWaiters.splice(0)) release();
    await flush();
    expect(document.querySelector('.pf-confirm')).not.toBeNull();
    expect(flightLine()).toBe('');
    expect(h.tipRuns).toEqual([]);
    expect(h.nameCalls).toEqual([]);
    expect(h.world.signCalls).toEqual([]);
  });
});

// The press is the App's once the form has read its amount and recipient: the
// check, its answer and the unlock a locked identity owes are App state the
// row draws on whichever form stands, and a node or identity change ends the
// press (WEB_INTERFACE → The wallet window → "The `send` row").

describe('the send check — the answer lands where a rebuild reads it', () => {
  it.each<Rebuild>(['the wallet raised', 'a window opened beside it'])('a rebuild mid-check, then a refusal: it reads on the live form — %s', async (how) => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const pressed = await press('@bob');
    rebuild(h, how);
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(live).not.toBe(pressed);
    await answer(h, result('none'));
    expect(flightLine()).toBe('');
    expect(refusalLine(live).hidden).toBe(false);
    expect(refusalLine(live).textContent).toBe('no one holds that name.');
    expect(keyLine(live).hidden).toBe(true);
    expect(h.world.signCalls).toEqual([]);
  });

  it('a rebuild mid-check, then a proof: the key stands beneath the live form\'s field, and the flow runs once', async () => {
    const h = harness();
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    rebuild(h, 'a window opened beside it');
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    await answer(h, result('proven', REC, 'Bob'));
    expect(keyLine(live).hidden).toBe(false);
    expect(keyLine(live).textContent).toBe(REC);
    expect(refusalLine(live).hidden).toBe(true);
    expect(flightLine()).toBe('submitting…');
    expect(h.world.signCalls).toHaveLength(1);
  });

  it('a rebuild mid-check, then the reader\'s own key: *that is your own key.* on the live form', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@me');
    rebuild(h, 'the wallet raised');
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    await answer(h, result('proven', ME, 'Me'));
    expect(refusalLine(live).textContent).toBe('that is your own key.');
    expect(refusalLine(live).hidden).toBe(false);
    expect(keyLine(live).hidden).toBe(true);
    expect(h.world.signCalls).toEqual([]);
  });

  it('the answer stands through a rebuild after it until the next press, which drops it — that press\'s own refusal standing through a render in place', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('none'));
    rebuild(h, 'the wallet raised');
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(refusalLine(live).hidden).toBe(false);
    expect(refusalLine(live).textContent).toBe('no one holds that name.');
    await press('@bob', '');
    expect(refusalLine(live).textContent).toBe('an amount is digits with up to eight decimals.');
    await h.drive.refreshWalletCredits();
    await flush();
    expect(refusalLine(live).textContent).toBe('an amount is digits with up to eight decimals.');
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
  });

  it('an accepted submission takes the key from beneath the field, and a render in place does not bring it back', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    expect(sendEntries(h)).toHaveLength(1);
    expect(keyLine(form).hidden).toBe(true);
    await h.drive.refreshWalletCredits();
    await flush();
    expect(keyLine(form).hidden).toBe(true);
    expect(values(form)).toEqual(['', '']);
  });
});

describe('the send check — an identity change ends the press', () => {
  it('the line goes with the change, and the check proving after it sends nothing', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    changeIdentity(h, OTHER);
    await flush();
    expect(flightLine()).toBe('');
    await answer(h, result('proven', REC, 'Bob'), isPress);
    expect(flightLine()).toBe('');
    expect(h.world.signCalls).toEqual([]);
    expect(sendEntries(h)).toEqual([]);
    expect(shownRefusals()).toEqual([]);
    expect(shownKeys()).toEqual([]);
    // The new identity's own press checks anew and sends as its own.
    await press('@bob');
    expect(h.nameCalls.filter(isPress)).toHaveLength(2);
    await answer(h, result('proven', REC, 'Bob'), isPress);
    expect(h.world.signCalls).toHaveLength(1);
    expect(sendEntries(h).map((e) => e.postId)).toEqual([REC]);
  });

  it('a press waiting on a tip run ends with the change: the run ending after it sends nothing and leaves no line', async () => {
    const h = harness();
    await ready(h);
    await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    changeIdentity(h, OTHER);
    await flush();
    expect(flightLine()).toBe('');
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const waiting = h.nameCalls.filter((c) => isPress(c) && !c.settled);
    for (const c of waiting) {
      c.settled = true;
      c.resolve(result('proven', REC, 'Bob'));
    }
    await flush();
    expect(flightLine()).toBe('');
    expect(h.world.signCalls).toEqual([]);
    expect(shownKeys()).toEqual([]);
  });

  it('a press made after the change keeps its line and its hold when the check from before the change answers', async () => {
    const h = harness();
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    changeIdentity(h, OTHER);
    await flush();
    await press('@bob');
    expect(flightLine()).toBe('checking @bob…');
    const [before, after] = h.nameCalls.filter(isPress);
    before!.settled = true;
    before!.resolve(result('proven', REC, 'Bob'));
    await flush();
    await h.drive.refreshWalletCredits();
    await flush();
    expect(flightLine()).toBe('checking @bob…');
    await press('@bob');
    expect(h.nameCalls.filter(isPress)).toHaveLength(2);
    expect(h.world.signCalls).toEqual([]);
    after!.settled = true;
    after!.resolve(result('proven', REC, 'Bob'));
    await flush();
    expect(h.world.signCalls).toHaveLength(1);
  });
});

describe('the send check — the unlock a locked identity owes', () => {
  it('a rebuild mid-check on a locked identity, then a proof: the unlock row stands on the live form, and the unlock sends once', async () => {
    const h = harness();
    h.world.locked = true;
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const pressed = await press('@bob');
    rebuild(h, 'a window opened beside it');
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(live).not.toBe(pressed);
    await answer(h, result('proven', REC, 'Bob'));
    const row = live.nextElementSibling as HTMLElement;
    expect(row.classList.contains('card-unlock')).toBe(true);
    expect(document.querySelectorAll('.card-unlock')).toHaveLength(1);
    expect(keyLine(live).textContent).toBe(REC);
    expect(h.world.signCalls).toEqual([]);
    await unlockWith(row, 'pw');
    expect(h.world.unlocks).toEqual(['pw']);
    expect(h.world.signCalls).toHaveLength(1);
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(keyLine(live).textContent).toBe(REC);
    // The row, submitted again, sends nothing more.
    await unlockWith(row, 'pw');
    expect(h.world.signCalls).toHaveLength(1);
  });

  it.each<Rebuild>(['the wallet raised', 'a window opened beside it'])('the owed row moves to a rebuilt form — %s — the same element, the passphrase typed in it standing', async (how) => {
    const h = harness();
    h.world.locked = true;
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const row = document.querySelector<HTMLElement>('.card-unlock')!;
    const pass = row.querySelector<HTMLInputElement>('input[type="password"]')!;
    pass.value = 'pw';
    rebuild(h, how);
    await flush();
    const live = document.querySelector<HTMLFormElement>('form.credits-form')!;
    expect(live.nextElementSibling).toBe(row);
    expect(pass.value).toBe('pw');
    // A render in place leaves it where it stands.
    await h.drive.refreshWalletCredits();
    await flush();
    expect(live.nextElementSibling).toBe(row);
    row.querySelector<HTMLFormElement>('form.pf')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(h.world.signCalls).toHaveLength(1);
  });

  it.each(['a node change', 'an identity change'] as const)('%s drops the owed send: its row leaves the screen, and unlocking through it sends nothing', async (how) => {
    const h = harness();
    h.world.locked = true;
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const row = document.querySelector<HTMLElement>('.card-unlock')!;
    if (how === 'a node change') await h.drive.changeNode(NODE_B);
    else changeIdentity(h, OTHER);
    await flush();
    expect(row.isConnected).toBe(false);
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(shownKeys()).toEqual([]);
    await unlockWith(row, 'pw');
    expect(h.world.signCalls).toEqual([]);
    expect(sendEntries(h)).toEqual([]);
  });

  it('`cancel` takes the owed row away and leaves the key standing; nothing is sent', async () => {
    const h = harness();
    h.world.locked = true;
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const row = document.querySelector<HTMLElement>('.card-unlock')!;
    const cancel = [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'cancel')!;
    cancel.click();
    await flush();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(keyLine(form).textContent).toBe(REC);
    await h.drive.refreshWalletCredits();
    await flush();
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(h.world.unlocks).toEqual([]);
    expect(h.world.signCalls).toEqual([]);
  });

  it('a wrong passphrase: the unlock refuses in its row, the owed send stands, and the right one sends', async () => {
    const h = harness();
    h.world.locked = true;
    h.world.sign = 'held';
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const row = document.querySelector<HTMLElement>('.card-unlock')!;
    await unlockWith(row, 'nope');
    const refused = row.querySelector<HTMLElement>('.pf-refusal')!;
    expect(refused.hidden).toBe(false);
    expect(refused.textContent).toBe('that passphrase does not open this key.');
    expect(row.isConnected).toBe(true);
    expect(h.world.signCalls).toEqual([]);
    await unlockWith(row, 'pw');
    expect(h.world.unlocks).toEqual(['nope', 'pw']);
    expect(h.world.signCalls).toHaveLength(1);
  });

  it('a press drops the owed send: its row leaves, and the new press answers — a key typed on a locked identity owing the unlock at once', async () => {
    const h = harness();
    h.world.locked = true;
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    const form = await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    const first = document.querySelector<HTMLElement>('.card-unlock')!;
    await press(EVE, '2');
    expect(first.isConnected).toBe(false);
    const second = form.nextElementSibling as HTMLElement;
    expect(second.classList.contains('card-unlock')).toBe(true);
    expect(second).not.toBe(first);
    expect(keyLine(form).textContent).toBe(EVE);
    expect(h.nameCalls.filter(isPress)).toHaveLength(1);
    await unlockWith(second, 'pw');
    expect(h.world.signCalls).toHaveLength(1);
    expect(sendEntries(h).map((e) => e.postId)).toEqual([EVE]);
  });

  it('after the unlock the next press owes none — it goes to the flow at once', async () => {
    const h = harness();
    h.world.locked = true;
    await ready(h);
    const a1 = anchorFor(100);
    await endRun(h, 0, verified(a1), a1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    await unlockWith(document.querySelector<HTMLElement>('.card-unlock')!, 'pw');
    expect(h.world.signCalls).toHaveLength(1);
    await press('@bob');
    await answer(h, result('proven', REC, 'Bob'));
    expect(document.querySelector('.card-unlock')).toBeNull();
    expect(h.world.signCalls).toHaveLength(2);
    expect(h.world.unlocks).toEqual(['pw']);
  });
});
