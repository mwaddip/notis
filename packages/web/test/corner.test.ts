// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { cornerState, cornerTitle, renderCorner, CORNER_STALE_MS } from '../src/view/corner';
import type { TipVerdict } from '../src/model/tip-verdict';

describe('cornerState — the dot from the client\'s own reads', () => {
  it('no read yet → none', () => {
    expect(cornerState({ lastTip: null, lastRiseAt: null, lastReadOk: null, now: 0 })).toBe('none');
  });

  it('the last read failed → down, even if a prior read had risen', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: false, now: 1000 })).toBe('down');
  });

  it('rose inside the ten-minute window → fresh', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS })).toBe('fresh');
  });

  it('rose exactly at the ten-minute edge → still fresh', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS })).toBe('fresh');
  });

  it('no rise for longer than the window → stale', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS + 1 })).toBe('stale');
  });

  it('answered but never rose → stale', () => {
    expect(cornerState({ lastTip: 100, lastRiseAt: null, lastReadOk: true, now: 60_000 })).toBe('stale');
  });
});

describe('cornerTitle — the words the corner reads to a reader', () => {
  it('fresh names the tip', () => {
    expect(cornerTitle('fresh', 2295)).toBe('blocks progressing · tip 2295');
  });
  it('stale names ten minutes and the tip', () => {
    expect(cornerTitle('stale', 2295)).toBe('no new block for 10 minutes · tip 2295');
  });
  it('down names the last tip when one exists', () => {
    expect(cornerTitle('down', 2295)).toBe('the node did not answer · last tip 2295');
  });
  it('down without a last tip stays short', () => {
    expect(cornerTitle('down', null)).toBe('the node did not answer');
  });
  it('none says no tip yet', () => {
    expect(cornerTitle('none', null)).toBe('no tip yet');
  });
});

describe('renderCorner — the button holds a dot and a height', () => {
  it('renders a button.corner with a led carrying the state class and a mono tip', () => {
    const host = document.createElement('button');
    renderCorner(host, 'fresh', 2295);
    expect(host.className).toBe('corner');
    const led = host.querySelector('.led');
    const tip = host.querySelector('.tip');
    expect(led).not.toBeNull();
    expect(led!.classList.contains('fresh')).toBe(true);
    expect(tip).not.toBeNull();
    expect(tip!.classList.contains('mono')).toBe(true);
    expect(tip!.textContent).toBe('2295');
  });

  it('sets aria-label and the title from cornerTitle', () => {
    const host = document.createElement('button');
    renderCorner(host, 'stale', 2295);
    expect(host.getAttribute('aria-label')).toBe('chain status');
    expect(host.getAttribute('title')).toBe('no new block for 10 minutes · tip 2295');
  });

  it('renders — for a null tip', () => {
    const host = document.createElement('button');
    renderCorner(host, 'none', null);
    expect(host.querySelector('.tip')!.textContent).toBe('—');
    expect(host.querySelector('.led')!.classList.contains('none')).toBe(true);
  });

  it('a second call replaces the previous contents in place', () => {
    const host = document.createElement('button');
    renderCorner(host, 'none', null);
    renderCorner(host, 'fresh', 42);
    expect(host.querySelectorAll('.led').length).toBe(1);
    expect(host.querySelectorAll('.tip').length).toBe(1);
    expect(host.querySelector('.led')!.classList.contains('fresh')).toBe(true);
    expect(host.querySelector('.tip')!.textContent).toBe('42');
  });

  it('re-render across every state changes only the led class and the tip text', () => {
    const host = document.createElement('button');
    for (const [s, t] of [['fresh', 1], ['stale', 2], ['down', 3], ['none', null]] as const) {
      renderCorner(host, s, t);
      expect(host.querySelector('.led')!.classList.contains(s)).toBe(true);
      expect(host.querySelector('.tip')!.textContent).toBe(t === null ? '—' : String(t));
    }
  });
});

// The verified-tip rule (WEB_INTERFACE → The status corner, → The extension →
// "The verified tip"): a build with no verifier keeps the first paragraph of
// the status corner word for word; a build with a verifier folds the verdict
// in beside the read. The order — a failed read · no read yet · refused · not
// returned · thin · stale · fresh — is pinned here.

