// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { profileBody, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { karmaResult } from './karma-fixture';
import { prefs } from '../src/prefs';

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
    createIdentity: async () => {},
    importIdentity: async () => {},
    exportIdentity: async () => {},
    forgetIdentity: () => {},
    lockIdentity: () => {},
    unlockIdentity: async () => {},
    askFaucet: () => {},
    ...over,
  };
}

function ctx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return { arrangement: '', identity: null, backedUp: false, karma: null, grant: null, membershipBars: null, ...over };
}

const render = (h: ProfileHandlers, c: ProfileCtx): HTMLElement => profileBody(h, c);

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

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
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
  it('create reveals a two-field set form (new-password) with a read-only username', () => {
    const body = render(handlers(), ctx());
    button(body, 'create')!.click();
    const form = body.querySelector('form.pf')!;
    const pws = [...form.querySelectorAll('input')].filter((i) => (i as HTMLInputElement).type === 'password') as HTMLInputElement[];
    expect(pws).toHaveLength(2);
    expect(pws.every((i) => i.autocomplete === 'new-password')).toBe(true);
    const user = form.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(user.readOnly).toBe(true); // the username value is pinned with the draft split (4c)
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
