import { vi } from 'vitest';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  boxRecordBytes,
  computeContentHash,
  computePostId,
  computeTxId,
  decodeOrderingBlock,
  encodeOrderingBlock,
  identityRecordKey,
  LIKE_KARMA_COST,
  POST_PRICE_REPLY,
  POST_PRICE_THREAD,
  PROTOCOL_VERSION,
  REPLY_AUTHOR_SHARE,
  STORAGE_RENT_PER_BYTE,
  USERNAME_BURN_PRICE,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  BackerStakeBox,
  CreditBox,
  IdentityRecord,
  KarmaBox,
  OrderingBlock,
  PostCommit,
  UtxoTransaction,
  VouchBox,
} from '@dagsocial/types';
import { blockHash } from '@dagsocial/validation';
import { materializeOutput } from '@dagsocial/consensus';
import {
  hex,
  makeApplicableBlock,
  makeCreditBox,
  makeKarmaBox,
  rawPublicKey,
  seedEmissionBox,
  seedKarmaPoolBox,
  signTransaction,
  type TestIdentity,
} from '../helpers.js';

/**
 * The block-application pin's scenario: a fixed pre-set state and eight blocks,
 * built and applied through the funnel, then the whole set reverted and applied
 * again. Everything is a function of fixed seeds and a fixed clock, so two runs
 * capture the same bytes.
 *
 * The profile numbers it needs shortened are `PIN_CONFIG`; the suite installs
 * them into the config module before anything here is imported.
 */

/**
 * The byte type of every block the scenario hands the funnel and the
 * speculative run: `'Uint8Array'` hands each block as `makeApplicableBlock`
 * builds it; `'Buffer'` hands it decoded from a `Buffer` of its encoding, where
 * every byte field the codec reads is a `Buffer` over that input.
 */
export type PinCarrier = 'Uint8Array' | 'Buffer';

function carried(block: OrderingBlock, carrier: PinCarrier): OrderingBlock {
  return carrier === 'Uint8Array'
    ? block
    : decodeOrderingBlock(Buffer.from(encodeOrderingBlock(block)));
}

/** The profile numbers the scenario runs under — installed by the suite's config mock. */
export const PIN_CONFIG = Object.freeze({
  karmaStaleThresholdBlocks: 6,
  karmaDecayIntervalBlocks: 3,
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
});

// ---------------------------------------------------------------------------
// Capture shapes
// ---------------------------------------------------------------------------

/** A table row with every column as text: integers in decimal, blobs in hex. */
export type Row = Record<string, string | null>;

export interface PinnedBlock {
  height: number;
  blockHash: string;
  stateRoot: string;
  /** `block_journal.journal_cbor` at this height, hex. */
  journalCbor: string;
  /** The `block_topology` rows at this height. */
  blockTopology: Row[];
  /** The `like_records` rows applied at this height. */
  likeRecords: Row[];
  /** The `dag_posts` rows this block confirmed or withdrew. */
  dagPosts: Row[];
}

export interface StateCapture {
  /** The prover's digest, hex. */
  stateRoot: string;
  /** Per table, a digest of every row in primary-key order. */
  tables: Record<string, string>;
}

/** A body the funnel refuses, and what the producer's speculation answered for it. */
export interface PinnedRefusal {
  height: number;
  name: string;
  verdict: unknown;
  speculation: string;
}

export interface RefusalCapture extends PinnedRefusal {
  /** The phrase of the rule the body breaks. */
  rule: string;
  /** Every line the funnel logged while refusing it. */
  logged: string[];
}

export interface ApplyPinCapture {
  preSet: StateCapture;
  blocks: PinnedBlock[];
  refusals: RefusalCapture[];
  postRevert: StateCapture;
  /** The same blocks applied again over the reverted store. */
  reapplied: PinnedBlock[];
}

// ---------------------------------------------------------------------------
// Identities — Ed25519 keys from fixed seeds
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function identityFromSeed(seed: Uint8Array): TestIdentity {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const userId = rawPublicKey(createPublicKey(privateKey));
  return { userId, publicKey: userId, privateKey };
}

function seedOf(text: string): Uint8Array {
  return createHash('blake2b512').update(text).digest().subarray(0, 32);
}

