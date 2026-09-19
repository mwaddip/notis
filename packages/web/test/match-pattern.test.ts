import { describe, it, expect } from 'vitest';
import { matchPatternFor } from '../extension/match-pattern.mjs';

// WEB_INTERFACE → The extension → "Permissions and policy, the whole list" —
// the bridge's match pattern is derived from the build's `notis-public`, and
// the port is dropped.
describe('matchPatternFor', () => {
  it('https://notis.fun/web/ → https://notis.fun/web/p/*', () => {
    expect(matchPatternFor('https://notis.fun/web/')).toBe('https://notis.fun/web/p/*');
  });

  it('http://localhost:19271/web/ → http://localhost/web/p/* (port dropped)', () => {
    expect(matchPatternFor('http://localhost:19271/web/')).toBe('http://localhost/web/p/*');
  });

  it('https://example.org/ → https://example.org/p/*', () => {
    expect(matchPatternFor('https://example.org/')).toBe('https://example.org/p/*');
  });

  it("'' → null", () => {
    expect(matchPatternFor('')).toBeNull();
  });

  it('throws on a non-http(s) scheme', () => {
    expect(() => matchPatternFor('file:///web/')).toThrow();
  });

  it("throws on a base that does not close with '/'", () => {
    expect(() => matchPatternFor('https://notis.fun/web')).toThrow();
  });

  it('throws on a base carrying a query', () => {
    expect(() => matchPatternFor('https://notis.fun/web/?x=1')).toThrow();
  });

  it('throws on a base carrying a fragment', () => {
    expect(() => matchPatternFor('https://notis.fun/web/#top')).toThrow();
  });
});
