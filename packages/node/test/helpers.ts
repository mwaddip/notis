import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'crypto';
import {
  computeTxId,
  computePostId,
  postFieldBytes,
  computeBoxId,
  canonicalBoxBytes,
  encodeTx,
  u32BE,
  leafHash,
  buildMerkleRoot,
  hexToBuf,
  PROTOCOL_VERSION,
  LIKE_KARMA_COST,
  POST_LOCK_THREAD_COST,
  POST_LOCK_REPLY_COST,
  EMPTY_STATE_ROOT,
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
  CreditBox,
  BlockHeader,
  OrderingBlock,
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
    protocolVersion: PROTOCOL_VERSION,
    timestamp: Date.now(),
  };
}

/**
 * A post, the signed transaction that creates it, the id that transaction gives
 * it, and the karma box it spends — the only way to name a post now.
 *
 * ⛔ **A post id cannot be derived from a post.** `computePostId(txId, index)`
 * takes no `Post` (TYPES_INTERFACE → Hashing functions), so a fixture that wants
 * an id has to build the creating transaction first. That inversion is the whole
 * of option (C), and a helper that hid it would let a test assert an id the
 * production path could never produce.
 *
 * ⚠ **`karmaBox` is returned, not seeded, and any caller whose block carries the
 * transaction has to insert it.** Apply defers a transaction whose inputs are
 * absent and REJECTS the block when they never arrive — the block commits to the
 * tx in `utxoTxIds`, so a body that cannot apply it is a body its own `stateRoot`
 * cannot reflect. An unseeded input therefore fails loudly at
 * `applyOrderingBlock`, never quietly at the assertions downstream. The box is
 * deterministic in the author and the content, so seeding it twice for one
 * fixture is a `UNIQUE(tx_id, output_index)` failure rather than a silent second
 * box.
 *
 * The transaction satisfies the engine's post biconditional
 * (`utxo-engine.checkTransitions`): one karma input, one karma change output and
 * one `PostLockBox` at the cost for this post's shape — `POST_LOCK_REPLY_COST`
 * when it carries parent refs, `POST_LOCK_THREAD_COST` when it does not — owned
 * by the author, who owns the karma being spent.
 */
