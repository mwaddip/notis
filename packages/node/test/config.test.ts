import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NETWORK_PROFILES,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  AVL_KEY_LENGTH,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
} from '@dagsocial/types';

const TEST_KEYS = [
  'PORT',
  'DB_PATH',
  'CHALLENGE_WINDOW_BLOCKS',
  'ORDERING_BLOCK_INTERVAL_MS',
  'ORDERING_BLOCK_MIN_SUB_BLOCKS',
  'MAX_SUB_BLOCKS_PER_BLOCK',
  'MAX_MEMPOOL_ENTRIES',
  'NETWORK_TYPE',
  'MINING_SECRET',
  'MINING_MODE',
  'NODE_ROLE',
  // Dead: consensus values are selected by NETWORK_TYPE, never set
  // individually. Section 7 sets these to prove they are ignored.
  'POST_POW_TARGET_BITS',
  'ORDERING_BLOCK_POW_TARGET_BITS',
  'KARMA_DECAY_INTERVAL_BLOCKS',
  'KARMA_STALE_THRESHOLD_BLOCKS',
  'KARMA_DECAY_AMOUNT',
  'KARMA_MINIMUM',
  'CREDIT_TREASURY_PCT',
  'CREDIT_INITIAL_REWARD',
  'TREASURY_PUBKEY',
  'AVL_KEY_LENGTH',
];

