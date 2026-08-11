import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeTxId,
  computeBoxId,
  canonicalBoxBytes,
  encodeTx,
  u32BE,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  CREDIT_MINER_REWARD_DELAY,
  EMPTY_STATE_ROOT,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
} from '@dagsocial/types';
import { verifyOrderingBlockPoW, blockHash } from '@dagsocial/validation';
import { materializeOutput } from '../src/services/utxo-engine.js';
import { config } from '../src/config.js';
import type { Config } from '../src/config.js';
import type {
  UtxoTransaction,
  AnyBox,
  BondBox,
  BoxId,
  InviteBox,
  Post,
  KarmaBox,
  BlockHeader,
  OrderingBlock,
  SubBlockEntry,
  PruneEntry,
} from '@dagsocial/types';

/**
 * Convert a short string label to a deterministic 32-byte Uint8Array
 * suitable as a UserId (Ed25519 public key) for testing.
 */
export function uid(label: string): Uint8Array {
  const h = createHash('blake2b512').update(label).digest();
  return new Uint8Array(h.subarray(0, 32));
}

/** Convert a Uint8Array userId to hex for comparison in test assertions */
export function uidHex(label: string): string {
  return Buffer.from(uid(label)).toString('hex');
}

/** Convert a Uint8Array userId to a hex string for HTTP API requests. */
export function toHex(u: Uint8Array): string {
  return Buffer.from(u).toString('hex');
}

// ---------------------------------------------------------------------------
// tx-hash signing helpers
// ---------------------------------------------------------------------------

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
export function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

/**
 * Sign a UtxoTransaction by computing its txId, signing that hash, and
 * storing the signature in `tx.signatures[pubKeyHex]`.
 */
