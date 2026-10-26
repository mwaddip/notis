import { describe, it, expect } from 'vitest';
import {
  buildPost,
  buildLike,
  buildVouch,
  buildUnvouch,
  buildInvite,
  buildWithdraw,
  buildClaim,
  buildBurn,
  buildSend,
  txToJson,
  InsufficientKarma,
  InsufficientCredits,
  BelowFloor,
  InvalidKey,
  type BuildContext,
  type RepBuildContext,
} from '../src/wallet/builders';
import {
  VOUCH_KARMA_AMOUNT, USERNAME_BURN_PRICE, MIN_BOX_VALUE_PER_BYTE, LIKE_KARMA_COST,
  computeCandidateBoxId,
  type UtxoTransaction, type CandidateOf, type CreditBox,
} from '@dagsocial/types';

// The builders produce the box shapes validateTx demands, encoded through
// @dagsocial/types. The txIds below are frozen — computed by an independent
// implementation over fixed inputs: height 5000, era 1, one spendable box of
// 227 (boxId 'cc'*32), author 'aa'*32, a reply parent 'bb'*32 / 'dd'*32 and a
// like target 'bb'*32 / 'ee'*32, over the content strings named here. A builder
// change that moves one is a wire change, not a value to adjust.
//
// txIdBytes has six fields (TYPES_INTERFACE → Layout — UtxoTransaction); every
// txId is computeTxId over those inputs under that layout, and every change-box
// id is computeCandidateBoxId over that txId.

const PUB = 'aa'.repeat(32);
const PARENT_AUTHOR = 'bb'.repeat(32);
const BOX_ID = 'cc'.repeat(32);
const PARENT_ID = 'dd'.repeat(32);
const TARGET_ID = 'ee'.repeat(32);
const THREAD_CONTENT = 'a test thread ✓';
const REPLY_CONTENT = 'a test reply ✓';

// The frozen txIds and the change-box ids they derive moved under the karma
// box's one-byte `income` mark (TYPES_INTERFACE → KarmaBox): every karma
// output (change on a post, a reply, a like, a vouch, an invite and a burn,
// and the returned box on a withdrawal and a claim) now encodes a trailing
// `u8(0)` on an own box, so the preimage `computeTxId` and
// `computeCandidateBoxId` hash is one byte longer. The content hash and the
// unvouch's vectors are unchanged — the escrow box carries no mark.
const THREAD_TXID = 'ff8329bdb14b0afd6a32e2f89f1924bbd1e03298e26d90929eb0c898701fc796';
const THREAD_CHANGE = 'a99bf6eeccf10dfae365cdbf17d652394385ad511821b33b4b75015618217c4e';
const REPLY_TXID = '86046d10064b3755c09bf25408de409bc63c5376402d86adbfffef31ff460ea6';
const REPLY_CHANGE = '0bf449c6cb43898ba081027a3585726c052bb59783d2ccbdc3f0e724e02dd25e';
const LIKE_TXID = '76551a603b4f28cb13ab2f08abc44120b6ea41dcc8452232be342768e731733a';
const LIKE_CHANGE = '089da24b9f9132961e0aeafd4d42461bebfbb89c3fd351deef63714d796275b9';
const THREAD_CONTENT_HASH = '8bc41f00d29d7adc055bc479bf21e13473a34426470b92aa675c6f83eba2429f';

// The membership vectors, frozen the same way — txIds over fixed inputs: height
// 5000, era 1, one spendable box of 227 ('cc'*32), author 'aa'*32, over a vouch
// target '11'*32, an invitee '22'*32 with a bond of 100, and an unvouch of a
// vouch box '33'*32 (stake 1, cast at 4990, cooldown 60 → release 5050).
const VOUCH_TARGET = '11'.repeat(32);
const INVITEE = '22'.repeat(32);
const VOUCH_BOX = '33'.repeat(32);
// A foreign key of the right length but outside the hex alphabet — the shape
// a node's confirmedAuthor, a vouch target or a pasted key can take when it
// is not what it claims (TYPES_INTERFACE → Export table).
const BAD_KEY = 'gg'.repeat(32);
const VOUCH_TXID = 'aee92c3169b71ff7b28391f3b42ad5021a08f008524e741d381fa371dc676ac9';
const VOUCH_CHANGE = '70bd6ce743bc1701d6fad83153dbc8263d8e2ef950423289fd5de41e0d124b3c';
const INVITE_TXID = '3a1f6cc577452b93ccf731f672a4ed94d37e73be0afa7e70455f402cf8f20a05';
const INVITE_CHANGE = 'f2b2a7499dbfe0371d3a1d14bd73c5b382b5d5472e2d6a6cc5c300000e7875b5';
const UNVOUCH_TXID = '5988584f619b498ca161e9d7739c975370bb75ea0c6ce6d3c87ac7efcfd11f6b';

