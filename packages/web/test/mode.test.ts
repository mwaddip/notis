// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { decideMode } from '../src/mode';

const ID = 'a'.repeat(64);

describe('decideMode', () => {
  it('standalone with base / and a 64-hex id', () => {
    const m = decideMode('/p/' + ID, '/');
    expect(m).toEqual({ kind: 'standalone', id: ID });
  });

  it('standalone with base /web/ and a 64-hex id', () => {
    const m = decideMode('/web/p/' + ID, '/web/');
    expect(m).toEqual({ kind: 'standalone', id: ID });
  });

  it('upper-case hex is lowered', () => {
    const upper = 'A'.repeat(64);
    const m = decideMode('/p/' + upper, '/');
    expect(m).toEqual({ kind: 'standalone', id: ID });
  });

  it('a 63-char id is workspace', () => {
    expect(decideMode('/p/' + 'a'.repeat(63), '/').kind).toBe('workspace');
  });

  it('a trailing slash is workspace', () => {
    expect(decideMode('/p/' + ID + '/', '/').kind).toBe('workspace');
  });

  it('the base alone is workspace', () => {
    expect(decideMode('/', '/').kind).toBe('workspace');
    expect(decideMode('/web/', '/web/').kind).toBe('workspace');
  });

  it('a non-hex id is workspace', () => {
    expect(decideMode('/p/' + 'g'.repeat(64), '/').kind).toBe('workspace');
  });
});
