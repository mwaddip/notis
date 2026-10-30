// MESH_INTERFACE → The IP certificate — Pebble v2.8.0's config.
// `profiles` is a map keyed by name; each profile carries a
// `description` and a `validityPeriod` in seconds. The old
// `"profile": "shortlived"` top-level field was not Pebble's schema and
// was ignored (Pebble logged `Loaded profile "default" with certificate
// validity period of 7776000 seconds`).
//
// Pebble selects the profile named by the newOrder's `profile` field;
// an order without one gets `default`. Scenario 4 drives mesh-node
// behaviour so pub1 can observe a renewal mid-run: `shortlived`'s
// lifetime is 180 s (3 min) so a renewer at half lifetime fires at
// 90 s. `default` stays near Pebble's reference value for every other
// client.

export const SHORTLIVED_VALIDITY_SECONDS = 180;
export const DEFAULT_VALIDITY_SECONDS = 7776000;

export function buildPebbleConfig({
  listenAddress,
  managementListenAddress,
  httpChallengePort,
  tlsPort = 5001,
  certificatePath,
  privateKeyPath,
}) {
  if (typeof listenAddress !== 'string' || listenAddress === '') throw new Error('buildPebbleConfig: listenAddress required');
  if (typeof managementListenAddress !== 'string' || managementListenAddress === '') throw new Error('buildPebbleConfig: managementListenAddress required');
  if (typeof httpChallengePort !== 'number') throw new Error('buildPebbleConfig: httpChallengePort required');
  if (typeof certificatePath !== 'string' || certificatePath === '') throw new Error('buildPebbleConfig: certificatePath required');
  if (typeof privateKeyPath !== 'string' || privateKeyPath === '') throw new Error('buildPebbleConfig: privateKeyPath required');
  return {
    pebble: {
      listenAddress,
      managementListenAddress,
      httpPort: httpChallengePort,
      tlsPort,
      ocspResponderURL: '',
      profiles: {
        default: {
          description: 'The profile Pebble serves when the newOrder does not name one',
          validityPeriod: DEFAULT_VALIDITY_SECONDS,
        },
        shortlived: {
          description: 'A short-lived cert so a scenario-driven renewer fires at half lifetime',
          validityPeriod: SHORTLIVED_VALIDITY_SECONDS,
        },
      },
      certificate: certificatePath,
      privateKey: privateKeyPath,
    },
  };
}
