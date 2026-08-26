import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NETWORK_PROFILES,
  MAGIC_MAINNET,
  MAGIC_TESTNET,
  MAGIC_DEVNET,
  AVL_KEY_LENGTH,
  CREDIT_INITIAL_REWARD,
  CREDIT_REWARD_REDUCTION,
  MAX_BLOCK_BODY_BYTES,
  MAX_REORG_DEPTH,
  ORDERING_BLOCK_POW_TARGET_FLOOR,
} from '@dagsocial/types';

const TEST_KEYS = [
  'PORT',
  'DB_PATH',
  'BLOCK_BODY_BUDGET_BYTES',
  'MAX_MEMPOOL_ENTRIES',
  'NETWORK_TYPE',
  'MINING_SECRET',
  'NODE_ROLE',
  // Dead: consensus values are selected by NETWORK_TYPE, never set
  // individually. Section 7 sets these to prove they are ignored.
  //
  // ⚠ These are ENVIRONMENT VARIABLE names, and an entry does not track the
  // constant a live read of it once reached — `CREDIT_TREASURY_PCT` is the
  // string an operator may still carry in a `.env`, which is the only thing
  // that makes asserting it inert worth anything. Renaming one to follow a
  // constant leaves the guard pointed at a variable nobody has ever set.
  'ORDERING_BLOCK_POW_TARGET_BITS',
  'KARMA_DECAY_INTERVAL_BLOCKS',
  'KARMA_STALE_THRESHOLD_BLOCKS',
  'KARMA_DECAY_AMOUNT',
  'KARMA_MINIMUM',
  'CREDIT_TREASURY_PCT',
  'CREDIT_INITIAL_REWARD',
  'TREASURY_PUBKEY',
  'AVL_KEY_LENGTH',
  'MAX_PROOF_HISTORY',
];

