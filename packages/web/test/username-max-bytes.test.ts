// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// USERNAME_MAX_BYTES mocked to 30, keeping every other export of
// @dagsocial/types with `importOriginal` (WEB_INTERFACE → The username row).
// `isValidUsernameBytes` imports the constant from `./constants.js` inside
// the types package, so it keeps the 24-byte rule compiled in.
vi.mock('@dagsocial/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/types')>();
  return { ...actual, USERNAME_MAX_BYTES: 30 };
});

import { profileBody, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { App } from '../src/app';
import { karmaResult } from './karma-fixture';
import type { Api } from '../src/api/client';
import type { WriteClient, ClaimSubmitResult } from '../src/api/write';
import type { AppIdentity } from '../src/model/state';
import type {
  FeedResult, StatusResult, BlockCurrent,
  VouchesTargetResult, VouchesVoucherResult, VouchCooldownsResult,
} from '../src/api/dto';
import type { Origin } from '../src/model/workspace';

const KEY = 'ab'.repeat(32);
const KBOX = '11'.repeat(32);
const ORIGIN: Origin = { from: 'pane', ci: 0 };
const unlocked = { pubKeyHex: KEY, locked: false };

function handlers(over: Partial<ProfileHandlers> = {}): ProfileHandlers {
  return {
    inspectFile: async () => ({ kind: 'clear', pubKeyHex: KEY }),
    draftIdentity: async () => ({ pubKeyHex: KEY }),
    createIdentity: async () => {},
    discardDraft: () => {},
    importIdentity: async () => {},
    exportIdentity: async () => {},
    forgetIdentity: async () => {},
    lockIdentity: async () => {},
    unlockIdentity: async () => {},
    askFaucet: () => {},
    invite: () => {},
    openAuthor: () => {},
    vouch: () => {},
    moreBonds: () => {},
    claimUsername: () => {},
    burnUsername: () => {},
    ...over,
  };
}

function ctx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return {
    identity: null, backedUp: false, karma: null, grant: null,
    invite: null, canAffordMinBond: false, bonds: null, inviteFlight: null,
    ownName: null, ownNameLoaded: true, usernameFlight: null, pendingUsername: null, canSignClaim: false, canAffordBurn: false,
    nameClay: () => false,
    verdict: undefined, figures: null,
    ...over,
  };
}

function memberCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return ctx({
    identity: unlocked,
    karma: karmaResult({ userId: KEY, member: true }),
    ownNameLoaded: true,
    canSignClaim: true,
    ...over,
  });
}

const render = (h: ProfileHandlers, c: ProfileCtx): HTMLElement => profileBody(h, () => c, () => ORIGIN).el;

function rowField(body: HTMLElement, label: string): HTMLElement | null {
  for (const r of body.querySelectorAll('.row')) {
    if (r.querySelector('label')?.textContent === label) return r.querySelector('.field');
  }
  return null;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- App-side setup for the claim flight -------------------------------------

const ME = 'aa'.repeat(32);
let idState: { pubKeyHex: string; locked: boolean } | null;
let claimResp: (() => ClaimSubmitResult) | null;

function statusResult(): StatusResult {
  return {
    networkType: 'testnet', blockHeight: 100, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 43200,
    vouchCooldownBlocks: 60, inviteBondMin: '100', inviteBondMax: '1000',
    membership: { memberCount: 2, memberBar: 3, memberLikesBar: 6 },
  };
}

function fakeApi(): Api {
  return {
    feed: async () => ({ posts: [], next: null, pending: [], pendingCount: 0 } as FeedResult),
    thread: async () => null,
    post: async () => null,
    status: async () => statusResult(),
    currentBlock: async (): Promise<BlockCurrent> => ({ height: 100, hash: null }),
    karma: async () => karmaResult({ userId: ME, member: true, invitesAvailable: 2, memberSinceBlock: 5, boxCount: 1, total: '250', effective: '250', boxes: [{ boxId: KBOX, value: '250' }], height: 100 }),
    vouchesByTarget: async (): Promise<VouchesTargetResult> => ({ vouches: [], count: 0, next: null }),
    vouchesByVoucher: async (): Promise<VouchesVoucherResult> => ({ vouches: [], count: 0, next: null }),
    vouchCooldowns: async (): Promise<VouchCooldownsResult> => ({ cooldowns: [], count: 0, next: null }),
    bonds: async () => ({ bonds: [], bondCount: 0, next: null }),
    usernameByOwner: async () => null,
    credits: async () => ({ userId: '', total: '0', boxes: [], boxCount: 0, next: null }),
    usernameByName: async () => null,
  };
}

function fakeWrite(): WriteClient {
  return {
    submitClaim: async () => claimResp ? claimResp() : ({ status: 'pending', txId: 'ff'.repeat(32), expiresAtHeight: 820, name: 'Test' }),
    submitBurn: async () => ({ status: 'pending', txId: 'ff'.repeat(32), expiresAtHeight: 820 }),
  } as unknown as WriteClient;
}

function fakeIdentity(): AppIdentity {
  return {
    current: () => idState,
    sign: async () => ({ signature: 'ab'.repeat(64) }),
    onChange: () => {},
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
  } as unknown as AppIdentity;
}

function appHarness() {
  idState = { pubKeyHex: ME, locked: false };
  claimResp = null;
  const app = new App(fakeApi(), fakeWrite(), fakeIdentity());
  const appbar = document.createElement('div');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  document.body.append(appbar, feed, panes);
  app.mount(appbar, feed, panes);
  return app as unknown as {
    loadFeed(): Promise<void>;
    loadMembershipState(): Promise<void>;
    claimUsername(name: string): Promise<void>;
    usernameFlight: { stage: string; reason?: string | null } | null;
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

// -----------------------------------------------------------------------------
// Every username site reads USERNAME_MAX_BYTES — the profile window's claim
// form field, its hint, the client-side refusal, and the App's claim flight's
// sentence on the node's *name invalid* — so a change of the constant moves
// every site at once (WEB_INTERFACE → The username row).
// -----------------------------------------------------------------------------
describe('every username site reads USERNAME_MAX_BYTES', () => {
  it('with USERNAME_MAX_BYTES at 30: the field, the hint, the refusal and the App\'s rejection sentence all name 30', async () => {
    // The profile window's claim form field, built as test/profile.test.ts
    // builds it.
    const field = rowField(render(handlers(), memberCtx()), 'username')!;
    const form = field.querySelector('form') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    expect(input.maxLength).toBe(30);
    expect(form.textContent).toContain('1 to 30 letters, digits or _');
    // The client-side refusal, drawn by a submit of a punctuated name —
    // `isValidUsernameBytes` keeps its own rule, and punctuation fails
    // for either bound.
    input.value = 'bad name!';
    form.dispatchEvent(new Event('submit'));
    const refusal = form.querySelector('.pf-refusal') as HTMLElement;
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toContain('1 to 30 letters, digits or _');
    // The App's claim flight on a node's *name invalid*: the sentence reads
    // *1 to 30 letters, digits or _*.
    const h = appHarness();
    claimResp = () => ({ status: 400, message: 'name invalid' } as unknown as ClaimSubmitResult);
    await h.loadFeed();
    await h.loadMembershipState();
    await h.claimUsername('Example');
    await flush();
    expect(h.usernameFlight?.stage).toBe('rejected');
    expect(h.usernameFlight?.reason).toContain('1 to 30 letters, digits or _');
  });
});