function seeded(label: string): TestIdentity {
  return identityFromSeed(seedOf(`dagsocial/test/block-apply-pin/${label}`));
}

// ---------------------------------------------------------------------------
// Time — every header stamp a minute apart, and a fixed clock
// ---------------------------------------------------------------------------

const ANCHOR_MS = 1_750_000_000_000;
const stampAt = (height: number): number => ANCHOR_MS + height * 60_000;
const CLOCK_MS = stampAt(1_000);

// ---------------------------------------------------------------------------
// Module graph — imported after the suite's config mock is in place
// ---------------------------------------------------------------------------

async function loadModules() {
  return {
    db: await import('../../src/store/db.js'),
    utxo: await import('../../src/store/utxo.js'),
    records: await import('../../src/store/identity-records.js'),
    posts: await import('../../src/store/posts.js'),
    usernames: await import('../../src/store/usernames.js'),
    vouches: await import('../../src/store/vouch-queries.js'),
    system: await import('../../src/store/system.js'),
    avl: await import('../../src/state/avl-prover.js'),
    blockApply: await import('../../src/services/block-apply.js'),
    forkResolution: await import('../../src/services/fork-resolution.js'),
    difficulty: await import('../../src/services/difficulty.js'),
    config: (await import('../../src/config.js')).config,
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

// ---------------------------------------------------------------------------
// Reading the store back
// ---------------------------------------------------------------------------

function toRow(raw: Record<string, unknown>): Row {
  const row: Row = {};
  for (const [column, value] of Object.entries(raw)) {
    if (value === null || value === undefined) row[column] = null;
    else if (value instanceof Uint8Array) row[column] = Buffer.from(value).toString('hex');
    else row[column] = String(value);
  }
  return row;
}

function rows(m: Modules, sql: string, ...params: unknown[]): Row[] {
  return (m.db.getDb().prepare(sql).safeIntegers().all(...params) as Record<string, unknown>[])
    .map(toRow);
}

/**
 * The tables a state capture digests, each in primary-key order: every table
 * block application writes but the pool, the refused headers and the AVL
 * storage, whose digest is the stateRoot.
 */
export const CONSENSUS_TABLES: ReadonlyArray<readonly [table: string, order: string]> = [
  ['utxo_boxes', 'id'],
  ['identity_records', 'identity_id'],
  ['network_record', 'id'],
  ['usernames', 'name_lower'],
  ['like_records', 'target_post_id, liker_id'],
  ['block_topology', 'post_id'],
  ['dag_posts', 'id'],
  ['dag_parent_refs', 'post_id, parent_id'],
  ['ordering_blocks', 'height'],
  ['block_journal', 'block_height'],
];

/** The digest a state capture holds for a table's rows. */
export function rowsDigest(tableRows: Row[]): string {
  return createHash('blake2b512').update(JSON.stringify(tableRows)).digest().subarray(0, 32).toString('hex');
}

function captureState(m: Modules): StateCapture {
  const tables: Record<string, string> = {};
  for (const [table, order] of CONSENSUS_TABLES) {
    tables[table] = rowsDigest(rows(m, `SELECT * FROM ${table} ORDER BY ${order}`));
  }
  return { stateRoot: proverDigestHex(m), tables };
}

function proverDigestHex(m: Modules): string {
  const digest = m.avl.getAvlProver().prover.digest();
  if (!digest) throw new Error('the prover holds no digest');
  return Buffer.from(digest).toString('hex');
}

function pinBlock(m: Modules, block: OrderingBlock): PinnedBlock {
  const height = block.header.height;
  const stored = m.db.getDb()
    .prepare('SELECT journal_cbor FROM block_journal WHERE block_height = ?')
    .get(height) as { journal_cbor: Buffer } | undefined;
  if (!stored) throw new Error(`block ${height} left no journal row`);
  const hash = blockHash(block.header);
  if (hash === null) throw new Error(`block ${height} has no hash`);
  return {
    height,
    blockHash: hash,
    stateRoot: block.header.stateRoot,
    journalCbor: Buffer.from(stored.journal_cbor).toString('hex'),
    blockTopology: rows(m, 'SELECT * FROM block_topology WHERE block_height = ? ORDER BY post_id', height),
    likeRecords: rows(
      m,
      'SELECT * FROM like_records WHERE applied_at_block = ? ORDER BY target_post_id, liker_id',
      height,
    ),
    dagPosts: rows(
      m,
      'SELECT * FROM dag_posts WHERE block_height = ? OR withdrawn_at_height = ? ORDER BY id',
      height,
      height,
    ),
  };
}

// ---------------------------------------------------------------------------
// Transactions — every output stamped with the height of the block carrying it
// ---------------------------------------------------------------------------

interface Built {
  tx: UtxoTransaction;
  txId: string;
  /** The outputs with the ids block application gives them. */
  out: AnyBox[];
}

interface BuiltPost extends Built {
  postId: string;
  commit: PostCommit;
}

function finish(tx: UtxoTransaction, signer: TestIdentity | null): Built {
  if (signer !== null) signTransaction(tx, signer.privateKey, hex(signer.userId));
  const txId = computeTxId(tx);
  return { tx, txId, out: tx.outputs.map((o, i) => materializeOutput(o, txId, i)) };
}

function karmaOut(owner: TestIdentity, value: bigint, h: number): AnyBoxCandidate {
  return { boxType: 'karma', value, createdAtBlock: h, owner: owner.userId } as AnyBoxCandidate;
}

/** The karma change output, when there is one, is output 0. */
function changeOf(built: Built): KarmaBox {
  const change = built.out[0];
  if (!change || change.boxType !== 'karma') throw new Error('transaction has no karma change');
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

function thread(author: TestIdentity, input: KarmaBox, content: string, h: number): BuiltPost {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > POST_PRICE_THREAD) outputs.push(karmaOut(author, input.value - POST_PRICE_THREAD, h));
  outputs.push({ boxType: 'karma_price', value: POST_PRICE_THREAD, createdAtBlock: h } as AnyBoxCandidate);
  const commit = commitOf(author, content, []);
  const built = finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, post: commit },
    author,
  );
  return { ...built, postId: computePostId(built.txId, 0), commit };
}

