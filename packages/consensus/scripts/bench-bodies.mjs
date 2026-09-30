// The bodies the benches build (CONSENSUS_INTERFACE → Cost; CONSENSUS_INTERFACE → The block's cost), each over its
// own stub state and from fixed seeds, so every run builds the same bytes. Three kinds of transaction:
//
//   ordinary   — a one-signer credit send, spending one whole credit;
//   packed     — a credit payment of as many signers as MAX_TX_BYTES holds;
//   oversigned — a one-input credit send signed by its input's owner and by keys no input requires.
//
// Every signer's box was created the block before, inside the rent period, so each input needs its owner's
// signature; every transaction conserves value; the settlement is `buildBlockSettlement`'s, placed last, and the body
// is weighed with it. A body's cost is counted over its tree: its state seeded into a prover with `seedTreeWrites`,
// the block proven on it — its reads recorded, then its writes (CONSENSUS_INTERFACE → The block proof) — so a body
// sized to MAX_BLOCK_COST is sized by the count every node and leaf makes. The proof helpers are the test tree's
// TypeScript, which Node 22.18 and later imports with its types stripped.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  EMPTY_STATE_ROOT,
  MAX_BLOCK_BODY_BYTES,
  MAX_BLOCK_COST,
  MAX_TX_BYTES,
  W_SIG,
  computeBoxId,
  computeTxId,
  decayCfgFor,
  decodeTx,
  encodeTx,
  profileFor,
  protocolVersionAt,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import { blockCost, buildBlockSettlement, seedTreeWrites } from '../dist/index.js';
import { proveBlock, proverFrom } from '../test/block-proof.ts';

export const HEIGHT = 1000;
const profile = profileFor('testnet');
/** The profile's numbers the rules read (CONSENSUS_INTERFACE → ApplyContext). */
export const ctx = {
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
const VERSION = protocolVersionAt(ctx.protocolVersionSchedule, HEIGHT);

/** The most signatures a body carries before they alone cost over the budget. */
export const BUDGET_SIGNATURES = Math.floor(MAX_BLOCK_COST / W_SIG);

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const seed32 = (label) =>
  new Uint8Array(createHash('sha512').update(`dagsocial/bench/${label}`).digest().subarray(0, 32));

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An Ed25519 key pair from a fixed seed. */
function keyPair(label) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed32(`key/${label}`)]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey: new Uint8Array(spki.subarray(spki.length - 32)) };
}

/** A stand-in signer, for weighing a transaction's shape: a key and no private half. */
const standIn = (label) => ({ privateKey: null, publicKey: seed32(`stand-in/${label}`) });

const signerKeys = [];
/** The first `n` signers, each from its own fixed seed. */
function signers(n) {
  for (let i = signerKeys.length; i < n; i++) signerKeys.push(keyPair(`signer/${i}`));
  return signerKeys.slice(0, n);
}

/** A box the view holds, under a stand-in creating transaction. */
function heldBox(candidate, label) {
  const box = { ...candidate, txId: hex(seed32(`box/${label}`)), index: 0 };
  return { ...box, id: computeBoxId(box) };
}

/** A signer's credit box of `value`, created the block before. */
const creditBox = (signer, value, label) =>
  heldBox({ boxType: 'credit', value, createdAtBlock: HEIGHT - 1, owner: signer.publicKey }, label);

const credit = (owner, value) => ({ boxType: 'credit', value, createdAtBlock: HEIGHT, owner });

/** A transaction spending `boxes`, signed over its id by each signer — a stand-in's entry is 64 zero bytes. */
function transaction(boxes, outputs, signers) {
  const tx = { inputs: boxes.map((box) => box.id), outputs, signatures: {}, protocolVersion: VERSION };
  const message = Buffer.from(computeTxId(tx), 'hex');
  for (const signer of signers) {
    tx.signatures[hex(signer.publicKey)] = signer.privateKey
      ? new Uint8Array(sign(null, message, signer.privateKey))
      : new Uint8Array(64);
  }
  return tx;
}

const miner = keyPair('miner');
const recipient = keyPair('recipient').publicKey;
const genesis = [
  heldBox({ boxType: 'emission', value: profile.creditEmissionTotal, createdAtBlock: 0 }, 'emission'),
  heldBox({ boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 }, 'karma_pool'),
];

/**
 * The credit bodies' transactions. A send moves a quarter of a whole credit to the recipient and the rest back. A
 * packed payment pays its signers' boxes whole to the recipient in one output, each box holding a little above the
 * credit floor (MIN_BOX_VALUE_PER_BYTE per record byte), so the output carries few value bytes and the body holds the
 * most signers; a signer adds at least its input's id, its key and its signature — `signerBytes`. An oversigned send
 * pays its first signer's box, of the same value, whole to the recipient; every later signer is a key no input
 * requires, its signature valid over the transaction's id, adding its key and its signature. A kind whose body is
 * refused names the reasons for it (`refusals`).
 */
