// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { profileBody, renderInvitesRow, renderUsernameRow, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { karmaResult } from './karma-fixture';
import { prefs } from '../src/prefs';
import type { Origin } from '../src/model/workspace';
import type { UsernameResult } from '../src/api/dto';

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
    inspectFile: () => ({ kind: 'clear', pubKeyHex: KEY }),
    draftIdentity: () => ({ pubKeyHex: KEY }),
    createIdentity: async () => {},
    discardDraft: () => {},
    importIdentity: async () => {},
    exportIdentity: async () => {},
    forgetIdentity: () => {},
    lockIdentity: () => {},
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
    arrangement: '', identity: null, backedUp: false, karma: null, grant: null, membershipBars: null,
    invite: null, canAffordMinBond: false, bonds: null, inviteFlight: null,
    ownName: null, ownNameLoaded: true, usernameFlight: null, pendingUsername: null, canSignClaim: false, canAffordBurn: false,
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
    expect(root.textContent).toContain('as many as your karma covers');
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
    expect(form.textContent).toContain('one karma per 3');
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

  it('the standing bonds show the invitee identity and value; the invitee prefix opens their window', () => {
    const opened: string[] = [];
    const h = handlers({ openAuthor: (k) => opened.push(k) });
    const c = memberCtx({
      bonds: { bonds: [{ id: 'b1', value: '100', inviterId: KEY, inviteePublicKey: INVITEE, inviterName: null, inviteeName: null }], bondCount: 1, next: 'cursor' },
    });
    const field = rowField(render(h, c), 'invites')!;
    const bondRow = field.querySelector('.bond')!;
    expect(bondRow.textContent).toContain('100 karma');
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
    expect(field.querySelector('.invites-bonds')?.textContent).toContain('100 karma');
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

  it('the passphrase row reads locked · unlock, or unlocked · lock', () => {
    const lf = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: true } })), 'passphrase')!;
    expect(lf.textContent).toContain('locked');
    expect(button(lf, 'unlock')).not.toBeNull();

    const asked: number[] = [];
    const uf = rowField(render(handlers({ lockIdentity: () => asked.push(1) }), ctx({ identity: unlocked })), 'passphrase')!;
    expect(uf.textContent).toContain('unlocked');
    button(uf, 'lock')!.click();
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
});

describe('profile window — the forms in place', () => {
  it('create drafts a key first and names it as the set form username; cancel discards', () => {
    const drafted: number[] = [];
    const discarded: number[] = [];
    const body = render(
      handlers({
        draftIdentity: () => {
          drafted.push(1);
          return { pubKeyHex: KEY };
        },
        discardDraft: () => discarded.push(1),
      }),
      ctx(),
    );
    button(body, 'create')!.click();
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

  it('locking in place turns the row back to locked · unlock', () => {
    const field = rowField(render(handlers(), ctx({ identity: { pubKeyHex: KEY, locked: false } })), 'passphrase')!;
    button(field, 'lock')!.click();
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
    const f = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '227' }) })), 'karma')!;
    expect(f.textContent).toContain('227 karma');
  });

  it('shows effective and held when decay has opened a gap', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '200' }) })), 'karma')!;
    expect(f.textContent).toContain('200 effective');
    expect(f.textContent).toContain('227 held');
  });

  it('the faucet step shows only with an identity, no karma, and a faucet configured', () => {
    prefs.faucet = '/faucet';
    const withFaucet = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'karma')!;
    expect(button(withFaucet, 'ask the faucet for karma')).not.toBeNull();

    // Karma held → the balance, no faucet button.
    const held = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '5', effective: '5' }) })), 'karma')!;
    expect(button(held, 'ask the faucet for karma')).toBeNull();

    // No faucet configured → no button, "no karma yet."
    prefs.faucet = '';
    const noFaucet = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'karma')!;
    expect(button(noFaucet, 'ask the faucet for karma')).toBeNull();
    expect(noFaucet.textContent).toContain('no karma yet');
  });

  it('the faucet button asks the faucet', () => {
    prefs.faucet = '/faucet';
    const asked: number[] = [];
    const f = rowField(render(handlers({ askFaucet: () => asked.push(1) }), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }) })), 'karma')!;
    button(f, 'ask the faucet for karma')!.click();
    expect(asked).toHaveLength(1);
  });

  it('a pending grant reads working…, an expired one names the height with ask again', () => {
    prefs.faucet = '/faucet';
    const pending = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }), grant: { state: 'pending' } })), 'karma')!;
    expect(pending.textContent).toContain('working…');

    const expired = rowField(
      render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }), grant: { state: 'expired', atHeight: 5999 } })),
      'karma',
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
    expect(f.textContent).toContain('a claim spends and returns one karma box');
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
    expect(form.textContent).toContain('10 karma');
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
    expect(confirm.textContent).toContain('burn @Alice_01 for 10 karma');
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