function reply(
  author: TestIdentity,
  input: KarmaBox,
  content: string,
  parentId: string,
  parentAuthor: TestIdentity,
  h: number,
): BuiltPost {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > POST_PRICE_REPLY) outputs.push(karmaOut(author, input.value - POST_PRICE_REPLY, h));
  outputs.push(
    { boxType: 'karma_price', value: POST_PRICE_REPLY - REPLY_AUTHOR_SHARE, createdAtBlock: h } as AnyBoxCandidate,
    { boxType: 'like_accrual', value: REPLY_AUTHOR_SHARE, createdAtBlock: h, author: parentAuthor.userId } as AnyBoxCandidate,
  );
  const commit = commitOf(author, content, [parentId]);
  const built = finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, post: commit },
    author,
  );
  return { ...built, postId: computePostId(built.txId, 0), commit };
}

function like(
  liker: TestIdentity,
  input: KarmaBox,
  postId: string,
  author: TestIdentity,
  h: number,
): Built {
  const outputs: AnyBoxCandidate[] = [];
  if (input.value > LIKE_KARMA_COST) outputs.push(karmaOut(liker, input.value - LIKE_KARMA_COST, h));
  outputs.push(
    { boxType: 'like_accrual', value: LIKE_KARMA_COST, createdAtBlock: h, author: author.userId } as AnyBoxCandidate,
  );
  return finish(
    { inputs: [input.id!], outputs, signatures: {}, protocolVersion: PROTOCOL_VERSION, likeTarget: postId },
    liker,
  );
}

function vouch(voucher: TestIdentity, input: KarmaBox, target: TestIdentity, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(voucher, input.value - VOUCH_KARMA_AMOUNT, h),
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: h,
        voucherId: voucher.userId,
        targetId: target.userId,
      } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, voucher);
}

function unvouch(voucher: TestIdentity, staked: VouchBox, cooldown: number, h: number): Built {
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

function invite(
  inviter: TestIdentity,
  input: KarmaBox,
  invitee: TestIdentity,
  bond: bigint,
  h: number,
): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(inviter, input.value - bond, h),
      {
        boxType: 'bond',
        value: bond,
        createdAtBlock: h,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, inviter);
}

