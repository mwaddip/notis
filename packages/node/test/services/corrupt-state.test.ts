import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  UnhashableStoredHeaderError,
  MissingStoredBlockError,
  MissingJournalError,
  MissingStateVersionError,
  CorruptChainStateError,
  failStopIfCorruptChain,
  guardStoreRead,
} from '../../src/services/corrupt-state.js';

// ---------------------------------------------------------------------------
// The boundary's own contract.
//
// Four paths reach `applyOrderingBlock` — gossip, sync, reorg and our own block
// creator — and each delegates its corrupt-state decision to this one function.
// Pinning it here is what lets those four be a one-line `catch` apiece: what is
// left to read at each site is *whether* it delegates, not *what* it decides.
//
// `process.exit` is stubbed to throw, because a real one would take the test
// runner with it. That the stub is reached at all is the assertion.
// ---------------------------------------------------------------------------

describe('failStopIfCorruptChain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the site and height, then stops the node', () => {
    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });

    expect(() =>
      failStopIfCorruptChain(new UnhashableStoredHeaderError('findForkPoint', 42)),
    ).toThrow('process.exit');

    expect(exited).toEqual([1]);
    expect(errors).toHaveLength(1);
    // Diagnostic first: both fields, from the error's own properties rather
    // than from parsing its message.
    expect(errors[0]).toContain('findForkPoint');
    expect(errors[0]).toContain('42');
  });

  it('re-throws anything else unchanged, and does not stop the node', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The boundary adds a decision; it is not a catch-all. An unrelated failure
    // has to come out the far side with its identity intact, or every error on
    // these four paths quietly changes shape by passing through here.
    const other = new TypeError('unrelated');
    expect(() => failStopIfCorruptChain(other)).toThrow(other);
    expect(exit).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('carries site and height as fields, not only in the message', () => {
    const err = new UnhashableStoredHeaderError('applyOrderingBlock', 7);
    expect(err.site).toBe('applyOrderingBlock');
    expect(err.height).toBe(7);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UnhashableStoredHeaderError');
  });

  it('stops for a missing block too, and keeps the two kinds distinguishable', () => {
    const missing = new MissingStoredBlockError('fork resolution', 9);
    expect(missing.site).toBe('fork resolution');
    expect(missing.height).toBe(9);
    expect(missing.name).toBe('MissingStoredBlockError');

    // Both are corrupt state, and the boundary is keyed on that rather than on
    // the specific fault — a third kind must not need a boundary edit to be
    // fatal. But they stay separate types, because "the header will not encode"
    // and "the row is gone" are different diagnoses.
    expect(missing).toBeInstanceOf(CorruptChainStateError);
    expect(new UnhashableStoredHeaderError('x', 1)).toBeInstanceOf(CorruptChainStateError);
    expect(missing).not.toBeInstanceOf(UnhashableStoredHeaderError);

    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });

    expect(() => failStopIfCorruptChain(missing)).toThrow('process.exit');
    expect(exited).toEqual([1]);
    expect(errors[0]).toContain('fork resolution');
    expect(errors[0]).toContain('not contiguous');
  });

  it('a third kind must not need a boundary edit to be fatal — journal and version', () => {
    const journal = new MissingJournalError('revertBlock', 5);
    expect(journal.site).toBe('revertBlock');
    expect(journal.height).toBe(5);
    expect(journal.name).toBe('MissingJournalError');
    expect(journal).toBeInstanceOf(CorruptChainStateError);

    const version = new MissingStateVersionError('reorg', 0);
    expect(version.site).toBe('reorg');
    expect(version.height).toBe(0);
    expect(version.name).toBe('MissingStateVersionError');
    expect(version).toBeInstanceOf(CorruptChainStateError);

    // All six members are fatal through the same boundary, keyed on the base
    // class. No boundary edit required for these two.
    const exited: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited.push(code ?? 0);
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => failStopIfCorruptChain(journal)).toThrow('process.exit');
    expect(() => failStopIfCorruptChain(version)).toThrow('process.exit');
    expect(exited).toEqual([1, 1]);
  });

  it('guardStoreRead wraps a family error into a fail-stop', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const poison = (h: number) => {
      throw new MissingStoredBlockError('test', h);
    };
    const guarded = guardStoreRead(poison);
    expect(() => guarded(3)).toThrow('process.exit');
  });

  it('guardStoreRead passes non-family errors through unchanged', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    const boom = new TypeError('unrelated');
    const guarded = guardStoreRead(() => { throw boom; });
    expect(() => guarded()).toThrow(boom);
    expect(exit).not.toHaveBeenCalled();
  });

  it('guardStoreRead returns the original value on a clean read', () => {
    const guarded = guardStoreRead((x: number) => x * 2);
    expect(guarded(5)).toBe(10);
  });
});
