import { describe, it, expect } from 'vitest';
import { matchPatternFor, originPatternFor } from '../extension/match-pattern.mjs';

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

  it("a base with both a missing '/' and a query throws the closing-slash text", () => {
    expect(() => matchPatternFor('https://notis.fun/web?x=1')).toThrow(
      /must end with '\/'/,
    );
  });

  it("the scheme throw names matchPatternFor", () => {
    expect(() => matchPatternFor('file:///web/')).toThrow(/matchPatternFor/);
  });

  it("the query throw names matchPatternFor", () => {
    expect(() => matchPatternFor('https://notis.fun/web/?x=1')).toThrow(/matchPatternFor/);
  });
});

// WEB_INTERFACE → The extension → "The manifest" —
// the one optional host permission is derived from the build's faucet base,
// and the port and the path are dropped.
describe('originPatternFor', () => {
  it('https://notis.fun/testnet/faucet → https://notis.fun/*', () => {
    expect(originPatternFor('https://notis.fun/testnet/faucet')).toBe('https://notis.fun/*');
  });

  it('http://127.0.0.1:19750/faucet → http://127.0.0.1/* (port dropped)', () => {
    expect(originPatternFor('http://127.0.0.1:19750/faucet')).toBe('http://127.0.0.1/*');
  });

  it('a closing slash on the base gives the same pattern as no closing slash', () => {
    expect(originPatternFor('https://notis.fun/testnet/faucet/')).toBe(
      originPatternFor('https://notis.fun/testnet/faucet'),
    );
  });

  it('https://example.org → https://example.org/*', () => {
    expect(originPatternFor('https://example.org')).toBe('https://example.org/*');
  });

  it("'' → null", () => {
    expect(originPatternFor('')).toBeNull();
  });

  it('throws on a relative base, and the message names originPatternFor', () => {
    expect(() => originPatternFor('/faucet')).toThrow(/originPatternFor/);
  });

  it('throws on a non-http(s) scheme, and the message names originPatternFor', () => {
    expect(() => originPatternFor('file:///faucet')).toThrow(/originPatternFor/);
  });

  it('throws on a base carrying a query, and the message names originPatternFor', () => {
    expect(() => originPatternFor('https://notis.fun/faucet?x=1')).toThrow(/originPatternFor/);
  });

  it('throws on a base carrying a fragment, and the message names originPatternFor', () => {
    expect(() => originPatternFor('https://notis.fun/faucet#top')).toThrow(/originPatternFor/);
  });

  it('http://[::1]:3000/faucet → http://[::1]/* (IPv6 literal, brackets kept)', () => {
    expect(originPatternFor('http://[::1]:3000/faucet')).toBe('http://[::1]/*');
  });
});
