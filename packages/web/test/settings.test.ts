// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { settingsBody, type SettingsHandlers } from '../src/view/settings';
import { prefs } from '../src/prefs';

// The @settings window rendered from a fake handlers shape
// (WEB_INTERFACE → The settings window). The preferences moved here from the
// @profile window — theme, identity tint, node, faucet, and the extension's
// sign-each-rep-action row — and the identity-tint preview came with them.

function handlers(over: Partial<SettingsHandlers> = {}): SettingsHandlers {
  return {
    setTheme: () => {},
    setIdTint: () => {},
    setNode: () => {},
    setFaucet: () => {},
    ...over,
  };
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
  prefs.idtint = 'spine';
  prefs.theme = 'light';
});

describe('settings window — the preference rows', () => {
  it('emits theme, identity tint, node and faucet — the same shape without an identity', () => {
    const body = settingsBody(handlers());
    for (const label of ['theme', 'identity tint', 'node', 'faucet']) {
      expect(rowField(body, label), label).not.toBeNull();
    }
  });

  it('the theme control names and shows the theme it would switch TO', () => {
    prefs.theme = 'light';
    const btn = rowField(settingsBody(handlers()), 'theme')!.querySelector('button')!;
    expect(btn.textContent).toBe('dark');
    expect(btn.getAttribute('aria-label')).toBe('switch to dark theme');
    prefs.theme = 'dark';
    const btn2 = rowField(settingsBody(handlers()), 'theme')!.querySelector('button')!;
    expect(btn2.textContent).toBe('light');
    expect(btn2.getAttribute('aria-label')).toBe('switch to light theme');
  });

  it('a press on theme calls setTheme with the target', () => {
    const setTheme = vi.fn();
    const body = settingsBody(handlers({ setTheme }));
    (rowField(body, 'theme')!.querySelector('button') as HTMLButtonElement).click();
    expect(setTheme).toHaveBeenCalledWith('dark');
  });
});

describe('settings window — the identity-tint preview', () => {
  it('two aria-hidden .bar sample bars stand above the four words', () => {
    const field = rowField(settingsBody(handlers()), 'identity tint')!;
    const preview = field.querySelector('.tint-preview')!;
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    const samples = preview.querySelectorAll('.bar');
    expect(samples.length).toBe(2);
    // Not .win — the samples are thread bars, the shape the tint applies to.
    for (const s of samples) expect(s.classList.contains('win')).toBe(false);
    // One focused, one not — the two states of a real title bar.
    expect(samples[0]!.classList.contains('focused')).toBe(false);
    expect(samples[1]!.classList.contains('focused')).toBe(true);
    // Each carries a fixed --idh, and the two differ so the reader sees the
    // arc, not one hue repeated.
    const a = (samples[0] as HTMLElement).style.getPropertyValue('--idh');
    const b = (samples[1] as HTMLElement).style.getPropertyValue('--idh');
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    expect(a).not.toBe(b);
    // The samples carry no controls: no <button> descendants.
    expect(preview.querySelectorAll('button').length).toBe(0);
  });

  it('the four words each aria-pressed by prefs.idtint', () => {
    prefs.idtint = 'both';
    const body = settingsBody(handlers());
    const field = rowField(body, 'identity tint')!;
    const words = [...field.querySelectorAll('.seg .word')];
    expect(words.map((w) => w.textContent)).toEqual(['spine', 'wash', 'both', 'off']);
    expect(words.map((w) => w.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
  });

  it('pressing a tint word calls setIdTint', () => {
    const setIdTint = vi.fn();
    const body = settingsBody(handlers({ setIdTint }));
    const off = [...rowField(body, 'identity tint')!.querySelectorAll('.seg .word')].find((w) => w.textContent === 'off')! as HTMLButtonElement;
    off.click();
    expect(setIdTint).toHaveBeenCalledWith('off');
  });
});

describe('settings window — the node row', () => {
  it('a change on the input calls setNode with the typed value', () => {
    const setNode = vi.fn();
    const body = settingsBody(handlers({ setNode }));
    const input = rowField(body, 'node')!.querySelector('input') as HTMLInputElement;
    input.value = 'https://other.example';
    input.dispatchEvent(new Event('change'));
    expect(setNode).toHaveBeenCalledWith('https://other.example');
  });
});

describe('settings window — the sign-each-rep-action row', () => {
  it('is absent when policy/setPolicy are — the in-page module', () => {
    expect(rowField(settingsBody(handlers()), 'sign each rep action')).toBeNull();
  });

  it('renders only when both policy and setPolicy are present — the extension', () => {
    const p = vi.fn(() => 'silent' as const);
    const sp = vi.fn(async () => {});
    const body = settingsBody(handlers({ policy: p, setPolicy: sp }));
    const field = rowField(body, 'sign each rep action');
    expect(field).not.toBeNull();
    const buttons = [...(field?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["don't ask", 'ask']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
    buttons[1]!.click();
    expect(sp).toHaveBeenCalledWith('ask');
  });

  it('shows the new pressed state on the next render', async () => {
    // policy() carries a mutable state; a re-render after setPolicy resolves
    // reads the new value — the App does this via renderRegionsFor('@settings').
    let policy: 'silent' | 'ask' = 'silent';
    const p = (): 'silent' | 'ask' => policy;
    const sp = async (v: 'silent' | 'ask'): Promise<void> => { policy = v; };
    const h = handlers({ policy: p, setPolicy: sp });
    const first = settingsBody(h);
    const firstButtons = [...rowField(first, 'sign each rep action')!.querySelectorAll('button')];
    firstButtons[1]!.click();
    await new Promise((r) => setTimeout(r, 0));
    const next = settingsBody(h);
    const nextButtons = [...rowField(next, 'sign each rep action')!.querySelectorAll('button')];
    expect(nextButtons[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(nextButtons[1]!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('settings window — the faucet row', () => {
  it('without a requestFaucetOrigin handler, a change calls setFaucet directly', async () => {
    const setFaucet = vi.fn();
    const body = settingsBody(handlers({ setFaucet }));
    const input = rowField(body, 'faucet')!.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(setFaucet).toHaveBeenCalledWith('https://faucet.example');
  });

  it('with requestFaucetOrigin, a refused origin reports and does not store', async () => {
    const setFaucet = vi.fn();
    const requestFaucetOrigin = vi.fn(async () => false);
    const body = settingsBody(handlers({ setFaucet, requestFaucetOrigin }));
    const field = rowField(body, 'faucet')!;
    const input = field.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(requestFaucetOrigin).toHaveBeenCalledWith('https://faucet.example');
    expect(setFaucet).not.toHaveBeenCalled();
    expect(field.querySelector('.hint')?.textContent).toBe('the browser refused access to that origin.');
  });

  it('with requestFaucetOrigin, a granted origin then stores', async () => {
    const setFaucet = vi.fn();
    const requestFaucetOrigin = vi.fn(async () => true);
    const body = settingsBody(handlers({ setFaucet, requestFaucetOrigin }));
    const field = rowField(body, 'faucet')!;
    const input = field.querySelector('input') as HTMLInputElement;
    input.value = 'https://faucet.example';
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(requestFaucetOrigin).toHaveBeenCalledWith('https://faucet.example');
    expect(setFaucet).toHaveBeenCalledWith('https://faucet.example');
  });
});
