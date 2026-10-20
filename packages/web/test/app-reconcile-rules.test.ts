// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PAGE_LIMIT_DEFAULT } from '@dagsocial/types';
import { App } from '../src/app';
import { NodeClient } from '../src/api/client';
import { PendingLedger } from '../src/wallet/ledger';
import type { AppIdentity } from '../src/model/state';
import type { WriteClient } from '../src/api/write';
import type { PendingEntry } from '../src/wallet/types';
import { karmaResult } from './karma-fixture';
import { jsonResponse, honestPageSlice } from './honest-page';
import { setNode, prefs } from '../src/prefs';

// WEB_INTERFACE → The wallet → "Reconcile runs on the reader's own refresh
// and on the bounded poll below" — a pending send lands when the one page the
// payment box would open lists it; a pending invite lands when
// `GET /invites/<key>`, read whole, lists a bond naming the invitee; the
// profile's bonds view is still its own first page with `more`.

const ME = 'aa'.repeat(32);
const REC = 'cd'.repeat(32);
const INV = 'ee'.repeat(32);
const PAY_BOX = '7f'.repeat(32); // the box id computeCandidateBoxId would predict
const PAY_BOX_LESS_ONE = `${'7f'.repeat(31)}7e`; // the id less one
const AMOUNT = 100_000_000n;

function statusBody(blockHeight: number): Record<string, unknown> {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function karmaBody(): Record<string, unknown> {
  return { ...karmaResult({ userId: ME, boxes: [], boxCount: 0, next: null, height: 1_000 }) };
}

function creditsBody(key: string, boxes: Array<{ boxId: string; value: string }>, next: string | null): Record<string, unknown> {
  return { userId: key, total: '0', boxes, boxCount: boxes.length, next };
}

function bondsBody(bonds: Array<Record<string, unknown>>, next: string | null, bondCount: number): Record<string, unknown> {
  return { bonds, bondCount, next };
}

interface Req { url: URL; path: string }

/** A fake-fetch harness. Routes:
 *  - /credits/<key> → the `credits` handler of the harness
 *  - /invites/<key> → the `bonds` handler
 *  - /blocks/current → the current block height, settable
 *  - /status → statusBody(blockHeight)
 *  - /karma/<key> → an empty karma listing
 *  - /vouches, cooldowns → empty
 */
function fakeNode(opts: {
  blockHeight: () => number;
  credits?: (key: string, after: string | null, limit: number) => { body: Record<string, unknown>; status: number };
  bonds?: (after: string | null, limit: number) => { body: Record<string, unknown>; status: number };
}): { requests: Req[] } {
  const requests: Req[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    const u = new URL(String(input), 'http://node.test');
    requests.push({ url: u, path: u.pathname });
    const path = u.pathname;
    const after = u.searchParams.get('after');
    const limitStr = u.searchParams.get('limit');
    const limit = limitStr === null ? 50 : Number(limitStr);
    if (path.startsWith('/credits/')) {
      const key = decodeURIComponent(path.slice('/credits/'.length));
      if (opts.credits) {
        const r = opts.credits(key, after, limit);
        return jsonResponse(r.body, r.status);
      }
      return jsonResponse(creditsBody(key, [], null));
    }
    if (path.startsWith('/invites/')) {
      if (opts.bonds) {
        const r = opts.bonds(after, limit);
        return jsonResponse(r.body, r.status);
      }
      return jsonResponse(bondsBody([], null, 0));
    }
    if (path === '/blocks/current') return jsonResponse({ height: opts.blockHeight(), hash: null });
    if (path === '/status') return jsonResponse(statusBody(opts.blockHeight()));
    if (path.startsWith('/karma/')) return jsonResponse(karmaBody());
    if (path === '/vouches') {
      if (u.searchParams.has('cooldowns')) return jsonResponse({ cooldowns: [], count: 0, next: null });
      return jsonResponse({ vouches: [], count: 0, next: null });
    }
    if (path.startsWith('/usernames')) return jsonResponse({}, 404);
    throw new Error(`no route for ${u.href}`);
  }));
  return { requests };
}

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

interface Drive {
  pollTick(): Promise<void>;
  ledger: { all(): PendingEntry[]; size: number };
  sendFlight: { stage: string } | null;
  inviteFlight: { stage: string } | null;
  bondsView: { bonds: unknown[]; next: string | null } | null;
  loadMembershipState(): Promise<void>;
}

interface Harness {
  app: App;
  drive: Drive;
  ledger: PendingLedger;
  requests: Req[];
  height: { value: number };
}