function clearTestEnv() {
  for (const key of TEST_KEYS) {
    delete process.env[key];
  }
}

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    clearTestEnv();
  });

  describe('1. defaults', () => {
    it('returns defaults when no env vars are set', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(3000);
      expect(cfg.dbPath).toBe('dagsocial.db');
      expect(cfg.postPowTargetBits).toBe(20);
      expect(cfg.challengeWindowBlocks).toBe(10);
      expect(cfg.orderingBlockIntervalMs).toBe(60000);
      expect(cfg.orderingBlockMinSubBlocks).toBe(1);
      expect(cfg.maxSubBlocksPerBlock).toBe(1000);
      expect(cfg.maxMempoolEntries).toBe(10000);
      expect(cfg.networkType).toBe('testnet');
      // toEqual, not toBe: vi.resetModules() gives the dynamically imported
      // config a fresh @dagsocial/types instance, so table identity does not
      // hold across the boundary — structural equality is the assertion.
      expect(cfg.profile).toEqual(NETWORK_PROFILES.testnet);
      expect(cfg.miningSecret).toBe('');
    });
  });

  describe('2. env overrides (operational and local vars only)', () => {
    it('reads overrides from env vars', async () => {
      process.env['PORT'] = '8080';
      process.env['DB_PATH'] = '/tmp/test.db';
      process.env['CHALLENGE_WINDOW_BLOCKS'] = '5';
      process.env['ORDERING_BLOCK_INTERVAL_MS'] = '30000';
      process.env['ORDERING_BLOCK_MIN_SUB_BLOCKS'] = '3';
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] = '500';
      process.env['MAX_MEMPOOL_ENTRIES'] = '25';
      process.env['NETWORK_TYPE'] = 'mainnet';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(8080);
      expect(cfg.dbPath).toBe('/tmp/test.db');
      expect(cfg.challengeWindowBlocks).toBe(5);
      expect(cfg.orderingBlockIntervalMs).toBe(30000);
      expect(cfg.orderingBlockMinSubBlocks).toBe(3);
      expect(cfg.maxSubBlocksPerBlock).toBe(500);
      expect(cfg.maxMempoolEntries).toBe(25);
      expect(cfg.networkType).toBe('mainnet');
      expect(cfg.miningSecret).toBe('sekret');
    });
  });

  describe('3. numeric parsing', () => {
    it('parses numeric strings correctly', async () => {
      process.env['PORT'] = '3001';
      process.env['ORDERING_BLOCK_INTERVAL_MS'] = '120000';
      process.env['MAX_SUB_BLOCKS_PER_BLOCK'] = '2000';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(typeof cfg.port).toBe('number');
      expect(cfg.port).toBe(3001);
      expect(cfg.orderingBlockIntervalMs).toBe(120000);
      expect(cfg.maxSubBlocksPerBlock).toBe(2000);
    });
  });

  describe('4. port is integer', () => {
    it('port is an integer', async () => {
      process.env['PORT'] = '3000';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(Number.isInteger(cfg.port)).toBe(true);
    });
  });

  // Each throwing case below has a control differing only in the guarded field.
  describe('5. mining auth fail-fast (audit M-7)', () => {
    it('throws when an external-mode miner has no MINING_SECRET', async () => {
      // Import under a safe env so module-level `config` builds, then flip.
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      delete process.env['MINING_SECRET'];

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('throws when MINING_SECRET is whitespace only', async () => {
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      process.env['MINING_SECRET'] = '   ';

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('fails at startup: importing config with that env rejects', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      delete process.env['MINING_SECRET'];

      await expect(import('../src/config.js')).rejects.toThrow(/MINING_SECRET/);
    });

    it('control: same env with a secret loads', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'external';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.miningMode).toBe('external');
      expect(cfg.miningSecret).toBe('sekret');
    });

    it('control: internal-mode miner loads without a secret', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_MODE'] = 'internal';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.miningMode).toBe('internal');
      expect(cfg.miningSecret).toBe('');
    });

    it('control: server role in external mode loads without a secret', async () => {
      process.env['NODE_ROLE'] = 'server';
      process.env['MINING_MODE'] = 'external';

      const { loadConfig } = await import('../src/config.js');

      expect(() => loadConfig()).not.toThrow();
    });
  });

  // NETWORK_TYPE selects the whole consensus parameter table at once
  // (ARCHITECTURE → Network Identity). Two operators who agree on it cannot
  // differ on anything it selects; one who sets an unknown value gets a dead
  // node, not a default network.
  describe('6. network profile selection (P2-A)', () => {
    it('resolves the testnet profile by default', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('testnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.testnet);
      expect(cfg.profile.magic).toBe(MAGIC_TESTNET);
      // Baked literals, so this fails if testnet ever stops inheriting these
      // from mainnet. Both networks build them from the same constants, which
      // is what keeps profile-sourcing them a devnet-only consensus change.
      expect(cfg.vouchCooldownBlocks).toBe(60);
      expect(cfg.inviteProbationBlocks).toBe(1000);
      expect(cfg.creditMinerRewardDelay).toBe(720);
      expect(cfg.creditFixedRateBlocks).toBe(1_051_200);
      expect(cfg.creditEpochBlocks).toBe(129_600);
    });

    it('NETWORK_TYPE=devnet resolves the devnet profile and copies its values', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('devnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.devnet);
      expect(cfg.profile.magic).toBe(MAGIC_DEVNET);
      // The flat consensus fields are copies OF the profile, not parallel
      // reads: each must equal the devnet table entry, not testnet's.
      expect(cfg.postPowTargetBits).toBe(4);
      expect(cfg.orderingBlockPowTargetBits).toBe(4);
      expect(cfg.karmaDecayIntervalBlocks).toBe(3);
      expect(cfg.karmaStaleThresholdBlocks).toBe(500);
      expect(cfg.vouchCooldownBlocks).toBe(3);
      expect(cfg.inviteProbationBlocks).toBe(10);
      expect(cfg.creditMinerRewardDelay).toBe(10);
      expect(cfg.creditFixedRateBlocks).toBe(1000);
      expect(cfg.creditEpochBlocks).toBe(100);
    });

    // The flat fields above are only half the claim: a consumer that still
    // reads the module constant leaves them defined and unused. `computeBlockReward`
    // is the one consumer reachable without a database, and it runs on the apply
    // path of nodes that never start a block creator — so it reads the process
    // config, not the injected one.
    it('the emission schedule a consumer computes follows NETWORK_TYPE', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';
      const { computeBlockReward } = await import('../src/services/block-creator.js');

      // devnet's fixed-rate period ends at 1000, so 1001 is one epoch in.
      expect(computeBlockReward(1000)).toBe(CREDIT_INITIAL_REWARD);
      expect(computeBlockReward(1001)).toBe(
        CREDIT_INITIAL_REWARD - CREDIT_REWARD_REDUCTION,
      );
    });

    it('the same heights are still fixed-rate on testnet', async () => {
      process.env['NETWORK_TYPE'] = 'testnet';
      const { computeBlockReward } = await import('../src/services/block-creator.js');

      expect(computeBlockReward(1001)).toBe(CREDIT_INITIAL_REWARD);
    });

    it('NETWORK_TYPE=mainnet resolves the mainnet profile', async () => {
      process.env['NETWORK_TYPE'] = 'mainnet';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.networkType).toBe('mainnet');
      expect(cfg.profile).toEqual(NETWORK_PROFILES.mainnet);
      expect(cfg.profile.magic).toBe(MAGIC_MAINNET);
    });

    it('throws for an unrecognised NETWORK_TYPE — never falls back', async () => {
      // Import under a safe env so module-level `config` builds, then flip.
      const { loadConfig } = await import('../src/config.js');

      process.env['NETWORK_TYPE'] = 'regtest';

      expect(() => loadConfig()).toThrow(/Unknown network type/);
    });

    it('fails at startup: importing config with a bad NETWORK_TYPE rejects', async () => {
      process.env['NETWORK_TYPE'] = 'regtest';

      await expect(import('../src/config.js')).rejects.toThrow(/Unknown network type/);
    });

    it('control: importing config with a known NETWORK_TYPE resolves', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';

      const { config } = await import('../src/config.js');

      expect(config.networkType).toBe('devnet');
    });
  });

  // NODE_INTERFACE → Configuration removed all TEN of these from the
  // environment: five became network-profile fields, five became universal
  // constants in `@dagsocial/types`. Setting any of them must change nothing.
  // Expected values are baked literals rather than reads of the same constants,
  // so a silent constant change fails here too.
  //
  // ⚠ Ten are set below and nine are asserted — `CREDIT_INITIAL_REWARD` has no
  // matching `expect`, so it is the one variable this section names without
  // covering.
  describe('7. consensus env reads are dead (P2-A)', () => {
    it('ignores every formerly-readable consensus variable', async () => {
      process.env['NETWORK_TYPE'] = 'testnet';
      process.env['POST_POW_TARGET_BITS'] = '1';
      process.env['ORDERING_BLOCK_POW_TARGET_BITS'] = '1';
      process.env['KARMA_DECAY_INTERVAL_BLOCKS'] = '1';
      process.env['KARMA_STALE_THRESHOLD_BLOCKS'] = '1';
      process.env['KARMA_DECAY_AMOUNT'] = '999';
      process.env['KARMA_MINIMUM'] = '999';
      process.env['CREDIT_TREASURY_PCT'] = '99';
      process.env['CREDIT_INITIAL_REWARD'] = '1';
      process.env['TREASURY_PUBKEY'] = 'ff'.repeat(32);
      process.env['AVL_KEY_LENGTH'] = '16';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.postPowTargetBits).toBe(20);
      expect(cfg.orderingBlockPowTargetBits).toBe(12);
      expect(cfg.karmaDecayIntervalBlocks).toBe(1440);
      expect(cfg.karmaStaleThresholdBlocks).toBe(40320);
      expect(cfg.karmaDecayAmount).toBe(5n);
      expect(cfg.karmaMinimum).toBe(10n);
      expect(cfg.creditTreasuryPct).toBe(10);
      expect(cfg.treasuryPubKey).toBe('');
      expect(cfg.avlKeyLength).toBe(32);
    });
  });

  // AVL_KEY_LENGTH sets the shape of every stateRoot, so the authoritative
  // definition lives in @dagsocial/types (TYPES_INTERFACE → State format) and
  // config only plumbs it. Comparing the plumbed field against the import goes
  // red if config.ts regrows a local definition that diverges — section 7's
  // baked 32 cannot catch the converse drift (types moves, a stale local pin
  // keeps node at 32 and 32 === 32 still passes).
  describe('8. avlKeyLength originates in @dagsocial/types', () => {
    it('plumbs the AVL_KEY_LENGTH export, not a local definition', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.avlKeyLength).toBe(AVL_KEY_LENGTH);
    });
  });

  // The treasury key reaches `CoinbaseOutput.owner`, whose writer demands
  // exactly 32 bytes, through a `Buffer.from(s, 'hex')` that truncates at the
  // first pair outside the alphabet instead of failing. The profile table is
  // its only source, so the profile is what these mock — a value no env var
  // can set is still a value a chain's genesis data can carry.
  describe('9. treasury key fail-fast (carried #14)', () => {
    // `config.ts` ends in `export const config = loadConfig()`, so the refusal
    // lands on the import — the same shape section 5 asserts for MINING_SECRET,
    // and the reason this is a startup failure rather than a mining-time one.
    function importWithTreasuryKey(treasuryPubKey: string) {
      vi.doMock('@dagsocial/types', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@dagsocial/types')>();
        return {
          ...actual,
          profileFor: (networkType: string) => ({
            ...actual.profileFor(networkType as never),
            treasuryPubKey,
          }),
        };
      });
      return import('../src/config.js');
    }

    it('accepts a 64-character hex key', async () => {
      const { loadConfig } = await importWithTreasuryKey('ab'.repeat(32));
      expect(loadConfig().treasuryPubKey).toBe('ab'.repeat(32));
    });

    it('accepts an empty key — no treasury is configured', async () => {
      const { loadConfig } = await importWithTreasuryKey('');
      expect(loadConfig().treasuryPubKey).toBe('');
    });

    // 64 characters, 0 bytes out of `Buffer.from(…, 'hex')`. A width check
    // passes it; the coinbase leaf writer does not.
    it('refuses 64 non-hex characters', async () => {
      await expect(importWithTreasuryKey('z'.repeat(64))).rejects.toThrow(
        /treasuryPubKey/,
      );
    });

    // 64 characters, 31 bytes — the near-miss a width check cannot see at all.
    it('refuses 62 hex characters followed by a non-hex pair', async () => {
      await expect(importWithTreasuryKey('ab'.repeat(31) + 'zz')).rejects.toThrow(
        /treasuryPubKey/,
      );
    });

    it('refuses a short hex key', async () => {
      await expect(importWithTreasuryKey('ab'.repeat(16))).rejects.toThrow(
        /treasuryPubKey/,
      );
    });
  });
});