// The withdraw vector, frozen the same way — txId and output id over fixed
// inputs: height 5000, era 1, one spendable box of 227 ('cc'*32), author
// 'aa'*32, over a post id 'ff'*32.
const WITHDRAW_POST_ID = 'ff'.repeat(32);
const WITHDRAW_TXID = 'a93c11ebccc94dd1781b002a987a1470ce29441fc694fa12f0c77ee572917cc8';
const WITHDRAW_OUTPUT = '37ca9c1d70085316a6eaa3d9059c81c45fcbf9424f85a011adb31d7d32f3cab8';

// The claim vector: a claim of 'Alice_01' from the same fixed ctx.
const CLAIM_TXID = '4e49c7b9820868ce5ccb944af09faca7eb15c4db2c80311b17cd3f574e2b2eba';
const CLAIM_CHANGE = '4b405733943ce53de0d63b6453740bf71702063462b2d8aa081b759222539e69';

// The burn vectors: a burn over a name box '44'*32 beside the 227 box, and a
// burn over a box of exactly 10 with no change.
const NAME_BOX_ID = '44'.repeat(32);
const BURN_TXID = '43b340fb44450093b529989f0ea6cf6f3f26bf80b4631f3a6ceaae0d118577b7';
const BURN_CHANGE = '9a22f86f083449159456ce6078779d78acf482070aaf6f844c87b95a943733c2';
const EXACT_BOX = '55'.repeat(32);
const BURN_EXACT_TXID = 'ec3fde946eb20fe3d1eb26917b049720acbd5ed41f336b0f7fd62b56bfe9a8bc';

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const ctx = (): RepBuildContext => ({ spendable: [{ boxId: BOX_ID, value: 227n }], height: 5000, era: 1, author: PUB, effective: 227n });

describe('builders — frozen against independent vectors', () => {
  it('a root post matches the frozen txId and change box, and pays POST_PRICE_THREAD', () => {
    const built = buildPost(ctx(), THREAD_CONTENT);
    expect(built.txId).toBe(THREAD_TXID);
    expect(built.change).toEqual({ boxId: THREAD_CHANGE, value: 222n, createdAtBlock: 5000 });
    expect(built.tx.inputs).toEqual([BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 222n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'karma_price', value: 5n, createdAtBlock: 5000 },
    ]);
    expect(built.tx.post?.parentRefs).toEqual([]);
    expect(toHex(built.tx.post!.contentHash)).toBe(THREAD_CONTENT_HASH);
    expect(built.tx.likeTarget).toBeUndefined();
    // Conservation: the change plus the price equals the one selected box.
    expect(built.change!.value + 5n).toBe(227n);
  });

  it('a reply matches the frozen txId and addresses the share to the confirmed author', () => {
    const built = buildPost(ctx(), REPLY_CONTENT, { id: PARENT_ID, authorHex: PARENT_AUTHOR });
    expect(built.txId).toBe(REPLY_TXID);
    expect(built.change).toEqual({ boxId: REPLY_CHANGE, value: 224n, createdAtBlock: 5000 });
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 224n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'karma_price', value: 2n, createdAtBlock: 5000 },
      { boxType: 'like_accrual', value: 1n, createdAtBlock: 5000, author: hexToBytes(PARENT_AUTHOR) },
    ]);
    expect(built.tx.post?.parentRefs).toEqual([PARENT_ID]);
    // Conservation: 224 + (2 + 1) = 227.
    expect(built.change!.value + 2n + 1n).toBe(227n);
  });

  it('a like matches the frozen txId, sets likeTarget, and carries no post', () => {
    const built = buildLike(ctx(), TARGET_ID, PARENT_AUTHOR);
    expect(built.txId).toBe(LIKE_TXID);
    expect(built.change).toEqual({ boxId: LIKE_CHANGE, value: 226n, createdAtBlock: 5000 });
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 226n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'like_accrual', value: 1n, createdAtBlock: 5000, author: hexToBytes(PARENT_AUTHOR) },
    ]);
    expect(built.tx.likeTarget).toBe(TARGET_ID);
    expect(built.tx.post).toBeUndefined();
  });
});

describe('builders — structural rules', () => {
  it('a zero change is no box', () => {
    // Exactly the thread price: no karma change output.
    const thread = buildPost({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 5n }] }, 'x');
    expect(thread.change).toBeNull();
    expect(thread.tx.outputs).toEqual([{ boxType: 'karma_price', value: 5n, createdAtBlock: 5000 }]);
    // Exactly the reply price: still the share and the pool, no change.
    const reply = buildPost({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 3n }] }, 'x', { id: PARENT_ID, authorHex: PARENT_AUTHOR });
    expect(reply.change).toBeNull();
    expect(reply.tx.outputs.map((o) => o.boxType)).toEqual(['karma_price', 'like_accrual']);
  });

  it('InsufficientKarma when the spendable view cannot cover the price', () => {
    expect(() => buildPost({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 4n }] }, 'x')).toThrow(InsufficientKarma);
    try {
      buildPost({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 4n }] }, 'x');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(5n);
      expect((e as InsufficientKarma).available).toBe(4n);
    }
    expect(() => buildLike({ ...ctx(), spendable: [] }, TARGET_ID, PARENT_AUTHOR)).toThrow(InsufficientKarma);
  });

  it('the own box leads the spend when it covers the price', () => {
    const OWN = 'a'.repeat(64);
    const INC = 'b'.repeat(64);
    const spendable = [
      { boxId: OWN, value: 10n },
      { boxId: INC, value: 100n, income: true as const },
    ];
    // Price 5: the own box alone covers it, the income box is untouched.
    const built = buildPost({ ...ctx(), spendable }, 'x');
    expect(built.tx.inputs).toEqual([OWN]);
    expect(built.change!.value).toBe(5n);
  });

  it('InvalidKey when a reply\'s or a like\'s confirmed author is not 64 lowercase hex', () => {
    expect(() => buildPost(ctx(), 'x', { id: PARENT_ID, authorHex: BAD_KEY })).toThrow(InvalidKey);
    expect(() => buildLike(ctx(), TARGET_ID, BAD_KEY)).toThrow(InvalidKey);
  });
});

