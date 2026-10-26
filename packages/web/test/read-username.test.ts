import { describe, it, expect } from 'vitest';
import { readUsername } from '../src/api/readers';

// WEB_INTERFACE → Reading a node's answer → "Every answer is rebuilt from its
// own fields": an owner and a box id are 64 lowercase hex, and an id spelled
// in the other case is not the node's answer (NODE_INTERFACE → HTTP API →
// "Hex is lowercase").

const OWNER = 'ab'.repeat(32);
const BOX = 'cd'.repeat(32);

describe('readUsername holds the owner and the box id to lowercase hex', () => {
  it('rebuilds a name held by a lowercase owner in a lowercase box', () => {
    expect(readUsername({ name: 'Kay', owner: OWNER, boxId: BOX, claimedAtBlock: 3 })).toEqual({
      name: 'Kay', owner: OWNER, boxId: BOX, claimedAtBlock: 3,
    });
  });

  it('refuses an owner spelled in uppercase', () => {
    expect(readUsername({ name: 'Kay', owner: OWNER.toUpperCase(), boxId: BOX, claimedAtBlock: 3 })).toBeNull();
  });

  it('refuses a box id spelled in uppercase', () => {
    expect(readUsername({ name: 'Kay', owner: OWNER, boxId: BOX.toUpperCase(), claimedAtBlock: 3 })).toBeNull();
  });

  it('refuses an owner of 63 characters', () => {
    expect(readUsername({ name: 'Kay', owner: OWNER.slice(1), boxId: BOX, claimedAtBlock: 3 })).toBeNull();
  });
});
