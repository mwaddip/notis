// MESH_INTERFACE → The IP certificate — Pebble v2.8's config holds a
// `profiles` map keyed by name; each profile carries a `validityPeriod`
// in seconds. The old `"profile": "shortlived"` field was ignored and
// Pebble served its default 90-day certificate. The stage builds the
// `profiles` map with both `default` and `shortlived` so scenario 4 can
// request short-lived certs and see a renewal mid-run.

import { describe, expect, it } from 'vitest';
import {
  buildPebbleConfig,
  SHORTLIVED_VALIDITY_SECONDS,
  DEFAULT_VALIDITY_SECONDS,
} from '../stage/lib/pebble-config.mjs';

describe('stage/lib/pebble-config.mjs', () => {
  it('writes a profiles map with shortlived and default', () => {
    const cfg = buildPebbleConfig({
      listenAddress: '10.100.0.21:14000',
      managementListenAddress: '10.100.0.21:15000',
      httpChallengePort: 5002,
      certificatePath: '/x/cert.pem',
      privateKeyPath: '/x/key.pem',
    });
    expect(cfg.pebble.profiles, 'profiles map is present').toBeDefined();
    expect(cfg.pebble.profiles.shortlived, 'shortlived profile').toBeDefined();
    expect(typeof cfg.pebble.profiles.shortlived!.validityPeriod).toBe('number');
    expect(cfg.pebble.profiles.shortlived!.validityPeriod, 'shortlived validityPeriod > 0').toBeGreaterThan(0);
    expect(cfg.pebble.profiles.default, 'default profile').toBeDefined();
    expect(typeof cfg.pebble.profiles.default!.validityPeriod).toBe('number');
  });

  it('shortlived is short enough for a scenario to see a renewal', () => {
    // Mesh node renews at half lifetime; scenario 4 runs on the order
    // of a few minutes, so the shortlived validity is a few minutes.
    expect(SHORTLIVED_VALIDITY_SECONDS, 'shortlived under 15 minutes').toBeLessThan(15 * 60);
    expect(SHORTLIVED_VALIDITY_SECONDS, 'shortlived at least 60 seconds').toBeGreaterThanOrEqual(60);
  });

  it('default sits near the Pebble reference (90 days)', () => {
    // Pebble's test config carries 7776000 (90 days). Keeping it close
    // lets `default` behave as the Pebble reference would.
    expect(DEFAULT_VALIDITY_SECONDS, 'default around 90 days').toBeGreaterThan(60 * 60 * 24);
  });

  it('carries certificate, privateKey, listenAddress and management from its options', () => {
    const cfg = buildPebbleConfig({
      listenAddress: '10.0.0.1:14000',
      managementListenAddress: '10.0.0.1:15000',
      httpChallengePort: 5002,
      certificatePath: '/a/cert.pem',
      privateKeyPath: '/a/key.pem',
    });
    expect(cfg.pebble.listenAddress).toBe('10.0.0.1:14000');
    expect(cfg.pebble.managementListenAddress).toBe('10.0.0.1:15000');
    expect(cfg.pebble.certificate).toBe('/a/cert.pem');
    expect(cfg.pebble.privateKey).toBe('/a/key.pem');
    expect(cfg.pebble.httpPort).toBe(5002);
  });
});