describe('membership builders — frozen against independent vectors', () => {
  it('a vouch matches the frozen txId and change box, and stakes exactly VOUCH_KARMA_AMOUNT', () => {
    const built = buildVouch(ctx(), VOUCH_TARGET);
    expect(built.txId).toBe(VOUCH_TXID);
    expect(built.change).toEqual({ boxId: VOUCH_CHANGE, value: 226n, createdAtBlock: 5000 });
    expect(built.tx.inputs).toEqual([BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 226n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 5000, voucherId: hexToBytes(PUB), targetId: hexToBytes(VOUCH_TARGET) },
    ]);
    expect((built.tx.outputs[1] as { value: bigint }).value).toBe(VOUCH_KARMA_AMOUNT);
    expect(built.tx.post).toBeUndefined();
    expect(built.tx.likeTarget).toBeUndefined();
    // Conservation: the change plus the stake equals the one selected box.
    expect(built.change!.value + VOUCH_KARMA_AMOUNT).toBe(227n);
  });

  it('an unvouch matches: one input, one escrow of the box value, release = cast + cooldown, no karma', () => {
    const built = buildUnvouch(ctx(), { boxId: VOUCH_BOX, value: 1n, createdAtBlock: 4990 }, 60);
    expect(built.txId).toBe(UNVOUCH_TXID);
    expect(built.change).toBeNull();
    expect(built.tx.inputs).toEqual([VOUCH_BOX]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'vouch_escrow', value: 1n, createdAtBlock: 5000, owner: hexToBytes(PUB), releaseAtBlock: 5050 },
    ]);
    // No karma output — the stake is held, not returned as change.
    expect(built.tx.outputs.every((o) => o.boxType !== 'karma')).toBe(true);
  });

  it('an invite matches the frozen txId and carries the bond named', () => {
    const built = buildInvite(ctx(), INVITEE, 100n);
    expect(built.txId).toBe(INVITE_TXID);
    expect(built.change).toEqual({ boxId: INVITE_CHANGE, value: 127n, createdAtBlock: 5000 });
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 127n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'bond', value: 100n, createdAtBlock: 5000, inviterId: hexToBytes(PUB), inviteePublicKey: hexToBytes(INVITEE) },
    ]);
    // Conservation: 127 + 100 = 227.
    expect(built.change!.value + 100n).toBe(227n);
  });
});

describe('membership builders — structural rules', () => {
  it('a vouch from a single 1-karma box emits no change', () => {
    const built = buildVouch({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 1n }] }, VOUCH_TARGET);
    expect(built.change).toBeNull();
    expect(built.tx.outputs).toEqual([
      { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 5000, voucherId: hexToBytes(PUB), targetId: hexToBytes(VOUCH_TARGET) },
    ]);
  });

  it('InsufficientKarma names the bond when the view cannot cover it', () => {
    expect(() => buildInvite({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 50n }] }, INVITEE, 100n)).toThrow(InsufficientKarma);
    try {
      buildInvite({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 50n }] }, INVITEE, 100n);
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(100n);
      expect((e as InsufficientKarma).available).toBe(50n);
    }
    // A vouch is unaffordable below VOUCH_KARMA_AMOUNT.
    expect(() => buildVouch({ ...ctx(), spendable: [] }, VOUCH_TARGET)).toThrow(InsufficientKarma);
  });

  it('InvalidKey when a vouch target or an invitee is not 64 lowercase hex', () => {
    expect(() => buildVouch(ctx(), BAD_KEY)).toThrow(InvalidKey);
    expect(() => buildInvite(ctx(), BAD_KEY, 100n)).toThrow(InvalidKey);
  });
});

describe('withdraw builder — frozen against the independent vector', () => {
  it('a withdrawal matches the frozen txId and output id, spends and returns one karma box', () => {
    const built = buildWithdraw(ctx(), WITHDRAW_POST_ID);
    expect(built.txId).toBe(WITHDRAW_TXID);
    expect(built.change).toEqual({ boxId: WITHDRAW_OUTPUT, value: 227n, createdAtBlock: 5000 });
    expect(built.tx.inputs).toEqual([BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 227n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
    ]);
    expect(built.tx.postWithdraw).toEqual({ postId: WITHDRAW_POST_ID });
    expect(built.tx.post).toBeUndefined();
    expect(built.tx.likeTarget).toBeUndefined();
    // Conservation: one box in, its whole value back out.
    expect(built.change!.value).toBe(227n);
  });
});

