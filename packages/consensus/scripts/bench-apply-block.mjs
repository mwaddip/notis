#!/usr/bin/env node
// Times `applyBlock` over the bodies `CONSENSUS_INTERFACE → Cost` bounds, each built over a stub `StateView`:
//
//   ordinary   — one-signer credit sends, each spending one whole credit, as many as MAX_BLOCK_BODY_BYTES
//                holds;
//   packed     — credit payments of as many signers as MAX_TX_BYTES holds, filled to MAX_BLOCK_BODY_BYTES,
//                the last payment taking the signers the remaining bytes hold;
//   corrupted  — the packed body with the signature its last input requires corrupted;
//   oversigned — one-input credit sends, each signed by its input's owner and by as many keys no input
//                requires as MAX_TX_BYTES holds, filled to MAX_BLOCK_BODY_BYTES as the packed body is.
//
// Every signer owns one credit box created the block before, inside the rent period, so each input needs
// its owner's signature; every transaction conserves value; the settlement is `buildBlockSettlement`'s,
// placed last, and the body is weighed with it. The first two bodies are valid end to end; each of the
// last two carries one defect and lists the reasons that name it — the body check's and `validateTx`'s
// own. Each run prints its verdict, and a verdict other than the one its body is built for sets the exit
// code. Keys come from fixed seeds, so every run builds the same bodies. The script reads this package's
// build and `@dagsocial/types`' codecs and constants — nothing else — so it times the tree it is built
// from: `pnpm -r build` first.
//
// usage: node packages/consensus/scripts/bench-apply-block.mjs [runs]    (runs defaults to 3)
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import {
  EMPTY_STATE_ROOT,
  MAX_BLOCK_BODY_BYTES,
  MAX_TX_BYTES,
  computeBoxId,
  computeTxId,
  decayCfgFor,
  decodeTx,
  encodeTx,
  profileFor,
  protocolVersionAt,
  utxoTxTreeByteLength,
} from '@dagsocial/types';
import { applyBlock, buildBlockSettlement } from '../dist/index.js';

const RUNS = Number(process.argv[2] ?? 3);
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error('usage: bench-apply-block.mjs [runs]');
  process.exit(2);
}

