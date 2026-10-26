// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { profileBody, type ProfileBody, type ProfileHandlers, type ProfileCtx } from '../src/view/profile';
import { karmaResult } from './karma-fixture';
import { prefs } from '../src/prefs';
import type { Origin } from '../src/model/workspace';

// The invites row's bond field reads a whole number of decimal digits inside
// the range the row carries; anything else shows the refusal line and the
// form submits nothing (WEB_INTERFACE → The profile window → "The `invites`
// row"). The form never hands `BigInt` a string the field did not check first.

const ORIGIN: Origin = { from: 'pane', ci: 0 };
const KEY = 'ab'.repeat(32);
const INVITEE = 'cd'.repeat(32);
const INVITE_PARAMS = { bondMin: '100', bondMax: '1000', probationBlocks: 43200 };

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

function memberCtx(over: Partial<ProfileCtx> = {}): ProfileCtx {
  return {
    identity: { pubKeyHex: KEY, locked: false },
    backedUp: false,
    karma: karmaResult({ userId: KEY, member: true, invitesAvailable: 2, memberSinceBlock: 5 }),
    karmaPlain: null,
    grant: null,
    invite: INVITE_PARAMS,
    canAffordMinBond: true,
    bonds: null,
    inviteFlight: null,
    ownName: null,
    ownNameLoaded: true,
    usernameFlight: null,
    pendingUsername: null,
    canSignClaim: false,
    canAffordBurn: false,
    nameClay: () => false,
    verdict: undefined,
    figures: null,
    ...over,
  };
}

function render(h: ProfileHandlers, c: ProfileCtx): ProfileBody {
  return profileBody(h, () => c, () => ORIGIN);
}

function rowField(body: HTMLElement, label: string): HTMLElement | null {
  for (const r of body.querySelectorAll('.row')) {
    if (r.querySelector('label')?.textContent === label) return r.querySelector('.field');
  }
  return null;
}

beforeEach(() => {
  localStorage.clear();
  prefs.faucet = '';
});

describe('invite form — the bond field is a whole number inside the bounds', () => {
  function form(): { form: HTMLFormElement; keyInput: HTMLInputElement; bondInput: HTMLInputElement; invited: Array<[string, bigint]>; refusal: () => HTMLElement | null } {
    const invited: Array<[string, bigint]> = [];
    const h = handlers({ invite: (k, b) => invited.push([k, b]) });
    const body = render(h, memberCtx()).el;
    const form = rowField(body, 'invites')!.querySelector('form.invite-form') as HTMLFormElement;
    const keyInput = form.querySelector('input[type="text"]') as HTMLInputElement;
    const bondInput = form.querySelector('input[type="number"]') as HTMLInputElement;
    keyInput.value = INVITEE;
    return { form, keyInput, bondInput, invited, refusal: () => form.querySelector('.pf-refusal') as HTMLElement | null };
  }

  it('the bond field reading 1e3 shows the refusal line and submits nothing', () => {
    const f = form();
    f.bondInput.value = '1e3';
    f.form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(f.refusal()?.hidden).toBe(false);
    expect(f.invited).toHaveLength(0);
  });

  it('the bond field reading -5 shows the refusal line and submits nothing', () => {
    const f = form();
    f.bondInput.value = '-5';
    f.form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(f.refusal()?.hidden).toBe(false);
    expect(f.invited).toHaveLength(0);
  });

  it('the bond field reading 1.5 shows the refusal line and submits nothing', () => {
    const f = form();
    f.bondInput.value = '1.5';
    f.form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(f.refusal()?.hidden).toBe(false);
    expect(f.invited).toHaveLength(0);
  });

  it('a bond one above the maximum shows the refusal line and submits nothing', () => {
    const f = form();
    f.bondInput.value = '1001';
    f.form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(f.refusal()?.hidden).toBe(false);
    expect(f.invited).toHaveLength(0);
  });
});
