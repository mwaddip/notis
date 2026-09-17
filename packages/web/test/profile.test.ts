// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileBody, renderInvitesRow, renderUsernameRow, renderCreditsRow, resetCreditsSendForm, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { karmaResult } from './karma-fixture';
import { prefs } from '../src/prefs';
import { shortHex } from '../src/dom';
import type { Origin } from '../src/model/workspace';
import type { CreditsResult, StatusResult, UsernameResult } from '../src/api/dto';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

const ORIGIN: Origin = { from: 'pane', ci: 0 };

// The @profile window rendered from a fake handlers/ctx (WEB_INTERFACE → The
// profile window): the two states, the six operations' forms, standing per tier,
// the karma field's states and the faucet step's three-condition rule. The create
// form's username value is pinned with the draft split (4c), not here.

const KEY = 'ab'.repeat(32);
const unlocked = { pubKeyHex: KEY, locked: false };

function handlers(over: Partial<ProfileHandlers> = {}): ProfileHandlers {
  return {
    setTheme: () => {},
    setIdTint: () => {},
    setNode: () => {},
    setFaucet: () => {},
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
    resolveRecipient: async () => ({ refusal: 'no one holds that name.' }),
    send: () => {},
    askFaucetCredits: () => {},
    ...over,
  };
}

function ctx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return {
    arrangement: '', identity: null, backedUp: false, karma: null, grant: null, membershipBars: null,
    invite: null, canAffordMinBond: false, bonds: null, inviteFlight: null,
    ownName: null, ownNameLoaded: true, usernameFlight: null, pendingUsername: null, canSignClaim: false, canAffordBurn: false,
    status: null, credits: null, creditGrant: null, sendFlight: null, pendingSend: null,
    // The web arm's default — the confirm row stands. The extension arm's
    // tests override this to false and cover the flow the prompt confirms
    // (WEB_INTERFACE → The profile window → "The `$NOTIS` row").
    confirmInRow: true,
    ...over,
  };
}

const render = (h: ProfileHandlers, c: ProfileCtx): HTMLElement => profileBody(h, c, ORIGIN);

function rowField(body: HTMLElement, label: string): HTMLElement | null {
  for (const r of body.querySelectorAll('.row')) {
    if (r.querySelector('label')?.textContent === label) return r.querySelector('.field');
  }
  return null;
}

