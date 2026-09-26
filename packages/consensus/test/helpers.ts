import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'crypto';
import {
  EMPTY_STATE_ROOT,
  LIKE_KARMA_COST,
  POST_PRICE_REPLY,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  REPLY_AUTHOR_SHARE,
  USERNAME_BURN_PRICE,
  VOUCH_KARMA_AMOUNT,
  canonicalBoxBytes,
  computeBoxId,
  computeContentHash,
  computePostId,
  computeTxId,
  decayCfgFor,
  encodeTx,
  u32BE,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  BackerPoolBox,
  BondBox,
  BoxId,
  CreditBox,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  NetworkProfile,
  OrderingBlock,
  PostCommit,
  TreasuryBox,
  UtxoTransaction,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import { buildBlockSettlement, materializeOutput } from '@dagsocial/consensus';
import type { ApplyContext, StateView } from '@dagsocial/consensus';

/**
 * Convert a short string label to a deterministic 32-byte Uint8Array
 * suitable as a UserId (Ed25519 public key) for testing.
 */
export function uid(label: string): Uint8Array {
  const h = createHash('blake2b512').update(label).digest();
  return new Uint8Array(h.subarray(0, 32));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Extract raw 32-byte Ed25519 public key from SPKI DER KeyObject. */
export function rawPublicKey(keyObj: KeyObject): Uint8Array {
  const der = keyObj.export({ type: 'spki', format: 'der' }) as Buffer;
  return new Uint8Array(der.subarray(der.length - 32));
}

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

/**
 * A `u32BE`-encodable nonce derived from a caller-supplied label.
 *
 * Deterministic, so a fixture built twice with the same label gets the same
 * ids across runs and file orderings. Masked to 31 bits so the value can
 * never reach `U32_SENTINEL` (`0xffffffff`), which `u32BE` reserves for the
 * un-encodable case.
 */
export function labelNonce(label: string): number {
  const h = createHash('blake2b512').update(label).digest();
  return h.readUInt32BE(0) & 0x7fffffff;
}

/**
 * Synthetic creating-transaction provenance for a seeded fixture box.
 *
 * Fixtures seed boxes directly rather than through a real transaction or a
 * mint, so they have no txId of their own — but `tx_id` and `output_index`
 * are NOT NULL, and the box id derives from them (NODE_INTERFACE → Box
 * Identity and Mint Provenance). This manufactures a stand-in, deterministic
 * on the candidate bytes plus the seed height and nonce, with its own domain
 * tag so a fixture id can never be mistaken for one a real mint or
 * transaction would produce.
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
 * A box as it exists once seeded: `id` present.
 *
 * `BoxBase.id` is optional because it is genuinely absent for one
 * expression — between building the candidate-plus-provenance object and
 * hashing it. A box that has been through `seedProvenance` is past that
 * point.
 */
export type Stored<B extends AnyBox = AnyBox> = B & { id: BoxId };

/**
 * Give a hand-built candidate the provenance and id a stored box must have.
 *
 * Mutates in place so a factory that already holds a reference to the
 * candidate keeps seeing the finished box. `computeBoxId(result) ===
 * result.id` holds for everything it returns.
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
 * The bond the fixtures name where the value is incidental — any amount
 * inside the running profile's range, which the devnet profile floors at 5
 * and caps at 250.
 */
export const FIXTURE_BOND_KARMA = 25n;

/**
 * The context a network profile gives the rules (CONSENSUS_INTERFACE → ApplyContext), for a
 * suite that runs them under a real profile.
 */
export function applyContextFor(profile: NetworkProfile): ApplyContext {
  return {
    protocolVersionSchedule: profile.protocolVersionSchedule,
    vouchCooldownBlocks: profile.vouchCooldownBlocks,
    inviteBondMin: profile.inviteBondMin,
    inviteBondMax: profile.inviteBondMax,
    inviteProbationBlocks: profile.inviteProbationBlocks,
    decayCfg: decayCfgFor(profile),
    storageRentPeriodBlocks: profile.storageRentPeriodBlocks,
    membershipBarMultiplier: profile.membershipBarMultiplier,
    backerSupply: profile.backerSupply,
    creditFixedRateBlocks: profile.creditFixedRateBlocks,
    creditEpochBlocks: profile.creditEpochBlocks,
    creditMinerRewardDelay: profile.creditMinerRewardDelay,
  };
}

/** An identity record with every field zero but the ones a fixture names. */
export function identityRecord(fields: Partial<IdentityRecord> = {}): IdentityRecord {
  return {
    lastActivityBlock: 0,
    lastDecayBlock: 0,
    invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0,
    memberBar: 0,
    memberVouches: 0,
    memberLikes: 0n,
    invitesUsed: 0,
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Stored boxes — `nonce` keeps two boxes of one content apart
// ---------------------------------------------------------------------------

export function karmaBox(owner: Uint8Array, value: bigint, nonce: number, createdAtBlock = 1): Stored<KarmaBox> {
  return seedProvenance<KarmaBox>({ boxType: 'karma', value, createdAtBlock, owner }, createdAtBlock, nonce);
}

export function escrowBox(
  owner: Uint8Array,
  releaseAtBlock: number,
  nonce: number,
  createdAtBlock = 1,
): Stored<VouchEscrowBox> {
  return seedProvenance<VouchEscrowBox>(
    { boxType: 'vouch_escrow', value: 1n, createdAtBlock, owner, releaseAtBlock },
    createdAtBlock,
    nonce,
  );
}

export function vouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  nonce: number,
  createdAtBlock = 1,
): Stored<VouchBox> {
  return seedProvenance<VouchBox>(
    { boxType: 'vouch', value: 1n, createdAtBlock, voucherId, targetId },
    createdAtBlock,
    nonce,
  );
}

export function accrualBox(author: Uint8Array, value: bigint, nonce: number, createdAtBlock = 1): Stored<LikeAccrualBox> {
  return seedProvenance<LikeAccrualBox>(
    { boxType: 'like_accrual', value, createdAtBlock, author },
    createdAtBlock,
    nonce,
  );
}

export function bondBox(
  inviterId: Uint8Array,
  inviteePublicKey: Uint8Array,
  nonce: number,
  createdAtBlock = 1,
): Stored<BondBox> {
  return seedProvenance<BondBox>(
    { boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock, inviterId, inviteePublicKey },
    createdAtBlock,
    nonce,
  );
}

/** One of the four protocol boxes — no owner, no per-type field but the backer pool's. */
export function protocolBox(
  boxType: 'emission' | 'treasury' | 'karma_pool' | 'backer_pool',
  value: bigint,
  nonce: number,
  createdAtBlock = 0,
): Stored<EmissionBox | TreasuryBox | KarmaPoolBox | BackerPoolBox> {
  const candidate = boxType === 'backer_pool'
    ? { boxType, value, createdAtBlock, staked: 0n, accrual: 0n }
    : { boxType, value, createdAtBlock };
  return seedProvenance(candidate, createdAtBlock, nonce);
}

// ---------------------------------------------------------------------------
// A StateView over maps (CONSENSUS_INTERFACE → Tests)
// ---------------------------------------------------------------------------

// Both import nothing Node, so the bundle test builds them for a browser.
export { MemoryStateView, writeEffects } from './memory-state-view.js';

// ---------------------------------------------------------------------------
// Signed transactions and candidate blocks
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 identity from a fixed seed — the same key on every run. */
export function seededIdentity(label: string): TestIdentity {
  const seed = createHash('blake2b512').update(`dagsocial/test/consensus/${label}`).digest().subarray(0, 32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const userId = rawPublicKey(createPublicKey(privateKey));
  return { userId, publicKey: userId, privateKey };
}

/** A transaction, its id, and its outputs with the ids block application gives them. */
export interface Built {
  tx: UtxoTransaction;
  txId: string;
  out: AnyBox[];
}

export interface BuiltPost extends Built {
  postId: string;
  commit: PostCommit;
}

/** Sign (unless unsigned) and materialize the outputs under the transaction's id. */
export function finish(tx: UtxoTransaction, signer: TestIdentity | null): Built {
  if (signer !== null) {
    const unsignedId = computeTxId(tx);
    tx.signatures[hex(signer.userId)] = new Uint8Array(
      cryptoSign(null, Buffer.from(unsignedId, 'hex'), signer.privateKey),
    );
  }
  const txId = computeTxId(tx);
  return { tx, txId, out: tx.outputs.map((o, i) => materializeOutput(o, txId, i)) };
}

const karmaOut = (owner: Uint8Array, value: bigint, h: number): AnyBoxCandidate =>
  ({ boxType: 'karma', value, createdAtBlock: h, owner }) as AnyBoxCandidate;

/** The karma change output — output 0 of every builder that leaves one. */
export function changeOf(built: Built): KarmaBox {
  const change = built.out[0];
  if (!change || change.boxType !== 'karma') throw new Error('the transaction leaves no karma change');
  return change;
}

function commitOf(author: TestIdentity, content: string, parentRefs: string[]): PostCommit {
  return {
    contentHash: computeContentHash(content),
    author: author.userId,
    parentRefs,
    protocolVersion: PROTOCOL_VERSION,
    type: 'regular',
  };
}

export function threadTx(author: TestIdentity, input: KarmaBox, content: string, h: number): BuiltPost {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > POST_PRICE_THREAD) outputs.push(karmaOut(author.userId, input.value - POST_PRICE_THREAD, h));
  outputs.push({ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: h } as AnyBoxCandidate);
  const commit = commitOf(author, content, []);
  const built = finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, post: commit },
    author,
  );
  return { ...built, postId: computePostId(built.txId, 0), commit };
}

export function replyTx(
  author: TestIdentity,
  input: KarmaBox,
  content: string,
  parentId: string,
  parentAuthor: Uint8Array,
  h: number,
): BuiltPost {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > POST_PRICE_REPLY) outputs.push(karmaOut(author.userId, input.value - POST_PRICE_REPLY, h));
  outputs.push(
    { boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: h } as AnyBoxCandidate,
    { boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: h, author: parentAuthor } as AnyBoxCandidate,
  );
  const commit = commitOf(author, content, [parentId]);
  const built = finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, post: commit },
    author,
  );
  return { ...built, postId: computePostId(built.txId, 0), commit };
}