function clearTestEnv() {
  for (const key of TEST_KEYS) {
    delete process.env[key];
  }
}

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    // `resetModules` drops the module registry but not the mock registry, so a
    // `vi.doMock('@dagsocial/types', …)` registered by one section is still
    // installed for every test after it. Each section that wants a mocked
    // profile registers its own inside the test body, after this runs.
    vi.doUnmock('@dagsocial/types');
    clearTestEnv();
  });

  describe('1. defaults', () => {
    it('returns defaults when no env vars are set', async () => {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(3000);
      expect(cfg.dbPath).toBe('dagsocial.db');
      expect(cfg.blockBodyBudgetBytes).toBe(MAX_BLOCK_BODY_BYTES);
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
      process.env['BLOCK_BODY_BUDGET_BYTES'] = '500';
      process.env['MAX_MEMPOOL_ENTRIES'] = '25';
      process.env['NETWORK_TYPE'] = 'mainnet';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.port).toBe(8080);
      expect(cfg.dbPath).toBe('/tmp/test.db');
      expect(cfg.blockBodyBudgetBytes).toBe(500);
      expect(cfg.maxMempoolEntries).toBe(25);
      expect(cfg.networkType).toBe('mainnet');
      expect(cfg.miningSecret).toBe('sekret');
    });
  });

  describe('3. numeric parsing', () => {
    it('parses numeric strings correctly', async () => {
      process.env['PORT'] = '3001';
      process.env['BLOCK_BODY_BUDGET_BYTES'] = '2000';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(typeof cfg.port).toBe('number');
      expect(cfg.port).toBe(3001);
      expect(cfg.blockBodyBudgetBytes).toBe(2000);
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
    it('throws when a miner has no MINING_SECRET', async () => {
      // Import under a safe env so module-level `config` builds, then flip.
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      delete process.env['MINING_SECRET'];

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('throws when MINING_SECRET is whitespace only', async () => {
      const { loadConfig } = await import('../src/config.js');

      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_SECRET'] = '   ';

      expect(() => loadConfig()).toThrow(/MINING_SECRET/);
    });

    it('fails at startup: importing config with that env rejects', async () => {
      process.env['NODE_ROLE'] = 'miner';
      delete process.env['MINING_SECRET'];

      await expect(import('../src/config.js')).rejects.toThrow(/MINING_SECRET/);
    });

    it('control: same env with a secret loads', async () => {
      process.env['NODE_ROLE'] = 'miner';
      process.env['MINING_SECRET'] = 'sekret';

      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();

      expect(cfg.miningSecret).toBe('sekret');
    });

    it('control: a server role loads without a secret', async () => {
      process.env['NODE_ROLE'] = 'server';

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
      expect(cfg.inviteProbationBlocks).toBe(43200);
      expect(cfg.creditMinerRewardDelay).toBe(1440);
      expect(cfg.creditFixedRateBlocks).toBe(1_051_200);
      expect(cfg.creditEpochBlocks).toBe(470_000);
      expect(cfg.creditEmissionTotal).toBe(422_640_000n * 10n ** 8n);
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
      //
      // All nine discriminate, `orderingBlockPowTargetBits` included: devnet's
      // 3072 is below testnet's 5984 (TYPES_INTERFACE → Network profiles), so a
      // read sourced from the wrong profile fails here. The target is in units
      // of 1/256 of a bit.
      expect(cfg.orderingBlockPowTargetBits).toBe(3072);
      expect(cfg.karmaDecayIntervalBlocks).toBe(3);
      expect(cfg.karmaStaleThresholdBlocks).toBe(500);
      expect(cfg.vouchCooldownBlocks).toBe(3);
      expect(cfg.inviteProbationBlocks).toBe(540);
      expect(cfg.creditMinerRewardDelay).toBe(10);
      expect(cfg.creditFixedRateBlocks).toBe(1000);
      expect(cfg.creditEpochBlocks).toBe(400);
      expect(cfg.creditEmissionTotal).toBe(362_000n * 10n ** 8n);
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
  // ⚠ Nine are set below and seven are asserted. `CREDIT_INITIAL_REWARD` has no
  // matching `expect`; `CREDIT_TREASURY_PCT` has no `Config` field left to
  // assert against, since the coinbase's percentages are read straight from
  // `@dagsocial/types` and nothing plumbs them. Both are still set here, which
  // is what this section is for — the guard is that an operator's stale `.env`
  // changes nothing, and that holds whether or not a field survives to name.
  describe('7. consensus env reads are dead (P2-A)', () => {
    it('ignores every formerly-readable consensus variable', async () => {
      process.env['NETWORK_TYPE'] = 'testnet';
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
      // 1/256-bit units, so 23.375 bits (VALIDATION_INTERFACE →
      // orderingPowTarget).
      expect(cfg.orderingBlockPowTargetBits).toBe(5984);
      expect(cfg.karmaDecayIntervalBlocks).toBe(1440);
      expect(cfg.karmaStaleThresholdBlocks).toBe(40320);
      expect(cfg.karmaDecayAmount).toBe(5n);
      expect(cfg.karmaMinimum).toBe(10n);
      expect(cfg.avlKeyLength).toBe(32);

      // `TREASURY_PUBKEY` has no `Config` field to assert against: the treasury
      // is a box no key can spend (ARCHITECTURE → Treasury), so no field on any
      // profile names it. Scanning the values is what catches a reintroduction
      // under **any** name — the guard here is that the variable reaches
      // nothing, which is a stronger claim than one named field ignoring it.
      expect(Object.values(cfg)).not.toContain('ff'.repeat(32));
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

  // The producer half of the ordering-block floor. `verifyOrderingBlockStructure`
  // refuses an arriving header below it (VALIDATION_INTERFACE →
  // orderingPowTarget); `expectedTarget()` returns the configured value
  // unchecked, so a profile below the floor builds templates this node's own
  // verifier — and every peer's — refuses: a node that stays up, mines, and
  // never produces. The profile table is the only source, so the profile is
  // what this mocks.
  describe('9. ordering-block target floor', () => {
    // Refusal, never clamping: silently raising a below-floor value mines the
    // chain against a target nobody configured. `config.ts` ends in
    // `export const config = loadConfig()`, so the refusal lands on the import.
    function importWithOrderingTarget(orderingBlockPowTargetBits: number) {
      vi.doMock('@dagsocial/types', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@dagsocial/types')>();
        return {
          ...actual,
          profileFor: (networkType: string) => ({
            ...actual.profileFor(networkType as never),
            orderingBlockPowTargetBits,
          }),
        };
      });
      return import('../src/config.js');
    }

    it('refuses to start on a profile whose ordering target is below the floor', async () => {
      await expect(
        importWithOrderingTarget(ORDERING_BLOCK_POW_TARGET_FLOOR - 1),
      ).rejects.toThrow(/below the ordering-block floor/i);
    });

    // The floor is admissible, so the comparison is `<` and not `<=`.
    it('accepts a profile sitting exactly on the floor', async () => {
      const { loadConfig } = await importWithOrderingTarget(
        ORDERING_BLOCK_POW_TARGET_FLOOR,
      );
      expect(loadConfig().orderingBlockPowTargetBits).toBe(
        ORDERING_BLOCK_POW_TARGET_FLOOR,
      );
    });
  });

  // The genesis proof payload's domain. `Buffer.from(s, 'hex')` stops at the
  // first character pair outside the alphabet instead of failing, and `writeLp`
  // is total by sentinel rather than throwing, so a malformed payload moves the
  // genesis state root with nothing raised anywhere.
  describe('10. genesis proof payload fail-fast', () => {
    function importWithProofPayload(genesisProofPayload: string) {
      vi.doMock('@dagsocial/types', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@dagsocial/types')>();
        return {
          ...actual,
          profileFor: (networkType: string) => ({
            ...actual.profileFor(networkType as never),
            genesisProofPayload,
          }),
        };
      });
      return import('../src/config.js');
    }

    it('accepts an even-length hex payload', async () => {
      const { loadConfig } = await importWithProofPayload('deadbeef');
      expect(loadConfig().profile.genesisProofPayload).toBe('deadbeef');
    });

    it('refuses an odd-length payload', async () => {
      await expect(importWithProofPayload('abc')).rejects.toThrow(/genesisProofPayload/);
    });

    it('refuses a non-hex payload', async () => {
      await expect(importWithProofPayload('zzzz')).rejects.toThrow(/genesisProofPayload/);
    });

    // ⚠ **The empty payload is the one that collapses two networks, and it is
    // the case a `*` quantifier admits.** testnet and devnet share the system
    // keypair and both box values, so their karma and credit boxes are
    // byte-identical and carry the same ids — the proof box is the entire
    // difference between their genesis states. An empty payload still encodes
    // cleanly, to the same bytes on both, so the two roots collide silently and
    // nothing downstream has anything left to tell them apart.
    it('refuses an empty payload', async () => {
      await expect(importWithProofPayload('')).rejects.toThrow(/genesisProofPayload/);
    });

    it('says why an empty payload is refused, not just that it is malformed', async () => {
      let message = '';
      try { await importWithProofPayload(''); } catch (err) { message = String(err); }
      expect(message).toMatch(/non-empty/i);
      expect(message).toMatch(/collapses/i);
    });

    // `network.test.ts` requires one or more hex pairs of the same profile
    // strings. Two guards on one rule must not disagree, and the fail-stop is
    // the one that must not be the permissive half.
    it('agrees with the profile table\'s own shape check', async () => {
      for (const profile of Object.values(NETWORK_PROFILES)) {
        expect(profile.genesisProofPayload, profile.networkType)
          .toMatch(/^([0-9a-f]{2})+$/);
      }
    });
  });

  // `checkpointProver` prunes AVL versions below `height - maxProofHistory`;
  // `findForkPoint` walks back a fixed `MAX_REORG_DEPTH` and can answer height
  // 0. A `MAX_PROOF_HISTORY` under that depth prunes inside the window the walk
  // still answers within, so `reorg` finds no version at its fork height and
  // aborts with the node still on its own chain. Refusal at load is what makes
  // that unreachable rather than merely loud.
  describe('11. proof history covers the reorg depth', () => {
    function importWithProofHistory(value: string) {
      process.env['MAX_PROOF_HISTORY'] = value;
      return import('../src/config.js');
    }

    it('refuses a MAX_PROOF_HISTORY below MAX_REORG_DEPTH', async () => {
      await expect(
        importWithProofHistory(String(MAX_REORG_DEPTH - 1)),
      ).rejects.toThrow(/below MAX_REORG_DEPTH/);
    });

    // The depth itself is admissible — the walk's deepest answer is exactly the
    // oldest version retained — so the comparison is `<` and not `<=`.
    it('accepts a MAX_PROOF_HISTORY sitting exactly on MAX_REORG_DEPTH', async () => {
      const { loadConfig } = await importWithProofHistory(String(MAX_REORG_DEPTH));
      expect(loadConfig().maxProofHistory).toBe(MAX_REORG_DEPTH);
    });

    // `parseInt` answers `NaN`, and `NaN < MAX_REORG_DEPTH` is false — a `<`
    // would admit the one value that makes every pruning height `NaN`.
    it('refuses a non-numeric MAX_PROOF_HISTORY', async () => {
      await expect(importWithProofHistory('later')).rejects.toThrow(
        /below MAX_REORG_DEPTH/,
      );
    });

    it('says which two numbers are out of order', async () => {
      let message = '';
      try { await importWithProofHistory('0'); } catch (err) { message = String(err); }
      expect(message).toMatch(/MAX_PROOF_HISTORY/);
      expect(message).toMatch(/MAX_REORG_DEPTH/);
    });

    // The shipped default must not be one env var away from the refusal.
    it('the default clears the depth', async () => {
      delete process.env['MAX_PROOF_HISTORY'];
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().maxProofHistory).toBeGreaterThanOrEqual(MAX_REORG_DEPTH);
    });
  });

  describe('12. block body budget is clamped to the consensus bound', () => {
    function importWithBudget(value: string) {
      process.env['BLOCK_BODY_BUDGET_BYTES'] = value;
      return import('../src/config.js');
    }

    // A node cannot raise its own consensus bound: above the ceiling, the ask
    // is read as "as much as the rules allow" rather than refused, because that
    // is the one legal value it names.
    it('clamps a budget above MAX_BLOCK_BODY_BYTES', async () => {
      const { loadConfig } = await importWithBudget(String(MAX_BLOCK_BODY_BYTES + 1));
      expect(loadConfig().blockBodyBudgetBytes).toBe(MAX_BLOCK_BODY_BYTES);
    });

    // The bound itself is admissible — the clamp is `min`, not `<`.
    it('honours a budget sitting exactly on MAX_BLOCK_BODY_BYTES', async () => {
      const { loadConfig } = await importWithBudget(String(MAX_BLOCK_BODY_BYTES));
      expect(loadConfig().blockBodyBudgetBytes).toBe(MAX_BLOCK_BODY_BYTES);
    });

    it('honours a smaller budget — a miner may publish smaller blocks', async () => {
      const { loadConfig } = await importWithBudget('64000');
      expect(loadConfig().blockBodyBudgetBytes).toBe(64_000);
    });

    // Refused rather than clamped or defaulted: `parseInt` answers `NaN`, every
    // comparison against it is false, and a budget nothing fits inside builds
    // empty blocks for as long as the node runs.
    it('refuses a non-numeric budget', async () => {
      await expect(importWithBudget('plenty')).rejects.toThrow(
        /BLOCK_BODY_BUDGET_BYTES/,
      );
    });

    it('refuses a zero or negative budget', async () => {
      await expect(importWithBudget('0')).rejects.toThrow(/BLOCK_BODY_BUDGET_BYTES/);
      vi.resetModules();
      await expect(importWithBudget('-1')).rejects.toThrow(/BLOCK_BODY_BUDGET_BYTES/);
    });
  });
  describe('13. the invite caps and the faucet identity reach config', () => {
    // The absence of a faucet identity IS mainnet's gate — no second boolean
    // states the same fact, so this is the whole of it.
    it('mainnet carries no faucet identity', async () => {
      process.env['NETWORK_TYPE'] = 'mainnet';
      const { loadConfig } = await import('../src/config.js');
      expect(loadConfig().faucetPublicKey).toBeUndefined();
    });

    // Copies OF the profile, not parallel reads — the same claim section 6
    // makes about the nine consensus fields, extended to the three this unit
    // adds. testnet and devnet disagree on both caps, so a read sourced from
    // the wrong profile fails here.
    it('testnet copies its caps and its faucet key from the profile', async () => {
      process.env['NETWORK_TYPE'] = 'testnet';
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();
      expect(cfg.inviteBondMin).toBe(NETWORK_PROFILES.testnet.inviteBondMin);
      expect(cfg.inviteBondMax).toBe(NETWORK_PROFILES.testnet.inviteBondMax);
      expect(cfg.faucetPublicKey).toBe(NETWORK_PROFILES.testnet.faucetPublicKey);
    });

    it('devnet copies its own, which are not testnet\'s', async () => {
      process.env['NETWORK_TYPE'] = 'devnet';
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();
      expect(cfg.inviteBondMin).toBe(NETWORK_PROFILES.devnet.inviteBondMin);
      expect(cfg.inviteBondMax).toBe(NETWORK_PROFILES.devnet.inviteBondMax);
      expect(cfg.faucetPublicKey).toBe(NETWORK_PROFILES.devnet.faucetPublicKey);
      expect(cfg.inviteBondMin).not.toBe(NETWORK_PROFILES.testnet.inviteBondMin);
      expect(cfg.inviteBondMax).not.toBe(NETWORK_PROFILES.testnet.inviteBondMax);
    });

    // A ceiling under its floor admits no bond at all, and the failure would
    // surface as every invite being rejected rather than as the configuration
    // at fault. Section 10's fail-fast pattern: the profile is mocked, because
    // no environment variable reaches these.
    it('refuses a profile whose ceiling sits under its floor', async () => {
      const types = await vi.importActual<typeof import('@dagsocial/types')>(
        '@dagsocial/types',
      );
      vi.doMock('@dagsocial/types', () => ({
        ...types,
        profileFor: () => ({ ...types.NETWORK_PROFILES.devnet, inviteBondMin: 300n, inviteBondMax: 250n }),
      }));
      process.env['NETWORK_TYPE'] = 'devnet';
      await expect(import('../src/config.js')).rejects.toThrow(/invite bond/i);
    });

    // 64 lowercase hex characters, an Ed25519 public key. A key the seeder
    // cannot decode seeds a box owned by the wrong bytes, and the box reaches
    // `genesisStateRoot` — so the node forks rather than fails.
    it('refuses a faucet key that is not 64 lowercase hex characters', async () => {
      const types = await vi.importActual<typeof import('@dagsocial/types')>(
        '@dagsocial/types',
      );
      vi.doMock('@dagsocial/types', () => ({
        ...types,
        profileFor: () => ({ ...types.NETWORK_PROFILES.devnet, faucetPublicKey: 'NOTHEX' }),
      }));
      process.env['NETWORK_TYPE'] = 'devnet';
      await expect(import('../src/config.js')).rejects.toThrow(/faucetPublicKey/);
    });

    // The control the refusal above needs: mainnet omits the field entirely and
    // must still load, or "absent" and "malformed" would be the same verdict.
    it('control: an absent faucet key is not a malformed one', async () => {
      process.env['NETWORK_TYPE'] = 'mainnet';
      const { loadConfig } = await import('../src/config.js');
      expect(() => loadConfig()).not.toThrow();
    });
  });
});