export function signTransaction(
  tx: UtxoTransaction,
  privKey: KeyObject,
  pubKeyHex: string,
): void {
  const txId = computeTxId(tx);
  const sig = cryptoSign(null, Buffer.from(txId, 'hex'), privKey);
  tx.signatures[pubKeyHex] = new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Shared block/box fixtures (used by block-apply, fork-resolution, and the
// journal round-trip suites — one definition, no per-file copies)
// ---------------------------------------------------------------------------

export interface TestIdentity {
  userId: Uint8Array;
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

export function makeTestIdentity(): TestIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubKey = rawPublicKey(publicKey);
  const userId = pubKey;
  return { userId, publicKey: pubKey, privateKey };
}

export function makePost(authorId: Uint8Array, content = 'test post'): Post {
  return {
    content,
    author: authorId,
    parentRefs: [],
    challenge: new Uint8Array(32),
    powNonce: 0,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
    signature: new Uint8Array(64),
  };
}

/**
 * Synthetic creating-transaction provenance for a seeded fixture box.
 *
 * Fixtures seed boxes directly into the store rather than through a real
 * transaction or a mint, so they have no txId of their own — but `tx_id` and
 * `output_index` are NOT NULL, and the box id derives from them
 * (NODE_INTERFACE → Box Identity and Mint Provenance). This manufactures a
 * stand-in.
 *
 * Deterministic on the candidate bytes plus the seed height, so a fixture built
 * twice with the same arguments gets the same box id and golden vectors stay
 * stable across runs and file orderings. A counter would not: it would make ids
 * depend on how many boxes a test happened to build first.
 *
 * `nonce` is the escape hatch for a test that deliberately seeds two *identical*
 * boxes — without it they derive one txId and trip
 * `UNIQUE(tx_id, output_index)`.
 *
 * Its own domain tag, so a fixture id can never be mistaken for one a real mint
 * or transaction would produce.
 */
const FIXTURE_TX_DOMAIN = new TextEncoder().encode('dagsocial/test-fixture-tx/1');

export function fixtureProvenance(
  candidate: object,
  seedHeight: number,
  nonce = 0,
): { txId: string; index: number } {
  const txId = createHash('blake2b512')
    .update(FIXTURE_TX_DOMAIN)
    .update(canonicalBoxBytes(candidate as never))
    .update(u32BE(seedHeight))
    .update(u32BE(nonce))
    .digest()
    .subarray(0, 32)
    .toString('hex');
  return { txId, index: 0 };
}

/**
 * A box as it exists once seeded or stored: `id` present.
 *
 * `BoxBase.id` is optional because it is genuinely absent for one expression —
 * between building the candidate-plus-provenance object and hashing it. A box
 * that has been through `seedProvenance` (or read back from a store, or handed
 * to the AVL prover) is past that point, and saying so once here beats a `!` at
 * every use site.
 */
export type Stored<B extends AnyBox = AnyBox> = B & { id: BoxId };

/**
 * Give a hand-built candidate the provenance and id a stored box must have.
 *
 * Seeding a box straight into the store requires `tx_id`/`output_index` (NOT
 * NULL) and an `id` that actually derives from them, which is the shape every
 * local fixture factory needs. Mutates in place so a factory that already holds
 * a reference to the candidate keeps seeing the finished box.
 *
 * Returns `Stored<T>`: this function always assigns `id`, so a caller that then
 * has to write `box.id!` is being told something false by the type.
 * `computeBoxId(result) === result.id` holds for everything it returns.
 */
export function seedProvenance<T extends AnyBox>(
  candidate: object,
  seedHeight = 1,
  nonce = 0,
): Stored<T> {
  Object.assign(candidate, fixtureProvenance(candidate, seedHeight, nonce));
  Object.assign(candidate, { id: computeBoxId(candidate as T) });
  return candidate as Stored<T>;
}

/**
 * Seed several candidates as outputs of **one** synthetic transaction.
 *
 * The shape an invite/bond pair needs since the bond resolves its InviteBox from
 * `(bond.txId, bond.inviteOutputIndex)` (user decision, 2026-08-06). Seeding them
 * with independent provenance would leave the bond pointing at an index of a
 * transaction that has no invite at it — which is exactly the mispairing the
 * index form makes inexpressible in production, so a fixture must not fake it.
 *
 * Returns the boxes in the order given; each `index` is its position here.
 */
export function seedAsOneTx(candidates: object[], seedHeight = 1, nonce = 0): AnyBox[] {
  const { txId } = fixtureProvenance(candidates[0]!, seedHeight, nonce);
  return candidates.map((candidate, index) => {
    const box = { ...candidate, txId, index } as AnyBox;
    return { ...box, id: computeBoxId(box) } as AnyBox;
  });
}

/**
 * A `u32BE`-encodable nonce derived from a caller-supplied label.
 *
 * Deterministic, so a fixture built twice with the same label gets the same
 * ids across runs and file orderings — the property `fixtureProvenance`
 * documents and the reason a counter is **not** used here (a counter makes ids
 * depend on how many boxes a test happened to build first).
 *
 * Masked to 31 bits so the value can never reach `U32_SENTINEL` (`0xffffffff`),
 * which `u32BE` reserves for the un-encodable case.
 */
export function labelNonce(label: string): number {
  const h = createHash('blake2b512').update(label).digest();
  return h.readUInt32BE(0) & 0x7fffffff;
}

/**
 * Seed an invite and its bond as the two outputs of ONE synthetic transaction.
 *
 * The pairing is a property of the pair: a bond resolves its InviteBox through
 * `(bond.txId, bond.inviteOutputIndex)`, so seeding the two with independent
 * provenance leaves the bond pointing at an index of a transaction that has no
 * invite at it — the mispairing the index form exists to make inexpressible.
 * A caller cannot build half of this correctly, so there is no half to build.
 *
 * **`label` is required, and it is the whole point.** `seedAsOneTx` derives the
 * shared txId from `candidates[0]` alone, so two pairs whose *invite* is
 * structurally identical at the same `seedHeight` get the same txId — and
 * therefore colliding box ids. Measured, and it is sharper than it first looks:
 * because only `candidates[0]` feeds the txId, a difference confined to the
 * **bond** does not separate the pairs either. Two such pairs produce bonds with
 * *different ids* sharing one `(txId, index)`, which is exactly what
 * `UNIQUE(tx_id, output_index)` forbids and what `getBoxByProvenance` resolves
 * by. Centralising the pattern here would multiply that hazard across every
 * caller, so `label` has no default: forgetting it is a compile error rather
 * than a silent collision. Pinned by `helpers.test.ts`.
 */
export function seedInviteAndBond(opts: {
  /** Distinguishes this pair from every other. Required — see above. */
  label: string;
  inviterId: Uint8Array;
  inviteValue?: bigint;
  bondValue?: bigint;
  secretHash?: Uint8Array;
  inviteePublicKey?: Uint8Array;
  probationStartBlock?: number;
  probationEndBlock?: number;
  seedHeight?: number;
}): { invite: Stored<InviteBox>; bond: Stored<BondBox> } {
  const inviteCandidate = {
    boxType: 'invite' as const,
    value: opts.inviteValue ?? INVITE_KARMA_AMOUNT,
    secretHash: opts.secretHash ?? new Uint8Array(32).fill(0xaa),
    inviterId: opts.inviterId,
    guard: 'hash_preimage_with_bond' as const,
  };
  const bondCandidate = {
    boxType: 'bond' as const,
    value: opts.bondValue ?? INVITE_BOND_KARMA,
    inviterId: opts.inviterId,
    // Index 0: the invite is output 0 of this same transaction, below.
    inviteOutputIndex: 0,
    inviteePublicKey: opts.inviteePublicKey ?? new Uint8Array(0),
    probationStartBlock: opts.probationStartBlock ?? 0,
    probationEndBlock: opts.probationEndBlock ?? 0,
    guard: 'bond_dual' as const,
  };
  const [invite, bond] = seedAsOneTx(
    [inviteCandidate, bondCandidate],
    opts.seedHeight ?? 1,
    labelNonce(opts.label),
  );
  return {
    invite: invite as Stored<InviteBox>,
    bond: bond as Stored<BondBox>,
  };
}

export function makeKarmaBox(
  value: bigint,
  owner: Uint8Array,
  seedHeight: number,
  nonce = 0,
): KarmaBox {
  const candidate = {
    boxType: 'karma' as const,
    value,
    owner,
    guard: 'owner_signature' as const,
    proofSource: 'genesis',
  };
  const box: KarmaBox = { ...candidate, ...fixtureProvenance(candidate, seedHeight, nonce) };
  box.id = computeBoxId(box);
  return box;
}

/**
 * Build a signed like transaction — the burn shape a real client submits
 * (NODE_INTERFACE → Per-block like settlement): the liker's karma box is
 * consumed into a single karma change box at
 * `−LIKE_KARMA_COST`, with `likeTarget` naming the post inside the signed
 * bytes. A like is a transaction, never a box.
 *
 * Block application re-validates every embedded tx in full, so a fixture that
 * omitted the signature or mis-stated the deficit would be indistinguishable
 * from a forgery and would take the whole block down with it.
 */
export function makeLikeTx(
  liker: TestIdentity,
  karmaBox: KarmaBox,
  targetPostId: string,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaBox.value - LIKE_KARMA_COST,
        owner: liker.userId,
        guard: 'owner_signature',
        proofSource: 'like_op',
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    likeTarget: targetPostId,
  };
  signTransaction(tx, liker.privateKey, Buffer.from(liker.userId).toString('hex'));
  return tx;
}

/**
 * The karma change box a `makeLikeTx` output creates, with its stored id.
 *
 * Routed through the production `materializeOutput` rather than re-deriving
 * here: the id binds the creating transaction, so a fixture that computed it
 * any other way would be asserting against its own arithmetic instead of the
 * node's.
 */
export function changeBoxOf(tx: UtxoTransaction): KarmaBox {
  return materializeOutput(tx.outputs[0]!, computeTxId(tx), 0) as KarmaBox;
}

/**
 * A complete `Config` for a test that has to hand one to production code.
 *
 * Derived from the loaded singleton rather than written out as a literal, so it
 * cannot fall behind `Config`: a field added later arrives already holding the
 * value the node would run with, and a fixture states only its deliberate
 * deviations.
 *
 * ⚠ A hand-written literal in place of this cannot be caught by the type
 * checker if the parameter it is passed to is typed as the literal itself —
 * `(cfg: typeof testConfig) => void` mentions `Config` nowhere and checks the
 * argument against its own shape. Every call site must be declared `Config`, or
 * the fixture is only ever compared to itself. Probe rather than argument:
 * change one `Config` field's type (`creditTreasuryPct: number → bigint`) and
 * every call site should fail.
 *
 * A missing field also fails QUIETLY rather than at the type checker, because
 * `block-creator.ts` is the only consumer that reads config off its argument
 * (`startBlockCreator` assigns it to the module-level `config`), and it reads
 * exactly six: `orderingBlockIntervalMs`, `orderingBlockMinSubBlocks`,
 * `maxSubBlocksPerBlock`, `miningMode`, `creditTreasuryPct`, `treasuryPubKey`.
 * Everything else — `verifyStateRoot` in `applyOrderingBlock`,
 * `maxMempoolEntries` in the mempool cap, `avlKeyLength` in `createAvlProver` —
 * imports the `src/config.js` singleton, which no test mocks, so an incomplete
 * fixture is simply never observed.
 *
 * Note what this design does with a newly *required* field: it fills it with the
 * value production runs with, silently and correctly, rather than failing the
 * build. That is deliberate — the fixtures track production instead of drifting
 * from it — but it means a field a test needs to *deviate* on must still be
 * stated at the call site.
 */
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return { ...config, ...overrides };
}