export function likeTx(liker: TestIdentity, input: KarmaBox, postId: string, author: Uint8Array, h: number): Built {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > LIKE_KARMA_COST) outputs.push(karmaOut(liker.userId, input.value - LIKE_KARMA_COST, h));
  outputs.push({ boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: h, author } as AnyBoxCandidate);
  return finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, likeTarget: postId },
    liker,
  );
}

export function vouchTx(voucher: TestIdentity, input: KarmaBox, target: Uint8Array, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(voucher.userId, input.value - VOUCH_KARMA_AMOUNT, h),
      { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: h, voucherId: voucher.userId, targetId: target } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, voucher);
}

export function unvouchTx(voucher: TestIdentity, staked: VouchBox, cooldown: number, h: number): Built {
  return finish({
    inputs: [staked.id!],
    outputs: [{
      boxType: 'vouch_escrow',
      value: staked.value,
      createdAtBlock: h,
      owner: voucher.userId,
      releaseAtBlock: staked.createdAtBlock + cooldown,
    } as AnyBoxCandidate],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, voucher);
}

export function inviteTx(inviter: TestIdentity, input: KarmaBox, invitee: Uint8Array, bond: bigint, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(inviter.userId, input.value - bond, h),
      { boxType: 'bond', value: bond, createdAtBlock: h, inviterId: inviter.userId, inviteePublicKey: invitee } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, inviter);
}

