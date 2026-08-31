import type { NetConfig } from '../src/types.js';
import { MAGIC_TESTNET } from '../src/frame.js';

/**
 * A NetConfig for tests — the values a plain node runs with. Pass `overrides`
 * for the few a case needs to differ (a distinct schedule, a smaller maxPeers,
 * a loopback listen address). One definition of the shape: a new NetConfig
 * field lands here, not in every test file.
 */
export function makeConfig(overrides: Partial<NetConfig> = {}): NetConfig {
  return {
    magic: MAGIC_TESTNET,
    protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
    bootstrapPeers: [],
    listenAddrs: '/ip4/0.0.0.0/tcp/0',
    maxPeers: 10,
    penaltyScoreThreshold: 500,
    temporalBanDurationMs: 3_600_000,
    penaltySafeIntervalMs: 120_000,
    syncRequestTimeoutMs: 10_000,
    ...overrides,
  };
}
