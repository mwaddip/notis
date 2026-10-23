// The four sites the memo rides — admission's `validateTx`, net's Stage 1,
// every block context and `screenBody` on the same context (NODE_INTERFACE →
// The signature memo).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createPrivateKey, sign as cryptoSign } from 'crypto';
import { initDb, getDb, closeDb } from '../../src/store/db.js';
import { setMempoolCap, DEFAULT_MAX_MEMPOOL_ENTRIES } from '../../src/store/mempool.js';
import { createApp } from '../../src/server.js';
import { setNet } from '../../src/services/net-instance.js';
import { config as nodeConfig } from '../../src/config.js';
import { applyContextFrom } from '../../src/services/block-apply.js';
import { signatureMemo, netValidators } from '../../src/services/signature-memo.js';
import { verifyEd25519, verifyEd25519Batch } from '@dagsocial/validation';
import {
  computeTxId,
  generateKeyPair,
  MAX_BLOCK_BODY_BYTES,
  PROTOCOL_VERSION,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBoxCandidate,
  CandidateOf,
  CreditBox,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  applyBlockThroughIntake,
  liveProver,
  makeApplicableBlock,
  makeTestConfig,
  seedBoxes,
  seedProvenance,
  txToJson,
} from '../helpers.js';

vi.mock('@dagsocial/validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dagsocial/validation')>();
  return {
    ...actual,
    verifyEd25519: vi.fn(actual.verifyEd25519),
    verifyEd25519Batch: vi.fn(actual.verifyEd25519Batch),
  };
});

const BOX_VALUE = 100_000n;
let nonce = 70_000;

type Key = { pub: Uint8Array; priv: ReturnType<typeof createPrivateKey>; hex: string; box: CreditBox };

async function makeKeys(n: number): Promise<Key[]> {
  const keys: Key[] = [];
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const kp = generateKeyPair();
    const box = seedProvenance<CreditBox>(
      { boxType: 'credit', value: BOX_VALUE, createdAtBlock: 0, owner: kp.publicKey },
      1,
      ++nonce,
    );
    boxes.push(box);
    keys.push({
      pub: kp.publicKey,
      priv: createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }),
      hex: Buffer.from(kp.publicKey).toString('hex'),
      box,
    });
  }
  await seedBoxes(boxes);
  return keys;
}

function buildTx(keys: Key[], outputs: AnyBoxCandidate[]): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: keys.map((k) => k.box.id!),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  const id = Buffer.from(computeTxId(tx), 'hex');
  for (const k of keys) tx.signatures[k.hex] = new Uint8Array(cryptoSign(null, id, k.priv));
  return tx;
}

function credit(owner: Uint8Array, value: bigint): CandidateOf<CreditBox> {
  return { boxType: 'credit', value, createdAtBlock: 0, owner } as CandidateOf<CreditBox>;
}
function fee(value: bigint): AnyBoxCandidate {
  return { boxType: 'fee', value, createdAtBlock: 0 } as AnyBoxCandidate;
}

