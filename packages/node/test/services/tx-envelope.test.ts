// ---------------------------------------------------------------------------
// The transaction envelope gate (`checkTxEnvelope`, NODE_INTERFACE →
// "Transaction envelope shape").
//
// `checkOutputShape` pinned what is INSIDE `tx.outputs`. This is its outer
// twin: it pins that `tx` has its four fields at all, and that each is the
// type its readers assume. Until it landed the envelope was the half nobody
// checked, and the corpus below is the MEASURED pre-gate behaviour of every
// row (2026-08-08, on `d0c97da` + the contracts commit, before any src change):
//
//   inputs: null            → TypeError at step 1's `tx.inputs.length`
//   inputs: 5               → TypeError at `new Set(5)` — "5 is not iterable"
//   inputs: "abc"           → a Set of CHARACTERS; 'a','b','c' reached getBox
//   inputs: [{}]            → RangeError from the SQLite bind inside getBox
//   outputs: null           → TypeError inside checkOutputShape's own `.length`
//   outputs: {} (an object) → slipped that loop (`length` undefined, so it never
//                             ran) and threw at conservation's `.reduce`
//   signatures missing/null → TypeError at `tx.signatures[hexKey]`
//   signatures: {}          → LEGAL, and must stay legal (uncommitted-bond cancel)
//   likeTarget: null        → passed conservation's `!== undefined` presence
//                             test, then TypeError at `h.update(null)` inside
//                             computeTxId — which checkAuthorization calls on its FIRST
//                             line, so the whole envelope reached the hasher
//   likeTarget: undefined   → hashed identically to absence (measured)
//   preimages: {n: 5}       → TypeError at `h.update(5)` inside computeTxId
//   preimages: {}           → hashed identically to absence (measured)
//   protocolVersion: "x"    → ACCEPTED end-to-end when signed as such (measured);
//                             the string was String()-coerced into its own id
//   an unknown envelope key → ACCEPTED, and invisible to computeTxId (measured):
//                             free malleability, two byte strings for one id
//
// Every throwing row was an HTTP 500 or — through the block funnel — a
// whole-block rejection logged as an "unexpected failure".
//
// PLACEMENT: the corpus below runs UNSIGNED. The gate is step 0, so every
// rejection must be envelope-worded; a signature-worded error (or a throw)
// would mean the gate now sits behind step 6, which is what this placement
// exists to detect — a shape check reached only after the checks that assume
// the shape is not a shape check.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeTxId,
  decodeTx,
  encodeTx,
  LIKE_KARMA_COST,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { AnyBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { encode as cborEncode } from 'cbor-x';
import Database from 'better-sqlite3';

import {
  rawPublicKey,
  seedProvenance,
  type Stored,
} from '../helpers.js';
import {
  initDb,
  closeDb,
  getDb,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  consumeBox as storeConsumeBox,
} from '../../src/store/index.js';
import { checkTxEnvelope, validateTx } from '../../src/services/utxo-engine.js';
import { config } from '../../src/config.js';

interface TestKeys {
  pub: Uint8Array;
  priv: KeyObject;
}

function makeKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKey(publicKey), priv: privateKey };
}

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

/** A well-formed envelope, minus whatever the caller overrides. */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inputs: [HEX_A],
    outputs: [],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    ...over,
  };
}

/** Run the gate and return its error, or `null` when it accepted. */
function reject(tx: unknown): string | null {
  const r = checkTxEnvelope(tx);
  return r.valid ? null : (r.error ?? '<no error string>');
}