export const KINDS = {
  ordinary: {
    boxValue: 10n ** 8n,
    build: ([signer], [box]) =>
      transaction([box], [credit(recipient, box.value / 4n), credit(signer.publicKey, box.value - box.value / 4n)], [signer]),
  },
  packed: {
    boxValue: 20_000n,
    signerBytes: 128,
    build: (signers, boxes) =>
      transaction(boxes, [credit(recipient, boxes.reduce((sum, box) => sum + box.value, 0n))], signers),
  },
  oversigned: {
    boxValue: 20_000n,
    signerBytes: 96,
    build: (signers, [box]) => transaction([box], [credit(recipient, box.value)], signers),
    // The first transaction is refused for carrying more signatures than inputs, or for the first key in
    // its map that no input requires.
    refusals: ([first], view) => {
      const txId = computeTxId(first);
      const owner = hex(view.getBox(first.inputs[0]).owner);
      const spare = Object.keys(first.signatures).sort().find((key) => key !== owner);
      return [
        `Rejected block height=${HEIGHT}: embedded UTXO tx ${txId} carries more signatures than inputs`,
        `Rejected block height=${HEIGHT}: embedded UTXO tx ${txId} failed re-validation: ` +
          `Signature map carries unrequired key ${spare.slice(0, 16)}…`,
      ];
    },
  },
};

/** The box kinds a seed may hold: the stub answers every read of each. */
const STUB_BOX_KINDS = new Set(['credit', 'karma', 'emission', 'treasury', 'karma_pool', 'backer_pool']);

const byValueDescThenId = (a, b) =>
  a.value > b.value ? -1 : a.value < b.value ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The state the rules read, over a seed's live boxes, identity records and network record
 * (CONSENSUS_INTERFACE → StateView): no name, post, like, vouch, escrow, bond or accrual, so a seed holding a box of a
 * kind outside `STUB_BOX_KINDS` is refused rather than answered wrong. `applyBlock` never writes it, so every run
 * reads the same state.
 */
export class StubView {
  constructor({ network, boxes, records }) {
    const unanswered = boxes.find((box) => !STUB_BOX_KINDS.has(box.boxType));
    if (unanswered) {
      throw new Error(`StubView: a seed holding a ${unanswered.boxType} box needs reads the stub does not answer`);
    }
    this.network = network;
    this.boxes = new Map(boxes.map((box) => [box.id, box]));
    this.records = new Map(records.map(({ identityId, record }) => [hex(identityId), record]));
    this.karma = new Map();
    for (const box of boxes.filter((b) => b.boxType === 'karma')) {
      const owner = hex(box.owner);
      if (!this.karma.has(owner)) this.karma.set(owner, []);
      this.karma.get(owner).push(box);
    }
    for (const held of this.karma.values()) held.sort(byValueDescThenId);
    const first = (boxType) =>
      boxes.filter((b) => b.boxType === boxType).sort((a, b) => (a.id < b.id ? -1 : 1))[0] ?? null;
    this.emission = first('emission');
    this.treasury = first('treasury');
    this.karmaPool = first('karma_pool');
    this.backerPool = first('backer_pool');
  }
  getBox(id) { return this.boxes.get(id) ?? null; }
  getBoxProvenance(id) {
    const box = this.boxes.get(id);
    return box ? { txId: box.txId, index: box.index } : null;
  }
  getIdentityRecord(identityId) {
    const record = this.records.get(hex(identityId));
    return record ? { ...record } : null;
  }
  getNetworkRecord() { return { ...this.network }; }
  getUsername() { return null; }
  getUsernameByOwner() { return null; }
  getEmissionBox() { return this.emission; }
  getTreasuryBox() { return this.treasury; }
  getKarmaPoolBox() { return this.karmaPool; }
  getBackerPoolBox() { return this.backerPool; }
  getKarmaBoxes(owner) { return [...(this.karma.get(hex(owner)) ?? [])]; }
  getVouchEscrowsFor() { return []; }
  getVouchBoxes() { return []; }
  getLikeAccrualBoxes() { return []; }
  getBondsInvitedAt() { return []; }
  getVouchEscrowsReleasableAt() { return []; }
  getLapsedVouches() { return []; }
  getTopologyAuthor() { return null; }
  getTopologyHeight() { return null; }
  getPostStanding() { return 'none'; }
  hasLikeRecord() { return false; }
}