/**
 * A map keyed by **bytes**, for mocks that stand in for a store lookup.
 *
 * Production compares `user_id` as a SQLite BLOB — **by value**
 * (`getActiveChallenge` binds `Buffer.from(userId)`). A plain `Map` keyed by a
 * `Uint8Array` compares **by reference**, so a mock built that way is strictly
 * *less* permissive than the thing it stands in for: it hits only while a test
 * reuses one array instance, and the moment a key is built twice (`uid('alice')`
 * returns a fresh array each call) the lookup returns `undefined` and the test
 * reads "no active challenge" instead of failing.
 *
 * ⚠ That failure is silent, and one object literal can get it right for one
 * field and wrong for the next. Hex-keying at each call site fixes the sites
 * that exist and leaves the next one free to get it wrong again; converting on
 * the way in cannot be forgotten.
 */
export class ByteKeyedMap<V> {
  private readonly inner = new Map<string, V>();

  private static key(k: Uint8Array): string {
    return Buffer.from(k).toString('hex');
  }

  set(key: Uint8Array, value: V): this {
    this.inner.set(ByteKeyedMap.key(key), value);
    return this;
  }

  get(key: Uint8Array): V | undefined {
    return this.inner.get(ByteKeyedMap.key(key));
  }

  has(key: Uint8Array): boolean {
    return this.inner.has(ByteKeyedMap.key(key));
  }

