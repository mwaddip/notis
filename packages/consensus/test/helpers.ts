import { createHash, generateKeyPairSync, type KeyObject } from 'crypto';
import { canonicalBoxBytes, computeBoxId, decayCfgFor, u32BE } from '@dagsocial/types';
import type {
  AnyBox,
  BackerPoolBox,
  BondBox,
  BoxId,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  NetworkProfile,
  TreasuryBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import type { ApplyContext, NetworkRecord, StateView, UsernameRow } from '@dagsocial/consensus';

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

const idOrder = (a: AnyBox, b: AnyBox): number => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);

/**
 * A `StateView` over maps — the stub view the overlay and `applyBlock` suites
 * read through. Every query answers with the order and the limit of the store's
 * own query for it (CONSENSUS_INTERFACE → StateView), computed from the whole map
 * on each call rather than composed, so it states each read independently of
 * the overlay: the overlay over this view after a write must answer what this
 * view answers once the same write is applied to it.
 */
export class MemoryStateView implements StateView {
  private readonly boxes = new Map<string, { box: AnyBox; live: boolean }>();
  private readonly records = new Map<string, IdentityRecord>();
  private network: NetworkRecord;
  private readonly names = new Map<string, UsernameRow>();
  private readonly topology = new Map<string, { author: Uint8Array; height: number }>();
  private readonly posts = new Map<string, 'live' | 'withdrawn'>();
  private readonly likes = new Set<string>();

  constructor(network: NetworkRecord = { memberCount: 0 }) {
    this.network = network;
  }

  /** An independent copy: a reference a suite applies the same writes to. */
  clone(): MemoryStateView {
    const copy = new MemoryStateView(this.network);
    for (const [id, entry] of this.boxes) copy.boxes.set(id, { ...entry });
    for (const [key, record] of this.records) copy.records.set(key, record);
    for (const [name, row] of this.names) copy.names.set(name, row);
    for (const [postId, row] of this.topology) copy.topology.set(postId, row);
    for (const [postId, standing] of this.posts) copy.posts.set(postId, standing);
    for (const like of this.likes) copy.likes.add(like);
    return copy;
  }

  // ---- writes: a fixture's seeding, and a reference's copy of a block's writes ----

  insertBox(box: AnyBox): void {
    if (box.id === undefined) throw new Error('MemoryStateView.insertBox: the box carries no id');
    if (this.boxes.has(box.id)) throw new Error(`MemoryStateView.insertBox: ${box.id} is held`);
    this.boxes.set(box.id, { box, live: true });
  }

  consumeBox(id: string): void {
    const entry = this.boxes.get(id);
    if (!entry || !entry.live) throw new Error(`MemoryStateView.consumeBox: ${id} is not live`);
    entry.live = false;
  }

  putIdentityRecord(identityId: Uint8Array, record: IdentityRecord): void {
    this.records.set(hex(identityId), record);
  }

  putNetworkRecord(record: NetworkRecord): void {
    this.network = record;
  }

  putUsername(row: UsernameRow): void {
    this.names.set(row.nameLower, row);
  }

  deleteUsername(nameLower: string): void {
    this.names.delete(nameLower);
  }

  /** A post's row — pending or confirmed, live until withdrawn. */
  insertPost(postId: string): void {
    this.posts.set(postId, 'live');
  }

  /** A confirmation keeps a row as it is and gives a post with none a placeholder. */
  confirmPost(postId: string): void {
    if (!this.posts.has(postId)) this.posts.set(postId, 'live');
  }

  insertBlockTopology(postId: string, author: Uint8Array, height: number): void {
    if (!this.topology.has(postId)) this.topology.set(postId, { author, height });
  }

  withdrawPost(postId: string): void {
    this.posts.set(postId, 'withdrawn');
  }

  insertLikeRecord(targetPostId: string, likerId: Uint8Array): void {
    this.likes.add(`${targetPostId}:${hex(likerId)}`);
  }

  // ---- StateView ----

  getBox(id: string): AnyBox | null {
    const entry = this.boxes.get(id);
    return entry && entry.live ? entry.box : null;
  }

  getBoxProvenance(id: string): { txId: string; index: number } | null {
    const entry = this.boxes.get(id);
    return entry ? { txId: entry.box.txId, index: entry.box.index } : null;
  }

  getIdentityRecord(identityId: Uint8Array): IdentityRecord | null {
    return this.records.get(hex(identityId)) ?? null;
  }

  getNetworkRecord(): NetworkRecord {
    return this.network;
  }

  getUsername(nameLower: string): UsernameRow | null {
    return this.names.get(nameLower) ?? null;
  }