/** The block over `view`: the body, then `buildBlockSettlement`'s settlement as its last entry. */
function blockOf(view, txs) {
  const txBytes = txs.map((tx) => encodeTx(tx));
  const settled = buildBlockSettlement(view, txBytes, HEIGHT, miner.publicKey, miner.publicKey, ctx);
  if ('error' in settled) throw new Error(`no settlement at height ${HEIGHT}: ${settled.error}`);
  return {
    header: {
      protocolVersion: VERSION,
      height: HEIGHT,
      prevBlockHash: '0'.repeat(64),
      utxoTxRoot: '0'.repeat(64),
      stateRoot: EMPTY_STATE_ROOT,
      validatorId: miner.publicKey,
      powNonce: 0,
      powTargetBits: 0,
      createdAt: 0,
      interlinkRoot: '0'.repeat(64),
    },
    utxoTxTree: {
      utxoTxIds: [...txs.map((tx) => computeTxId(tx)), computeTxId(settled.tx)],
      utxoTxs: [...txBytes, encodeTx(settled.tx)],
    },
    validatorSignature: new Uint8Array(64),
  };
}

/** The body's weight: transactions of these lengths, then a settlement of `settlement` bytes. */
function bodyBytes(lengths, settlement) {
  const all = [...lengths, settlement];
  return utxoTxTreeByteLength({
    utxoTxIds: all.map(() => '0'.repeat(64)),
    utxoTxs: all.map((length) => new Uint8Array(length)),
  });
}

/** Signatures in a body of these groups. */
const count = (groups) => groups.reduce((sum, n) => sum + n, 0);

