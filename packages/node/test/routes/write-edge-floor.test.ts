// NODE_INTERFACE → Credits; MEMPOOL_INTERFACE → Fee floor.
//
// A floor above zero prices a transfer and refuses one whose fee is beneath
// it. The suite's default config pins the floor at zero; this file registers
// its own `vi.doMock` of `src/config.js` so a mocked floor takes effect at the
// admission seam. ⚠ `vi.doMock` outlives `vi.restoreAllMocks` and
// `vi.resetModules` — `vi.doUnmock` in the `afterEach` ends it.
import { makeTestConfig, seedProvenance, toHex, txToJson } from '../helpers.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createPrivateKey, sign as cryptoSign } from 'crypto';
import {
  computeTxId,
  encodeTx,
  generateKeyPair,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type { CandidateOf, CreditBox, UtxoTransaction } from '@dagsocial/types';

const FLOOR = 1n;

describe('write edge — floor above zero', () => {
  let server: http.Server;
  let baseUrl: string;
  let sender: ReturnType<typeof generateKeyPair>;
  let senderPriv: ReturnType<typeof createPrivateKey>;
  let senderHex: string;
  let receiver: ReturnType<typeof generateKeyPair>;
  let insertBoxDyn: typeof import('../../src/store/utxo.js').insertBox;
  let closeDbDyn: typeof import('../../src/store/db.js').closeDb;
  let boxNonce = 20_000;

  function freshCreditInput(value: bigint): string {
    const box = seedProvenance<CreditBox>({
      boxType: 'credit',
      value,
      createdAtBlock: 0,
      owner: sender.publicKey,
    }, 1, ++boxNonce);
    insertBoxDyn(box);
    return box.id;
  }

  function buildCreditPlusFee(inputValue: bigint, feeValue: bigint): UtxoTransaction {
    const inputBoxId = freshCreditInput(inputValue);
    const change = inputValue - feeValue;
    const tx: UtxoTransaction = {
      inputs: [inputBoxId],
      outputs: [
        { boxType: 'credit', value: change, createdAtBlock: 0, owner: receiver.publicKey },
        { boxType: 'fee', value: feeValue, createdAtBlock: 0 },
      ] as CandidateOf<CreditBox>[],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    const sig = cryptoSign(null, Buffer.from(computeTxId(tx), 'hex'), senderPriv);
    tx.signatures[senderHex] = new Uint8Array(sig);
    return tx;
  }

  async function request(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve) => {
      const url = new URL(baseUrl + path);
      const payload = Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(payload.length),
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, data: JSON.parse(d) });
            } catch {
              resolve({ status: res.statusCode ?? 0, data: d });
            }
          });
        },
      );
      req.write(payload);
      req.end();
    });
  }

  beforeAll(async () => {
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: Object.freeze({ ...actual.config, minFeeRatePerByte: FLOOR }),
      };
    });
    vi.resetModules();
    const dbMod = await import('../../src/store/db.js');
    const utxoMod = await import('../../src/store/utxo.js');
    const { createApp } = await import('../../src/server.js');
    dbMod.initDb(':memory:');
    dbMod.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    insertBoxDyn = utxoMod.insertBox;
    closeDbDyn = dbMod.closeDb;

    sender = generateKeyPair();
    senderPriv = createPrivateKey({ key: Buffer.from(sender.secretKey), format: 'der', type: 'pkcs8' });
    senderHex = toHex(sender.publicKey);
    receiver = generateKeyPair();

    const app = createApp(makeTestConfig({
      port: 0,
      dbPath: ':memory:',
      networkType: 'testnet',
      profile: profileFor('testnet'),
      nodeRole: 'server',
      blockBodyBudgetBytes: MAX_BLOCK_BODY_BYTES,
      orderingBlockPowTargetBits: 3072,
      bootstrapPeers: [],
      listenAddrs: '/ip4/127.0.0.1/tcp/0',
      maxPeers: 50,
    }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
    closeDbDyn();
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  it('a transfer whose fee meets the floor pools', async () => {
    // The floor is one base unit per in-block byte, so a fee at least equal to
    // the transaction's in-block byte count meets it. 100_000n far exceeds any
    // realistic entry byte count for a two-output transfer.
    const tx = buildCreditPlusFee(1_000_000n, 100_000n);
    const res = await request('/credits/transfer', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it('a transfer whose fee is one base unit below the floor answers 402', async () => {
    // A fee below `floor * bytes` is refused by the admission seam
    // (`FeeBelowFloorError`, 402). With `floor = 1n`, a `fee = bytes - 1` misses
    // by one base unit; the entry's byte cost is at least the encoding's own
    // length, so `encodeTx(draft).length - 1` is below the floor.
    const draft = buildCreditPlusFee(1_000_000n, 1n);
    const bytes = BigInt(encodeTx(draft).length);
    const tx = buildCreditPlusFee(1_000_000n, bytes - 1n);
    const res = await request('/credits/transfer', { tx: txToJson(tx) });
    expect(res.status, JSON.stringify(res.data)).toBe(402);
  });
});
