// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { profileBody, renderInvitesRow, renderUsernameRow, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { karmaResult } from './karma-fixture';
import { prefs } from '../src/prefs';
import type { Origin } from '../src/model/workspace';
import type { UsernameResult } from '../src/api/dto';
import type { FiguresView } from '../src/model/state';
import type { TipVerdict } from '../src/model/tip-verdict';
import type { FiguresResult, FigureBox, LedgerSums, RecordResult, Anchor } from '@dagsocial/nipopow-client';
import type { BlockHeader, IdentityRecord, UserId } from '@dagsocial/types';

const appCss = readFileSync(resolve(process.cwd(), 'src/style/app.css'), 'utf8');

const ORIGIN: Origin = { from: 'pane', ci: 0 };

// The @profile window rendered from a fake handlers/ctx (WEB_INTERFACE → The
// profile window): the two states, the six operations' forms, no standing row
// on any tier, the rep row's number, and the faucet step's three-condition rule.
// The create form's username value is pinned with the draft split (4c), not here.

const KEY = 'ab'.repeat(32);
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
    nameClay: () => false, // no check has decided a pair — every handle in ink
    // The web arm's default — no verifier, so `figuresLine` reads row 1 and
    // renders nothing beneath the number. The extension arm's tests override
    // both (WEB_INTERFACE → The extension → "The verified figures").
    verdict: undefined, figures: null,
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

  it('preference rows do not appear in the profile window — they belong to @settings', () => {
    // WEB_INTERFACE → The profile window: everything the settings window holds
    // is absent here (WEB_INTERFACE → The settings window). test/settings.test.ts
    // pins the presence there.
    for (const c of [ctx(), ctx({ identity: unlocked })]) {
      const body = render(handlers(), c);
      for (const label of ['theme', 'identity tint', 'node', 'faucet', 'sign each rep action', 'arrangement']) {
        expect(rowField(body, label), label).toBeNull();
      }
    }
  });

  it('the $NOTIS row does not appear in the profile window — it is the wallet window (WEB_INTERFACE → "Everything `$NOTIS` lives here and on no profile")', () => {
    for (const c of [ctx(), ctx({ identity: unlocked })]) {
      const body = render(handlers(), c);
      expect(rowField(body, '$NOTIS')).toBeNull();
      expect(body.querySelector('.credits-field')).toBeNull();
      expect(body.querySelector('.credits-line')).toBeNull();
      expect(body.querySelector('.credits-form')).toBeNull();
      expect(body.querySelector('.credits-flight')).toBeNull();
    }
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

// ---------------------------------------------------------------------------
// The key as a copy control (WEB_INTERFACE → The profile window → "The key is
// a control, and a press copies it").
// ---------------------------------------------------------------------------

describe('profile — the key as a copy control', () => {
  it('the key row holds a button in the word pattern, mono, the whole 64 hex, labelled copy this key', () => {
    const f = rowField(render(handlers(), ctx({ identity: unlocked })), 'key')!;
    const btn = f.querySelector('button.key-copy') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.classList.contains('word')).toBe(true);
    expect(btn.classList.contains('mono')).toBe(true);
    expect(btn.textContent).toBe(KEY);
    expect(btn.getAttribute('aria-label')).toBe('copy this key');
    expect(btn.type).toBe('button');
  });

  it('a press writes the key to the clipboard and appends the muted copied follower; a second press writes nothing (WEB_INTERFACE → The profile window → "The key is a control, and a press copies it")', async () => {
    const writes: string[] = [];
    // The fake clipboard resolves; nothing else in this file writes it.
    const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t: string) => { writes.push(t); } },
    });
    try {
      const f = rowField(render(handlers(), ctx({ identity: unlocked })), 'key')!;
      const btn = f.querySelector('button.key-copy') as HTMLButtonElement;
      btn.click();
      await flush();
      expect(writes).toEqual([KEY]);
      const note = btn.querySelector('.key-copy-note') as HTMLElement;
      expect(note).not.toBeNull();
      expect(note.classList.contains('inkmute')).toBe(true);
      expect(note.textContent).toBe(' copied');
      // The key still stands in the button — the note is appended, not a replacement.
      expect(btn.textContent).toBe(KEY + ' copied');
      // A second press writes nothing new and adds no second note.
      btn.click();
      await flush();
      expect(writes).toEqual([KEY]);
      expect(f.querySelectorAll('.key-copy-note')).toHaveLength(1);
    } finally {
      if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  it('with no clipboard write, the control is replaced by selectable mono text followed by — copy it by hand', () => {
    const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    try {
      const f = rowField(render(handlers(), ctx({ identity: unlocked })), 'key')!;
      const btn = f.querySelector('button.key-copy') as HTMLButtonElement;
      btn.click();
      // The button is gone; the mono key and the "— copy it by hand" tail stand in its place.
      expect(f.querySelector('button.key-copy')).toBeNull();
      const monoSpan = f.querySelector('.mono') as HTMLElement;
      expect(monoSpan).not.toBeNull();
      expect(monoSpan.textContent).toBe(KEY);
      expect(f.textContent).toContain('— copy it by hand');
    } finally {
      if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  it('a clipboard rejection replaces the control by selectable text (the fallback path)', async () => {
    const originalClipboard = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('nope'); } },
    });
    try {
      const f = rowField(render(handlers(), ctx({ identity: unlocked })), 'key')!;
      const btn = f.querySelector('button.key-copy') as HTMLButtonElement;
      btn.click();
      await flush();
      expect(f.querySelector('button.key-copy')).toBeNull();
      expect((f.querySelector('.mono') as HTMLElement).textContent).toBe(KEY);
      expect(f.textContent).toContain('— copy it by hand');
    } finally {
      if (originalClipboard === undefined) delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      else Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
    }
  });

  // The key control's face and size rest on stylesheet order: `.word`
  // (`font: inherit`) then `.mono` (the mono family) then `.key-copy` (the
  // labels' 12.5px), all one class each. Only the rule's text is pinned
  // elsewhere; here the rendered measure is what the reader sees.
  it('under the stylesheet, the .key-copy button computes the mono family and 12.5px', () => {
    const style = document.createElement('style');
    style.textContent = appCss;
    document.head.appendChild(style);
    const body = render(handlers(), ctx({ identity: unlocked }));
    document.body.appendChild(body);
    try {
      const btn = body.querySelector('button.key-copy') as HTMLElement;
      const s = window.getComputedStyle(btn);
      expect(s.fontSize).toBe('12.5px');
      // `--mono` resolves to a cascade whose first family is JetBrains Mono.
      expect(s.fontFamily).toContain('JetBrains Mono');
    } finally {
      document.body.removeChild(body);
      document.head.removeChild(style);
    }
  });
});