  getUsernameByOwner(owner: Uint8Array): UsernameRow | null {
    const ownerHex = hex(owner);
    for (const row of this.names.values()) {
      if (row.owner === ownerHex) return row;
    }
    return null;
  }

  getEmissionBox(): EmissionBox | null {
    return this.firstOfType<EmissionBox>('emission');
  }

  getTreasuryBox(): TreasuryBox | null {
    return this.firstOfType<TreasuryBox>('treasury');
  }

  getKarmaPoolBox(): KarmaPoolBox | null {
    return this.firstOfType<KarmaPoolBox>('karma_pool');
  }

  getBackerPoolBox(): BackerPoolBox | null {
    return this.firstOfType<BackerPoolBox>('backer_pool');
  }

  getKarmaBoxes(owner: Uint8Array): KarmaBox[] {
    const ownerHex = hex(owner);
    return this.live<KarmaBox>((b) => b.boxType === 'karma' && hex(b.owner) === ownerHex)
      .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : idOrder(a, b)));
  }

  getVouchEscrowsFor(voucherId: Uint8Array): VouchEscrowBox[] {
    const voucherHex = hex(voucherId);
    return this.live<VouchEscrowBox>((b) => b.boxType === 'vouch_escrow' && hex(b.owner) === voucherHex)
      .sort(idOrder);
  }

  getVouchBoxes(voucherId: Uint8Array, targetId: Uint8Array): VouchBox[] {
    const [voucherHex, targetHex] = [hex(voucherId), hex(targetId)];
    return this.live<VouchBox>((b) =>
      b.boxType === 'vouch' && hex(b.voucherId) === voucherHex && hex(b.targetId) === targetHex)
      .sort(idOrder);
  }

  getLikeAccrualBoxes(author: Uint8Array): LikeAccrualBox[] {
    const authorHex = hex(author);
    return this.live<LikeAccrualBox>((b) => b.boxType === 'like_accrual' && hex(b.author) === authorHex)
      .sort(idOrder);
  }

  /** The store's query joins the invitee's record, so a bond whose invitee holds none is not listed. */
  getBondsInvitedAt(maxInvitedAt: number, limit: number): BondBox[] {
    return this.live<BondBox>((b) => b.boxType === 'bond')
      .map((bond) => ({ bond, invitedAt: this.getIdentityRecord(bond.inviteePublicKey)?.invitedAtBlock ?? 0 }))
      .filter(({ invitedAt }) => invitedAt > 0 && invitedAt <= maxInvitedAt)
      .sort((a, b) => a.invitedAt - b.invitedAt || idOrder(a.bond, b.bond))
      .slice(0, limit)
      .map(({ bond }) => bond);
  }

  getVouchEscrowsReleasableAt(height: number, limit: number): VouchEscrowBox[] {
    return this.live<VouchEscrowBox>((b) => b.boxType === 'vouch_escrow' && b.releaseAtBlock <= height)
      .sort((a, b) => a.releaseAtBlock - b.releaseAtBlock || idOrder(a, b))
      .slice(0, limit);
  }

  /** The store's query joins the voucher's record: `NOT (member_since_block > 0 AND member_vouches >= member_bar)`. */
  getLapsedVouches(limit: number): VouchBox[] {
    return this.live<VouchBox>((b) => {
      if (b.boxType !== 'vouch') return false;
      const voucher = this.getIdentityRecord(b.voucherId);
      return voucher !== null && !(voucher.memberSinceBlock > 0 && voucher.memberVouches >= voucher.memberBar);
    })
      .sort(idOrder)
      .slice(0, limit);
  }

  getTopologyAuthor(postId: string): Uint8Array | null {
    return this.topology.get(postId)?.author ?? null;
  }

  getTopologyHeight(postId: string): number | null {
    return this.topology.get(postId)?.height ?? null;
  }

  getPostStanding(postId: string): 'live' | 'withdrawn' | 'none' {
    return this.posts.get(postId) ?? 'none';
  }

  hasLikeRecord(targetPostId: string, likerId: Uint8Array): boolean {
    return this.likes.has(`${targetPostId}:${hex(likerId)}`);
  }

  private live<B extends AnyBox>(matches: (box: AnyBox) => boolean): B[] {
    const found: B[] = [];
    for (const { box, live } of this.boxes.values()) {
      if (live && matches(box)) found.push(box as B);
    }
    return found;
  }

  private firstOfType<B extends AnyBox>(boxType: AnyBox['boxType']): B | null {
    return this.live<B>((b) => b.boxType === boxType).sort(idOrder)[0] ?? null;
  }
}