describe('withdraw builder — structural rules', () => {
  it('takes the own box when the view holds the own and the income box', () => {
    const OWN = 'a'.repeat(64);
    const INC = 'b'.repeat(64);
    const spendable = [
      // Own leads, even though the income box carries more.
      { boxId: OWN, value: 3n },
      { boxId: INC, value: 10n, income: true as const },
    ];
    const built = buildWithdraw({ ...ctx(), spendable }, WITHDRAW_POST_ID);
    expect(built.tx.inputs).toEqual([OWN]);
    expect(built.change!.value).toBe(3n);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 3n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
    ]);
  });

  it('InsufficientKarma names one box when the spendable view is empty', () => {
    expect(() => buildWithdraw({ ...ctx(), spendable: [] }, WITHDRAW_POST_ID)).toThrow(InsufficientKarma);
    try {
      buildWithdraw({ ...ctx(), spendable: [] }, WITHDRAW_POST_ID);
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(1n);
      expect((e as InsufficientKarma).available).toBe(0n);
    }
  });
});

describe('txToJson — the node JSON edge', () => {
  const sign = (tx: UtxoTransaction): UtxoTransaction => ({ ...tx, signatures: { [PUB]: new Uint8Array(64) } });

  it('renders a post: hex owner/author, decimal-string values, the commit, one signature', () => {
    const built = buildPost(ctx(), THREAD_CONTENT);
    const body = txToJson(sign(built.tx));
    expect(body.inputs).toEqual([BOX_ID]);
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '222', createdAtBlock: 5000, owner: PUB },
      { boxType: 'karma_price', value: '5', createdAtBlock: 5000 },
    ]);
    expect(body.post).toEqual({
      contentHash: THREAD_CONTENT_HASH,
      author: PUB,
      parentRefs: [],
      protocolVersion: 1,
      type: 'regular',
    });
    expect(body.signatures).toEqual({ [PUB]: '00'.repeat(64) });
    expect(body.likeTarget).toBeUndefined();
  });

  it('renders a like: likeTarget present, no post, exactly one signature', () => {
    const built = buildLike(ctx(), TARGET_ID, PARENT_AUTHOR);
    const body = txToJson(sign(built.tx));
    expect(body.likeTarget).toBe(TARGET_ID);
    expect(body.post).toBeUndefined();
    expect(Object.keys(body.signatures as object)).toHaveLength(1);
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '226', createdAtBlock: 5000, owner: PUB },
      { boxType: 'like_accrual', value: '1', createdAtBlock: 5000, author: PARENT_AUTHOR },
    ]);
  });

  it('renders a vouch: hex voucherId/targetId, decimal value', () => {
    const built = buildVouch(ctx(), VOUCH_TARGET);
    const body = txToJson(sign(built.tx));
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '226', createdAtBlock: 5000, owner: PUB },
      { boxType: 'vouch', value: '1', createdAtBlock: 5000, voucherId: PUB, targetId: VOUCH_TARGET },
    ]);
    expect(body.post).toBeUndefined();
    expect(body.likeTarget).toBeUndefined();
  });

  it('renders an unvouch: escrow owner hex, decimal value, releaseAtBlock a number', () => {
    const built = buildUnvouch(ctx(), { boxId: VOUCH_BOX, value: 1n, createdAtBlock: 4990 }, 60);
    const body = txToJson(sign(built.tx));
    expect(body.inputs).toEqual([VOUCH_BOX]);
    expect(body.outputs).toEqual([
      { boxType: 'vouch_escrow', value: '1', createdAtBlock: 5000, owner: PUB, releaseAtBlock: 5050 },
    ]);
  });

  it('renders an invite: hex inviterId/inviteePublicKey, decimal value', () => {
    const built = buildInvite(ctx(), INVITEE, 100n);
    const body = txToJson(sign(built.tx));
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '127', createdAtBlock: 5000, owner: PUB },
      { boxType: 'bond', value: '100', createdAtBlock: 5000, inviterId: PUB, inviteePublicKey: INVITEE },
    ]);
  });

  it('renders a withdrawal: postWithdraw present, one karma output, no post/likeTarget', () => {
    const built = buildWithdraw(ctx(), WITHDRAW_POST_ID);
    const body = txToJson(sign(built.tx));
    expect(body.inputs).toEqual([BOX_ID]);
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '227', createdAtBlock: 5000, owner: PUB },
    ]);
    expect(body.postWithdraw).toEqual({ postId: WITHDRAW_POST_ID });
    expect(body.post).toBeUndefined();
    expect(body.likeTarget).toBeUndefined();
  });

  it('renders a claim: hex owner/name, decimal value, no post/likeTarget', () => {
    const built = buildClaim(ctx(), 'Alice_01');
    const body = txToJson(sign(built.tx));
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '227', createdAtBlock: 5000, owner: PUB },
      { boxType: 'username', value: '0', createdAtBlock: 5000, owner: PUB, name: toHex(new TextEncoder().encode('Alice_01')) },
    ]);
    expect(body.post).toBeUndefined();
    expect(body.likeTarget).toBeUndefined();
  });

  it('renders a burn: karma change and karma_price, no post/likeTarget', () => {
    const built = buildBurn(ctx(), { boxId: NAME_BOX_ID });
    const body = txToJson(sign(built.tx));
    expect(body.inputs).toEqual([BOX_ID, NAME_BOX_ID]);
    expect(body.outputs).toEqual([
      { boxType: 'karma', value: '217', createdAtBlock: 5000, owner: PUB },
      { boxType: 'karma_price', value: '10', createdAtBlock: 5000 },
    ]);
    expect(body.post).toBeUndefined();
    expect(body.likeTarget).toBeUndefined();
  });
});