  delete(key: Uint8Array): boolean {
    return this.inner.delete(ByteKeyedMap.key(key));
  }

  get size(): number {
    return this.inner.size;
  }
}

export const ZERO_HASH = '0'.repeat(64);

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * The first nonce that satisfies the header's declared target, found with the
 * production verifier.
 *
 * Hand-built blocks have to carry a real solution: `powTargetBits` must equal
 * the height schedule, so declaring target 0 to sail past PoW is itself a
 * rejected block and never reaches the checks behind it.
 */
export function solveHeaderPow(header: BlockHeader): number {
  for (let nonce = 0; ; nonce++) {
    if (verifyOrderingBlockPoW({ ...header, powNonce: nonce })) return nonce;
  }
}

/**
 * The validator signature a block creator produces: raw Ed25519 over the 32
 * bytes of `blockHash(header)`. `block-creator.ts` signs this way at both of
 * its block-finalizing sites, and apply verifies it (NODE_INTERFACE → Block
 * finalization).
 *
 * Hand-built blocks therefore have to carry a real signature — an all-zero
 * placeholder is rejected before any check behind it, which would make every
 * post-signature rejection test assert its own reason vacuously. Call this only
 * once `powNonce` is final: the nonce is a header field, so it is inside the
 * hash being signed.
 */
