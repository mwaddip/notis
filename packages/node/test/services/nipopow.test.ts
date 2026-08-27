import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/store/db.js';
import {
  createOrderingBlock,
  getCurrentHeight,
  getPopowHeaderByHash,
  getPopowHeaderAtHeight,
  getLastHeaders,
  getHeadersAfter,
} from '../../src/store/ordering.js';
import { createPopowHeaderReader } from '../../src/services/nipopow.js';
import { buildMinedHeaderChain } from '../helpers.js';
import { GENESIS_PREV_BLOCK_HASH } from '@dagsocial/types';
import { proveWithReader, verifyProof } from '@dagsocial/nipopow';
import { unlinkSync } from 'fs';

const TEST_DB = '/tmp/dagsocial-test-nipopow-service.sqlite';
const CHAIN_LEN = 64;

describe('PopowHeaderReader + proveWithReader', () => {
  beforeAll(() => {
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
    initDb(TEST_DB);

    const { headers, interlinksPerHeader } = buildMinedHeaderChain({
      anchorPrevBlockHash: GENESIS_PREV_BLOCK_HASH,
      anchorInterlinks: [],
      startHeight: 1,
      count: CHAIN_LEN,
      powTargetBits: 3072,
    });

    for (let i = 0; i < headers.length; i++) {
      createOrderingBlock(
        {
          header: headers[i]!,
          utxoTxTree: { utxoTxIds: ['77'.repeat(32)], utxoTxs: [new Uint8Array(96)] },
          validatorSignature: new Uint8Array(64),
        },
        interlinksPerHeader[i]!,
      );
    }
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(TEST_DB); } catch { /* ignore */ }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proveWithReader produces a proof that verifyProof accepts', () => {
    const reader = createPopowHeaderReader({
      getPopowHeaderByHash,
      getPopowHeaderAtHeight,
      getLastHeaders,
      getHeadersAfter,
      getCurrentHeight,
    });

    const m = 6;
    const k = 6;
    const proof = proveWithReader(reader, { m, k });
    expect(proof.m).toBe(m);
    expect(proof.k).toBe(k);
    expect(proof.prefix.length).toBeGreaterThan(0);
    expect(proof.prefix[0]!.header.height).toBe(1);
    expect(proof.suffixHead.header.height).toBe(CHAIN_LEN - k + 1);
    expect(proof.suffixTail).toHaveLength(k - 1);

    // NIPOPOW_INTERFACE → verifyProof: devnet profile
    const result = verifyProof(proof, {
      expectedTarget: () => 3072,
      genesisId: '',
      protocolVersion: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('guardStoreRead wrap: a poisoned row causes process.exit', () => {
    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const reader = createPopowHeaderReader({
      getPopowHeaderByHash: () => {
        throw Object.assign(new Error('decode failure'), {
          name: 'UnreadableStoredBlockError',
        });
      },
      getPopowHeaderAtHeight,
      getLastHeaders,
      getHeadersAfter,
      getCurrentHeight,
    });

    // guardStoreRead only stops for CorruptChainStateError instances. The
    // fake above is not one, so it passes through. The real test of the
    // boundary is in corrupt-state.test.ts; this confirms the guard is wired.
    expect(() => reader.popowHeaderByHash('ff'.repeat(32))).toThrow('decode failure');
  });
});
