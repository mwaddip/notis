// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { card } from '../src/view/card';
import type { PostJson } from '../src/api/dto';
import type { Flight } from '../src/view/card';
import { contentHashHex } from '../src/integrity';

// The stage line's copy — two stages then one of three endings. The endings say
// what happened, never a status code (HOUSE_STYLE → Voice).

const PUB = 'aa'.repeat(32);
function pending(content: string): PostJson {
  return {
    id: 'local1', content, contentHash: contentHashHex(content), author: PUB, parentRefs: [],
    protocolVersion: 0, type: 'regular', status: 'pending', blockHeight: null, blockIndex: null,
    blockCreatedAt: null, likeCount: 0, likedByViewer: null,
  };
}
const stageText = (flight: Flight): string => card(pending('x'), { flight }).querySelector('.stage')?.textContent ?? '';

function confirmed(author: string): PostJson {
  return {
    id: 'p1', content: 'hello', contentHash: contentHashHex('hello'), author, parentRefs: [],
    protocolVersion: 1, type: 'regular', status: 'confirmed', blockHeight: 6001, blockIndex: 0,
    blockCreatedAt: 0, likeCount: 0, likedByViewer: null,
  };
}

describe('card — the stage line', () => {
  it('reads submitting…, then submitted', () => {
    expect(stageText({ stage: 'submitting' })).toContain('submitting');
    expect(stageText({ stage: 'submitted' })).toBe('submitted');
  });

  it('an expired card reads "by height N" — the entry is eligible at N, purged once the tip passes it', () => {
    const onTryAgain = vi.fn();
    const c = card(pending('x'), { flight: { stage: 'expired', expiresAtHeight: 6335, onTryAgain } });
    const text = c.querySelector('.stage')!.textContent!;
    expect(text).toContain('no block took this by height');
    expect(text).not.toContain('before height');
    expect(text).toContain('6,335');
    [...c.querySelectorAll('button')].find((b) => b.textContent === 'try again')!.click();
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });

  it('a rejected card reads the node reason, never a status code', () => {
    expect(stageText({ stage: 'rejected', reason: 'the node is full right now.' })).toBe('the node is full right now.');
  });
});

describe('card — · you', () => {
  it('marks the reader\'s own card with · you after the prefix, and no other', () => {
    const own = card(confirmed(PUB), { you: true });
    expect(own.querySelector('.you')?.textContent).toBe('· you');
    expect(card(confirmed('bb'.repeat(32)), { you: false }).querySelector('.you')).toBeNull();
    expect(card(confirmed(PUB)).querySelector('.you')).toBeNull(); // no opt → no mark
  });
});