describe('claim builder — frozen against the independent vector', () => {
  it('a claim matches the frozen txId and change box, spends and returns the smallest box', () => {
    const built = buildClaim(ctx(), 'Alice_01');
    expect(built.txId).toBe(CLAIM_TXID);
    expect(built.change).toEqual({ boxId: CLAIM_CHANGE, value: 227n, createdAtBlock: 5000 });
    expect(built.tx.inputs).toEqual([BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 227n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'username', value: 0n, createdAtBlock: 5000, owner: hexToBytes(PUB), name: new TextEncoder().encode('Alice_01') },
    ]);
    expect(built.tx.post).toBeUndefined();
    expect(built.tx.likeTarget).toBeUndefined();
    expect(built.change!.value).toBe(227n);
  });
});

describe('claim builder — structural rules', () => {
  it('InsufficientKarma when the spendable view is empty', () => {
    expect(() => buildClaim({ ...ctx(), spendable: [] }, 'Alice_01')).toThrow(InsufficientKarma);
    try {
      buildClaim({ ...ctx(), spendable: [] }, 'Alice_01');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(1n);
      expect((e as InsufficientKarma).available).toBe(0n);
    }
  });

  it('takes the own box when the view holds the own and the income box', () => {
    const OWN = 'a'.repeat(64);
    const INC = 'b'.repeat(64);
    const spendable = [
      { boxId: OWN, value: 3n },
      { boxId: INC, value: 10n, income: true as const },
    ];
    const built = buildClaim({ ...ctx(), spendable }, 'Test');
    expect(built.tx.inputs).toEqual([OWN]);
    expect(built.change!.value).toBe(3n);
  });
});

describe('burn builder — frozen against the independent vector', () => {
  it('a burn matches the frozen txId: karma ids then name box id, change at 0, price at 1', () => {
    const built = buildBurn(ctx(), { boxId: NAME_BOX_ID });
    expect(built.txId).toBe(BURN_TXID);
    expect(built.change).toEqual({ boxId: BURN_CHANGE, value: 217n, createdAtBlock: 5000 });
    expect(built.tx.inputs).toEqual([BOX_ID, NAME_BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma', value: 217n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 5000 },
    ]);
    expect(built.change!.value + USERNAME_BURN_PRICE).toBe(227n);
  });

  it('a burn over exactly USERNAME_BURN_PRICE emits no change box', () => {
    const built = buildBurn({ ...ctx(), spendable: [{ boxId: EXACT_BOX, value: 10n }] }, { boxId: NAME_BOX_ID });
    expect(built.txId).toBe(BURN_EXACT_TXID);
    expect(built.change).toBeNull();
    expect(built.tx.inputs).toEqual([EXACT_BOX, NAME_BOX_ID]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: 5000 },
    ]);
  });
});

describe('burn builder — structural rules', () => {
  it('InsufficientKarma when the spendable view cannot cover USERNAME_BURN_PRICE', () => {
    expect(() => buildBurn({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 5n }] }, { boxId: NAME_BOX_ID })).toThrow(InsufficientKarma);
    try {
      buildBurn({ ...ctx(), spendable: [{ boxId: BOX_ID, value: 5n }] }, { boxId: NAME_BOX_ID });
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(USERNAME_BURN_PRICE);
      expect((e as InsufficientKarma).available).toBe(5n);
    }
  });
});

// -------------------------------------------------------------------------
// The send builder — WEB_INTERFACE → The wallet. Frozen vectors: fixed inputs
// (height 5000, era 1, author 'aa'*32, recipient '44'*32, credit boxes of
// stated values), the frozen txId, the change id and the payment id. Main
// recomputes every one by hand through the shared codec.
// -------------------------------------------------------------------------

const RECIPIENT = '44'.repeat(32);
const CREDIT_BOX = 'cc'.repeat(32);
const CREDIT_BOX_2 = 'dd'.repeat(32);

