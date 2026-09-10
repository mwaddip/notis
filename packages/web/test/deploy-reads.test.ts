// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readBase, readMeta } from '../src/prefs';

function setBase(href: string): void {
  let el = document.querySelector('base');
  if (!el) { el = document.createElement('base'); document.head.prepend(el); }
  el.setAttribute('href', href);
}

function setMeta(name: string, content: string): void {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) { el = document.createElement('meta'); el.name = name; document.head.appendChild(el); }
  el.content = content;
}

function clearTag(sel: string): void {
  document.querySelector(sel)?.remove();
}

describe('readBase (WEB_BASE)', () => {
  beforeEach(() => clearTag('base'));

  it('/web/ → /web/', () => {
    setBase('/web/');
    expect(readBase()).toBe('/web/');
  });

  it('/web without trailing slash → /web/', () => {
    setBase('/web');
    expect(readBase()).toBe('/web/');
  });

  it('absent → /', () => {
    expect(readBase()).toBe('/');
  });

  it('/ → /', () => {
    setBase('/');
    expect(readBase()).toBe('/');
  });
});

describe('readMeta (BUILD_BASE / BUILD_FAUCET_BASE)', () => {
  beforeEach(() => {
    clearTag('meta[name="notis-api"]');
    clearTag('meta[name="notis-faucet"]');
  });

  it('/testnet/api → /testnet/api', () => {
    setMeta('notis-api', '/testnet/api');
    expect(readMeta('notis-api')).toBe('/testnet/api');
  });

  it('trailing slash stripped: /testnet/api/ → /testnet/api', () => {
    setMeta('notis-api', '/testnet/api/');
    expect(readMeta('notis-api')).toBe('/testnet/api');
  });

  it('absent → empty string', () => {
    expect(readMeta('notis-api')).toBe('');
  });

  it('faucet reads the same way', () => {
    setMeta('notis-faucet', '/testnet/faucet');
    expect(readMeta('notis-faucet')).toBe('/testnet/faucet');
  });

  it('faucet absent → empty string', () => {
    expect(readMeta('notis-faucet')).toBe('');
  });
});