/** The largest `n` in `[0, upper]` for which `fits(n)` holds, `fits` holding from 0 up to it and no further. */
function largest(upper, fits) {
  let [low, high] = [0, upper];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The length of a `kind` transaction of `n` stand-in signers. */
function weighed(kind, n) {
  const stand = Array.from({ length: n }, (_, i) => standIn(`${n}/${i}`));
  const boxes = stand.map((s, i) => creditBox(s, kind.boxValue, `stand-in/${n}/${i}`));
  return encodeTx(kind.build(stand, boxes)).length;
}

/** As many signers as MAX_TX_BYTES holds in one `kind` transaction. */
function signersPerTx(kind) {
  return largest(
    Math.floor(MAX_TX_BYTES / kind.signerBytes),
    (n) => n === 0 || weighed(kind, n) <= MAX_TX_BYTES,
  );
}

/**
 * `total` signers in `kind` transactions, each carrying as many as MAX_TX_BYTES holds and the last the rest — signers
 * per transaction.
 */
export function packedShape(kind, total) {
  const perTx = signersPerTx(kind);
  const rest = total % perTx;
  return [...new Array((total - rest) / perTx).fill(perTx), ...(rest > 0 ? [rest] : [])];
}

/**
 * `kind` transactions carrying as many signers as MAX_TX_BYTES holds, as many as MAX_BLOCK_BODY_BYTES holds, then one
 * carrying the signers the remaining bytes hold — signers per transaction, weighed with stand-ins. A body of credit
 * transactions pays no fee, so its settlement is one length whatever the body holds.
 */
export function filledShape(kind) {
  const settlement = blockOf(new StubView({ network: { memberCount: 0 }, boxes: genesis, records: [] }), [])
    .utxoTxTree.utxoTxs[0].length;
  const perTx = signersPerTx(kind);
  const full = weighed(kind, perTx);
  const fullTxs = largest(
    Math.floor(MAX_BLOCK_BODY_BYTES / full),
    (n) => bodyBytes(new Array(n).fill(full), settlement) <= MAX_BLOCK_BODY_BYTES,
  );
  const rest = largest(
    perTx - 1,
    (n) => n === 0 || bodyBytes([...new Array(fullTxs).fill(full), weighed(kind, n)], settlement) <= MAX_BLOCK_BODY_BYTES,
  );
  return [...new Array(fullTxs).fill(perTx), ...(rest > 0 ? [rest] : [])];
}

/** A body of `txs` carrying `signatures`, over its own view of `seed`, with every bound it is held to checked. */
function bodyOf(name, seed, txs, signatures) {
  const view = new StubView(seed);
  const block = blockOf(view, txs);
  const bytes = utxoTxTreeByteLength(block.utxoTxTree);
  const settlement = block.utxoTxTree.utxoTxs.at(-1).length;
  const heaviest = Math.max(0, ...block.utxoTxTree.utxoTxs.slice(0, -1).map((b) => b.length));
  if (bytes > MAX_BLOCK_BODY_BYTES) throw new Error(`${name}: a body of ${bytes} bytes is over ${MAX_BLOCK_BODY_BYTES}`);
  if (heaviest > MAX_TX_BYTES) throw new Error(`${name}: a transaction of ${heaviest} bytes is over ${MAX_TX_BYTES}`);
  return { name, seed, view, block, signatures, txs: txs.length, bytes, settlement, heaviest, refusals: null };
}

/** A body of `groups` transactions of `kind` — signers per transaction — over the boxes it spends and genesis. */
export function built(name, kind, groups) {
  const all = signers(count(groups));
  const boxes = all.map((s, i) => creditBox(s, kind.boxValue, `${name}/${i}`));
  const txs = [];
  let next = 0;
  for (const size of groups) {
    txs.push(kind.build(all.slice(next, next + size), boxes.slice(next, next + size)));
    next += size;
  }
  const spent = new Set(txs.flatMap((tx) => tx.inputs));
  const seed = {
    network: { memberCount: 0 },
    boxes: [...genesis, ...boxes.filter((box) => spent.has(box.id))],
    records: [],
  };
  const body = bodyOf(name, seed, txs, next);
  return { ...body, refusals: kind.refusals ? kind.refusals(txs, body.view) : null };
}

/**
 * `body` with the signature its last input requires corrupted: S loses its lowest set bit, so the signature keeps its
 * shape and a check of it reaches the equation, where it fails. The block is refused by the body check, or for that
 * input's signature.
 */
export function corrupted(body) {
  const { utxoTxIds, utxoTxs } = body.block.utxoTxTree;
  const last = utxoTxs.length - 2; // the last user transaction; the settlement follows it
  const tx = decodeTx(utxoTxs[last]);
  const input = tx.inputs.at(-1);
  const key = hex(body.view.getBox(input).owner);
  const signature = Uint8Array.from(tx.signatures[key]);
  const at = signature.findIndex((byte, i) => i >= 32 && byte !== 0);
  signature[at] &= signature[at] - 1;
  tx.signatures[key] = signature;
  return {
    ...body,
    name: 'corrupted',
    block: {
      ...body.block,
      utxoTxTree: { utxoTxIds, utxoTxs: utxoTxs.map((bytes, i) => (i === last ? encodeTx(tx) : bytes)) },
    },
    refusals: [
      `Rejected block height=${HEIGHT}: a signature in the body does not verify`,
      `Rejected block height=${HEIGHT}: embedded UTXO tx ${utxoTxIds[last]} failed re-validation: ` +
        `Missing or invalid owner signature for box ${input}`,
    ],
  };
}

/**
 * `body` refused for its signatures' cost, which `applyBlock` checks before the batch (CONSENSUS_INTERFACE → Applying
 * a block).
 */
export const overBudget = (body) => ({
  ...body,
  refusals: [`Rejected block height=${HEIGHT}: its ${body.signatures} signatures cost more than a block may`],
});

/**
 * `body` proven on a prover holding its seed (CONSENSUS_INTERFACE → The block proof): the parent's digest, the proof,
 * the digest its writes reach, and its cost — the batch's entries, the distinct keys its tree view looked up and its
 * writes (CONSENSUS_INTERFACE → The block's cost). Every body proven here is built valid, so a refusal over its tree
 * throws.
 */
export function proven(body) {
  const { network, boxes, records } = body.seed;
  const prover = proverFrom(seedTreeWrites(boxes, records, network));
  const parentDigest = prover.digest();
  const run = proveBlock(prover, body.block, ctx);
  if (!run.result.ok) throw new Error(`${body.name}: the block is refused over its tree: ${run.result.reason}`);
  const cost = { signatures: run.result.effects.signatures, lookups: run.lookups, writes: run.writes.length };
  return { parentDigest, proof: run.proof, digest: run.digest, cost };
}

/**
 * The largest body `bodyFor(n)`, `n` from `from` up, whose cost is within MAX_BLOCK_COST, with its proof. The costs
 * at `from` and `from + 1` place `n` on the guess that each unit adds the same cost; the answer is the `n` whose own
 * proven cost is within the budget and whose `n + 1` is over it.
 */
export function atBudget(bodyFor, from) {
  const probes = new Map();
  const probe = (n) => {
    if (!probes.has(n)) {
      const body = bodyFor(n);
      probes.set(n, { body, proven: proven(body) });
    }
    return probes.get(n);
  };
  const cost = (n) => blockCost(probe(n).proven.cost);
  const step = cost(from + 1) - cost(from);
  if (step <= 0) throw new Error(`atBudget: a unit past ${from} adds a cost of ${step}`);
  let n = from + Math.max(0, Math.floor((MAX_BLOCK_COST - cost(from)) / step));
  while (n > from && cost(n) > MAX_BLOCK_COST) n--;
  if (cost(n) > MAX_BLOCK_COST) {
    throw new Error(`atBudget: the body at ${from} costs ${cost(from)}, over ${MAX_BLOCK_COST}`);
  }
  while (cost(n + 1) <= MAX_BLOCK_COST) n++;
  return probe(n);
}