// ---------------------------------------------------------------------------
// The `as unknown as KarmaBox` casts below are DELIBERATE. `checkTxEnvelope`
// is total over any decoded-CBOR value and this suite feeds it exactly the
// values a well-typed literal cannot express — a present-`undefined` key, a
// non-array `outputs`, an unexpected envelope key. See the note in
// `field-type-pin.test.ts` for the rule that separates these from the harness
// casts this unit removed.
// ---------------------------------------------------------------------------
describe('checkTxEnvelope — the closed envelope', () => {
  it('accepts the well-formed minimum', () => {
    expect(checkTxEnvelope(envelope())).toEqual({ valid: true });
  });

  it('accepts every optional field in its legal form', () => {
    expect(
      checkTxEnvelope(
        envelope({
          likeTarget: HEX_B,
          signatures: { [HEX_B]: new Uint8Array(64) },
        }),
      ),
    ).toEqual({ valid: true });
  });

  // -------------------------------------------------------------------------
  // 1. tx itself
  // -------------------------------------------------------------------------

  it('rejects any non-object, never throwing on one', () => {
    for (const v of [null, undefined, 5, 'tx', true, 10n, [], [envelope()]]) {
      const err = reject(v);
      expect(err, `value ${String(v)}`).toContain('Invalid tx envelope');
      expect(err).toContain('expected a plain object');
    }
  });

  it('rejects an object whose reads could come from a prototype', () => {
    // `Object.hasOwn` decides presence here, but every downstream read is a
    // plain `tx.likeTarget` that walks the chain. Pinning the prototype is
    // what makes the two agree.
    const polluted = Object.create({ likeTarget: HEX_B }) as Record<string, unknown>;
    Object.assign(polluted, envelope());
    expect(reject(polluted)).toContain('expected a plain object');
    // A null-prototype object is plain and stays legal.
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, envelope());
    expect(reject(bare)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 2. the closed key set
  // -------------------------------------------------------------------------

  it('rejects an unknown envelope key — computeTxId cannot see it', () => {
    const clean = envelope() as unknown as UtxoTransaction;
    const dirty = envelope({ bogusKey: 'free' }) as unknown as UtxoTransaction;
    // The malleability being closed: one id, two distinct CBOR byte strings.
    expect(computeTxId(dirty)).toBe(computeTxId(clean));
    expect(reject(dirty)).toContain("unexpected key 'bogusKey'");
  });

  it('rejects a REQUIRED key present with the value undefined', () => {
    for (const key of ['inputs', 'outputs', 'signatures', 'protocolVersion']) {
      const err = reject(envelope({ [key]: undefined }));
      expect(err, key).toContain(`key '${key}' is present with value undefined`);
    }
  });

  it('a present-undefined likeTarget IS absence — one encoding, so nothing to refuse', () => {
    // ⛔ **The rule inverted with the codec, and the reason is `opt()`.** An
    // absent optional field writes a single presence tag, so present-`undefined`
    // and absent are ONE byte string rather than two — and `computeTxId` reads
    // it with the same `!== undefined` test. There is no ambiguity left for a
    // gate to refuse.
    //
    // ⚠ **And `decodeTx` produces exactly this shape**: it writes `likeTarget`
    // and `post` unconditionally, holding `undefined` where the tag said absent.
    // A gate refusing it refuses every non-like transaction inside a block.
    const absent = envelope() as unknown as UtxoTransaction;
    const present = envelope({ likeTarget: undefined }) as unknown as UtxoTransaction;
    expect(computeTxId(present)).toBe(computeTxId(absent));
    expect(reject(present)).toBeNull();
    expect(Object.hasOwn(decodeTx(encodeTx(absent)), 'likeTarget')).toBe(true);
    expect(decodeTx(encodeTx(absent)).likeTarget).toBeUndefined();
  });

  it('rejects a missing required key', () => {
    for (const key of ['inputs', 'outputs', 'signatures', 'protocolVersion']) {
      const env = envelope();
      delete env[key];
      expect(reject(env), key).toContain(`missing required key '${key}'`);
    }
  });

  // -------------------------------------------------------------------------
  // 3. inputs
  // -------------------------------------------------------------------------

  it('rejects every non-array inputs — the four measured throw shapes', () => {
    for (const v of [null, 5, 'abc', {}, true, 10n]) {
      const err = reject(envelope({ inputs: v }));
      expect(err, `inputs=${String(v)}`).toContain('inputs must be an array');
    }
  });

  it('rejects an inputs entry that is not a 64-char lowercase-hex id', () => {
    const cases: [unknown, string][] = [
      [{}, 'object'],
      [null, 'null'],
      [5, '5'],
      ['abc', 'short hex'],
      ['A'.repeat(64), 'uppercase hex'],
      [`${HEX_A}a`, '65 chars'],
      [HEX_A.slice(1), '63 chars'],
      ['g'.repeat(64), 'non-hex characters'],
      [new Uint8Array(32), 'raw bytes'],
    ];
    for (const [entry, label] of cases) {
      const err = reject(envelope({ inputs: [entry] }));
      expect(err, label).toContain('inputs[0] must be 64 lowercase hex characters');
    }
  });

  it('leaves emptiness to validateTx step 1 — an empty inputs array is shape-legal', () => {
    expect(reject(envelope({ inputs: [] }))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. outputs
  // -------------------------------------------------------------------------

  it('rejects every non-array outputs, the object shape included', () => {
    // `{}` is the interesting one: it slipped checkOutputShape's index loop
    // (its `length` is undefined) and threw at conservation's `.reduce`.
    for (const v of [null, {}, 5, 'x', true]) {
      const err = reject(envelope({ outputs: v }));
      expect(err, `outputs=${String(v)}`).toContain('outputs must be an array');
    }
  });

  it('does not type output ENTRIES — that is step 4 s job', () => {
    expect(reject(envelope({ outputs: [null, 5, { boxType: 'nonsense' }] }))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 5. signatures
  // -------------------------------------------------------------------------

  it('rejects a non-object signatures map', () => {
    for (const v of [null, 5, 'sig', [], true]) {
      const err = reject(envelope({ signatures: v }));
      expect(err, `signatures=${String(v)}`).toContain('signatures must be a plain object');
    }
  });

  it('keeps an EMPTY signatures map legal — the uncommitted-bond cancel path', () => {
    expect(reject(envelope({ signatures: {} }))).toBeNull();
  });

  it('rejects a non-hex signature key', () => {
    for (const key of ['abc', 'A'.repeat(64), `${HEX_A}a`, 'g'.repeat(64)]) {
      const err = reject(envelope({ signatures: { [key]: new Uint8Array(64) } }));
      expect(err, key).toContain('signatures key must be 64 lowercase hex characters');
    }
  });

  it('rejects a signature value that is not 64 bytes of Uint8Array', () => {
    const bad: [unknown, string][] = [
      [null, 'must be a Uint8Array'],
      ['deadbeef', 'must be a Uint8Array'],
      [5, 'must be a Uint8Array'],
      [Array.from(new Uint8Array(64)), 'must be a Uint8Array'],
      [new Uint8Array(63), 'must be 64 bytes'],
      [new Uint8Array(65), 'must be 64 bytes'],
      [new Uint8Array(0), 'must be 64 bytes'],
    ];
    for (const [value, expected] of bad) {
      expect(reject(envelope({ signatures: { [HEX_A]: value } })), expected).toContain(expected);
    }
  });

  it('accepts a Buffer signature — CBOR decodes byte strings as one', () => {
    expect(reject(envelope({ signatures: { [HEX_A]: Buffer.alloc(64) } }))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 6. preimages — the name is RESERVED, never to be reused
  // -------------------------------------------------------------------------

  it('refuses a preimages key as an unexpected one, not as a malformed field', () => {
    // ⛔ **`preimages` is not a field of `UtxoTransaction`** (TYPES_INTERFACE →
    // Layout — UtxoTransaction: the name is reserved). It is outside the `TxId`
    // preimage, so admitting it would be free malleability — two byte strings
    // carrying one id — which is the class the closed key set exists to close.
    // The diagnosis is therefore the unknown-key one, and every shape of the
    // old field lands on it identically.
    for (const v of [{}, null, 5, { [HEX_B]: new Uint8Array([1]) }, { zz: 1 }]) {
      const err = reject(envelope({ preimages: v }));
      expect(err, String(v)).toContain("unexpected key 'preimages'");
    }
  });

  it('and the node hashes the same id with or without one', () => {
    // The malleability, shown rather than asserted: the two differ on the wire
    // and hash alike, which is exactly why the key set has to be closed.
    const clean = envelope() as unknown as UtxoTransaction;
    const stray = envelope({ preimages: { [HEX_B]: new Uint8Array([1]) } }) as unknown as UtxoTransaction;
    expect(computeTxId(stray)).toBe(computeTxId(clean));
  });

  // -------------------------------------------------------------------------
  // 7. protocolVersion
  // -------------------------------------------------------------------------

  it('rejects anything but PROTOCOL_VERSION exactly', () => {
    const bad = ['x', String(PROTOCOL_VERSION), null, PROTOCOL_VERSION + 1, PROTOCOL_VERSION - 1,
      1.5, BigInt(PROTOCOL_VERSION), true, {}, []];
    for (const v of bad) {
      const err = reject(envelope({ protocolVersion: v }));
      expect(err, `protocolVersion=${String(v)}`).toContain(
        `protocolVersion must be ${PROTOCOL_VERSION}`,
      );
    }
    expect(reject(envelope({ protocolVersion: PROTOCOL_VERSION }))).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 8. likeTarget
  // -------------------------------------------------------------------------

  it('rejects a likeTarget that is not a 64-char lowercase-hex post id', () => {
    for (const v of [null, 5, '', 'target_post', 'A'.repeat(64), `${HEX_B}b`, {}, new Uint8Array(32)]) {
      const err = reject(envelope({ likeTarget: v }));
      expect(err, `likeTarget=${String(v)}`).toContain(
        'likeTarget must be 64 lowercase hex characters',
      );
    }
  });

  // -------------------------------------------------------------------------
  // Totality — the gate never throws, and never calls a caller's toString
  // -------------------------------------------------------------------------

  it('is total: no input makes it throw, and error strings never call toString', () => {
    const hostile = {
      inputs: {
        get length(): never {
          throw new Error('length getter ran');
        },
      },
    };
    expect(() => checkTxEnvelope(hostile)).not.toThrow();

    const toStringBomb = {
      ...envelope(),
      protocolVersion: {
        toString: () => {
          throw new Error('toString ran');
        },
      },
    };
    let result: ReturnType<typeof checkTxEnvelope> | undefined;
    expect(() => {
      result = checkTxEnvelope(toStringBomb);
    }).not.toThrow();
    expect(result!.valid).toBe(false);
    expect(result!.error).toContain('object'); // describeValue, not String(v)
  });
});

// ---------------------------------------------------------------------------
// Through validateTx — step 0, ahead of everything, on UNSIGNED transactions
// ---------------------------------------------------------------------------

/** The author `getTopologyAuthor` resolves here, and the key a marker must name. */
const LIKE_AUTHOR = new Uint8Array(32).fill(0x5e);

describe('validateTx step 0 — the envelope gate in place', () => {
  let db: Database.Database;

  function makeDeps() {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array): bigint =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      // The marker's author pin. One author for every target this suite names,
      // so a marker naming anyone else is refused (NODE_INTERFACE → Karma
      // transition rules).
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      getTopologyAuthor: () => LIKE_AUTHOR,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: ReturnType<typeof makeDeps>;
  let owner: TestKeys;
  let seeded: Stored<KarmaBox>;

  function seedKarma(o: Uint8Array, value: bigint, nonce = 0): Stored<KarmaBox> {
    const box = seedProvenance<KarmaBox>({
      boxType: 'karma' as const,
      value,
      createdAtBlock: 0,
      owner: o,
    }, 1, nonce);
    storeInsertBox(box);
    return box;
  }

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();
    deps = makeDeps();
    owner = makeKeys();
    seeded = seedKarma(owner.pub, 100n);
  });

  afterEach(() => {
    closeDb();
  });

  /** A conserving karma self-spend over the seeded box — deliberately UNSIGNED. */
  function unsignedTx(over: Record<string, unknown> = {}): UtxoTransaction {
    return {
      inputs: [seeded.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n,
          createdAtBlock: 0,
          owner: owner.pub,
        } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      ...over,
    } as unknown as UtxoTransaction;
  }

  /**
   * The whole pre-gate throw inventory, each row now a clean rejection. Run
   * UNSIGNED so the placement tripwire has teeth: step 0 runs before step 6,
   * so no rejection here may be signature-worded, and none may throw.
   */
  const CORPUS: [string, Record<string, unknown>][] = [
    ['inputs: null', { inputs: null }],
    ['inputs: 5', { inputs: 5 }],
    ['inputs: "abc"', { inputs: 'abc' }],
    ['inputs: [{}]', { inputs: [{}] }],
    ['inputs: [null]', { inputs: [null] }],
    ['inputs: [5]', { inputs: [5] }],
    ['inputs: [uppercase hex]', { inputs: ['A'.repeat(64)] }],
    ['inputs: [short hex]', { inputs: ['ab'] }],
    ['outputs: null', { outputs: null }],
    ['outputs: {} (non-array object)', { outputs: {} }],
    ['outputs: 5', { outputs: 5 }],
    ['signatures: null', { signatures: null }],
    ['signatures: 5', { signatures: 5 }],
    ['signatures: [] (array)', { signatures: [] }],
    ['signatures: {hex: non-bytes}', { signatures: { [HEX_A]: 'aa' } }],
    ['signatures: {hex: 63 bytes}', { signatures: { [HEX_A]: new Uint8Array(63) } }],
    ['signatures: {non-hex: bytes}', { signatures: { zz: new Uint8Array(64) } }],
    ['likeTarget: null', { likeTarget: null }],
    // ⛔ **`likeTarget: undefined` is NOT here, and its absence is the rule.**
    // `opt()` gives absence one encoding, so present-`undefined` is absence
    // rather than an ambiguity — and it is the shape `decodeTx` produces for
    // every non-like transaction. Its acceptance is asserted above.
    ['likeTarget: non-hex string', { likeTarget: 'target_post' }],
    ['likeTarget: 5', { likeTarget: 5 }],
    ['preimages: {hex: 5} (a reserved name)', { preimages: { [HEX_B]: 5 } }],
    ['preimages: {} (a reserved name)', { preimages: {} }],
    ['protocolVersion: "x"', { protocolVersion: 'x' }],
    ['protocolVersion: 2', { protocolVersion: PROTOCOL_VERSION + 1 }],
    ['protocolVersion: 1.5', { protocolVersion: 1.5 }],
    ['protocolVersion: null', { protocolVersion: null }],
    ['unknown envelope key', { bogusKey: 'free' }],
  ];

  it.each(CORPUS)('rejects %s at step 0 — no throw, no signature wording', (label, patch) => {
    const tx = unsignedTx(patch);

    let result: ReturnType<typeof validateTx> | undefined;
    expect(() => {
      result = validateTx(deps, tx, 10);
    }, `${label} threw`).not.toThrow();

    expect(result!.valid, label).toBe(false);
    expect(result!.error, label).toContain('Invalid tx envelope');
    // The tripwire: a signature-worded rejection means the gate drifted
    // behind step 6.
    expect(result!.error!.toLowerCase(), label).not.toContain('signature for box');
    expect(result!.error!.toLowerCase(), label).not.toContain('owner signature');
  });

  it('missing envelope keys reject at step 0 too', () => {
    for (const key of ['inputs', 'outputs', 'signatures', 'protocolVersion']) {
      const tx = unsignedTx() as unknown as Record<string, unknown>;
      delete tx[key];
      const result = validateTx(deps, tx as unknown as UtxoTransaction, 10);
      expect(result.valid, key).toBe(false);
      expect(result.error, key).toContain(`missing required key '${key}'`);
    }
  });

  it('non-vacuity: the same UNSIGNED tx with a clean envelope reaches step 6', () => {
    // Proves every rejection above isolates the envelope rule rather than
    // tripping over the absent signature — and that step 0 is not swallowing
    // the authorization check.
    const result = validateTx(deps, unsignedTx(), 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Missing or invalid owner signature');
  });

  it('non-vacuity: the SIGNED tx with a clean envelope still validates', () => {
    const tx = unsignedTx();
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(owner.pub).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, owner.priv),
    );
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('a signed protocolVersion:"x" tx no longer validates — the measured hole', () => {
    // Pre-gate this exact construction returned { valid: true } and pooled.
    const tx = unsignedTx({ protocolVersion: 'x' });
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(owner.pub).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, owner.priv),
    );
    const result = validateTx(deps, tx, 10);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(`protocolVersion must be ${PROTOCOL_VERSION}`);
  });

  it('a like transaction with a real hex target still validates', () => {
    // The one legal `likeTarget` shape, so the gate's hex rule is not a ban on
    // the field. ⛔ **The like CONSERVES now** — its cost moves into a marker
    // earmarked for the target's author rather than leaving the ledger as a
    // deficit (ARCHITECTURE → The conservation axiom).
    const tx: UtxoTransaction = {
      inputs: [seeded.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n - LIKE_KARMA_COST,
          createdAtBlock: 0,
          owner: owner.pub,
        } as unknown as KarmaBox,
        {
          boxType: 'like_accrual',
          value: LIKE_KARMA_COST,
          createdAtBlock: 0,
          author: LIKE_AUTHOR,
        } as unknown as KarmaBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      likeTarget: HEX_B,
    };
    const hash = Buffer.from(computeTxId(tx), 'hex');
    tx.signatures[Buffer.from(owner.pub).toString('hex')] = new Uint8Array(
      cryptoSign(null, hash, owner.priv),
    );
    expect(validateTx(deps, tx, 10)).toMatchObject({ valid: true });
  });
});

// ---------------------------------------------------------------------------
// The decode layer — raw bytes, through decodeTx, into the gate
//
// ⛔ **THE DECODER IS POSITIONAL, so it cannot hand this gate a hostile map at
// all.** It reads fixed widths and length prefixes off a byte string, so what it
// returns is an object with the codec's own key set and the codec's own field
// types — there is no `__proto__` key to rename, no `outputs: 'no'`, and no
// arbitrary value to survive. What it CAN do is refuse, and that is what these
// pin (VALIDATION_INTERFACE → What a decoder subsumes depends on the ENTRY
// PATH).
//
// ⚠ **The gate is not thereby redundant.** It runs at `validateTx` step 0, where
// the transaction came off the HTTP edge through `jsonToTx` and crossed no
// decoder — which is the whole reason it is stated once and called from both.
// ---------------------------------------------------------------------------

describe('checkTxEnvelope at the decode boundary', () => {
  it('the decoder REFUSES arbitrary bytes rather than producing an object', () => {
    const values: Uint8Array[] = [
      new Uint8Array([5]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(0),
      cborEncode({ inputs: [1, 2], outputs: 'no' }) as unknown as Uint8Array,
      cborEncode(['a string']) as unknown as Uint8Array,
    ];
    for (const bytes of values) {
      expect(() => decodeTx(bytes), Buffer.from(bytes).toString('hex')).toThrow();
    }
  });

  it('and what it DOES return carries the closed key set, nothing else', () => {
    // Including the two optional fields, present and holding `undefined` where
    // the presence tag said absent — the shape the gate has to accept.
    const tx = envelope() as unknown as UtxoTransaction;
    const decoded = decodeTx(encodeTx(tx));
    for (const key of Object.keys(decoded)) {
      expect(
        ['inputs', 'outputs', 'signatures', 'protocolVersion', 'likeTarget', 'post'],
        key,
      ).toContain(key);
    }
    expect(checkTxEnvelope(decoded)).toEqual({ valid: true });
  });

  it('round-trips an honest transaction through the codec unchanged', () => {
    const tx = envelope({
      signatures: { [HEX_A]: new Uint8Array(64).fill(7) },
      likeTarget: HEX_B,
    }) as unknown as UtxoTransaction;
    const decoded = decodeTx(encodeTx(tx));
    expect(checkTxEnvelope(decoded)).toEqual({ valid: true });
    expect(computeTxId(decoded)).toBe(computeTxId(tx));
  });
});