const RISE = { lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: 60_000 } as const;
const NO_RISE = { lastTip: 100, lastRiseAt: 0, lastReadOk: true, now: CORNER_STALE_MS + 1 } as const;
const FAILED = { lastTip: 100, lastRiseAt: 0, lastReadOk: false, now: 1 } as const;
const NEVER = { lastTip: null, lastRiseAt: null, lastReadOk: null, now: 1 } as const;

const VERIFIED: TipVerdict = { kind: 'verified', nodes: 2, height: 7766 };
const THIN_ONE: TipVerdict = { kind: 'thin', reason: 'one-node', height: 7766 };
const THIN_SHORT: TipVerdict = { kind: 'thin', reason: 'too-short', height: 12 };
const THIN_NO: TipVerdict = { kind: 'thin', reason: 'no-proof', height: 7766 };
const THIN_SPLIT: TipVerdict = { kind: 'thin', reason: 'split', height: 7766 };
const REFUSED_INVALID: TipVerdict = { kind: 'refused', reason: 'invalid-proof', by: null, height: 7766 };
const REFUSED_OUTWORKED: TipVerdict = {
  kind: 'refused', reason: 'outworked',
  by: 'https://node02.notis.fun/testnet/api', height: 7766,
};

describe('cornerState — verdict: undefined reproduces the first paragraph\'s four states', () => {
  it('rise inside the window → fresh', () => {
    expect(cornerState({ ...RISE, verdict: undefined })).toBe('fresh');
  });
  it('no rise for longer → stale', () => {
    expect(cornerState({ ...NO_RISE, verdict: undefined })).toBe('stale');
  });
  it('the last read failed → down', () => {
    expect(cornerState({ ...FAILED, verdict: undefined })).toBe('down');
  });
  it('no read yet → none', () => {
    expect(cornerState({ ...NEVER, verdict: undefined })).toBe('none');
  });
});

describe('cornerState — verdict folds in, first row that holds', () => {
  it('a failed read outranks a verdict — down even under refused', () => {
    expect(cornerState({ ...FAILED, verdict: REFUSED_INVALID })).toBe('down');
    expect(cornerState({ ...FAILED, verdict: VERIFIED })).toBe('down');
    expect(cornerState({ ...FAILED, verdict: THIN_ONE })).toBe('down');
    expect(cornerState({ ...FAILED, verdict: null })).toBe('down');
  });
  it('no read yet outranks a verdict — none even under refused', () => {
    expect(cornerState({ ...NEVER, verdict: REFUSED_INVALID })).toBe('none');
    expect(cornerState({ ...NEVER, verdict: null })).toBe('none');
  });
  it('refused outranks checking, thin and the stale/fresh cases', () => {
    expect(cornerState({ ...RISE, verdict: REFUSED_INVALID })).toBe('refused');
    expect(cornerState({ ...RISE, verdict: REFUSED_OUTWORKED })).toBe('refused');
    expect(cornerState({ ...NO_RISE, verdict: REFUSED_INVALID })).toBe('refused');
  });
  it('verdict null after an answering read → checking', () => {
    expect(cornerState({ ...RISE, verdict: null })).toBe('checking');
    expect(cornerState({ ...NO_RISE, verdict: null })).toBe('checking');
  });
  it('a thin verdict → thin (any reason)', () => {
    expect(cornerState({ ...RISE, verdict: THIN_ONE })).toBe('thin');
    expect(cornerState({ ...RISE, verdict: THIN_SHORT })).toBe('thin');
    expect(cornerState({ ...RISE, verdict: THIN_NO })).toBe('thin');
    expect(cornerState({ ...RISE, verdict: THIN_SPLIT })).toBe('thin');
    expect(cornerState({ ...NO_RISE, verdict: THIN_ONE })).toBe('thin');
  });
  it('verified verdict + rise → fresh; verified verdict + no rise → stale', () => {
    expect(cornerState({ ...RISE, verdict: VERIFIED })).toBe('fresh');
    expect(cornerState({ ...NO_RISE, verdict: VERIFIED })).toBe('stale');
  });
});