function harness(entries: PendingEntry[], opts: Parameters<typeof fakeNode>[0]): Harness {
  const ledger = new PendingLedger(ME);
  for (const e of entries) ledger.add(e);
  const node = fakeNode(opts);
  const app = new App(new NodeClient(() => ''), {} as unknown as WriteClient, identity(), ledger, undefined, undefined, null, null);
  const appbar = document.createElement('header');
  const feed = document.createElement('section'); feed.id = 'feed';
  const panes = document.createElement('section'); panes.id = 'panes';
  const workspace = document.createElement('div'); workspace.className = 'workspace';
  workspace.append(feed, panes);
  document.body.append(appbar, workspace);
  app.mount(appbar, feed, panes);
  return {
    app, drive: app as unknown as Drive, ledger,
    requests: node.requests,
    height: { value: 1_000 },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SEND = (boxId: string): PendingEntry => ({
  txId: 'ab'.repeat(32), kind: 'send', postId: REC, inputs: ['11'.repeat(32)],
  expiresAtHeight: 5_000, submittedAtHeight: 1_000,
  send: { toHex: REC, toName: null, amount: AMOUNT, boxId },
});

const INVITE = (invitee: string): PendingEntry => ({
  txId: 'cd'.repeat(32), kind: 'invite', postId: invitee, inputs: ['22'.repeat(32)],
  expiresAtHeight: 5_000, submittedAtHeight: 1_000,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  localStorage.clear();
  document.body.innerHTML = '';
  setNode('');
  prefs.faucet = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a pending send lands through the one page the payment box would open', () => {
  it('a recipient past the credits bound lands in one credits request; the URL names after=<amount>:<id-1> and limit=1', async () => {
    const heightBox = { value: 1_000 };
    // The recipient's /credits answers only the one row the one-page read
    // asks for — a page strictly after `<amount>:<id-1>` of limit 1,
    // naming the payment box.
    const h = harness([SEND(PAY_BOX)], {
      blockHeight: () => heightBox.value,
      credits: (key, after, limit) => {
        if (key === REC && after === `${AMOUNT.toString()}:${PAY_BOX_LESS_ONE}` && limit === 1) {
          return { status: 200, body: creditsBody(REC, [{ boxId: PAY_BOX, value: AMOUNT.toString() }], null) };
        }
        // Any other credits read: empty page (so the whole-list read reads
        // nothing, well beyond the bound-breaking case).
        return { status: 200, body: creditsBody(key, [], null) };
      },
    });
    await flush();
    const recipientBefore = h.requests.filter((r) => r.path === `/credits/${REC}`).length;
    expect(recipientBefore).toBe(0); // control: no recipient read yet
    heightBox.value = 1_001; // the poll decides when the height moves
    await h.drive.pollTick();
    await flush();
    // Control: the ledger holds no send entry after the landing.
    expect(h.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    // Control: the row's flight reads 'landed'.
    expect(h.drive.sendFlight?.stage).toBe('landed');
    // The rule: exactly ONE /credits request for the recipient — the one
    // page named with after=<amount>:<id-1> and limit=1.
    const recipientReqs = h.requests.filter((r) => r.path === `/credits/${REC}`);
    expect(recipientReqs).toHaveLength(1);
    expect(recipientReqs[0]!.url.searchParams.get('after')).toBe(`${AMOUNT.toString()}:${PAY_BOX_LESS_ONE}`);
    expect(recipientReqs[0]!.url.searchParams.get('limit')).toBe('1');
  });

  it('a recipient holding both (amount, id-1) and (amount, id): the one page answers (amount, id), landed', async () => {
    const heightBox = { value: 1_000 };
    // A key ordered on `value DESC, id` places (AMOUNT, PAY_BOX_LESS_ONE)
    // before (AMOUNT, PAY_BOX); a page strictly after the first answers
    // the second as its one row.
    const list: Array<{ boxId: string; value: string }> = [
      { boxId: PAY_BOX_LESS_ONE, value: AMOUNT.toString() },
      { boxId: PAY_BOX, value: AMOUNT.toString() },
    ];
    const h = harness([SEND(PAY_BOX)], {
      blockHeight: () => heightBox.value,
      credits: (key, after, limit) => {
        if (key !== REC) return { status: 200, body: creditsBody(key, [], null) };
        const slice = honestPageSlice(
          list,
          (b) => `${b.value}:${b.boxId}`,
          `http://node.test/credits/${key}?${new URLSearchParams({
            ...(after !== null ? { after } : {}),
            limit: String(limit),
          }).toString()}`,
        );
        return { status: 200, body: creditsBody(key, slice.rows, slice.next) };
      },
    });
    await flush();
    const recipientBefore = h.requests.filter((r) => r.path === `/credits/${REC}`).length;
    expect(recipientBefore).toBe(0); // control
    heightBox.value = 1_001;
    await h.drive.pollTick();
    await flush();
    // The box at (AMOUNT, PAY_BOX_LESS_ONE) is NEVER the answer; the one
    // row of the page is PAY_BOX.
    expect(h.ledger.all().find((e) => e.kind === 'send')).toBeUndefined();
    expect(h.drive.sendFlight?.stage).toBe('landed');
  });
});

describe('a pending invite reads /invites whole, decides on the whole read, and the profile view stays its first page', () => {
  it("a pending invite whose bond is on the bonds' second page lands", async () => {
    const heightBox = { value: 1_000 };
    const firstPage = Array.from({ length: PAGE_LIMIT_DEFAULT }, (_, i) => ({
      id: `${((i + 1) >>> 0).toString(16).padStart(2, '0')}${'00'.repeat(31)}`,
      value: '100',
      inviterId: ME,
      inviteePublicKey: `${((i + 100) >>> 0).toString(16).padStart(2, '0')}${'ff'.repeat(31)}`,
      inviterName: null,
      inviteeName: null,
    }));
    const secondPage = [{
      id: `${'fe'.repeat(32)}`,
      value: '100',
      inviterId: ME,
      inviteePublicKey: INV, // the pending invite's invitee is here, on page 2
      inviterName: null,
      inviteeName: null,
    }];
    const h = harness([INVITE(INV)], {
      blockHeight: () => heightBox.value,
      bonds: (after, limit) => {
        // The reconcile reads whole with PAGE_LIMIT_MAX; the profile's view
        // asks PAGE_LIMIT_DEFAULT with no `after` — either way, a honest
        // keyset slice.
        const list = [...firstPage, ...secondPage];
        const slice = honestPageSlice(
          list,
          (b) => b.id,
          `http://node.test/invites/${ME}?${new URLSearchParams({
            ...(after !== null ? { after } : {}),
            limit: String(limit),
          }).toString()}`,
        );
        return { status: 200, body: bondsBody(slice.rows as unknown as Array<Record<string, unknown>>, slice.next, list.length) };
      },
    });
    await flush();
    const invitesBefore = h.requests.filter((r) => r.path === `/invites/${ME}`).length;
    expect(invitesBefore).toBe(0); // control
    heightBox.value = 1_001;
    await h.drive.pollTick();
    await flush();
    // The rule: the invite is landed — the bond on page 2 was read.
    expect(h.ledger.all().find((e) => e.kind === 'invite')).toBeUndefined();
    expect(h.drive.inviteFlight).toBeNull();
  });

  it("an invite's landing leaves the bonds view the profile's first page, with its `more`", async () => {
    const heightBox = { value: 1_000 };
    // The first page carries PAGE_LIMIT_DEFAULT bonds beside a `next`; the
    // reconcile reads whole, but the profile's view holds only the first
    // page and its `more` control (next != null).
    const firstPage = Array.from({ length: PAGE_LIMIT_DEFAULT }, (_, i) => ({
      id: `${((i + 1) >>> 0).toString(16).padStart(2, '0')}${'00'.repeat(31)}`,
      value: '100',
      inviterId: ME,
      inviteePublicKey: `${((i + 100) >>> 0).toString(16).padStart(2, '0')}${'ff'.repeat(31)}`,
      inviterName: null,
      inviteeName: null,
    }));
    const secondPage = [{
      id: `${'fe'.repeat(32)}`,
      value: '100',
      inviterId: ME,
      inviteePublicKey: INV,
      inviterName: null,
      inviteeName: null,
    }];
    const h = harness([INVITE(INV)], {
      blockHeight: () => heightBox.value,
      bonds: (after, limit) => {
        const list = [...firstPage, ...secondPage];
        const slice = honestPageSlice(
          list,
          (b) => b.id,
          `http://node.test/invites/${ME}?${new URLSearchParams({
            ...(after !== null ? { after } : {}),
            limit: String(limit),
          }).toString()}`,
        );
        return { status: 200, body: bondsBody(slice.rows as unknown as Array<Record<string, unknown>>, slice.next, list.length) };
      },
    });
    await h.drive.loadMembershipState(); // seeds bondsView with the first page
    await flush();
    expect(h.drive.bondsView?.bonds).toHaveLength(PAGE_LIMIT_DEFAULT); // control
    expect(h.drive.bondsView?.next).not.toBeNull(); // control: `more` would show
    heightBox.value = 1_001;
    await h.drive.pollTick();
    await flush();
    // The rule: the invite landed; the bonds view holds only the first page
    // and its `more` — the reconcile's whole-list read wrote nothing into it.
    expect(h.ledger.all().find((e) => e.kind === 'invite')).toBeUndefined();
    expect(h.drive.bondsView?.bonds).toHaveLength(PAGE_LIMIT_DEFAULT);
    expect(h.drive.bondsView?.next).not.toBeNull();
  });
});
