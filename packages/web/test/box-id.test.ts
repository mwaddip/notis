import { describe, it, expect } from 'vitest';
import { decrementBoxId } from '../src/wallet/box-id';

// WEB_INTERFACE → The wallet → "Reconcile runs on the reader's own refresh and
// on the bounded poll below" — a pending send's landing read asks
// `GET /credits/<recipient>?after=<amount>:<the id less one>&limit=1`; the id
// less one is a decrement of the 64 lowercase hex that names a box. The all-zero
// id has none below it, so the entry reads as pending (no request leaves).

describe('decrementBoxId — the 64-hex id one below the one it is handed', () => {
  it('an id ending in 01 decrements to one ending in 00', () => {
    const id = `${'00'.repeat(31)}01`;
    const out = decrementBoxId(id);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(64);
    expect(out).toBe(`${'00'.repeat(31)}00`);
  });

  it('a trailing zero borrows: a nibble value one is zero, the one before it one less', () => {
    // The decrement of ...10 is ...0f (the trailing 0 borrows from the 1).
    const id = `${'00'.repeat(31)}10`;
    const out = decrementBoxId(id);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(64);
    expect(out).toBe(`${'00'.repeat(31)}0f`);
  });

  it('the all-zero id has none below it: the decrement is null', () => {
    const id = '0'.repeat(64);
    const out = decrementBoxId(id);
    expect(out).toBeNull();
  });

  it('a long borrow chain: ...1000 decrements to ...0fff', () => {
    const id = `${'00'.repeat(30)}1000`;
    const out = decrementBoxId(id);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(64);
    expect(out).toBe(`${'00'.repeat(30)}0fff`);
  });
});
