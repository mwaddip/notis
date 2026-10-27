import { describe, it, expect } from 'vitest';
import type { NetConfig } from '../src/types.js';
import { MAGIC_TESTNET } from '../src/frame.js';

// NET_INTERFACE → Outbound Manager: the three peer-discovery knobs
// (`minPeers`, `peerDbCap`, `outboundRedialCooldownMs`) are required in
// NetConfig; net holds no default for any of them. A @ts-expect-error on a
// literal that leaves one out is only honoured when the field is required —
// an optional field makes the directive unused, which `tsc --noEmit` reports.

const base = {
  magic: MAGIC_TESTNET,
  protocolVersionSchedule: [{ version: 1, fromHeight: 0 }],
  orderingBlockPowTargetFloorBits: 2304,
  bootstrapPeers: [],
  listenAddrs: '/ip4/0.0.0.0/tcp/0',
  maxPeers: 10,
  penaltyScoreThreshold: 500,
  temporalBanDurationMs: 3_600_000,
  penaltyDecayIntervalMs: 120_000,
  syncRequestTimeoutMs: 10_000,
};

describe('NetConfig requires each of the three peer-discovery knobs', () => {
  it("tsc catches a literal that leaves minPeers, peerDbCap or outboundRedialCooldownMs out", () => {
    // @ts-expect-error minPeers is required
    const missingMinPeers: NetConfig = { ...base, peerDbCap: 1_000, outboundRedialCooldownMs: 60_000 };
    // @ts-expect-error peerDbCap is required
    const missingPeerDbCap: NetConfig = { ...base, minPeers: 3, outboundRedialCooldownMs: 60_000 };
    // @ts-expect-error outboundRedialCooldownMs is required
    const missingRedialCooldown: NetConfig = { ...base, minPeers: 3, peerDbCap: 1_000 };

    // Values exist at runtime so the compile-time directives above drive
    // the gate; this assertion keeps the literals from being flagged unused.
    expect([missingMinPeers, missingPeerDbCap, missingRedialCooldown].every(c => c.maxPeers === 10)).toBe(true);
  });
});