describe('cornerTitle — verdict-aware titles, word for word', () => {
  it('verdict: undefined keeps the first paragraph\'s four titles exactly', () => {
    expect(cornerTitle('fresh', 2295)).toBe('blocks progressing · tip 2295');
    expect(cornerTitle('stale', 2295)).toBe('no new block for 10 minutes · tip 2295');
    expect(cornerTitle('down', 2295)).toBe('the node did not answer · last tip 2295');
    expect(cornerTitle('down', null)).toBe('the node did not answer');
    expect(cornerTitle('none', null)).toBe('no tip yet');
  });
  it('fresh under a verified verdict names the count', () => {
    expect(cornerTitle('fresh', 7766, VERIFIED)).toBe('verified across 2 nodes · tip 7766');
  });
  it('stale keeps the first paragraph\'s wording even when a verified verdict holds', () => {
    expect(cornerTitle('stale', 7766, VERIFIED)).toBe('no new block for 10 minutes · tip 7766');
  });
  it('checking says checking the chain', () => {
    expect(cornerTitle('checking', 7766)).toBe('checking the chain · tip 7766');
  });
  it('thin has one wording per reason', () => {
    expect(cornerTitle('thin', 7766, THIN_ONE)).toBe('only one node could be checked · tip 7766');
    expect(cornerTitle('thin', 12, THIN_SHORT)).toBe('the chain is too short to check yet · tip 12');
    expect(cornerTitle('thin', 7766, THIN_NO)).toBe('this node served no proof · tip 7766');
    expect(cornerTitle('thin', 7766, THIN_SPLIT)).toBe('the nodes share no block to compare · tip 7766');
  });
  it('refused invalid-proof: this node\'s proof did not verify', () => {
    expect(cornerTitle('refused', 7766, REFUSED_INVALID)).toBe("this node's proof did not verify · tip 7766");
  });
  it('refused outworked names the winner\'s host, never the URL', () => {
    expect(cornerTitle('refused', 7766, REFUSED_OUTWORKED))
      .toBe('node02.notis.fun holds more work than this node · tip 7766');
  });
  it('refused outworked with an unparsable by reads another node', () => {
    const v: TipVerdict = { kind: 'refused', reason: 'outworked', by: 'not a url', height: 7766 };
    expect(cornerTitle('refused', 7766, v)).toBe('another node holds more work than this node · tip 7766');
  });
  it('refused outworked with by: null reads another node', () => {
    const v: TipVerdict = { kind: 'refused', reason: 'outworked', by: null, height: 7766 };
    expect(cornerTitle('refused', 7766, v)).toBe('another node holds more work than this node · tip 7766');
  });
  it('a null tip reads as — in every verdict-aware title', () => {
    expect(cornerTitle('checking', null)).toBe('checking the chain · tip —');
    expect(cornerTitle('thin', null, THIN_ONE)).toBe('only one node could be checked · tip —');
    expect(cornerTitle('refused', null, REFUSED_INVALID)).toBe("this node's proof did not verify · tip —");
  });
});

describe('renderCorner — the tip\'s weight rides its own span', () => {
  it('a refused verdict adds clay to the tip span, and nothing else does', () => {
    const host = document.createElement('button');
    renderCorner(host, 'refused', 7766, REFUSED_INVALID);
    expect(host.querySelector('.tip')!.classList.contains('clay')).toBe(true);
    expect(host.querySelector('.led')!.classList.contains('refused')).toBe(true);
    // Every other state keeps the tip muted (no clay class).
    for (const s of ['fresh', 'stale', 'down', 'none', 'checking', 'thin'] as const) {
      renderCorner(host, s, 42);
      expect(host.querySelector('.tip')!.classList.contains('clay')).toBe(false);
      expect(host.querySelector('.led')!.classList.contains(s)).toBe(true);
    }
  });
  it('a re-render clears clay from the tip when the state leaves refused', () => {
    const host = document.createElement('button');
    renderCorner(host, 'refused', 7766, REFUSED_INVALID);
    expect(host.querySelector('.tip')!.classList.contains('clay')).toBe(true);
    renderCorner(host, 'fresh', 7767, VERIFIED);
    expect(host.querySelector('.tip')!.classList.contains('clay')).toBe(false);
  });
  it('the verdict-aware title is written onto the host', () => {
    const host = document.createElement('button');
    renderCorner(host, 'refused', 7766, REFUSED_OUTWORKED);
    expect(host.getAttribute('title')).toBe('node02.notis.fun holds more work than this node · tip 7766');
    renderCorner(host, 'checking', 7766);
    expect(host.getAttribute('title')).toBe('checking the chain · tip 7766');
    renderCorner(host, 'thin', 7766, THIN_ONE);
    expect(host.getAttribute('title')).toBe('only one node could be checked · tip 7766');
  });
});