export function makePostTx(
  author: TestIdentity,
  content = 'test post',
  overrides: Partial<Post> = {},
): { post: Post; tx: UtxoTransaction; postId: string; karmaBox: KarmaBox } {
  const post: Post = { ...makePost(author.userId, content), ...overrides };
  const lock =
    post.parentRefs.length === 0 ? POST_LOCK_THREAD_COST : POST_LOCK_REPLY_COST;
  // One karma above the lock, so the change output is non-zero and the
  // conservation check is a real subtraction rather than an identity.
  const karmaBox = makeKarmaBox(lock + 1n, author.userId, 0, fixtureNonce(content));
  const tx: UtxoTransaction = {
    inputs: [karmaBox.id!],
    outputs: [
      { boxType: 'karma', value: 1n, owner: author.userId, guard: 'owner_signature' } as never,
      {
        boxType: 'post_lock',
        value: lock,
        originalValue: lock,
        owner: author.userId,
        guard: 'block_apply',
      } as never,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    post,
  };
  signTransaction(tx, author.privateKey, toHex(author.userId));
  const txId = computeTxId(tx);
  return { post, tx, postId: computePostId(txId, 0), karmaBox };
}

/**
 * `makePostTx` with its karma input already in the store — what a test wants
 * whenever a block or the pool is going to carry the transaction.
 *
 * The store module is reached by DYNAMIC import, which is what makes this safe
 * under `vi.resetModules()`: a static import here would bind one module instance
 * for the whole file while each test's own `importUtxo()` gets a fresh one, and
 * the two would hold different `db` handles. Every store-touching helper in this
 * file imports the same way, for the same reason.
 */
export async function seedPostTx(
  author: TestIdentity,
  content = 'test post',
  overrides: Partial<Post> = {},
): Promise<{ post: Post; tx: UtxoTransaction; postId: string; karmaBox: KarmaBox }> {
  const made = makePostTx(author, content, overrides);
  const { insertBox } = await import('../src/store/utxo.js');
  insertBox(made.karmaBox);
  return made;
}

/**
 * A per-content nonce for the karma box a post fixture spends. Two posts by one
 * author in one test seed two boxes, and identical boxes derive one fixture txId
 * — `UNIQUE(tx_id, output_index)`. Deterministic, so a fixture built twice keeps
 * its ids.
 */
function fixtureNonce(content: string): number {
  return createHash('blake2b512').update(content).digest().readUInt32BE(0);
}

/**
 * A distinct, well-formed transaction per label — a pool occupant for a test
 * whose subject is the mempool's bookkeeping rather than the transaction.
 *
 * Each names its own input box, because `insertUtxoTx` refuses a second pending
 * spend of the same box: two fillers sharing an input would make a
 * capacity or FIFO test measure the conflict rule instead.
 */
export function fillerTx(label: string): UtxoTransaction {
  const id = createHash('blake2b512')
    .update(new TextEncoder().encode('dagsocial/test-filler/1'))
    .update(new TextEncoder().encode(label))
    .digest().subarray(0, 32).toString('hex');
  return { inputs: [id], outputs: [], signatures: {}, protocolVersion: PROTOCOL_VERSION };
}

/**
 * The id a post fixture gets from its creating transaction.
 *
 * ⛔ **A post id is not a function of a post** — `computePostId(txId, index)`
 * takes no `Post` (TYPES_INTERFACE → Hashing functions). A fixture that seeds a
 * post directly into the store has no creating transaction, so this manufactures
 * the stand-in, exactly as `fixtureProvenance` below does for a seeded box.
 *
 * Deterministic on the post's own bytes, so a fixture built twice gets the same
 * id and golden values stay stable across runs and file orderings.
 *
 * ⚠ **This is a FIXTURE helper and its name says so.** It runs the real
 * `computePostId` over a synthetic `TxId`, so it is structurally what production
 * does — but a test asserting a *production* id must build the real transaction
 * (`makePostTx`), not call this.
 */
export function fixturePostId(post: Post): string {
  const synthetic = createHash('blake2b512')
    .update(new TextEncoder().encode('dagsocial/test-fixture-post-tx/1'))
    .update(postFieldBytes(post))
    .digest()
    .subarray(0, 32)
    .toString('hex');
  return computePostId(synthetic, 0);
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
 * The shape an invite/bond pair needs: production emits the two from one
 * transaction, so a fixture giving them independent provenance is a pair no
 * transaction could have produced.
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
 * Production emits the pair from one transaction, and every rule that reads them
 * assumes it: both boxes carry the same `inviterId` and the same
 * `inviteePublicKey`, and that key IS the pairing — an address is invited once,
 * ever, so it names exactly one live pair.
 *
 * **`label` is required, and it is the whole point.** `seedAsOneTx` derives the
 * shared txId from `candidates[0]` alone, so two pairs whose *invite* is
 * structurally identical at the same `seedHeight` get the same txId — and
 * therefore colliding box ids. Measured, and it is sharper than it first looks:
 * because only `candidates[0]` feeds the txId, a difference confined to the
 * **bond** does not separate the pairs either. Two such pairs produce bonds with
 * *different ids* sharing one `(txId, index)`, which is exactly what
 * `UNIQUE(tx_id, output_index)` forbids. Centralising the pattern here would
 * multiply that hazard across every caller, so `label` has no default: forgetting
 * it is a compile error rather than a silent collision. Pinned by
 * `helpers.test.ts`.
 */
export function seedInviteAndBond(opts: {
  /** Distinguishes this pair from every other. Required — see above. */
  label: string;
  inviterId: Uint8Array;
  inviteValue?: bigint;
  bondValue?: bigint;
  inviteePublicKey?: Uint8Array;
  seedHeight?: number;
}): { invite: Stored<InviteBox>; bond: Stored<BondBox> } {
  const invitee = opts.inviteePublicKey ?? new Uint8Array(32).fill(0xaa);
  const inviteCandidate = {
    boxType: 'invite' as const,
    // An invite holds nothing; the karma it names is minted at the claim.
    value: opts.inviteValue ?? 0n,
    inviterId: opts.inviterId,
    inviteePublicKey: invitee,
    guard: 'invite_dual' as const,
  };
  const bondCandidate = {
    boxType: 'bond' as const,
    value: opts.bondValue ?? INVITE_BOND_KARMA,
    inviterId: opts.inviterId,
    inviteePublicKey: invitee,
    guard: 'block_apply' as const,
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
  };
  const box: KarmaBox = { ...candidate, ...fixtureProvenance(candidate, seedHeight, nonce) };
  box.id = computeBoxId(box);
  return box;
}

export function makeCreditBox(
  value: bigint,
  owner: Uint8Array,
  seedHeight: number,
  nonce = 0,
): CreditBox {
  const candidate = {
    boxType: 'credit' as const,
    value,
    owner,
    guard: 'owner_signature' as const,
  };
  const box: CreditBox = { ...candidate, ...fixtureProvenance(candidate, seedHeight, nonce) };
  box.id = computeBoxId(box);
  return box;
}

/**
 * A signed credit transfer that leaves `fee` unspent — the deficit the block
 * carrying it claims in its coinbase (MINING_INTERFACE → Coinbase Application).
 *
 * The change goes back to the spender, so the only value that leaves the
 * transaction's own arithmetic is the fee. `inputs` are boxes, not ids, because
 * the sum has to be taken over what they actually hold: a fee stated against a
 * mis-stated input total is a fixture that tests the wrong number.
 */
export function makeCreditTx(
  spender: TestIdentity,
  inputs: CreditBox[],
  fee: bigint,
  recipient?: Uint8Array,
): UtxoTransaction {
  const total = inputs.reduce((sum, b) => sum + b.value, 0n);
  const tx: UtxoTransaction = {
    inputs: inputs.map((b) => b.id!),
    outputs: [
      {
        boxType: 'credit',
        value: total - fee,
        owner: recipient ?? spender.userId,
        guard: 'owner_signature',
      } as CreditBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, spender.privateKey, hex(spender.userId));
  return tx;
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
 * The `PostLockBox` a `makePostTx` transaction creates, with its stored id —
 * output 1, where `changeBoxOf` takes output 0.
 *
 * Same routing through `materializeOutput`, for the same reason: prune
 * settlement finds this box by the id apply gave it, so a fixture that derived
 * the id another way would assert against its own arithmetic.
 */
export function lockBoxOf(tx: UtxoTransaction): AnyBox {
  return materializeOutput(tx.outputs[1]!, computeTxId(tx), 1);
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
 * change one `Config` field's type (`blockBodyBudgetBytes: number → bigint`) and
 * every call site should fail.
 *
 * A missing field also fails QUIETLY rather than at the type checker, because
 * `block-creator.ts` is the only consumer that reads config off its argument
 * (`startBlockCreator` assigns it to the module-level `config`), and it reads
 * exactly one: `blockBodyBudgetBytes`, which is a local preference over a
 * consensus ceiling and so is a node's own to set. Everything the applier
 * re-derives — the coinbase's slices, the treasury key, the maturity lock —
 * reads the `src/config.js` singleton and the network profile instead, because
 * a creator reading a local value would build blocks its own network refuses.
 * Everything else — `verifyStateRoot` in `applyOrderingBlock`,
 * `maxMempoolEntries` in the mempool cap, `avlKeyLength` in `createAvlProver` —
 * imports that singleton too, which no test mocks, so an incomplete fixture is
 * simply never observed.
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
 * The next ordering block, mined over the path a miner uses: the creator stores
 * a template, this solves its header, and `submitMinedBlock` signs, finalizes
 * and applies it (MINING_INTERFACE → Mining API).
 *
 * Returns the block **as the node stored it**, so its `validatorSignature` is
 * the validator's and the block re-applies. The template's is a 64-byte zero
 * placeholder — `submitMinedBlock` signs its own copy — and a block carrying
 * that is refused at `verifyValidatorSignature` before any check behind it.
 *
 * `null` means no block reached the chain: either the creator declined to build
 * a template (a body the speculative apply rejected) or apply refused the
 * finalized block.
 *
 * The store is imported here rather than at module scope because a test that
 * has called `vi.resetModules()` holds a newer instance than this file's own
 * imports, and only the newer one shares a database with the caller's `bc`.
 */
export async function mineNextBlock(bc: {
  createOrderingBlock: () => OrderingBlock | null;
  getCurrentTemplate: () => OrderingBlock | null;
  submitMinedBlock: (powNonce: number, submittedHeight: number) => string | null;
}): Promise<OrderingBlock | null> {
  bc.createOrderingBlock();
  const tpl = bc.getCurrentTemplate();
  if (tpl === null) return null;
  const nonce = solveHeaderPow(tpl.header);
  if (bc.submitMinedBlock(nonce, tpl.header.height) === null) return null;
  const { getOrderingBlock } = await import('../src/store/ordering.js');
  return getOrderingBlock(tpl.header.height);
}

/**
 * The validator signature a block creator produces: raw Ed25519 over the 32
 * bytes of `blockHash(header)`. `block-creator.ts` signs this way in
 * `submitMinedBlock`, its one block-finalizing site, and apply verifies it
 * (NODE_INTERFACE → Block finalization).
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
    /** Replace the coinbase outright. The default is the one the block's own
     *  body requires — `splitCoinbase` over the emission, the fees the embedded
     *  transactions leave, and the actors they carry — so a test states this
     *  only to deviate from it deliberately. */
    coinbaseSplit?: Array<{ owner: Uint8Array; value: bigint; isTreasury: boolean }>;
  } = {},
): Promise<OrderingBlock> {
  const { computeUtxoTxRoot, buildCoinbaseOutputs, predictIncome } = await import(
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
  const lockedUntilBlock = opts.lockedUntilBlock ?? height + config.creditMinerRewardDelay;
  const embeddedTxs = opts.utxoTxs ?? [];
  const txCbors = embeddedTxs.map((tx) => encodeTx(tx));

  // The coinbase this body requires, built the way the creator builds it — the
  // helper's contract is a block that passes every apply check, and since the
  // coinbase became the block's income that is a function of the body rather
  // than of the height alone. A test that wants a wrong coinbase says so.
  const { fees, actors } = predictIncome(txCbors, miner.userId);
  const utxoTxTree = {
    utxoTxIds: embeddedTxs.map((tx) => computeTxId(tx)),
    utxoTxs: txCbors,
    pruneEntries: opts.pruneEntries ?? [],
    coinbaseOutputs: opts.coinbaseSplit
      ? opts.coinbaseSplit.map((share) => ({ ...share, lockedUntilBlock }))
      : buildCoinbaseOutputs(height, fees, actors, miner.userId).map((out) => ({
          ...out,
          lockedUntilBlock,
        })),
  };

  const header = {
    protocolVersion: PROTOCOL_VERSION,
    height,
    prevBlockHash,
    utxoTxRoot: computeUtxoTxRoot(utxoTxTree),
    stateRoot: EMPTY_STATE_ROOT,
    validatorId: miner.userId,
    powNonce: 0,
    powTargetBits: opts.powTargetBits ?? expectedTarget(height),
    createdAt: Date.now(),
  } as BlockHeader;

  const block = {
    header,
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