function button(root: HTMLElement, text: string): HTMLButtonElement | null {
  for (const b of root.querySelectorAll('button')) if (b.textContent === text) return b as HTMLButtonElement;
  return null;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const INVITEE = 'cd'.repeat(32);
const INVITE_PARAMS = { bondMin: '100', bondMax: '1000', probationBlocks: 43200 };
function memberCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return ctx({
    identity: unlocked,
    karma: karmaResult({ userId: KEY, member: true, invitesAvailable: 2, memberSinceBlock: 5 }),
    invite: INVITE_PARAMS,
    canAffordMinBond: true,
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
});

describe('profile window — the invites row', () => {
  it('the line per tier: member available, root "covers", resident "comes with membership"', () => {
    const member = rowField(render(handlers(), memberCtx()), 'invites')!;
    expect(member.textContent).toContain('2 invites available');
    const root = rowField(render(handlers(), memberCtx({ karma: karmaResult({ userId: KEY, member: true, invitesAvailable: null }) })), 'invites')!;
    expect(root.textContent).toContain('as many as your rep covers');
    const resident = rowField(render(handlers(), memberCtx({ karma: karmaResult({ userId: KEY, member: false, invitesAvailable: 0 }) })), 'invites')!;
    expect(resident.textContent).toContain('invites come with membership');
  });

  it('the form shows only with an invite available AND karma for the minimum; the default bond is the minimum', () => {
    // Available but cannot afford → no form.
    const poor = rowField(render(handlers(), memberCtx({ canAffordMinBond: false })), 'invites')!;
    expect(poor.querySelector('form.invite-form')).toBeNull();
    // Available and affordable → the form, bond defaulting to the minimum, min/max from /status.
    const form = rowField(render(handlers(), memberCtx()), 'invites')!.querySelector('form.invite-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    const bond = form.querySelector('input[type="number"]') as HTMLInputElement;
    expect(bond.value).toBe('100');
    expect(bond.min).toBe('100');
    expect(bond.max).toBe('1000');
    // The copy's numbers come from /status and types.
    expect(form.textContent).toContain('43200');
    expect(form.textContent).toContain('one rep per 3');
  });

  it('submitting a valid key and bond calls invite; an invalid key refuses with no invite', () => {
    const invited: Array<[string, bigint]> = [];
    const h = handlers({ invite: (k, b) => invited.push([k, b]) });
    const form = rowField(render(h, memberCtx()), 'invites')!.querySelector('form.invite-form') as HTMLFormElement;
    const key = form.querySelector('input[type="text"]') as HTMLInputElement;
    const bond = form.querySelector('input[type="number"]') as HTMLInputElement;
    // An invalid key → a refusal, no invite.
    key.value = 'nope';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect((form.querySelector('.pf-refusal') as HTMLElement | null)?.hidden).toBe(false);
    expect(invited).toHaveLength(0);
    // A valid key and the default bond → invite(key, 100n).
    key.value = INVITEE;
    bond.value = '150';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(invited).toEqual([[INVITEE, 150n]]);
  });

  it('after an in-row unlock, a second invite goes straight through with no new unlock row', async () => {
    // An in-row unlock fires no onChange, so the App does not re-render the
    // profile; the invite form holds its own effective ctx so the next press
    // sees the unlocked identity (WEB_INTERFACE → The wallet).
    const invited: Array<[string, bigint]> = [];
    const unlockedWith: string[] = [];
    const h = handlers({
      invite: (k, b) => invited.push([k, b]),
      unlockIdentity: async (p) => { unlockedWith.push(p); },
    });
    const field = rowField(render(h, memberCtx({ identity: { pubKeyHex: KEY, locked: true } })), 'invites')!;
    const form = field.querySelector('form.invite-form') as HTMLFormElement;
    const keyInput = form.querySelector('input[type="text"]') as HTMLInputElement;
    const bondInput = form.querySelector('input[type="number"]') as HTMLInputElement;

    // First press: locked → the unlock row mounts under the form, no invite.
    keyInput.value = INVITEE;
    bondInput.value = '150';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    const urow = field.querySelector('.card-unlock');
    expect(urow).not.toBeNull();
    expect(invited).toHaveLength(0);

    // The unlock's submit resolves; the invite fires.
    const unlock = urow!.querySelector('form.pf') as HTMLFormElement;
    (unlock.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    unlock.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(unlockedWith).toEqual(['pw']);
    expect(invited).toEqual([[INVITEE, 150n]]);

    // Second press: the effective ctx is unlocked, so the invite fires directly —
    // no second unlock is asked, and no new .card-unlock row appears.
    const OTHER = 'ef'.repeat(32);
    keyInput.value = OTHER;
    bondInput.value = '200';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(field.querySelectorAll('.card-unlock')).toHaveLength(1); // still the one from the first press
    expect(unlockedWith).toHaveLength(1); // no second unlock asked
    expect(invited).toEqual([[INVITEE, 150n], [OTHER, 200n]]);
  });

  it('the standing bonds show the invitee identity and value; the invitee prefix opens their window', () => {
    const opened: string[] = [];
    const h = handlers({ openAuthor: (k) => opened.push(k) });
    const c = memberCtx({
      bonds: { bonds: [{ id: 'b1', value: '100', inviterId: KEY, inviteePublicKey: INVITEE, inviterName: null, inviteeName: null }], bondCount: 1, next: 'cursor' },
    });
    const field = rowField(render(h, c), 'invites')!;
    const bondRow = field.querySelector('.bond')!;
    expect(bondRow.textContent).toContain('100 rep');
    expect(bondRow.querySelector('.vmark')).toBeNull();
    const btn = bondRow.querySelector('.authorbtn') as HTMLElement;
    expect(btn.classList.contains('hex')).toBe(true);
    btn.click();
    expect(opened).toEqual([INVITEE]);
    expect(button(field, 'more')).not.toBeNull();
  });

  it('the standing bond shows the handle @Name when inviteeName is set, the same control', () => {
    const opened: string[] = [];
    const h = handlers({ openAuthor: (k) => opened.push(k) });
    const c = memberCtx({
      bonds: { bonds: [{ id: 'b1', value: '100', inviterId: KEY, inviteePublicKey: INVITEE, inviterName: null, inviteeName: 'Bob' }], bondCount: 1, next: null },
    });
    const field = rowField(render(h, c), 'invites')!;
    const bondRow = field.querySelector('.bond')!;
    const btn = bondRow.querySelector('.authorbtn') as HTMLElement;
    expect(btn.textContent).toBe('@Bob');
    expect(btn.classList.contains('handle')).toBe(true);
    expect(btn.classList.contains('hex')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('open this author');
    btn.click();
    expect(opened).toEqual([INVITEE]);
  });

  it('the invite flight shows its stage line in the row', () => {
    const field = rowField(render(handlers(), memberCtx({ inviteFlight: { stage: 'rejected', reason: 'invite rejected: that key already holds an account' } })), 'invites')!;
    expect(field.querySelector('.stage')?.textContent).toContain('already holds an account');
  });

  it('renderInvitesRow updates the line and bonds in place, leaving the form the reader is filling', () => {
    const field = rowField(render(handlers(), memberCtx()), 'invites')!;
    const form = field.querySelector('form.invite-form') as HTMLFormElement;
    const key = form.querySelector('input[type="text"]') as HTMLInputElement;
    key.value = 'a-key-in-progress'; // the reader is filling it for the next invite
    // An invite lands: fewer available, a new bond — updated in place.
    const landed = memberCtx({
      karma: karmaResult({ userId: KEY, member: true, invitesAvailable: 1 }),
      bonds: { bonds: [{ id: 'b1', value: '100', inviterId: KEY, inviteePublicKey: INVITEE, inviterName: null, inviteeName: null }], bondCount: 1, next: null },
    });
    renderInvitesRow(field, handlers(), landed, ORIGIN);
    // The same form element, its value intact — an unsolicited landing moves no form.
    expect(field.querySelector('form.invite-form')).toBe(form);
    expect((field.querySelector('input[type="text"]') as HTMLInputElement).value).toBe('a-key-in-progress');
    // The line dropped by one and the bond appeared.
    expect(field.querySelector('.invites-line')?.textContent).toContain('1 invite available');
    expect(field.querySelector('.invites-bonds')?.textContent).toContain('100 rep');
  });
});

describe('profile window — the two states', () => {
  it('with no identity, offers create and import and shows no key or standing row', () => {
    const body = render(handlers(), ctx());
    expect(body.textContent).toContain('no identity in this browser');
    expect(button(body, 'create')).not.toBeNull();
    expect(button(body, 'import')).not.toBeNull();
    expect(rowField(body, 'key')).toBeNull();
    expect(rowField(body, 'standing')).toBeNull();
  });

  it('with an identity, the key row shows the whole key in mono', () => {
    const key = rowField(render(handlers(), ctx({ identity: unlocked })), 'key')!;
    expect(key.querySelector('.mono')!.textContent).toBe(KEY);
  });

  it('the passphrase row reads locked · unlock, or unlocked · lock', async () => {
    const lf = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: true } })), 'passphrase')!;
    expect(lf.textContent).toContain('locked');
    expect(button(lf, 'unlock')).not.toBeNull();

    const asked: number[] = [];
    const uf = rowField(render(handlers({ lockIdentity: async () => { asked.push(1); } }), ctx({ identity: unlocked })), 'passphrase')!;
    expect(uf.textContent).toContain('unlocked');
    button(uf, 'lock')!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toHaveLength(1);
  });

  it('the preference rows — theme, identity tint, node, faucet, arrangement — appear in both states', () => {
    for (const c of [ctx(), ctx({ identity: unlocked })]) {
      const body = render(handlers(), c);
      for (const label of ['theme', 'identity tint', 'node', 'faucet', 'arrangement']) {
        expect(rowField(body, label), label).not.toBeNull();
      }
    }
  });

  it('the sign-each-rep-action row is absent when policy/setPolicy are — the in-page module', () => {
    const body = render(handlers(), ctx());
    expect(rowField(body, 'sign each rep action')).toBeNull();
  });

  it('the sign-each-rep-action row renders only when both policy and setPolicy are present — the extension', () => {
    const p = vi.fn(() => 'silent' as const);
    const sp = vi.fn(async () => {});
    const body = render(handlers({ policy: p, setPolicy: sp }), ctx({ identity: unlocked }));
    const field = rowField(body, 'sign each rep action');
    expect(field).not.toBeNull();
    // The seg carries two aria-pressed buttons; silent is pressed.
    const buttons = [...(field?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["don't ask", 'ask']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
    // A press on 'ask' calls setPolicy('ask').
    buttons[1]!.click();
    expect(sp).toHaveBeenCalledWith('ask');
  });

  it('the sign-each-rep-action row shows the new pressed state on the next render', async () => {
    // policy() carries a mutable state; a re-render after setPolicy resolves
    // reads the new value — the App does this via renderRegionsFor('@profile').
    let policy: 'silent' | 'ask' = 'silent';
    const p = () => policy;
    const sp = async (v: 'silent' | 'ask'): Promise<void> => { policy = v; };
    const h = handlers({ policy: p, setPolicy: sp });
    const first = render(h, ctx({ identity: unlocked }));
    const firstButtons = [...rowField(first, 'sign each rep action')!.querySelectorAll('button')];
    firstButtons[1]!.click();
    await new Promise((r) => setTimeout(r, 0));
    // A subsequent render reads the fresh policy value.
    const next = render(h, ctx({ identity: unlocked }));
    const nextButtons = [...rowField(next, 'sign each rep action')!.querySelectorAll('button')];
    expect(nextButtons[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(nextButtons[1]!.getAttribute('aria-pressed')).toBe('true');
  });

  it('the faucet row without a requestFaucetOrigin handler calls setFaucet directly', async () => {
    const setFaucet = vi.fn();
    const body = render(handlers({ setFaucet }), ctx());
    const field = rowField(body, 'faucet');
    const input = field!.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(setFaucet).toHaveBeenCalledWith('https://faucet.example');
  });

  it('the faucet row with a requestFaucetOrigin handler requests permission first; a refusal reports and does not store', async () => {
    const setFaucet = vi.fn();
    const requestFaucetOrigin = vi.fn(async () => false);
    const body = render(handlers({ setFaucet, requestFaucetOrigin }), ctx());
    const field = rowField(body, 'faucet')!;
    const input = field.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(requestFaucetOrigin).toHaveBeenCalledWith('https://faucet.example');
    expect(setFaucet).not.toHaveBeenCalled();
    // The hint names the refusal.
    expect(field.querySelector('.hint')?.textContent).toBe('the browser refused access to that origin.');
  });

  it('the faucet row with a granted requestFaucetOrigin then stores', async () => {
    const setFaucet = vi.fn();
    const requestFaucetOrigin = vi.fn(async () => true);
    const body = render(handlers({ setFaucet, requestFaucetOrigin }), ctx());
    const field = rowField(body, 'faucet')!;
    const input = field.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(requestFaucetOrigin).toHaveBeenCalledWith('https://faucet.example');
    expect(setFaucet).toHaveBeenCalledWith('https://faucet.example');
  });
});

describe('profile window — the forms in place', () => {
  it('create drafts a key first and names it as the set form username; cancel discards', async () => {
    const drafted: number[] = [];
    const discarded: number[] = [];
    const body = render(
      handlers({
        draftIdentity: async () => {
          drafted.push(1);
          return { pubKeyHex: KEY };
        },
        discardDraft: () => discarded.push(1),
      }),
      ctx(),
    );
    button(body, 'create')!.click();
    // draftIdentity is async — let its microtask settle before the form draws.
    await new Promise((r) => setTimeout(r, 0));
    expect(drafted).toHaveLength(1); // the key exists before the passphrase
    const form = body.querySelector('form.pf') as HTMLElement;
    const pws = [...form.querySelectorAll('input')].filter((i) => (i as HTMLInputElement).type === 'password') as HTMLInputElement[];
    expect(pws).toHaveLength(2);
    expect(pws.every((i) => i.autocomplete === 'new-password')).toBe(true);
    const user = form.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(user.readOnly).toBe(true);
    expect(user.value).toBe(KEY); // the draft key, so the manager saves against the key it will later unlock
    // Cancelling the form discards the draft.
    button(form, 'cancel')!.click();
    expect(discarded).toHaveLength(1);
  });

  it('unlock reveals a one-field current-password form with the key as username', () => {
    const field = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: true } })), 'passphrase')!;
    button(field, 'unlock')!.click();
    const form = field.querySelector('form.pf')!;
    const pws = [...form.querySelectorAll('input')].filter((i) => (i as HTMLInputElement).type === 'password') as HTMLInputElement[];
    expect(pws).toHaveLength(1);
    expect(pws[0]!.autocomplete).toBe('current-password');
    const user = form.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(user.value).toBe(KEY);
    expect(user.readOnly).toBe(true);
  });

  it('unlocking in place turns the passphrase row to unlocked · lock', async () => {
    const field = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: true } })), 'passphrase')!;
    button(field, 'unlock')!.click();
    const form = field.querySelector('form.pf') as HTMLFormElement;
    (form.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(field.querySelector('form.pf')).toBeNull(); // the form is gone
    expect(field.textContent).toContain('unlocked');
    expect(button(field, 'lock')).not.toBeNull();
  });

  it('locking in place turns the row back to locked · unlock', async () => {
    const field = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: false } })), 'passphrase')!;
    button(field, 'lock')!.click();
    // lockIdentity is async — let its microtask settle before the row redraws.
    await new Promise((r) => setTimeout(r, 0));
    expect(field.textContent).toContain('locked');
    expect(button(field, 'unlock')).not.toBeNull();
  });

  it('export reveals the file set form under the username <key> · file when unlocked', () => {
    const field = rowField(render(handlers(), ctx({ identity: unlocked })), 'export')!;
    button(field, 'export')!.click();
    const user = field.querySelector('form.pf input[autocomplete="username"]') as HTMLInputElement;
    expect(user.value).toBe(`${KEY} · file`);
    const pws = [...field.querySelectorAll('input')].filter((i) => (i as HTMLInputElement).type === 'password');
    expect(pws).toHaveLength(2);
  });

  it('forget confirms in place, leading with the never-exported fact and focusing keep', () => {
    const field = rowField(render(handlers(), ctx({ identity: unlocked, backedUp: false })), 'forget')!;
    button(field, 'forget')!.click();
    expect(field.textContent).toContain('cannot be recovered');
    expect(button(field, 'keep')).not.toBeNull();
    expect(button(field, 'forget')).not.toBeNull();

    // Backed up → the shorter confirm, no never-exported clause.
    const backed = rowField(render(handlers(), ctx({ identity: unlocked, backedUp: true })), 'forget')!;
    button(backed, 'forget')!.click();
    expect(backed.textContent).not.toContain('cannot be recovered');
  });

  it('the backup line shows under key until the key is backed up', () => {
    expect(rowField(render(handlers(), ctx({ identity: unlocked, backedUp: false })), 'key')!.textContent).toContain('export it to keep it');
    expect(rowField(render(handlers(), ctx({ identity: unlocked, backedUp: true })), 'key')!.textContent).not.toContain('export it to keep it');
  });
});