export function signHeader(header: BlockHeader, privateKey: KeyObject): Uint8Array {
  // A header outside the encodable domain has no hash, so there is nothing to
  // sign. Said here rather than left to `Buffer.from(null, 'hex')`, because a
  // test that hits this has built a header no producer could have built and
  // wants to be told which of the two it meant.
  const hash = blockHash(header);
  if (hash === null) {
    throw new Error('signHeader: header is outside the encodable domain — nothing to sign');
  }
  return new Uint8Array(cryptoSign(null, Buffer.from(hash, 'hex'), privateKey));
}

/**
 * A PruneEntry that is internally valid in every respect a node can check
 * without knowing who the author is: the Merkle root is the real root over the
 * subtree ids, and the signature is a real Ed25519 signature over
 * blake2b(rootPostHash ‖ merkleRoot) from `signWith`, whose public key it
 * carries as `authorId`. What a test varies is *whose* key that is.
 */
export function makePruneEntry(
  rootPostHash: string,
  subtreePostIds: string[],
  signWith: TestIdentity,
): PruneEntry {
  const leaves = [...subtreePostIds].sort().map((id) => leafHash('stump', hexToBuf(id)));
  const subtreeMerkleRoot = buildMerkleRoot(leaves);
  const payload = createHash('blake2b512')
    .update(rootPostHash)
    .update(Buffer.from(subtreeMerkleRoot))
    .digest()
    .subarray(0, 32);
  return {
    rootPostHash,
    subtreePostIds,
    subtreeMerkleRoot,
    authorId: signWith.userId,
    authorSignature: new Uint8Array(cryptoSign(null, payload, signWith.privateKey)),
    trigger: 'author',
  };
}

/**
 * A hand-built block that passes every apply check: chain-linked at genesis,
 * correct Merkle roots, coinbase paying exactly the scheduled emission with the
 * scheduled maturity lock, the post-block AVL state root, a real PoW solution
 * at the scheduled target, and a real validator signature from the key its
 * header names.
 *
 * Each override deviates in exactly one respect, so what a test measures is
 * that deviation and nothing else.
 *
 * The state root is computed against the state *as it stands when this is
 * called*, because that is the state the mutation phase runs on. A block built
 * now and applied after the chain has moved carries a stale root and is
 * rejected — build it against the state it will be applied to.
 */