const HEIGHT = 1000;
const profile = profileFor('testnet');
// The profile's numbers the rules read (CONSENSUS_INTERFACE → ApplyContext).
const ctx = {
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

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const seed32 = (label) =>
  new Uint8Array(createHash('sha512').update(`dagsocial/bench-apply-block/${label}`).digest().subarray(0, 32));

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

/**
 * The bodies' transactions. A send moves a quarter of a whole credit to the recipient and the rest back.
 * A packed payment pays its signers' boxes whole to the recipient in one output, each box holding a
 * little above the credit floor (MIN_BOX_VALUE_PER_BYTE per record byte), so the output carries few value
 * bytes and the body holds the most signers. An oversigned send pays its first signer's box, of the same
 * value, whole to the recipient; every later signer is a key no input requires, its signature valid over
 * the transaction's id. A kind whose body is refused names the reasons for it (`refusals`).
 */
const KINDS = {
  ordinary: {
    boxValue: 10n ** 8n,
    build: ([signer], [box]) =>
      transaction([box], [credit(recipient, box.value / 4n), credit(signer.publicKey, box.value - box.value / 4n)], [signer]),
  },
  packed: {
    boxValue: 20_000n,
    build: (signers, boxes) =>
      transaction(boxes, [credit(recipient, boxes.reduce((sum, box) => sum + box.value, 0n))], signers),
  },
  oversigned: {
    boxValue: 20_000n,
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

/**
 * The state the rules read, over a map of live boxes: no identity, name, post or like records
 * (CONSENSUS_INTERFACE → StateView). `applyBlock` never writes it, so every run reads the same state.
 */
class StubView {
  constructor(boxes) {
    this.boxes = new Map(boxes.map((box) => [box.id, box]));
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
  getIdentityRecord() { return null; }
  getNetworkRecord() { return { memberCount: 0 }; }
  getUsername() { return null; }
  getUsernameByOwner() { return null; }
  getEmissionBox() { return this.emission; }
  getTreasuryBox() { return this.treasury; }
  getKarmaPoolBox() { return this.karmaPool; }
  getBackerPoolBox() { return this.backerPool; }
  getKarmaBoxes() { return []; }
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

const miner = keyPair('miner');
const recipient = keyPair('recipient').publicKey;
const genesis = [
  heldBox({ boxType: 'emission', value: profile.creditEmissionTotal, createdAtBlock: 0 }, 'emission'),
  heldBox({ boxType: 'karma_pool', value: 1_000_000n, createdAtBlock: 0 }, 'karma_pool'),
];

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
  const signers = Array.from({ length: n }, (_, i) => standIn(`${n}/${i}`));
  const boxes = signers.map((s, i) => creditBox(s, kind.boxValue, `stand-in/${n}/${i}`));
  return encodeTx(kind.build(signers, boxes)).length;
}

/**
 * Each body's shape as signers per transaction, weighed with stand-ins. A body of credit transactions
 * pays no fee, so its settlement is one length whatever the body holds; each built body is weighed again
 * whole.
 */
function shapes() {
  const settlement = blockOf(new StubView([...genesis]), []).utxoTxTree.utxoTxs[0].length;
  const fillWith = (length) =>
    largest(
      Math.floor(MAX_BLOCK_BODY_BYTES / length),
      (n) => bodyBytes(new Array(n).fill(length), settlement) <= MAX_BLOCK_BODY_BYTES,
    );

  /**
   * Transactions of `kind` carrying as many signers as MAX_TX_BYTES holds, as many as the body holds, then
   * one carrying the signers the remaining bytes hold; a signer adds at least `signerBytes` bytes.
   */
  const packedWith = (kind, signerBytes) => {
    const perTx = largest(
      Math.floor(MAX_TX_BYTES / signerBytes),
      (n) => n === 0 || weighed(kind, n) <= MAX_TX_BYTES,
    );
    const full = weighed(kind, perTx);
    const fullTxs = fillWith(full);
    const rest = largest(
      perTx - 1,
      (n) => n === 0 || bodyBytes([...new Array(fullTxs).fill(full), weighed(kind, n)], settlement) <= MAX_BLOCK_BODY_BYTES,
    );
    return [...new Array(fullTxs).fill(perTx), ...(rest > 0 ? [rest] : [])];
  };

  return {
    ordinary: new Array(fillWith(weighed(KINDS.ordinary, 1))).fill(1),
    // A signer adds at least its input's id, its key and its signature: 128 bytes.
    packed: packedWith(KINDS.packed, 128),
    // A signer no input requires adds its key and its signature: 96 bytes.
    oversigned: packedWith(KINDS.oversigned, 96),
  };
}

/**
 * A body of `groups` transactions of `kind`, over its own view of the boxes it spends, with every bound it
 * is held to checked.
 */
function built(name, kind, groups, signers) {
  const boxes = signers.slice(0, count(groups)).map((s, i) => creditBox(s, kind.boxValue, `${name}/${i}`));
  const txs = [];
  let next = 0;
  for (const size of groups) {
    txs.push(kind.build(signers.slice(next, next + size), boxes.slice(next, next + size)));
    next += size;
  }
  const spent = new Set(txs.flatMap((tx) => tx.inputs));
  const view = new StubView([...genesis, ...boxes.filter((box) => spent.has(box.id))]);
  const block = blockOf(view, txs);
  const bytes = utxoTxTreeByteLength(block.utxoTxTree);
  const settlement = block.utxoTxTree.utxoTxs.at(-1).length;
  const heaviest = Math.max(...block.utxoTxTree.utxoTxs.slice(0, -1).map((b) => b.length));
  if (bytes > MAX_BLOCK_BODY_BYTES) throw new Error(`${name}: a body of ${bytes} bytes is over ${MAX_BLOCK_BODY_BYTES}`);
  if (heaviest > MAX_TX_BYTES) throw new Error(`${name}: a transaction of ${heaviest} bytes is over ${MAX_TX_BYTES}`);
  const refusals = kind.refusals ? kind.refusals(txs, view) : null;
  return { name, view, block, signatures: next, txs: txs.length, bytes, settlement, heaviest, refusals };
}

/**
 * `body` with the signature its last input requires corrupted: S loses its lowest set bit, so the signature
 * keeps its shape and a check of it reaches the equation, where it fails. The block is refused by the body
 * check, or for that input's signature.
 */
function corrupted(body) {
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

const setupStart = performance.now();
const { ordinary, packed, oversigned } = shapes();
const signers = Array.from(
  { length: Math.max(count(ordinary), count(packed), count(oversigned)) },
  (_, i) => keyPair(`signer/${i}`),
);
const packedBody = built('packed', KINDS.packed, packed, signers);
const bodies = [
  built('ordinary', KINDS.ordinary, ordinary, signers),
  packedBody,
  corrupted(packedBody),
  built('oversigned', KINDS.oversigned, oversigned, signers),
];

console.log(
  `node ${process.version} · testnet profile · height ${HEIGHT} · ` +
  `bodies built in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`,
);
for (const b of bodies) {
  console.log(
    `${b.name.padEnd(10)} ${b.txs} transactions, ${b.signatures} signatures; body ${b.bytes} of ` +
    `${MAX_BLOCK_BODY_BYTES} bytes with a ${b.settlement}-byte settlement; heaviest transaction ` +
    `${b.heaviest} of ${MAX_TX_BYTES}`,
  );
}
for (const b of bodies) {
  for (let run = 1; run <= RUNS; run++) {
    const start = performance.now();
    const result = applyBlock(b.view, b.block, ctx);
    const seconds = (performance.now() - start) / 1000;
    const expected = b.refusals === null ? result.ok : !result.ok && b.refusals.includes(result.reason);
    if (!expected) process.exitCode = 1;
    console.log(
      `${b.name.padEnd(10)} run ${run}: ${seconds.toFixed(3)} s, ` +
      `${((seconds * 1e6) / b.signatures).toFixed(1)} µs a signature — ` +
      (result.ok ? 'ok: true' : `ok: false — ${result.reason}`) +
      (expected ? '' : ' — not the verdict this body is built for'),
    );
  }
}