describe('profile window — standing per tier', () => {
  it('root when invitesAvailable is null', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, invitesAvailable: null }) })), 'standing')!;
    expect(f.querySelector('.standing')!.textContent).toBe('root');
  });

  it('member with since-block and invites available', () => {
    const f = rowField(
      render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, member: true, memberSinceBlock: 5000, invitesAvailable: 3 }) })),
      'standing',
    )!;
    expect(f.querySelector('.standing')!.textContent).toBe('member');
    expect(f.textContent).toContain('since block');
    expect(f.textContent).toContain('5000');
    expect(f.textContent).toContain('3 invites available');
  });

  it('resident with vouch and like counts against the network bars', () => {
    const f = rowField(
      render(
        handlers(),
        ctx({
          identity: unlocked,
          karma: karmaResult({ boxCount: 1, member: false, memberVouches: 1, memberLikes: '2', invitesAvailable: 0 }),
          membershipBars: { memberBar: 2, memberLikesBar: 2 },
        }),
      ),
      'standing',
    )!;
    expect(f.querySelector('.standing')!.textContent).toBe('resident');
    expect(f.textContent).toContain('1 of 2');
    expect(f.textContent).toContain('vouches');
  });
});

describe('profile window — the karma field and the faucet step', () => {
  it('shows the balance when a box is held', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '227' }) })), 'rep')!;
    expect(f.textContent).toContain('227 rep');
  });

  it('shows effective and held when decay has opened a gap', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '200' }) })), 'rep')!;
    expect(f.textContent).toContain('200 effective');
    expect(f.textContent).toContain('227 held');
  });

  it('the faucet step shows only with an identity, no karma, and a faucet configured', () => {
    prefs.faucet = '/faucet';
    const withFaucet = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'rep')!;
    expect(button(withFaucet, 'ask the faucet for rep')).not.toBeNull();

    // Karma held → the balance, no faucet button.
    const held = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '5', effective: '5' }) })), 'rep')!;
    expect(button(held, 'ask the faucet for rep')).toBeNull();

    // No faucet configured → no button, "no rep yet."
    prefs.faucet = '';
    const noFaucet = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'rep')!;
    expect(button(noFaucet, 'ask the faucet for rep')).toBeNull();
    expect(noFaucet.textContent).toContain('no rep yet');
  });

  it('the faucet button asks the faucet', () => {
    prefs.faucet = '/faucet';
    const asked: number[] = [];
    const f = rowField(render(handlers({ askFaucet: () => asked.push(1) }), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'rep')!;
    button(f, 'ask the faucet for rep')!.click();
    expect(asked).toHaveLength(1);
  });

  it('a pending grant reads working…, an expired one names the height with ask again', () => {
    prefs.faucet = '/faucet';
    const pending = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }), grant: { state: 'pending' } })), 'rep')!;
    expect(pending.textContent).toContain('working…');

    const expired = rowField(
      render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }), grant: { state: 'expired', atHeight: 5999 } })),
      'rep',
    )!;
    expect(expired.textContent).toContain('5999');
    expect(button(expired, 'ask again')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The username row (WEB_INTERFACE → The username row)
// ---------------------------------------------------------------------------

const HELD: UsernameResult = { name: 'Alice_01', owner: KEY, boxId: 'dd'.repeat(32), claimedAtBlock: 100 };

describe('profile — the username row', () => {
  it('the row sits between invites and passphrase', () => {
    const b = render(handlers(), memberCtx());
    const labels = [...b.querySelectorAll('.row label')].map((l) => l.textContent);
    const inv = labels.indexOf('invites');
    const un = labels.indexOf('username');
    const pp = labels.indexOf('passphrase');
    expect(un).toBeGreaterThan(inv);
    expect(un).toBeLessThan(pp);
  });

  it('not read yet — muted dash', () => {
    const f = rowField(render(handlers(), memberCtx({ ownNameLoaded: false })), 'username')!;
    expect(f.textContent).toBe('—');
  });

  it('holding none, no karma box — the hint, no form', () => {
    const f = rowField(render(handlers(), memberCtx({ canSignClaim: false })), 'username')!;
    expect(f.textContent).toContain('a claim spends and returns one rep box');
    expect(f.querySelector('form')).toBeNull();
  });

  it('holding none, can sign — the claim form with field, claim, hint', () => {
    const f = rowField(render(handlers(), memberCtx({ canSignClaim: true })), 'username')!;
    const form = f.querySelector('form') as HTMLFormElement;
    expect(form).not.toBeNull();
    const input = form.querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('the name to claim');
    expect(input.maxLength).toBe(24);
    expect(button(form, 'claim')).not.toBeNull();
    expect(form.textContent).toContain('free, once per key');
    expect(form.textContent).toContain('10 rep');
  });

  it('the claim form validates through isValidUsernameBytes and drops a leading @', () => {
    const claimed: string[] = [];
    const h = handlers({ claimUsername: (n) => claimed.push(n) });
    const f = rowField(render(h, memberCtx({ canSignClaim: true })), 'username')!;
    const form = f.querySelector('form') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;

    input.value = '  @ValidName  ';
    form.dispatchEvent(new Event('submit'));
    expect(claimed).toEqual(['ValidName']);

    input.value = 'bad name!';
    form.dispatchEvent(new Event('submit'));
    const refusal = form.querySelector('.pf-refusal') as HTMLElement;
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toContain('1 to 24 letters, digits or _');
  });

  it('the claim form shows the unlock form when the identity is locked', () => {
    const locked = { pubKeyHex: KEY, locked: true };
    const f = rowField(render(handlers(), ctx({
      identity: locked, karma: karmaResult({ userId: KEY, member: true }), canSignClaim: true,
      ownNameLoaded: true,
    })), 'username')!;
    const form = f.querySelector('form') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    input.value = 'Test';
    form.dispatchEvent(new Event('submit'));
    expect(f.querySelector('.card-unlock')).not.toBeNull();
  });

  it('holding @Name — the handle, the burn word, the hint', () => {
    const f = rowField(render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: true })), 'username')!;
    expect(f.querySelector('.handle')?.textContent).toBe('@Alice_01');
    expect(button(f, 'burn')).not.toBeNull();
    expect(f.textContent).toContain('held since block');
    expect(f.textContent).toContain('100');
  });

  it('burn disabled when the price is not covered', () => {
    const f = rowField(render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: false })), 'username')!;
    const b = button(f, 'burn') as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.title).toContain('less');
  });

  it('burn asks in place with burn · keep, focus on keep', () => {
    const body = render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: true }));
    document.body.appendChild(body);
    const f = rowField(body, 'username')!;
    button(f, 'burn')!.click();
    const confirm = f.querySelector('.pf-confirm') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain('burn @Alice_01 for 10 rep');
    expect(button(confirm, 'keep')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('keep');
    document.body.removeChild(body);
  });

  it('keep and Esc restore the line', () => {
    const f = rowField(render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: true })), 'username')!;
    button(f, 'burn')!.click();
    expect(f.querySelector('.pf-confirm')).not.toBeNull();
    button(f, 'keep')!.click();
    expect(f.querySelector('.pf-confirm')).toBeNull();
    expect(f.querySelector('.handle')?.textContent).toBe('@Alice_01');
  });

  it('burn confirm shows unlock form when locked', () => {
    const locked = { pubKeyHex: KEY, locked: true };
    const f = rowField(render(handlers(), ctx({
      identity: locked, karma: karmaResult({ userId: KEY, member: true }), ownName: HELD, canAffordBurn: true,
      ownNameLoaded: true,
    })), 'username')!;
    button(f, 'burn')!.click();
    const confirm = f.querySelector('.pf-confirm') as HTMLElement;
    button(confirm, 'burn')!.click();
    expect(f.querySelector('form')).not.toBeNull();
  });

  it('a pending claim — the muted handle and submitted', () => {
    const f = rowField(render(handlers(), memberCtx({ pendingUsername: { kind: 'claim', name: 'Bob' } })), 'username')!;
    const muted = f.querySelector('.handle.inkmute') as HTMLElement;
    expect(muted?.textContent).toBe('@Bob');
    expect(f.textContent).toContain('submitted');
  });

  it('a pending burn — the muted handle and submitted', () => {
    const f = rowField(render(handlers(), memberCtx({
      ownName: HELD, pendingUsername: { kind: 'burn', name: 'Alice_01' },
    })), 'username')!;
    expect(f.querySelector('.handle.inkmute')).not.toBeNull();
    expect(f.textContent).toContain('submitted');
  });

  it('submitting — the muted handle and submitting…', () => {
    const f = rowField(render(handlers(), memberCtx({
      pendingUsername: { kind: 'claim', name: 'Test' },
      usernameFlight: { stage: 'submitting' },
    })), 'username')!;
    expect(f.textContent).toContain('submitting');
  });

  it('a rejected flight shows the reason in the flight slot', () => {
    const f = rowField(render(handlers(), memberCtx({
      canSignClaim: true, usernameFlight: { stage: 'rejected', reason: 'claim rejected: that name is taken.' },
    })), 'username')!;
    expect(f.textContent).toContain('that name is taken.');
    expect(f.querySelector('form')).not.toBeNull();
  });

  it('an expired flight shows try again', () => {
    const onTry = vi.fn();
    const f = rowField(render(handlers(), memberCtx({
      canSignClaim: true, usernameFlight: { stage: 'expired', expiresAtHeight: 9000, onTryAgain: onTry },
    })), 'username')!;
    expect(f.textContent).toContain('9,000');
    const tryBtn = button(f, 'try again');
    expect(tryBtn).not.toBeNull();
    tryBtn!.click();
    expect(onTry).toHaveBeenCalledTimes(1);
  });

  it('renderUsernameRow updates the row in place', () => {
    const h = handlers();
    const c = memberCtx({ canSignClaim: true });
    const b = render(h, c);
    const f = rowField(b, 'username')!;
    expect(f.querySelector('form')).not.toBeNull();
    const c2 = memberCtx({ ownName: HELD, canAffordBurn: true });
    renderUsernameRow(f, h, c2);
    expect(f.querySelector('.handle')?.textContent).toBe('@Alice_01');
    expect(f.querySelector('form')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The $NOTIS row — WEB_INTERFACE → The profile window.
// Every state is rendered from a ctx shape the App produces. A locked press
// mounts the unlock row in place; a landing renders *sent* in the flight slot;
// the form the reader is filling survives every in-place update.
// ---------------------------------------------------------------------------

const REC = 'cd'.repeat(32);
const REC_NAME = 'bob';

function statusAt(blockHeight: number): StatusResult {
  return {
    networkType: 'testnet', blockHeight, protocolVersion: 1, postCount: 0, pendingPosts: 0,
    totalKarma: '0', liquidKarma: '0', totalCredits: '0', inviteProbationBlocks: 0, vouchCooldownBlocks: 0,
    inviteBondMin: '0', inviteBondMax: '0', membership: { memberCount: 1, memberBar: 1, memberLikesBar: 2 },
  };
}

function creditsResult(over: Partial<CreditsResult> = {}): CreditsResult {
  return { userId: KEY, total: '0', boxes: [], boxCount: 0, next: null, ...over };
}

function creditsCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return ctx({ identity: unlocked, status: statusAt(1000), credits: creditsResult(), ...over });
}

describe('profile window — the $NOTIS row', () => {
  beforeEach(() => { prefs.faucet = ''; });

  it('credits null shows —', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked })), '$NOTIS')!;
    expect(f.querySelector('.credits-line')?.textContent).toBe('—');
    expect(f.querySelector('form.credits-form')).toBeNull();
    expect(f.querySelector('.credits-flight')?.textContent).toBe('');
  });

  it('a spendable sum shows the balance in gold + $NOTIS, no locked hint', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '1250000000' }], boxCount: 1 }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    const bal = f.querySelector('.mono.gold') as HTMLElement;
    expect(bal.textContent).toBe('12.5');
    expect(f.querySelector('.credits-line')?.textContent).toContain('12.5');
    expect(f.querySelector('.credits-line')?.textContent).toContain('$NOTIS');
    expect(f.querySelector('.credits-line .hint')).toBeNull();
    expect(f.querySelector('form.credits-form')).not.toBeNull();
  });

  it('a locked box past height stays out of the balance and the hint reads its value (READ-1 defect 1)', () => {
    // One unlocked at 100_000_000 (1 $NOTIS), one locked to block 2000, height 1000.
    const c = creditsCtx({
      credits: creditsResult({
        boxes: [
          { boxId: 'a'.repeat(32), value: '100000000' },
          { boxId: 'b'.repeat(32), value: '900000000', lockedUntilBlock: 2000 },
        ],
        boxCount: 2,
      }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).toBe('1');
    const hint = f.querySelector('.credits-line .hint');
    expect(hint?.textContent).toContain('9 $NOTIS more unlock by block ');
    expect(hint?.textContent).toContain('2000');
    // The total is NOT summed with the locked value — the hint stands beside it.
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).not.toBe('10');
  });

  it('a lockedUntilBlock === height is spendable, one past drops (READ-1 defect 1, the boundary)', () => {
    const c = creditsCtx({
      status: statusAt(1000),
      credits: creditsResult({
        boxes: [
          { boxId: 'a'.repeat(32), value: '100000000', lockedUntilBlock: 1000 }, // === height, kept
          { boxId: 'b'.repeat(32), value: '200000000', lockedUntilBlock: 1001 }, // one past, dropped
        ],
        boxCount: 2,
      }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    expect((f.querySelector('.mono.gold') as HTMLElement).textContent).toBe('1');
    expect(f.querySelector('.credits-line .hint')?.textContent).toContain('2 $NOTIS more');
  });

  it('only locked boxes → the zero branch with the locked hint beneath (READ-1 defect 1)', () => {
    prefs.faucet = ''; // no faucet → the zero branch reads "no $NOTIS yet."
    const c = creditsCtx({
      credits: creditsResult({
        boxes: [{ boxId: 'a'.repeat(32), value: '900000000', lockedUntilBlock: 2000 }],
        boxCount: 1,
      }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    const line = f.querySelector('.credits-line')!;
    expect(line.textContent).toContain('no $NOTIS yet.');
    expect(line.querySelector('.hint')?.textContent).toContain('9 $NOTIS more unlock by block');
    expect(f.querySelector('form.credits-form')).toBeNull();
  });

  it('faucet configured, no spendable → *ask the faucet for $NOTIS*', () => {
    prefs.faucet = '/faucet';
    const f = rowField(render(handlers(), creditsCtx()), '$NOTIS')!;
    expect(button(f, 'ask the faucet for $NOTIS')).not.toBeNull();
  });

  it('faucet configured, grant pending → working…', () => {
    prefs.faucet = '/faucet';
    const f = rowField(render(handlers(), creditsCtx({ creditGrant: { state: 'pending' } })), '$NOTIS')!;
    expect(f.querySelector('.credits-line')?.textContent).toContain('working…');
    expect(button(f, 'ask the faucet for $NOTIS')).toBeNull();
  });

  it('faucet configured, grant expired → the height and *ask again*', () => {
    prefs.faucet = '/faucet';
    const f = rowField(render(handlers(), creditsCtx({ creditGrant: { state: 'expired', atHeight: 5999 } })), '$NOTIS')!;
    expect(f.querySelector('.credits-line')?.textContent).toContain("no block took the faucet's transfer");
    expect(f.querySelector('.credits-line')?.textContent).toContain('5999');
    expect(button(f, 'ask again')).not.toBeNull();
  });

  it('no faucet configured, no credits → *no $NOTIS yet.*', () => {
    prefs.faucet = '';
    const f = rowField(render(handlers(), creditsCtx()), '$NOTIS')!;
    expect(f.querySelector('.credits-line')?.textContent).toContain('no $NOTIS yet.');
    expect(button(f, 'ask the faucet for $NOTIS')).toBeNull();
  });

  it('the send form validates: empty amount, non-numeric, zero, ninth decimal, own key', async () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    const refusal = form.querySelector<HTMLElement>('.pf-refusal')!;

    const submit = async (t: string, a: string): Promise<void> => {
      to.value = t; amount.value = a;
      form.dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
    };

    // Empty amount.
    await submit(REC, '');
    expect(refusal.hidden).toBe(false);
    expect(refusal.textContent).toContain('an amount is digits');
    // A non-numeric amount.
    await submit(REC, 'x');
    expect(refusal.textContent).toContain('an amount is digits');
    // Zero.
    await submit(REC, '0');
    expect(refusal.textContent).toContain('an amount is digits');
    // Ninth decimal.
    await submit(REC, '0.123456789');
    expect(refusal.textContent).toContain('an amount is digits');
    // Own key → *that is your own key.*
    await submit(KEY, '1');
    expect(refusal.textContent).toContain('your own key');
    // Not a key or a name.
    await submit('!!', '1');
    expect(refusal.textContent).toContain('not a key or a name');
  });

  it('the confirm row: two texts with the 16-glyph prefix (READ-1 nit)', async () => {
    // resolveRecipient answers a resolved handle for the "@bob" input; the confirm
    // shows the handle and the 16-glyph key prefix.
    const h = handlers({ resolveRecipient: async () => ({ key: REC, name: REC_NAME }) });
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(h, c), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;

    to.value = '@bob'; amount.value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    let confirm = f.querySelector('.pf-confirm') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain('send 12.5 $NOTIS to @bob · ');
    expect(confirm.querySelector('.mono')?.textContent).toBe(shortHex(REC, 16));

    // A bare key input → the second text: no handle, the prefix in mono.
    // Re-query the form — restoreForm builds a fresh element on keep.
    button(f, 'keep')!.click();
    const OTHER = 'ff'.repeat(32);
    const form2 = f.querySelector('form.credits-form') as HTMLFormElement;
    const to2 = form2.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount2 = form2.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to2.value = OTHER; amount2.value = '1';
    form2.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    confirm = f.querySelector('.pf-confirm') as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(confirm.textContent).toContain('send 1 $NOTIS to ');
    expect(confirm.textContent).not.toContain('@');
    expect(confirm.querySelector('.mono')?.textContent).toBe(shortHex(OTHER, 16));
  });

  it('keep restores the form with its values', async () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '3.14';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // The confirm row is up.
    expect(f.querySelector('.pf-confirm')).not.toBeNull();
    button(f, 'keep')!.click();
    // The form is back with its values.
    const back = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs = back.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[0]!.value).toBe(REC);
    expect(inputs[1]!.value).toBe('3.14');
  });

  it('a locked press on send mounts the unlock row and calls no handler', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const h = handlers({ send: (k, n, a) => sent.push([k, n, a]) });
    const c = creditsCtx({
      identity: { pubKeyHex: KEY, locked: true },
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(h, c), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // Confirm shown → press send → the wrap becomes the unlock form.
    const confirm = f.querySelector('.pf-confirm') as HTMLElement;
    const sendBtn = [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
    sendBtn.click();
    // The unlock form is now in the confirm's wrap; the send handler was not called.
    expect(f.querySelector('form.pf')?.querySelector<HTMLInputElement>('input[type="password"]')).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('after an in-row unlock, a second send goes straight through with no unlock form mounted', async () => {
    // An in-row unlock fires no onChange, so the App does not re-render the
    // profile; sendConfirm holds its own effective ctx so the rebuilt form and
    // the next press see the unlocked identity (WEB_INTERFACE → The wallet).
    const sent: Array<[string, string | null, bigint]> = [];
    const unlockedWith: string[] = [];
    const h = handlers({
      send: (k, n, a) => sent.push([k, n, a]),
      unlockIdentity: async (p) => { unlockedWith.push(p); },
    });
    const c = creditsCtx({
      identity: { pubKeyHex: KEY, locked: true },
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(h, c), '$NOTIS')!;

    // First press: submit → confirm → send → unlock form mounts, no send yet.
    const form1 = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs1 = form1.querySelectorAll<HTMLInputElement>('input');
    inputs1[0]!.value = REC; inputs1[1]!.value = '1';
    form1.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const confirm1 = f.querySelector('.pf-confirm') as HTMLElement;
    ([...confirm1.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement).click();
    // The confirm wrap now holds the unlock form (a password input identifies it).
    const unlock = f.querySelector('.pf-confirm form') as HTMLFormElement;
    expect(unlock.querySelector('input[type="password"]')).not.toBeNull();
    expect(sent).toHaveLength(0);

    // The unlock's submit resolves: send fires, the unlock form is gone, and
    // the slot holds a fresh sendForm built with an unlocked effective ctx.
    (unlock.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    unlock.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(unlockedWith).toEqual(['pw']);
    expect(sent).toHaveLength(1);
    expect(f.querySelector('input[type="password"]')).toBeNull();
    expect(f.querySelector('form.credits-form')).not.toBeNull();

    // Second press: fill the rebuilt form, submit, press send. The rebuilt
    // form's ctx is unlocked, so send fires straight — no unlock form mounts.
    const form2 = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs2 = form2.querySelectorAll<HTMLInputElement>('input');
    inputs2[0]!.value = REC; inputs2[1]!.value = '2';
    form2.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const confirm2 = f.querySelector('.pf-confirm') as HTMLElement;
    ([...confirm2.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement).click();
    expect(f.querySelector('input[type="password"]')).toBeNull();
    expect(sent).toHaveLength(2);
    expect(unlockedWith).toHaveLength(1); // no second unlock asked
  });

  it('the pending line reads *<amount> $NOTIS to @bob · submitted* (READ-1 defect 2)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      pendingSend: { toHex: REC, toName: 'bob', amount: 1_250_000_000n },
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe('12.5 $NOTIS to @bob · submitted');
  });

  it('the pending line falls back to the 16-glyph prefix when toName is null (READ-1 defect 2)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      pendingSend: { toHex: REC, toName: null, amount: 1_250_000_000n },
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe(`12.5 $NOTIS to ${shortHex(REC, 16)} · submitted`);
  });

  it('a landed flight reads *sent* (READ-1 defect 4)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'landed' },
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    expect(f.querySelector('.credits-flight')?.textContent).toBe('sent');
  });

  it('a rejected flight reads the reason; a notSent flight reads *not sent.*; an expired one reads the height', () => {
    const rejected = rowField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send rejected: not enough $NOTIS.' },
    })), '$NOTIS')!;
    expect(rejected.querySelector('.credits-flight')?.textContent).toContain('not enough $NOTIS.');

    const notSent = rowField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    })), '$NOTIS')!;
    expect(notSent.querySelector('.credits-flight')?.textContent).toContain('send not sent.');

    const expired = rowField(render(handlers(), creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'expired', expiresAtHeight: 9000 },
    })), '$NOTIS')!;
    expect(expired.querySelector('.credits-flight')?.textContent).toContain('9,000');
  });

  it('renderCreditsRow leaves the form the reader is filling in place (READ-1 defect 3)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const body = render(handlers(), c);
    const f = rowField(body, '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '3.14';

    // A pending send lands on this row via renderCreditsRow — the form must stay
    // with its values (WEB_INTERFACE → The wallet).
    const c2 = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
      sendFlight: { stage: 'rejected', reason: 'send not sent.' },
    });
    renderCreditsRow(f, handlers(), c2);
    // Same form element, same values.
    expect(f.querySelector('form.credits-form')).toBe(form);
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    expect(inputs[0]!.value).toBe(REC);
    expect(inputs[1]!.value).toBe('3.14');
    // The flight slot shows the ending.
    expect(f.querySelector('.credits-flight')?.textContent).toContain('send not sent.');
  });

  it('resetCreditsSendForm clears the form after an accepted submission (READ-1 defect 3)', () => {
    const c = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    const f = rowField(render(handlers(), c), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = REC; inputs[1]!.value = '3.14';
    resetCreditsSendForm(f);
    expect(inputs[0]!.value).toBe('');
    expect(inputs[1]!.value).toBe('');
  });

  it('renderCreditsRow builds a form when the spendable side turns from zero to non-zero', () => {
    // Empty at first — no form.
    const empty = creditsCtx();
    const body = render(handlers(), empty);
    const f = rowField(body, '$NOTIS')!;
    expect(f.querySelector('form.credits-form')).toBeNull();
    // A grant lands: credits now hold a box; the update owes a fresh form.
    const withCredits = creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });
    renderCreditsRow(f, handlers(), withCredits);
    expect(f.querySelector('form.credits-form')).not.toBeNull();
  });

  // The layout — the recipient on its own line, the amount and the boxed `send`
  // on one line inside .amount-row. The box is the primary action's, the same
  // classes the composer's `post` and the feed's `new post` wear (WEB_INTERFACE
  // → The profile window → "The `$NOTIS` row"; HOUSE_STYLE → Interaction → "A
  // box marks a commit pair and a surface's primary action").
  describe('the send form — the recipient above, the amount and the boxed send on one line', () => {
    const spendableCtx = (): ProfileCtx => creditsCtx({
      credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    });

    it('the amount input and the send button share .amount-row; the recipient sits above it', () => {
      const f = rowField(render(handlers(), spendableCtx()), '$NOTIS')!;
      const form = f.querySelector('form.credits-form') as HTMLFormElement;
      const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
      const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
      const send = [...form.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
      const row = form.querySelector('.amount-row') as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.contains(amount)).toBe(true);
      expect(row.contains(send)).toBe(true);
      // The recipient sits above the row — it is not itself a child of it.
      expect(row.contains(to)).toBe(false);
    });

    it('the send button carries btn btn-primary and type=submit — the primary action\'s box', () => {
      const f = rowField(render(handlers(), spendableCtx()), '$NOTIS')!;
      const form = f.querySelector('form.credits-form') as HTMLFormElement;
      const send = [...form.querySelectorAll('button')].find((b) => b.textContent === 'send') as HTMLButtonElement;
      expect(send.type).toBe('submit');
      expect(send.classList.contains('btn')).toBe(true);
      expect(send.classList.contains('btn-primary')).toBe(true);
    });

    it('under the app stylesheet the row computes display: flex', () => {
      const style = document.createElement('style');
      style.textContent = appCss;
      document.head.appendChild(style);
      const body = render(handlers(), spendableCtx());
      document.body.appendChild(body);
      const f = rowField(body, '$NOTIS')!;
      const row = f.querySelector('form.credits-form .amount-row') as HTMLElement;
      const s = window.getComputedStyle(row);
      expect(s.display).toBe('flex');
      document.body.removeChild(body);
      document.head.removeChild(style);
    });
  });
});

