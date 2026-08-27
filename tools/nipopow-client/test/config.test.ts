import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError } from '../src/config.js';

function env(overrides: Record<string, string> = {}) {
  return {
    NETWORK_TYPE: 'devnet',
    NODE_URLS: 'http://a:3000,http://b:3001',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('parses valid minimal config', () => {
    const c = parseConfig([], env());
    expect(c.nodeUrls).toEqual(['http://a:3000', 'http://b:3001']);
    expect(c.profile.networkType).toBe('devnet');
    expect(c.m).toBe(6);
    expect(c.k).toBe(20);
    expect(c.user).toBeNull();
    expect(c.allowSingle).toBe(false);
    expect(c.json).toBe(false);
  });

  it('parses --m, --k, --user, --allow-single, --json', () => {
    const c = parseConfig(
      ['--m', '10', '--k', '5', '--user', 'ab'.repeat(32), '--allow-single', '--json'],
      env({ NODE_URLS: 'http://solo:3000' }),
    );
    expect(c.m).toBe(10);
    expect(c.k).toBe(5);
    expect(c.user).toBe('ab'.repeat(32));
    expect(c.allowSingle).toBe(true);
    expect(c.json).toBe(true);
  });

  it('refuses missing NETWORK_TYPE', () => {
    expect(() => parseConfig([], { NODE_URLS: 'http://a:3000,http://b:3001' }))
      .toThrow(ConfigError);
  });

  it('refuses unknown NETWORK_TYPE', () => {
    expect(() => parseConfig([], env({ NETWORK_TYPE: 'mars' })))
      .toThrow(ConfigError);
  });

  it('refuses missing NODE_URLS', () => {
    expect(() => parseConfig([], { NETWORK_TYPE: 'devnet' }))
      .toThrow(ConfigError);
  });

  it('refuses single node without --allow-single', () => {
    expect(() => parseConfig([], env({ NODE_URLS: 'http://solo:3000' })))
      .toThrow(ConfigError);
  });

  it('accepts single node with --allow-single', () => {
    const c = parseConfig(['--allow-single'], env({ NODE_URLS: 'http://solo:3000' }));
    expect(c.nodeUrls).toEqual(['http://solo:3000']);
  });

  it('refuses --m 0', () => {
    expect(() => parseConfig(['--m', '0'], env()))
      .toThrow(ConfigError);
  });

  it('refuses --m above MAX_NIPOPOW_PARAM', () => {
    expect(() => parseConfig(['--m', '129'], env()))
      .toThrow(ConfigError);
  });

  it('refuses --k above MAX_NIPOPOW_PARAM', () => {
    expect(() => parseConfig(['--k', '200'], env()))
      .toThrow(ConfigError);
  });

  it('refuses --user that is not 64 hex chars', () => {
    expect(() => parseConfig(['--user', 'xyz'], env()))
      .toThrow(ConfigError);
  });

  it('refuses hex notation in --m', () => {
    expect(() => parseConfig(['--m', '0x10'], env()))
      .toThrow(ConfigError);
  });

  it('refuses scientific notation in --k', () => {
    expect(() => parseConfig(['--k', '1e2'], env()))
      .toThrow(ConfigError);
  });

  it('refuses unknown argument', () => {
    expect(() => parseConfig(['--bad'], env()))
      .toThrow(ConfigError);
  });
});