export async function makeApplicableBlock(
  opts: {
    powTargetBits?: number;
    lockedUntilBlock?: number;
    /** Override the post-block state root — a block committing to state it
     *  does not produce. */
    stateRoot?: string;
    /** Sign with this key instead of the miner's — a block whose signature does
     *  not come from the key its `validatorId` names (forged authorship). */
    signWith?: KeyObject;
    /** Height to build at; anything above 1 chain-links to the stored block below. */
    height?: number;
    /** Sub-block entries this block confirms (topology + authorship). */
    subBlockEntries?: SubBlockEntry[];
    /** Prune entries this block settles. */
    pruneEntries?: PruneEntry[];
    /** Mine to this identity (coinbase owner + validatorId) instead of a fresh
     *  one — lets a test seed pre-existing boxes for the coinbase owner. */
    miner?: TestIdentity;
    /** Embed these UTXO transactions directly — the validator-embeds-a-tx
     *  shape, bypassing every gateway (mempool intake, castLike's
     *  one-signature rule). Ids and CBOR are derived here, so the Merkle
     *  commitment is honest; whether the txs are *valid* is exactly what the
     *  suite's apply measures. Listed in the order given — dependency order
     *  is the apply loop's job. */
    utxoTxs?: UtxoTransaction[];
    /** Split the coinbase across these owners instead of paying the miner
     *  alone — the shape a node with `creditTreasuryPct > 0` produces. The
     *  shares must sum to the scheduled emission or apply rejects the block. */
    coinbaseSplit?: Array<{ owner: Uint8Array; value: bigint; isTreasury: boolean }>;
  } = {},
): Promise<OrderingBlock> {
  const { computeSubBlockRoot, computeUtxoTxRoot, computeBlockReward } = await import(
    '../src/services/block-creator.js'
  );
  const { expectedTarget } = await import('../src/services/difficulty.js');

  const height = opts.height ?? 1;
  let prevBlockHash = ZERO_HASH;
  if (height > 1) {
    const { getOrderingBlock } = await import('../src/store/ordering.js');
    const prev = getOrderingBlock(height - 1) as OrderingBlock | null;
    if (!prev) throw new Error(`makeApplicableBlock: no stored block at height ${height - 1}`);
    const prevHash = blockHash(prev.header);
    if (prevHash === null) {
      throw new Error(
        `makeApplicableBlock: stored block at height ${height - 1} has a header ` +
        `outside the encodable domain`,
      );
    }
    prevBlockHash = prevHash;
  }
  const miner = opts.miner ?? makeTestIdentity();
  const subBlockEntries = opts.subBlockEntries ?? [];
  const subBlockTree = {
    subBlockEntries,
    pruneEntries: opts.pruneEntries ?? [],
  };
  const lockedUntilBlock = opts.lockedUntilBlock ?? height + CREDIT_MINER_REWARD_DELAY;
  const embeddedTxs = opts.utxoTxs ?? [];
  const utxoTxTree = {
    utxoTxIds: embeddedTxs.map((tx) => computeTxId(tx)),
    utxoTxs: embeddedTxs.map((tx) => encodeTx(tx)),
    coinbaseOutputs: (
      opts.coinbaseSplit ?? [
        { owner: miner.userId, value: computeBlockReward(height), isTreasury: false },
      ]
    ).map((share) => ({ ...share, lockedUntilBlock })),
  };

  const header = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash,
    subBlockRoot: computeSubBlockRoot(subBlockTree),
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: miner.userId,
    powNonce: 0,
    powTargetBits: opts.powTargetBits ?? expectedTarget(height),
    createdAt: Date.now(),
  } as BlockHeader;

  const block = {
    header,
    subBlockTree,
    utxoTxTree,
    validatorSignature: new Uint8Array(64),
  } as unknown as OrderingBlock;

  // Post-block state root (NODE_INTERFACE → Post-block stateRoot), obtained the
  // way the block creator obtains it: by running this body through the apply
  // path's own mutation phase and rolling it back. It has to be final before
  // the nonce and the signature,
  // which both cover the header. No prover — most suites — speculates
  // `no-prover`, and apply skips the check there, so EMPTY_STATE_ROOT stands
  // in. A `body-rejected` body gets EMPTY_STATE_ROOT too: the helper's job is
  // to hand the caller its block either way, and the suite's own apply will
  // reject the body loudly.
  const { computePostBlockStateRoot } = await import('../src/services/block-apply.js');
  const speculation = computePostBlockStateRoot(block, height);
  header.stateRoot =
    opts.stateRoot ??
    (speculation.kind === 'computed' ? speculation.stateRoot : EMPTY_STATE_ROOT);

  header.powNonce = solveHeaderPow(header);
  block.validatorSignature = signHeader(header, opts.signWith ?? miner.privateKey);
  return block;
}

/**
 * Convert a UtxoTransaction to a JSON-safe object suitable for HTTP API
 * requests.  Uint8Array fields are hex-encoded.
 */
export function txToJson(tx: UtxoTransaction): Record<string, unknown> {
  return {
    inputs: tx.inputs,
    outputs: tx.outputs.map((o) => {
      const obj: Record<string, unknown> = { ...o };
      for (const [k, v] of Object.entries(obj)) {
        if (v instanceof Uint8Array) obj[k] = Buffer.from(v).toString('hex');
        // Box values/amounts are bigint — the JSON API carries them as
        // decimal strings (json-to-tx coerces them back).
        else if (typeof v === 'bigint') obj[k] = v.toString();
      }
      return obj;
    }),
    signatures: Object.fromEntries(
      Object.entries(tx.signatures).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
    ),
    preimages: tx.preimages
      ? Object.fromEntries(
          Object.entries(tx.preimages).map(([k, v]) => [k, Buffer.from(v).toString('hex')]),
        )
      : undefined,
    protocolVersion: tx.protocolVersion,
    // Present ⟺ the tx is a like — the JSON edge must not drop it, since it
    // sits inside the signed bytes.
    ...(tx.likeTarget !== undefined ? { likeTarget: tx.likeTarget } : {}),
  };
}
