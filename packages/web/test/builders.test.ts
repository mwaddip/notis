import { describe, it, expect } from 'vitest';
import {
  buildPost,
  buildLike,
  buildVouch,
  buildUnvouch,
  buildInvite,
  buildWithdraw,
  txToJson,
  InsufficientKarma,
  type BuildContext,
} from '../src/wallet/builders';
import { VOUCH_KARMA_AMOUNT, type UtxoTransaction } from '@dagsocial/types';

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

const THREAD_TXID = 'c44b433f6a46671d9dc3977fd85fb9ddbad951c9dfc17e39e07a017e4c3b8197';
const THREAD_CHANGE = 'ca865902ed1a20c9ad69b3fbe54c770ac9f54c7f02e4d8188ae2cc0702d80eec';
const REPLY_TXID = '367d003c4e7480f96481ccf36b7a984b6c5b18240d1c2722f47b0b947ca5065f';
const REPLY_CHANGE = '65326b56c014d1f40933ebcf1d071a253eabe341a25eee07b51fe430a143eeff';
const LIKE_TXID = '7ccf15c3b930fa33eb8558e594f2c192cede855c6e558a896313f03ac1f6639c';
const LIKE_CHANGE = '24e438a4227fc1a99fdff98cd6942907c614c1bf200f7a7316c7c52b8e337281';
const THREAD_CONTENT_HASH = '8bc41f00d29d7adc055bc479bf21e13473a34426470b92aa675c6f83eba2429f';

// The membership vectors, frozen the same way — txIds over fixed inputs: height
// 5000, era 1, one spendable box of 227 ('cc'*32), author 'aa'*32, over a vouch
// target '11'*32, an invitee '22'*32 with a bond of 100, and an unvouch of a
// vouch box '33'*32 (stake 1, cast at 4990, cooldown 60 → release 5050).
const VOUCH_TARGET = '11'.repeat(32);
const INVITEE = '22'.repeat(32);
const VOUCH_BOX = '33'.repeat(32);
const VOUCH_TXID = '6b5e1ba32c2bfe23b6db0db940fbadf1166ff2a5cbd472d1a2017934149e3e50';
const VOUCH_CHANGE = '80626928e3ad938060005951abb752273d45ab6965f7593c955b20670723cf45';
const INVITE_TXID = '764853c48611aa6d2a6d568d59a048af5a251d0e60caa80b22846e7215437d30';
const INVITE_CHANGE = '2e1beb54dd3028bd7acace8edafaea4bef9ab23b2f89890c9ae20619963c3a1d';
const UNVOUCH_TXID = '5988584f619b498ca161e9d7739c975370bb75ea0c6ce6d3c87ac7efcfd11f6b';

// The withdraw vector, frozen the same way — txId and output id over fixed
// inputs: height 5000, era 1, one spendable box of 227 ('cc'*32), author
// 'aa'*32, over a post id 'ff'*32.
const WITHDRAW_POST_ID = 'ff'.repeat(32);
const WITHDRAW_TXID = '1ee0e7e76e1d2c03414a37135b7d08930bfe7d477b4504379978f2cbf6bacf89';
const WITHDRAW_OUTPUT = '0aa7e4a5c67536ccee34946d3276bd2631752a5df5eddca32115e9ab44cd4658';

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

const ctx = (): BuildContext => ({ spendable: [{ boxId: BOX_ID, value: 227n }], height: 5000, era: 1, author: PUB });

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

  it('selection sorts value-descending before selectBoxes', () => {
    const spendable = [
      { boxId: 'a'.repeat(64), value: 3n },
      { boxId: 'b'.repeat(64), value: 10n },
      { boxId: 'c'.repeat(64), value: 1n },
    ];
    // Price 5 is covered by the single largest box; the others are untouched.
    const built = buildPost({ ...ctx(), spendable }, 'x');
    expect(built.tx.inputs).toEqual(['b'.repeat(64)]);
    expect(built.change!.value).toBe(5n);
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
  it('spends the smallest box when the view holds several', () => {
    const spendable = [
      { boxId: 'a'.repeat(64), value: 10n },
      { boxId: 'b'.repeat(64), value: 3n },
      { boxId: 'c'.repeat(64), value: 7n },
    ];
    const built = buildWithdraw({ ...ctx(), spendable }, WITHDRAW_POST_ID);
    expect(built.tx.inputs).toEqual(['b'.repeat(64)]);
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
});