function claim(holder: TestIdentity, input: KarmaBox, name: string, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      karmaOut(holder, input.value, h),
      {
        boxType: 'username',
        value: 0n,
        createdAtBlock: h,
        owner: holder.userId,
        name: new TextEncoder().encode(name),
      } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, holder);
}

function burn(holder: TestIdentity, input: KarmaBox, name: AnyBox, h: number): Built {
  return finish({
    inputs: [input.id!, name.id!],
    outputs: [
      karmaOut(holder, input.value - USERNAME_BURN_PRICE, h),
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: h } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, holder);
}

function withdraw(author: TestIdentity, input: KarmaBox, postId: string, h: number): Built {
  return finish({
    inputs: [input.id!],
    outputs: [karmaOut(author, input.value, h)],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    postWithdraw: { postId },
  }, author);
}

function consolidate(owner: TestIdentity, inputs: KarmaBox[], h: number): Built {
  return finish({
    inputs: inputs.map((b) => b.id!),
    outputs: [karmaOut(owner, inputs.reduce((sum, b) => sum + b.value, 0n), h)],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, owner);
}

function creditSend(
  sender: TestIdentity,
  input: CreditBox,
  amount: bigint,
  recipient: TestIdentity,
  fee: bigint,
  h: number,
): Built {
  return finish({
    inputs: [input.id!],
    outputs: [
      { boxType: 'credit', value: amount, createdAtBlock: h, owner: recipient.userId } as AnyBoxCandidate,
      { boxType: 'credit', value: input.value - amount - fee, createdAtBlock: h, owner: sender.userId } as AnyBoxCandidate,
      { boxType: 'fee', value: fee, createdAtBlock: h } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, sender);
}

/** NODE_INTERFACE → Storage rent is a transition requiring no signature. */
function rent(box: CreditBox, provenance: { txId: string; index: number }, h: number): Built {
  const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(box, provenance.txId, provenance.index).length);
  return finish({
    inputs: [box.id!],
    outputs: [
      { boxType: 'credit', value: box.value - charge, createdAtBlock: h, owner: box.owner } as AnyBoxCandidate,
      { boxType: 'fee', value: charge, createdAtBlock: h } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, null);
}

function unstake(backer: TestIdentity, stake: BackerStakeBox, weight: bigint, h: number): Built {
  return finish({
    inputs: [stake.id!],
    outputs: [
      { boxType: 'backer_unstake', value: 0n, createdAtBlock: h, owner: backer.userId, weight } as AnyBoxCandidate,
      {
        boxType: 'backer_stake',
        value: 0n,
        createdAtBlock: h,
        owner: backer.userId,
        weight: stake.weight - weight,
      } as AnyBoxCandidate,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  }, backer);
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

function residentRecord(): IdentityRecord {
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
  };
}

export async function runApplyPinScenario(carrier: PinCarrier = 'Uint8Array'): Promise<ApplyPinCapture> {
  const m = await loadModules();
  for (const [field, value] of Object.entries(PIN_CONFIG)) {
    const read = (m.config as unknown as Record<string, unknown>)[field];
    const profileRead = (m.config.profile as unknown as Record<string, unknown>)[field];
    if (read !== value || profileRead !== value) {
      throw new Error(`config ${field} reads ${String(read)} / profile ${String(profileRead)}, the pin needs ${value}`);
    }
  }

  m.db.initDb(':memory:');
  m.difficulty.setClock(() => CLOCK_MS);
  try {
    return await runScenario(m, carrier);
  } finally {
    m.difficulty.setClock(null);
    m.db.closeDb();
  }
}

async function runScenario(m: Modules, carrier: PinCarrier): Promise<ApplyPinCapture> {
  const miner = seeded('miner');
  const [r1, r2] = [seeded('root-1'), seeded('root-2')];
  const t = seeded('target');
  const x = seeded('second-target');
  const l1 = seeded('liker-1');
  const l2 = seeded('liker-2');
  const w1 = seeded('withdrawer-full');
  const w2 = seeded('withdrawer-placeholder');
  const u = seeded('name-holder');
  const d1 = seeded('dormant');
  const [c1, c2, c3] = [seeded('credit-sender'), seeded('credit-recipient'), seeded('rent-payer')];
  const [i1, i2, i3] = [seeded('invitee-1'), seeded('invitee-2'), seeded('invitee-3')];

  // The profile's first backer row is the key of the seed
  // blake2b512('dagsocial/devnet/backer/A')[0:32]; the check below holds it to that.
  const backerA = identityFromSeed(seedOf('dagsocial/devnet/backer/A'));
  const backerTable = m.config.profile.backerTable;
  if (backerTable[0]?.key !== hex(backerA.userId)) {
    throw new Error('backer A does not derive to the profile table\'s first key');
  }

  const cooldown = m.config.vouchCooldownBlocks;
  const credit = 10n ** 8n;

  // ---- the pre-set state ----
  // Two roots and the backer stakes as genesis seeds them (ARCHITECTURE → Genesis);
  // residents holding karma and a record; two credit holders; the protocol boxes.
  m.system.seedGenesisCommittee([hex(r1.userId), hex(r2.userId)], 1000n, 0);
  const residents: Array<[TestIdentity, bigint]> = [
    [t, 200n], [x, 50n], [l1, 20n], [l2, 50n], [w1, 50n], [w2, 50n], [u, 100n], [d1, 100n],
  ];
  for (const [who, value] of residents) {
    m.utxo.insertBox(makeKarmaBox(value, who.userId, 0));
    m.records.putIdentityRecord(who.userId, residentRecord());
  }
  m.utxo.insertBox(makeCreditBox(100n * credit, c1.userId, 0));
  m.utxo.insertBox(makeCreditBox(10n * credit, c3.userId, 0));
  await seedEmissionBox();
  await seedKarmaPoolBox();
  m.system.ensureBackerPoolBox(m.system.seedGenesisBackers(backerTable, 0), 0);
  m.records.putNetworkRecord({ memberCount: 2 });

  const karma = (who: TestIdentity): KarmaBox[] => m.utxo.getKarmaBoxes(who.userId);
  const largest = (who: TestIdentity): KarmaBox => {
    const box = karma(who)[0];
    if (!box) throw new Error(`${hex(who.userId).slice(0, 8)} holds no karma`);
    return box;
  };

  // W1's thread arrives as a packet before block 1, so its row holds the body
  // (NODE_INTERFACE → Post transactions).
  const fullContent = 'a thread whose body this node holds';
  const pFull = thread(w1, largest(w1), fullContent, 1);
  m.posts.insertPost(pFull.postId, pFull.commit, fullContent);

  const handle = m.avl.createAvlProver();
  m.avl.bootstrapAvlProver(
    handle,
    m.utxo.getUnspentBoxes(),
    0,
    m.records.getAllIdentityRecords().map(({ identityId, record }) => ({
      key: identityRecordKey(identityId),
      record,
    })),
    [{ key: m.records.networkRecordKey(), network: m.records.getNetworkRecord() }],
  );
  const preSet = captureState(m);

  // ---- the set ----
  const blocks: OrderingBlock[] = [];
  const pinned: PinnedBlock[] = [];
  const refusals: RefusalCapture[] = [];
  const build = async (txs: Built[]): Promise<OrderingBlock> => {
    const height = blocks.length + 1;
    const block = await makeApplicableBlock({ height, miner, createdAt: stampAt(height), utxoTxs: txs.map((b) => b.tx) });
    return carried(block, carrier);
  };
  const applyNext = async (txs: Built[]): Promise<void> => {
    const block = await build(txs);
    const verdict = m.blockApply.applyOrderingBlockVerdict(block);
    if (!verdict.applied) {
      throw new Error(`block ${block.header.height} was refused: ${JSON.stringify(verdict)}`);
    }
    if (proverDigestHex(m) !== block.header.stateRoot) {
      throw new Error(`block ${block.header.height} applied to a digest its header does not name`);
    }
    blocks.push(block);
    pinned.push(pinBlock(m, block));
  };
  const refuse = async (name: string, rule: string, txs: Built[]): Promise<void> => {
    const before = captureState(m);
    const block = await build(txs);
    const speculation = m.blockApply.computePostBlockStateRoot(block).kind;
    const logged: string[] = [];
    const record = (...args: unknown[]): void => { logged.push(args.map(String).join(' ')); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(record);
    const error = vi.spyOn(console, 'error').mockImplementation(record);
    let verdict: unknown;
    try {
      verdict = m.blockApply.applyOrderingBlockVerdict(block);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    if (JSON.stringify(captureState(m)) !== JSON.stringify(before)) {
      throw new Error(`refusing "${name}" changed the store`);
    }
    refusals.push({ height: block.header.height, name, verdict, speculation, rule, logged });
  };

  // Block 1 — a thread and a reply to it in one block; the full post; a placeholder.
  const pT = thread(t, largest(t), 'the target opens a thread', 1);
  const pPlaceholder = thread(w2, largest(w2), 'a thread this node never receives the body of', 1);
  await applyNext([
    pT,
    reply(r2, largest(r2), 'a reply in the block that confirms its parent', pT.postId, t, 1),
    pFull,
    pPlaceholder,
  ]);

  // Block 2 — likes on an earlier post; a root's vouch sets the target, a
  // root's invite confers membership; a name claim; a credit send with a fee.
  {
    const r1Like = like(r1, largest(r1), pT.postId, t, 2);
    const r1Vouch = vouch(r1, changeOf(r1Like), t, 2);
    const r2Like = like(r2, largest(r2), pT.postId, t, 2);
    const r2Invite = invite(r2, changeOf(r2Like), i1, 25n, 2);
    const c1Box = m.utxo.getCreditBoxes(c1.userId)[0]!;
    await applyNext([
      r1Like,
      r1Vouch,
      r2Like,
      r2Invite,
      claim(u, largest(u), 'Pinned', 2),
      creditSend(c1, c1Box, 40n * credit, c2, credit, 2),
      reply(l2, largest(l2), 'a reply to an earlier thread', pT.postId, t, 2),
    ]);
  }

  // Refused at height 3 — each body breaks a rule on a read of what an earlier
  // transaction in the same block wrote.
  {
    const firstVouch = vouch(t, largest(t), x, 3);
    await refuse('a second vouch for one pair', 'A live vouch already exists', [
      firstVouch,
      vouch(t, changeOf(firstVouch), x, 3),
    ]);
    const staked = m.vouches.getVouchBox(r1.userId, t.userId);
    if (!staked) throw new Error('no live vouch from the first root to the target');
    await refuse('a cast behind the voucher\'s own unvouch', 'Vouch cast is locked', [
      unvouch(r1, staked, cooldown, 3),
      vouch(r1, largest(r1), t, 3),
    ]);
    const spent1 = thread(i1, largest(i1), 'a first spend', 3);
    const spent2 = thread(i1, changeOf(spent1), 'a second spend', 3);
    const spent3 = thread(i1, changeOf(spent2), 'a third spend', 3);
    await refuse('a cast after the voucher\'s own spends', 'Vouch cast requires a karma balance of at least', [
      spent1,
      spent2,
      spent3,
      vouch(i1, changeOf(spent3), x, 3),
    ]);
    await refuse('a name claimed twice', 'name taken', [
      claim(x, largest(x), 'Twin', 3),
      claim(l1, largest(l1), 'twin', 3),
    ]);
    const firstName = claim(w2, largest(w2), 'First', 3);
    await refuse('two names for one identity', 'identity holds a name', [
      firstName,
      claim(w2, changeOf(firstName), 'Second', 3),
    ]);
    const box = largest(l1);
    await refuse('one box spent twice', 'has an unresolved input', [
      like(l1, box, pT.postId, t, 3),
      like(l1, box, pFull.postId, w1, 3),
    ]);
    const firstLike = like(l1, largest(l1), pT.postId, t, 3);
    await refuse('one post liked twice by one liker', 'duplicates an existing like-record', [
      firstLike,
      like(l1, changeOf(firstLike), pT.postId, t, 3),
    ]);
    const fresh = thread(w2, largest(w2), 'a thread withdrawn in its own block', 3);
    await refuse('a withdrawal in the block that confirms the post', 'is not confirmed in an earlier block', [
      fresh,
      withdraw(w2, changeOf(fresh), fresh.postId, 3),
    ]);
    const twice = seeded('invitee-named-twice');
    await refuse('two bonds naming one invitee', 'which another bond in this block already names', [
      invite(r1, largest(r1), twice, 25n, 3),
      invite(r2, largest(r2), twice, 25n, 3),
    ]);
  }

  // Block 3 — likes on a post this block confirms; a member's vouch and a
  // member's invite; a root's invite in the same block; a full post withdrawn.
  const pI1 = thread(i1, largest(i1), 'the first invitee posts', 3);
  {
    const r1Like = like(r1, largest(r1), pI1.postId, i1, 3);
    const tVouch = vouch(t, largest(t), x, 3);
    await applyNext([
      pI1,
      r1Like,
      like(r2, largest(r2), pI1.postId, i1, 3),
      like(l1, largest(l1), pI1.postId, i1, 3),
      tVouch,
      invite(t, changeOf(tVouch), i2, 5n, 3),
      invite(r1, changeOf(r1Like), i3, 25n, 3),
      withdraw(w1, largest(w1), pFull.postId, 3),
    ]);
  }

  // Block 4 — a placeholder withdrawn; likes that pay out a carry; a backer's
  // partial unstake.
  {
    const stake = m.utxo.getBackerStakeBox(backerA.userId);
    if (!stake) throw new Error('backer A holds no stake box');
    await applyNext([
      withdraw(w2, largest(w2), pPlaceholder.postId, 4),
      like(l2, largest(l2), pI1.postId, i1, 4),
      like(w1, largest(w1), pI1.postId, i1, 4),
      unstake(backerA, stake, 10n, 4),
    ]);
  }

  // Block 5 — the unvouch that lapses the target, its escrow already at its
  // release height and outside this block's settlement, which settles the first
  // bond; a name burned and claimed again in one block.
  {
    const staked = m.vouches.getVouchBox(r1.userId, t.userId);
    if (!staked) throw new Error('no live vouch from the first root to the target');
    const held = m.usernames.getUsernameByOwner(u.userId);
    const nameBox = held ? m.utxo.getBox(held.boxId) : null;
    if (!nameBox) throw new Error('the name holder holds no name box');
    await applyNext([
      unvouch(r1, staked, cooldown, 5),
      burn(u, largest(u), nameBox, 5),
      claim(l2, largest(l2), 'PINNED', 5),
      like(x, largest(x), pT.postId, t, 5),
    ]);
  }

  // Block 6 — the lapse leg, the first escrow's release, two bonds settling;
  // rent; a post paid from an exact balance.
  {
    const c3Box = m.utxo.getCreditBoxes(c3.userId)[0]!;
    const provenance = m.utxo.getBoxProvenance(c3Box.id!);
    if (!provenance) throw new Error('the rent box has no provenance');
    await applyNext([
      rent(c3Box, provenance, 6),
      thread(i2, largest(i2), 'the second invitee posts from an exact balance', 6),
    ]);
  }

  // Block 7 — the lapse escrow's release; decay fires for a dormant poster and
  // for two roots who like its post.
  const pDormant = thread(d1, largest(d1), 'a dormant identity posts', 7);
  await applyNext([
    pDormant,
    like(r1, largest(r1), pDormant.postId, d1, 7),
    like(r2, largest(r2), pDormant.postId, d1, 7),
  ]);

  // Block 8 — a root's vouch re-qualifies the lapsed target; decay held at the
  // floor; a consolidation of three karma boxes.
  await applyNext([
    vouch(r2, largest(r2), t, 8),
    like(l1, largest(l1), pDormant.postId, d1, 8),
    consolidate(t, karma(t), 8),
  ]);

  // ---- the whole set reverted, then applied again ----
  m.forkResolution.reorg(0, []);
  const postRevert = captureState(m);

  const reapplied: PinnedBlock[] = [];
  for (const block of blocks) {
    const verdict = m.blockApply.applyOrderingBlockVerdict(block);
    if (!verdict.applied) {
      throw new Error(`reapplying block ${block.header.height} was refused: ${JSON.stringify(verdict)}`);
    }
    reapplied.push(pinBlock(m, block));
  }

  return { preSet, blocks: pinned, refusals, postRevert, reapplied };
}