let baseUrl = '';
function post(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const url = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
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

describe('the signature memo rides admission, Stage 1 and every block context', () => {
  let server: http.Server;
  const receiver = generateKeyPair();

  beforeAll(async () => {
    initDb(':memory:');
    getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const netStub = {
      penalizePeer: () => {},
      chainMoved: () => {},
      needHeaders: () => {},
      broadcastOrderingBlock: async () => {},
      broadcastTx: async () => {},
      getConnectedPeers: () => [],
      tipApplied: () => {},
      setKarmaMembers: () => {},
      addKarmaMember: () => {},
      removeKarmaMember: () => {},
      requestPostBodies: async () => [],
    };
    setNet(netStub as unknown as Parameters<typeof setNet>[0]);

    await liveProver();

    const app = createApp(
      makeTestConfig({
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
      }),
    );
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
    server.close();
    setNet(null as unknown as Parameters<typeof setNet>[0]);
    closeDb();
  });

  // The admission site: `server.ts`'s `utxoEngineDeps.verifySignature` reads
  // through the memo (NODE_INTERFACE → The signature memo).
  it(
    'POST /credits/transfer refused at validateTx\'s step 9 twice over three signers reads the rule once',
    async () => {
      const signers = await makeKeys(3);
      const total = BOX_VALUE * 3n;
      // Two FeeBox outputs — step 9 refuses them (NODE_INTERFACE → validateTx).
      const tx = buildTx(signers, [credit(receiver.publicKey, total - 2n), fee(1n), fee(1n)]);
      vi.mocked(verifyEd25519).mockClear();
      vi.mocked(verifyEd25519Batch).mockClear();
      const r1 = await post('/credits/transfer', { tx: txToJson(tx) });
      expect(r1.status).toBe(400);
      expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(3);
      vi.mocked(verifyEd25519).mockClear();
      vi.mocked(verifyEd25519Batch).mockClear();
      const r2 = await post('/credits/transfer', { tx: txToJson(tx) });
      expect(r2.status).toBe(r1.status);
      expect(r2.data).toEqual(r1.data);
      expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(0);
      expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(0);
    },
  );

  // The admission site, past the cost gate: a refusal the pool answers reaches
  // beyond the signatures, so the second arrival hits the memo on them.
  it(
    'POST /credits/transfer refused for a full pool twice reads the rule once',
    async () => {
      setMempoolCap(2);
      try {
        const resident = (await makeKeys(1))[0]!;
        const residentTx = buildTx(
          [resident],
          [credit(receiver.publicKey, BOX_VALUE - 5_000n), fee(5_000n)],
        );
        const pooled = await post('/credits/transfer', { tx: txToJson(residentTx) });
        expect(pooled.status, JSON.stringify(pooled.data)).toBe(200);

        const signers = await makeKeys(3);
        const total = BOX_VALUE * 3n;
        // Bids nothing — no FeeBox output.
        const tx = buildTx(signers, [credit(receiver.publicKey, total)]);
        vi.mocked(verifyEd25519).mockClear();
        vi.mocked(verifyEd25519Batch).mockClear();
        const r1 = await post('/credits/transfer', { tx: txToJson(tx) });
        expect(r1.status).toBe(503);
        expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(3);
        vi.mocked(verifyEd25519).mockClear();
        vi.mocked(verifyEd25519Batch).mockClear();
        const r2 = await post('/credits/transfer', { tx: txToJson(tx) });
        expect(r2.status).toBe(r1.status);
        expect(r2.data).toEqual(r1.data);
        expect(vi.mocked(verifyEd25519).mock.calls.length).toBe(0);
        expect(vi.mocked(verifyEd25519Batch).mock.calls.length).toBe(0);
      } finally {
        setMempoolCap(DEFAULT_MAX_MEMPOOL_ENTRIES);
      }
    },
  );

  // The block context: admission records the transfer's signature, and the
  // block that carries it pays no arithmetic for the same entry again
  // (CONSENSUS_INTERFACE → ApplyContext).
  it(
    'a transfer admitted, then the block carrying it applied — no batch call carries the transfer\'s entries',
    async () => {
      const signer = (await makeKeys(1))[0]!;
      const tx = buildTx([signer], [credit(receiver.publicKey, BOX_VALUE)]);
      const admitted = await post('/credits/transfer', { tx: txToJson(tx) });
      expect(admitted.status, JSON.stringify(admitted.data)).toBe(200);
      vi.mocked(verifyEd25519).mockClear();
      vi.mocked(verifyEd25519Batch).mockClear();
      const block = await makeApplicableBlock({ height: 1, utxoTxs: [tx] });
      expect(await applyBlockThroughIntake(block)).toBe(true);
      const txSig = tx.signatures[signer.hex]!;
      for (const call of vi.mocked(verifyEd25519Batch).mock.calls) {
        const entries = call[0] as ReadonlyArray<{ signature: Uint8Array }>;
        for (const e of entries) {
          const eq = e.signature.length === txSig.length &&
            e.signature.every((b, i) => b === txSig[i]);
          expect(eq).toBe(false);
        }
      }
    },
  );

  // The context carries the memo as its signature pair.
  it('applyContextFrom(config).signatureChecks is the memo', () => {
    expect(applyContextFrom(nodeConfig).signatureChecks).toBe(signatureMemo);
  });

  // The net site: `netValidators().verifyTxSignatures` reads one transaction's
  // map through the memo's batch (NET_INTERFACE → Stage 1 → "A transaction's
  // signatures are checked at Stage 1").
  it(
    'netValidators\' signature check reads the batch once, then not at all',
    async () => {
      const signer = (await makeKeys(1))[0]!;
      const tx = buildTx([signer], [credit(receiver.publicKey, BOX_VALUE - 1n), fee(1n)]);
      vi.mocked(verifyEd25519Batch).mockClear();
      expect(netValidators().verifyTxSignatures(tx)).toBe(true);
      const after1 = vi.mocked(verifyEd25519Batch).mock.calls.length;
      expect(after1).toBe(1);
      expect(netValidators().verifyTxSignatures(tx)).toBe(true);
      const total = vi.mocked(verifyEd25519Batch).mock.calls.length;
      expect(total).toBe(1);
    },
  );
});