const SEND_MAIN_TXID = 'd3bb3f9b115d9065e36284e8a225ca9e2804721298f1bbad09c1baa5372b13e1';
const SEND_MAIN_CHANGE = 'fb0b8f6e1b2bf54738aacedc98299194b9e470d408ffd077702090b8203a55ed';
const SEND_MAIN_PAYMENT = '4ad589c04e8bd04a5ac18facc52a1a4b6056bebe4d1dcdc9de24b197eb6e48ad';
const SEND_EXACT_TXID = 'ccd601ff2a64719e86a8f3bf924326d4fd359998242818fef08601c4042bd1c1';
const SEND_EXACT_PAYMENT = 'c6b4c791c940eedfa4564f721026506663f41edaf2727ad75a87db60d0f9c7b2';
const SEND_TWO_TXID = 'a8fd4fa310dd8d9e907677ea2f12fe0bff5849bd6131008e67d44a81672f726e';
const SEND_TWO_CHANGE = '5213806b6d402b99b5a7f849418ce15082d856a83cda07858cf1ed86e6d9ef5d';
const SEND_TWO_PAYMENT = '912c1839ce7f0f35c6e1c2a147b3d36b3fb621a97224c8169bdef218a5ab6ada';

describe('send builder — frozen vectors', () => {
  it('12.5 $NOTIS from a 100 box: change at 0, payment at 1, no fee', () => {
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 10_000_000_000n }], height: 5000, era: 1, author: PUB };
    const built = buildSend(ctx, RECIPIENT, 1_250_000_000n);
    expect(built.txId).toBe(SEND_MAIN_TXID);
    expect(built.change).toEqual({ boxId: SEND_MAIN_CHANGE, value: 8_750_000_000n, createdAtBlock: 5000 });
    expect(built.paymentBoxId).toBe(SEND_MAIN_PAYMENT);
    expect(built.tx.inputs).toEqual([CREDIT_BOX]);
    expect(built.tx.outputs).toEqual([
      { boxType: 'credit', value: 8_750_000_000n, createdAtBlock: 5000, owner: hexToBytes(PUB) },
      { boxType: 'credit', value: 1_250_000_000n, createdAtBlock: 5000, owner: hexToBytes(RECIPIENT) },
    ]);
    // No fee box on any send this client builds (WEB_INTERFACE → The wallet).
    expect(built.tx.outputs.some((o) => o.boxType === 'fee')).toBe(false);
    // The payment id equals an independent computeCandidateBoxId over the same
    // candidate — the txId, and index 1 in this shape (change at 0, payment at 1).
    const payment: CandidateOf<CreditBox> = {
      boxType: 'credit', value: 1_250_000_000n, createdAtBlock: 5000, owner: hexToBytes(RECIPIENT),
    };
    expect(computeCandidateBoxId(payment, built.txId, 1)).toBe(built.paymentBoxId);
  });

  it('an exact spend emits the payment alone — no change, payment at index 0', () => {
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 1_250_000_000n }], height: 5000, era: 1, author: PUB };
    const built = buildSend(ctx, RECIPIENT, 1_250_000_000n);
    expect(built.txId).toBe(SEND_EXACT_TXID);
    expect(built.change).toBeNull();
    expect(built.paymentBoxId).toBe(SEND_EXACT_PAYMENT);
    expect(built.tx.outputs).toEqual([
      { boxType: 'credit', value: 1_250_000_000n, createdAtBlock: 5000, owner: hexToBytes(RECIPIENT) },
    ]);
    const payment: CandidateOf<CreditBox> = {
      boxType: 'credit', value: 1_250_000_000n, createdAtBlock: 5000, owner: hexToBytes(RECIPIENT),
    };
    expect(computeCandidateBoxId(payment, built.txId, 0)).toBe(built.paymentBoxId);
  });

  it('two boxes selected largest-first', () => {
    const ctx: BuildContext = {
      spendable: [
        { boxId: CREDIT_BOX, value: 1_000_000_000n },
        { boxId: CREDIT_BOX_2, value: 500_000_000n },
      ], height: 5000, era: 1, author: PUB,
    };
    const built = buildSend(ctx, RECIPIENT, 1_400_000_000n);
    expect(built.txId).toBe(SEND_TWO_TXID);
    expect(built.change?.boxId).toBe(SEND_TWO_CHANGE);
    expect(built.paymentBoxId).toBe(SEND_TWO_PAYMENT);
    expect(built.tx.inputs).toEqual([CREDIT_BOX, CREDIT_BOX_2]);
  });
});

// -------------------------------------------------------------------------
// Two-box karma selection — WEB_INTERFACE → The wallet → "The rep view holds
// two boxes at most, and every karma builder tells them apart". Own is the
// unmarked box; income the one marked `income: true`. The own box is named
// first, and the income box rides with it only when the own box does not
// cover the spend; with no own box, the income box is spent alone. A
// withdrawal and a claim take the same one box (own, or income where there
// is no own). A view carries both when the key holds both, and the two sum
// to the figure the row shows.
// -------------------------------------------------------------------------

const OWN_BOX = '77'.repeat(32);
const INC_BOX = '88'.repeat(32);

function twoBoxCtx(own: bigint | null, income: bigint | null): RepBuildContext {
  const spendable: Array<{ boxId: string; value: bigint; income?: true }> = [];
  if (own !== null) spendable.push({ boxId: OWN_BOX, value: own });
  if (income !== null) spendable.push({ boxId: INC_BOX, value: income, income: true });
  return { spendable: spendable as BuildContext['spendable'], height: 5000, era: 1, author: PUB, effective: 0n };
}