describe('profile window — no standing row for any tier', () => {
  it('no standing row for a root, a member or a resident (WEB_INTERFACE → "No window renders standing")', () => {
    for (const karma of [
      karmaResult({ boxCount: 1, invitesAvailable: null }),                                            // root
      karmaResult({ boxCount: 1, member: true, memberSinceBlock: 5000, invitesAvailable: 3 }),          // member
      karmaResult({ boxCount: 1, member: false, memberVouches: 1, memberLikes: '2', invitesAvailable: 0 }), // resident
    ]) {
      const body = render(handlers(), ctx({ identity: unlocked, karma }));
      expect(rowField(body, 'standing')).toBeNull();
    }
  });
});

describe('profile window — the karma field and the faucet step', () => {
  it('the rep row reads the effective number alone, with and without a decay gap (WEB_INTERFACE → "The `rep` row is the `effective` number alone")', () => {
    // No gap — the row's label says what the number counts, so no unit follows it.
    const flush = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '227' }) })), 'rep')!;
    expect(flush.querySelector('.mono')!.textContent).toBe('227');
    expect(flush.textContent).toBe('227'); // no ' rep', no ' effective · N held'
    // A decay gap — still the effective number alone, never `held`.
    const decayed = rowField(render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 1, total: '227', effective: '200' }) })), 'rep')!;
    expect(decayed.querySelector('.mono')!.textContent).toBe('200');
    expect(decayed.textContent).toBe('200');
    expect(decayed.textContent).not.toContain('held');
    expect(decayed.textContent).not.toContain('effective');
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
  it('the row sits above key when a name is held, below it otherwise (WEB_INTERFACE → The username row → "A name is claimed and burned from the profile window, in one row whose place follows the name")', () => {
    // Holding none — the row stands below key.
    const withoutName = [...render(handlers(), memberCtx()).querySelectorAll('.row label')].map((l) => l.textContent);
    expect(withoutName).toEqual(['key', 'username', 'rep', 'invites', 'passphrase', 'export', 'forget']);
    // Holding a name at build time — the row places on top.
    const withName = [...render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: true })).querySelectorAll('.row label')].map((l) => l.textContent);
    expect(withName).toEqual(['username', 'key', 'rep', 'invites', 'passphrase', 'export', 'forget']);
  });

  it('a landing updates the row where it stands and moves no row (HOUSE_STYLE → Motion → "Pending state is the one legitimate unsolicited update, and it pays for itself in geometry")', () => {
    // Built without a name — the row stands below key.
    const b = render(handlers(), memberCtx({ canSignClaim: true }));
    const before = [...b.querySelectorAll('.row label')].map((l) => l.textContent);
    const usernameField = rowField(b, 'username')!;
    expect(usernameField.querySelector('form')).not.toBeNull();
    // A landing renders the row in place with a name held.
    renderUsernameRow(usernameField, handlers(), memberCtx({ ownName: HELD, canAffordBurn: true }));
    const after = [...b.querySelectorAll('.row label')].map((l) => l.textContent);
    // The order is unchanged: the row still stands below key.
    expect(after).toEqual(before);
    // The row's content is updated: the form is gone, the handle stands.
    expect(usernameField.querySelector('form')).toBeNull();
    expect(usernameField.querySelector('.handle')?.textContent).toBe('@Alice_01');
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
    expect(input.placeholder).toBe('a name');
    expect(input.maxLength).toBe(24);
    expect(button(form, 'claim')).not.toBeNull();
    expect(form.textContent).toContain('free, once per key');
    expect(form.textContent).toContain('10 rep');
  });

  it('the input and the boxed claim share one flex row; claim is btn btn-primary type=submit (WEB_INTERFACE → The username row → "Holding none, nothing pending, a rep box to spend")', () => {
    const f = rowField(render(handlers(), memberCtx({ canSignClaim: true })), 'username')!;
    const form = f.querySelector('form') as HTMLFormElement;
    const nameRow = form.querySelector('.name-row') as HTMLElement;
    expect(nameRow).not.toBeNull();
    const input = nameRow.querySelector('input') as HTMLInputElement;
    const submit = nameRow.querySelector('button') as HTMLButtonElement;
    expect(input).not.toBeNull();
    expect(submit.textContent).toBe('claim');
    expect(submit.type).toBe('submit');
    expect(submit.classList.contains('btn')).toBe(true);
    expect(submit.classList.contains('btn-primary')).toBe(true);
    // The refusal and the rule sentence sit beneath the row (siblings of it in the form).
    expect(form.children[0]).toBe(nameRow);
    expect(form.querySelector('.pf-refusal')).not.toBeNull();
    expect(form.querySelector('.hint')).not.toBeNull();
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
// The verified-figures line beneath the rep number (WEB_INTERFACE → The
// extension → "The verified figures", → The profile window → "The `rep` row
// is the `effective` number alone"). The pure model's rows are pinned in
// test/figures-line.test.ts; these tests pin the row's plumbing: the hint
// element renders under the mono number, and under the full rule (row 4)
// the mono span gains `.clay` alongside the hint. The number stays the live
// `effective` in every state.
// ---------------------------------------------------------------------------

const EMPTY_SUMS: LedgerSums = { proven: 0n, young: 0n, unchecked: 0n, absent: 0n };
const RECORD: IdentityRecord = {
  lastActivityBlock: 0, lastDecayBlock: 0, invitedAtBlock: 0,
  lifetimeLikesReceived: 0n, memberSinceBlock: 0, memberBar: 0,
  memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
};
function stubHeader(over: Partial<BlockHeader> = {}): BlockHeader {
  return {
    protocolVersion: 1, height: 9020, prevBlockHash: '00'.repeat(32),
    utxoTxRoot: '00'.repeat(32), stateRoot: '00'.repeat(32),
    validatorId: new Uint8Array(32) as UserId, powNonce: 0, powTargetBits: 0,
    createdAt: 0, interlinkRoot: '00'.repeat(32),
    ...over,
  };
}
function pfAnchor(suffixHeight = 9005, tipHeight = 9020): Anchor {
  return {
    tip: stubHeader({ height: tipHeight }),
    suffixHead: { header: stubHeader({ height: suffixHeight }), interlinks: [] },
  };
}
function pfBox(over: Partial<FigureBox> & Pick<FigureBox, 'boxClass' | 'status'>): FigureBox {
  return { boxId: 'a'.repeat(64), value: 0n, lockedUntilBlock: null, verdict: 'test', ...over };
}
function pfFigures(result: Partial<FiguresResult> = {}, suffixHeight = 9005): FiguresView {
  return {
    result: {
      boxes: [],
      record: { status: 'proven', record: RECORD } as RecordResult,
      karma: { ...EMPTY_SUMS, effective: 0n },
      credits: { ...EMPTY_SUMS },
      heightAfter: 9020,
      failed: false,
      ...result,
    },
    anchor: pfAnchor(suffixHeight),
  };
}
const VERIFIED_PF: TipVerdict = { kind: 'verified', nodes: 2, height: 9020 };
const REFUSED_PF: TipVerdict = { kind: 'refused', reason: 'invalid-proof', by: null, height: null };

describe('profile — the verified-figures line beneath the rep number', () => {
  const repCtx = (over: Partial<ProfileCtx> = {}): ProfileCtx => ctx({
    identity: unlocked,
    karma: karmaResult({ boxCount: 1, total: '100', effective: '100', height: 9020 }),
    ...over,
  });

  it('the default web ctx (no verifier) renders no hint under the mono number', () => {
    const f = rowField(render(handlers(), repCtx()), 'rep')!;
    const mono = f.querySelector<HTMLElement>('.mono')!;
    expect(mono.textContent).toBe('100');
    expect(mono.classList.contains('clay')).toBe(false);
    expect(f.querySelector('.hint')).toBeNull();
  });

  it('a verified verdict + a proven+young result renders a muted hint, no .clay on the number', () => {
    const fv = pfFigures({
      boxes: [
        pfBox({ boxClass: 'karma', status: 'proven', value: 87n }),
        pfBox({ boxClass: 'karma', status: 'young',  value: 13n }),
      ],
      karma: { proven: 87n, young: 13n, unchecked: 0n, absent: 0n, effective: 87n },
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    const hint = f.querySelector<HTMLElement>('.hint');
    expect(hint?.textContent).toBe('87 rep proven at block 9005 · 13 rep landed since');
    expect(hint?.classList.contains('clay')).toBe(false);
    const mono = f.querySelector<HTMLElement>('.mono')!;
    expect(mono.classList.contains('clay')).toBe(false);
    expect(mono.textContent).toBe('100');
  });

  it('an unproven karma box → the full rule: clay hint AND clay class on the mono number (row 4)', () => {
    const fv = pfFigures({
      boxes: [pfBox({ boxClass: 'karma', status: 'unproven', value: 100n })],
      karma: { ...EMPTY_SUMS, effective: null },
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    const hint = f.querySelector<HTMLElement>('.hint');
    expect(hint?.textContent).toBe("this node's proof of your rep did not verify");
    expect(hint?.classList.contains('clay')).toBe(true);
    const mono = f.querySelector<HTMLElement>('.mono')!;
    expect(mono.classList.contains('clay')).toBe(true);
    expect(mono.textContent).toBe('100');
  });

  it('the record unproven, boxes proven → the same clay line ("proof of your rep")', () => {
    const fv = pfFigures({
      boxes: [pfBox({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...EMPTY_SUMS, proven: 100n, effective: null },
      record: { status: 'unproven', verdict: '' } as RecordResult,
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    expect(f.querySelector<HTMLElement>('.hint')?.textContent).toBe("this node's proof of your rep did not verify");
    expect(f.querySelector<HTMLElement>('.mono')!.classList.contains('clay')).toBe(true);
  });

  it('an absent karma sum → clay "the node lists N rep the chain does not hold"', () => {
    const fv = pfFigures({
      boxes: [pfBox({ boxClass: 'karma', status: 'absent', value: 5n })],
      karma: { ...EMPTY_SUMS, absent: 5n, effective: null },
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    expect(f.querySelector<HTMLElement>('.hint')?.textContent).toBe('the node lists 5 rep the chain does not hold');
    expect(f.querySelector<HTMLElement>('.mono')!.classList.contains('clay')).toBe(true);
  });

  // A listing height that is not a block height leaves the valuation unmade —
  // `effective: null` beside a proven or absent record (WEB_INTERFACE → The
  // extension → "A run is total"): the full rule, the number in its slot.
  for (const record of [
    { status: 'proven', record: RECORD } as RecordResult,
    { status: 'absent' } as RecordResult,
  ]) {
    it(`the valuation not made beside the ${record.status} record, every box proven → the clay line and the number clay, never "0 rep proven"`, () => {
      const fv = pfFigures({
        boxes: [pfBox({ boxClass: 'karma', status: 'proven', value: 100n })],
        record,
        karma: { ...EMPTY_SUMS, proven: 100n, effective: null },
        failed: true,
      });
      const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
      const hint = f.querySelector<HTMLElement>('.hint');
      expect(hint?.textContent).toBe("this node's proof of your rep did not verify");
      expect(hint?.classList.contains('clay')).toBe(true);
      const mono = f.querySelector<HTMLElement>('.mono')!;
      expect(mono.classList.contains('clay')).toBe(true);
      expect(mono.textContent).toBe('100');
    });
  }

  it('the record no-proof, no boxes no-proof → muted "the node served no proof for your rep"', () => {
    const fv = pfFigures({
      boxes: [pfBox({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...EMPTY_SUMS, proven: 100n, effective: null },
      record: { status: 'no-proof', verdict: '' } as RecordResult,
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    const hint = f.querySelector<HTMLElement>('.hint');
    expect(hint?.textContent).toBe('the node served no proof for your rep');
    expect(hint?.classList.contains('clay')).toBe(false);
    expect(f.querySelector<HTMLElement>('.mono')!.classList.contains('clay')).toBe(false);
  });

  it('a refused verdict, no figures back → the unverified line (row 3), muted', () => {
    const f = rowField(render(handlers(), repCtx({ verdict: REFUSED_PF, figures: null })), 'rep')!;
    const hint = f.querySelector<HTMLElement>('.hint');
    expect(hint?.textContent).toBe('not checked — the chain is not verified');
    expect(hint?.classList.contains('clay')).toBe(false);
    expect(f.querySelector<HTMLElement>('.mono')!.classList.contains('clay')).toBe(false);
  });

  it('every proven and effective reproduces the number → no hint (row 6 silence)', () => {
    const fv = pfFigures({
      boxes: [pfBox({ boxClass: 'karma', status: 'proven', value: 100n })],
      karma: { ...EMPTY_SUMS, proven: 100n, effective: 100n },
    });
    const f = rowField(render(handlers(), repCtx({ verdict: VERIFIED_PF, figures: fv })), 'rep')!;
    expect(f.querySelector('.hint')).toBeNull();
    expect(f.querySelector<HTMLElement>('.mono')!.classList.contains('clay')).toBe(false);
  });

  it('the empty karma listing (boxCount 0) renders no hint even under a verified verdict (row 2)', () => {
    // The faucet step / "no rep yet." branch stands as it does — the hint's
    // absence is what row 2 pins.
    prefs.faucet = '';
    const f = rowField(
      render(handlers(), ctx({ identity: unlocked, karma: karmaResult({ boxCount: 0 }), verdict: VERIFIED_PF, figures: null })),
      'rep',
    )!;
    // No mono number under an empty karma listing — the row renders the
    // "no rep yet." branch or the faucet step, and the pure model reads row 2
    // for the rep row. Neither branch owns a hint of the verified-figures
    // shape.
    expect(f.querySelector('.hint')).toBeNull();
  });
});

describe('profile — a handle the chain does not back is clay (WEB_INTERFACE → The identity display)', () => {
  const clayFor = (key: string, name: string) => (k: string, n: string): boolean => k === key && n === name;
  const bondsWith = (inviteeName: string): ProfileCtx['bonds'] => ({
    bonds: [{ id: 'b1', value: '100', inviterId: KEY, inviteePublicKey: INVITEE, inviterName: 'Me', inviteeName }], bondCount: 1, next: null,
  });

  it('a standing-bond row pairs the invitee\'s key with its name — clay on the same control; ink as today', () => {
    const opened: string[] = [];
    const h = handlers({ openAuthor: (k) => opened.push(k) });
    const clay = rowField(render(h, memberCtx({ bonds: bondsWith('Ivy'), nameClay: clayFor(INVITEE, 'Ivy') })), 'invites')!
      .querySelector('.bond .authorbtn') as HTMLElement;
    expect([...clay.classList]).toEqual(['handle', 'authorbtn', 'clay']);
    expect(clay.textContent).toBe('@Ivy');
    clay.click();
    expect(opened).toEqual([INVITEE]);
    const ink = rowField(render(handlers(), memberCtx({ bonds: bondsWith('Ivy'), nameClay: clayFor(KEY, 'Ivy') })), 'invites')!
      .querySelector('.bond .authorbtn') as HTMLElement;
    expect([...ink.classList]).toEqual(['handle', 'authorbtn']);
  });

  it('the username row pairs the loaded key with the reader\'s name — clay; ink as today', () => {
    // The node's answer names another owner; the pair is the reader's own key.
    const held: UsernameResult = { ...HELD, owner: INVITEE };
    const clay = rowField(render(handlers(), memberCtx({ ownName: held, canAffordBurn: true, nameClay: clayFor(KEY, 'Alice_01') })), 'username')!;
    const h = clay.querySelector('.handle') as HTMLElement;
    expect([...h.classList]).toEqual(['handle', 'clay']);
    expect(h.textContent).toBe('@Alice_01');
    // No line grows here — the author window's name row is the one place.
    expect(clay.querySelector('.hint.clay')).toBeNull();
    const ink = rowField(render(handlers(), memberCtx({ ownName: HELD, canAffordBurn: true, nameClay: clayFor(KEY, 'alice_01') })), 'username')!;
    expect([...(ink.querySelector('.handle') as HTMLElement).classList]).toEqual(['handle']);
  });

  it('an in-place update of the username row reads the predicate too', () => {
    const b = render(handlers(), memberCtx({ canSignClaim: true }));
    const field = rowField(b, 'username')!;
    renderUsernameRow(field, handlers(), memberCtx({ ownName: HELD, canAffordBurn: true, nameClay: clayFor(KEY, 'Alice_01') }));
    expect(field.querySelector('.handle.clay')?.textContent).toBe('@Alice_01');
  });

  it('a pending claim\'s handle is the reader\'s own typed name, not one a node showed — it stays inkmute', () => {
    const f = rowField(render(handlers(), memberCtx({ pendingUsername: { kind: 'claim', name: 'Alice_01' }, nameClay: () => true })), 'username')!;
    expect([...(f.querySelector('.handle') as HTMLElement).classList]).toEqual(['handle', 'inkmute']);
  });
});
