import { bytesToHex as hex } from '@dagsocial/types';
import type {
  AnyBox,
  BackerPoolBox,
  BondBox,
  EmissionBox,
  IdentityRecord,
  KarmaBox,
  KarmaPoolBox,
  LikeAccrualBox,
  TreasuryBox,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import type { BlockEffects, NetworkRecord, StateView, UsernameRow } from '@dagsocial/consensus';

// This module imports nothing Node and reads no Node global: the bundle test
// builds it for a browser beside `applyBlock` (CONSENSUS_INTERFACE → Tests).

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

  /** Every entry the view holds, as one string: equal before and after a run that wrote nothing. */
  digest(): string {
    const byKey = <V>(entries: Iterable<[string, V]>): Array<[string, V]> =>
      [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify(
      {
        boxes: byKey(this.boxes.entries()),
        records: byKey(this.records.entries()),
        network: this.network,
        names: byKey(this.names.entries()),
        topology: byKey(this.topology.entries()),
        posts: byKey(this.posts.entries()),
        likes: [...this.likes].sort(),
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value instanceof Uint8Array ? hex(value) : value),
    );
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

/**
 * Write a block's effects into the view in their order — the node's writer's
 * work, done over maps, so a suite can apply the next block over the state this
 * one left. The view derives the holder record from the name rows, as the
 * store does.
 */
export function writeEffects(view: MemoryStateView, effects: BlockEffects, height: number): void {
  for (const m of effects.mutations) {
    switch (m.kind) {
      case 'box':
        if (m.op === 'insert') view.insertBox(m.box);
        else view.consumeBox(m.boxId);
        break;
      case 'record':
        view.putIdentityRecord(m.identityId, m.record);
        break;
      case 'network':
        view.putNetworkRecord(m.record);
        break;
      case 'username':
        if (m.row !== null) view.putUsername(m.row);
        else view.deleteUsername(m.nameLower);
        break;
      case 'holder':
        break;
    }
  }
  for (const { postId, post } of effects.posts) {
    view.confirmPost(postId);
    view.insertBlockTopology(postId, post.author, height);
  }
  for (const { targetPostId, likerId } of effects.likeRecords) view.insertLikeRecord(targetPostId, likerId);
  for (const postId of effects.withdrawals) view.withdrawPost(postId);
}