describe('builders — the own box is named first, the income box only when it must', () => {
  it('every karma builder takes the own box alone when it covers (own 50, income 100)', () => {
    const builts = [
      buildPost(twoBoxCtx(50n, 100n), 'x'),
      buildPost(twoBoxCtx(50n, 100n), 'x', { id: PARENT_ID, authorHex: PARENT_AUTHOR }),
      buildLike(twoBoxCtx(50n, 100n), TARGET_ID, PARENT_AUTHOR),
      buildVouch(twoBoxCtx(50n, 100n), VOUCH_TARGET),
      buildInvite(twoBoxCtx(50n, 100n), INVITEE, 10n),
      buildBurn(twoBoxCtx(50n, 100n), { boxId: NAME_BOX_ID }),
    ];
    for (const built of builts) {
      // The input list begins with the own box; a burn adds its name box
      // after (an input it carries beside the karma one), everything else
      // takes the own box alone.
      expect(built.tx.inputs[0]).toBe(OWN_BOX);
      expect(built.tx.inputs).not.toContain(INC_BOX);
      // Exactly one karma output, carrying no `income` key.
      const karmaOuts = built.tx.outputs.filter((o) => o.boxType === 'karma');
      expect(karmaOuts).toHaveLength(1);
      expect((karmaOuts[0] as { income?: unknown }).income).toBeUndefined();
    }
  });

  it('with own 3 and income 100, a root post takes both and returns one change of the sum less the price', () => {
    const built = buildPost(twoBoxCtx(3n, 100n), 'x');
    // Both inputs ride, the own one first.
    expect(built.tx.inputs).toEqual([OWN_BOX, INC_BOX]);
    // One karma output: 103 - 5 = 98.
    expect(built.change?.value).toBe(98n);
    const karmaOuts = built.tx.outputs.filter((o) => o.boxType === 'karma');
    expect(karmaOuts).toHaveLength(1);
    expect((karmaOuts[0] as { income?: unknown }).income).toBeUndefined();
  });

  it('with no own box, a like takes the income box alone and returns an unmarked change', () => {
    const built = buildLike(twoBoxCtx(null, 100n), TARGET_ID, PARENT_AUTHOR);
    expect(built.tx.inputs).toEqual([INC_BOX]);
    const karmaOuts = built.tx.outputs.filter((o) => o.boxType === 'karma');
    expect(karmaOuts).toHaveLength(1);
    expect((karmaOuts[0] as { income?: unknown }).income).toBeUndefined();
    // The unmarked change equals the income value less the like's cost.
    expect(built.change?.value).toBe(100n - LIKE_KARMA_COST);
  });

  it('neither covers — the typed refusal names the price and the sum of both', () => {
    // own 3 + income 1 = 4; a root post needs 5.
    expect(() => buildPost(twoBoxCtx(3n, 1n), 'x')).toThrow(InsufficientKarma);
    try {
      buildPost(twoBoxCtx(3n, 1n), 'x');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientKarma);
      expect((e as InsufficientKarma).required).toBe(5n);
      expect((e as InsufficientKarma).available).toBe(4n);
    }
  });

  it('a withdrawal and a claim take the own box, even when the income box is smaller', () => {
    // Own 100, income 50 — the old "smallest" rule would pick income.
    const w = buildWithdraw(twoBoxCtx(100n, 50n), WITHDRAW_POST_ID);
    expect(w.tx.inputs).toEqual([OWN_BOX]);
    expect(w.change?.value).toBe(100n);
    expect((w.tx.outputs[0] as { income?: unknown }).income).toBeUndefined();

    const c = buildClaim(twoBoxCtx(100n, 50n), 'Alice_01');
    expect(c.tx.inputs).toEqual([OWN_BOX]);
    expect(c.change?.value).toBe(100n);
  });

  it('with no own box, a withdrawal and a claim take the income box and return its value', () => {
    const w = buildWithdraw(twoBoxCtx(null, 50n), WITHDRAW_POST_ID);
    expect(w.tx.inputs).toEqual([INC_BOX]);
    expect(w.change?.value).toBe(50n);
    expect((w.tx.outputs[0] as { income?: unknown }).income).toBeUndefined();

    const c = buildClaim(twoBoxCtx(null, 50n), 'Alice_01');
    expect(c.tx.inputs).toEqual([INC_BOX]);
    expect(c.change?.value).toBe(50n);
  });

  it('a pending spend moves the own box: the next build names the predicted change', () => {
    // A prior like took the own box of value 50 and emitted a change of 49
    // (unmarked) beside the still-unspent income box of 100. The next like
    // (cost 1) names the change alone, since it covers.
    const CHG = '66'.repeat(32);
    const spendable = [
      { boxId: INC_BOX, value: 100n, income: true },
      { boxId: CHG, value: 49n },
    ] as BuildContext['spendable'];
    const built = buildLike({ spendable, height: 5000, era: 1, author: PUB, effective: 149n } satisfies RepBuildContext, TARGET_ID, PARENT_AUTHOR);
    expect(built.tx.inputs).toEqual([CHG]);
    expect(built.tx.inputs).not.toContain(INC_BOX);
  });

  it('a pending spend whose change does not cover the next spend brings the income box with it', () => {
    // Prior spend left a tiny change (1); the next thread post needs 5. Both
    // must ride, the change first.
    const TINY = '99'.repeat(32);
    const spendable = [
      { boxId: INC_BOX, value: 100n, income: true },
      { boxId: TINY, value: 1n },
    ] as BuildContext['spendable'];
    const built = buildPost({ spendable, height: 5000, era: 1, author: PUB, effective: 101n } satisfies RepBuildContext, 'x');
    expect(built.tx.inputs).toEqual([TINY, INC_BOX]);
  });

  it('a pending spend that took the income box leaves the view holding the predicted change alone', () => {
    // Both own and income are spent by the prior entry; the view carries one
    // unmarked change. The next build names it, and the output is unmarked.
    const CHG = 'aa'.repeat(32);
    const spendable = [{ boxId: CHG, value: 49n }] as BuildContext['spendable'];
    const built = buildLike({ spendable, height: 5000, era: 1, author: PUB, effective: 49n } satisfies RepBuildContext, TARGET_ID, PARENT_AUTHOR);
    expect(built.tx.inputs).toEqual([CHG]);
    const karmaOuts = built.tx.outputs.filter((o) => o.boxType === 'karma');
    expect(karmaOuts).toHaveLength(1);
    expect((karmaOuts[0] as { income?: unknown }).income).toBeUndefined();
  });

  it('no builder makes two karma outputs or a marked one, over the shapes above', () => {
    const builts = [
      buildPost(twoBoxCtx(50n, 100n), 'x'),
      buildPost(twoBoxCtx(50n, 100n), 'x', { id: PARENT_ID, authorHex: PARENT_AUTHOR }),
      buildLike(twoBoxCtx(50n, 100n), TARGET_ID, PARENT_AUTHOR),
      buildVouch(twoBoxCtx(50n, 100n), VOUCH_TARGET),
      buildInvite(twoBoxCtx(50n, 100n), INVITEE, 10n),
      buildBurn(twoBoxCtx(50n, 100n), { boxId: NAME_BOX_ID }),
      buildWithdraw(twoBoxCtx(50n, 100n), WITHDRAW_POST_ID),
      buildClaim(twoBoxCtx(50n, 100n), 'Alice_01'),
      buildLike(twoBoxCtx(null, 100n), TARGET_ID, PARENT_AUTHOR),
    ];
    for (const built of builts) {
      const karmaOuts = built.tx.outputs.filter((o) => o.boxType === 'karma');
      expect(karmaOuts.length).toBeLessThanOrEqual(1);
      for (const k of karmaOuts) {
        expect((k as { income?: unknown }).income).toBeUndefined();
      }
    }
  });
});