export function claimTx(holder: TestIdentity, input: KarmaBox, name: string, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(holder.userId, input.value, h),
      { boxType: 'username', value: 0n, createdAtBlock: h, owner: holder.userId, name: new TextEncoder().encode(name) } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, holder);
}

export function burnTx(holder: TestIdentity, input: KarmaBox, nameBox: AnyBox, h: number): Built {
  return finish({
    inputs: [input.id!, nameBox.id!],
    outputs: [
      karmaOut(holder.userId, input.value - USERNAME_BURN_PRICE, h),
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: h } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, holder);
}

export function withdrawTx(author: TestIdentity, input: KarmaBox, postId: string, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [karmaOut(author.userId, input.value, h)],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  }, author);
}

export function consolidateTx(owner: TestIdentity, inputs: KarmaBox[], h: number): Built {
  return finish({
    inputs: inputs.map((b) => b.id!),
    outputs: [karmaOut(owner.userId, inputs.reduce((sum, b) => sum + b.value, 0n), h)],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, owner);
}

export function creditSendTx(
  sender: TestIdentity,
  input: CreditBox,
  amount: bigint,
  recipient: Uint8Array,
  fee: bigint,
  h: number,
): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      { boxType: 'credit', value: amount, createdAtBlock: h, owner: recipient } as AnyBoxCandidate,
      { boxType: 'credit', value: input.value - amount - fee, createdAtBlock: h, owner: sender.userId } as AnyBoxCandidate,
      { boxType: 'fee', value: fee, createdAtBlock: h } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, sender);
}

/**
 * A candidate block of these transactions at `height`, its settlement the
 * producer's build over `view` and its last entry. The hash-covered header
 * fields are placeholders, as in the producer's speculative run: `applyBlock`
 * reads `height` and `validatorId` alone.
 */
export function candidateBlock(
  view: StateView,
  height: number,
  txs: Built[],
  validator: Uint8Array,
  ctx: ApplyContext,
): OrderingBlock {
  const txBytes = txs.map((b) => encodeTx(b.tx));
  const settled = buildBlockSettlement(view, txBytes, height, validator, validator, ctx);
  if ('error' in settled) throw new Error(`no settlement at height ${height}: ${settled.error}`);
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      height,
      prevBlockHash: '0'.repeat(64),
      utxoTxRoot: '0'.repeat(64),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: validator,
      powNonce: 0,
      powTargetBits: 0,
      createdAt: 0,
      interlinkRoot: '0'.repeat(64),
    },
    utxoTxTree: {
      utxoTxIds: [...txs.map((b) => b.txId), computeTxId(settled.tx)],
      utxoTxs: [...txBytes, encodeTx(settled.tx)],
    },
    validatorSignature: new Uint8Array(64),
  };
}