// ---------------------------------------------------------------------------
// The extension arm — WEB_INTERFACE → The profile window → "The `$NOTIS` row".
// `confirmInRow: false` — the confirm row does not build; the resolved key
// renders beneath the recipient field in mono, whole, and `send` fires at
// once. A locked press mounts the unlock form under the form (the invites
// row's `.card-unlock` pattern) and proceeds on unlock.
// ---------------------------------------------------------------------------

function extCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return creditsCtx({
    credits: creditsResult({ boxes: [{ boxId: 'a'.repeat(32), value: '10000000000' }], boxCount: 1 }),
    confirmInRow: false,
    ...over,
  });
}

describe('profile — the $NOTIS row, extension arm (confirmInRow: false)', () => {
  it('a resolved handle: no .pf-confirm; the whole key beneath the recipient in mono; send called once', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const h = handlers({
      send: (k, n, a) => sent.push([k, n, a]),
      resolveRecipient: async () => ({ key: REC, name: REC_NAME }),
    });
    const f = rowField(render(h, extCtx()), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = '@bob'; amount.value = '12.5';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // No confirm row is ever built on the extension arm.
    expect(f.querySelector('.pf-confirm')).toBeNull();
    // The resolved key renders beneath the recipient, mono, whole (never a prefix).
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    expect(key.hidden).toBe(false);
    expect(key.textContent).toBe(REC);
    expect(key.classList.contains('mono')).toBe(true);
    // send was called once with the resolved key.
    expect(sent).toEqual([[REC, REC_NAME, 1_250_000_000n]]);
  });

  it('a bare key: no .pf-confirm; the same key beneath the field; send called with name null', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const h = handlers({ send: (k, n, a) => sent.push([k, n, a]) });
    const OTHER = 'ff'.repeat(32);
    const f = rowField(render(h, extCtx()), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = OTHER; amount.value = '3.14';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(f.querySelector('.pf-confirm')).toBeNull();
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    expect(key.hidden).toBe(false);
    expect(key.textContent).toBe(OTHER);
    expect(sent).toEqual([[OTHER, null, 314_000_000n]]);
  });

  it('a locked press mounts the unlock form UNDER the form; unlock proceeds; no confirm row is built', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const unlockedWith: string[] = [];
    const h = handlers({
      send: (k, n, a) => sent.push([k, n, a]),
      unlockIdentity: async (p) => { unlockedWith.push(p); },
    });
    const f = rowField(render(h, extCtx({ identity: { pubKeyHex: KEY, locked: true } })), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    to.value = REC; amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    // No confirm row is ever built.
    expect(f.querySelector('.pf-confirm')).toBeNull();
    // The unlock form is UNDER the form, the invites row's .card-unlock pattern.
    const urow = form.parentElement?.querySelector('.card-unlock');
    expect(urow).not.toBeNull();
    // No send yet — the unlock is pending.
    expect(sent).toHaveLength(0);
    // The unlock's submit resolves; the send fires.
    const unlock = urow!.querySelector('form.pf') as HTMLFormElement;
    (unlock.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    unlock.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(unlockedWith).toEqual(['pw']);
    expect(sent).toEqual([[REC, null, 100_000_000n]]);
    // The card-unlock is gone.
    expect(form.parentElement?.querySelector('.card-unlock')).toBeNull();
  });

  it('a second submit after an in-row unlock goes straight through with no new unlock row', async () => {
    const sent: Array<[string, string | null, bigint]> = [];
    const unlockedWith: string[] = [];
    const h = handlers({
      send: (k, n, a) => sent.push([k, n, a]),
      unlockIdentity: async (p) => { unlockedWith.push(p); },
    });
    const f = rowField(render(h, extCtx({ identity: { pubKeyHex: KEY, locked: true } })), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const to = form.querySelector<HTMLInputElement>('input[aria-label*="recipient"]')!;
    const amount = form.querySelector<HTMLInputElement>('input[aria-label*="amount"]')!;
    // First press: locked → the unlock row mounts under the form.
    to.value = REC; amount.value = '1';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const urow = form.parentElement?.querySelector('.card-unlock');
    (urow!.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
    (urow!.querySelector('form.pf') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(sent).toEqual([[REC, null, 100_000_000n]]);
    // Second press: no new unlock row is mounted; send fires straight.
    const OTHER = 'ff'.repeat(32);
    to.value = OTHER; amount.value = '2';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(form.parentElement?.querySelector('.card-unlock')).toBeNull();
    expect(unlockedWith).toEqual(['pw']); // no second unlock asked
    expect(sent).toEqual([[REC, null, 100_000_000n], [OTHER, null, 200_000_000n]]);
  });

  it('resetCreditsSendForm clears the resolved-key hint alongside the inputs', () => {
    // Fill the form and reveal the resolved-key line, then reset.
    const f = rowField(render(handlers(), extCtx()), '$NOTIS')!;
    const form = f.querySelector('form.credits-form') as HTMLFormElement;
    const key = form.querySelector<HTMLElement>('.resolved-key')!;
    key.textContent = REC;
    key.hidden = false;
    const inputs = form.querySelectorAll<HTMLInputElement>('input');
    inputs[0]!.value = REC; inputs[1]!.value = '1';
    resetCreditsSendForm(f);
    expect(inputs[0]!.value).toBe('');
    expect(inputs[1]!.value).toBe('');
    expect(key.textContent).toBe('');
    expect(key.hidden).toBe(true);
  });
});