describe('send builder — refusals', () => {
  it('InvalidKey when the recipient is not 64 lowercase hex', () => {
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 500n }], height: 5000, era: 1, author: PUB };
    expect(() => buildSend(ctx, BAD_KEY, 100n)).toThrow(InvalidKey);
  });

  it('InsufficientCredits when the spendable view cannot cover the amount', () => {
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 500n }], height: 5000, era: 1, author: PUB };
    expect(() => buildSend(ctx, RECIPIENT, 100_000_000_000n)).toThrow(InsufficientCredits);
    try {
      buildSend(ctx, RECIPIENT, 100_000_000_000n);
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientCredits);
      expect((e as InsufficientCredits).required).toBe(100_000_000_000n);
      expect((e as InsufficientCredits).available).toBe(500n);
    }
  });

  it('BelowFloor payment when the amount is one base unit', () => {
    // Selecting one big box, sending 1 base unit — the payment record is at
    // least a few dozen bytes, and MIN_BOX_VALUE_PER_BYTE is 156, so 1n < floor.
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 1_000_000_000n }], height: 5000, era: 1, author: PUB };
    expect(() => buildSend(ctx, RECIPIENT, 1n)).toThrow(BelowFloor);
    try {
      buildSend(ctx, RECIPIENT, 1n);
    } catch (e) {
      expect(e).toBeInstanceOf(BelowFloor);
      expect((e as BelowFloor).which).toBe('payment');
      expect((e as BelowFloor).floor).toBeGreaterThan(MIN_BOX_VALUE_PER_BYTE);
    }
  });

  it('BelowFloor change when the leftover is one base unit', () => {
    // Selecting a 500_000_001 box and sending 500_000_000 leaves a change of 1n.
    const ctx: BuildContext = { spendable: [{ boxId: CREDIT_BOX, value: 500_000_001n }], height: 5000, era: 1, author: PUB };
    expect(() => buildSend(ctx, RECIPIENT, 500_000_000n)).toThrow(BelowFloor);
    try {
      buildSend(ctx, RECIPIENT, 500_000_000n);
    } catch (e) {
      expect(e).toBeInstanceOf(BelowFloor);
      expect((e as BelowFloor).which).toBe('change');
    }
  });
});
