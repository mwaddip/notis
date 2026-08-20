import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  UnreadableStoredBlockError,
  MissingStoredBlockError,
  MissingJournalError,
  CorruptChainStateError,
  failStopIfCorruptChain,
  guardStoreRead,
} from '../../src/services/corrupt-state.js';

// ---------------------------------------------------------------------------
// Boundary pins for the fail-stop registration at each entry (NODE_INTERFACE →
// Relay handlers / Sync handlers).
//
// `process.exit` is stubbed to throw so the test runner survives; the stub
// being reached is the assertion.
// ---------------------------------------------------------------------------

describe('pull-path boundary (setBlocksHandler registration)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a corrupt-state error from handleOrderingBlock fires exit', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Simulate the index.ts registration: handleOrderingBlock throws a family
    // member synchronously (from getOrderingBlock, extendsOurTip, or apply's
    // re-throw), and the registration's try/catch calls failStopIfCorruptChain.
    const fakeHandler = () => {
      throw new UnreadableStoredBlockError('getOrderingBlock', 5, new Error('bad row'));
    };

    // The shape mirrors index.ts: try { return handler() } catch (err) { failStopIfCorruptChain(err) }
    const pullEntry = () => {
      try {
        return fakeHandler();
      } catch (err) {
        failStopIfCorruptChain(err);
      }
    };

    expect(pullEntry).toThrow('process.exit');
  });

  it('a non-family error passes through unchanged', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    const boom = new TypeError('peer garbage');
    const fakeHandler = () => { throw boom; };

    const pullEntry = () => {
      try {
        return fakeHandler();
      } catch (err) {
        failStopIfCorruptChain(err);
      }
    };

    expect(pullEntry).toThrow(boom);
    expect(exit).not.toHaveBeenCalled();
  });

  it('ordinary returns are unchanged: true for held/applied', () => {
    const fakeHandler = () => true;
    const pullEntry = () => {
      try {
        return fakeHandler();
      } catch (err) {
        failStopIfCorruptChain(err);
      }
    };
    expect(pullEntry()).toBe(true);
  });

  it('ordinary returns are unchanged: false for rejected/non-extending', () => {
    const fakeHandler = () => false;
    const pullEntry = () => {
      try {
        return fakeHandler();
      } catch (err) {
        failStopIfCorruptChain(err);
      }
    };
    expect(pullEntry()).toBe(false);
  });
});

describe('provider boundary (setHeadersHandler / blocks routes)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('a family error through the wrapped provider fires exit', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const poison = (_h: number) => {
      throw new UnreadableStoredBlockError('rowToOrderingBlock', 3, new Error('corrupt'));
    };
    const guarded = guardStoreRead(poison);
    expect(() => guarded(3)).toThrow('process.exit');
  });

  it('a non-family error passes through to the caller', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    const boom = new RangeError('out of bounds');
    const guarded = guardStoreRead(() => { throw boom; });
    expect(() => guarded()).toThrow(boom);
    expect(exit).not.toHaveBeenCalled();
  });

  it('blocks route dep receives the guarded read — family error fires exit', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // The property under test is the wrap. The route factory's dep calls
    // `deps.getOrderingBlock(height)`. If that dep is the guarded version, a
    // family error fires exit instead of becoming an Express 500.
    const poison = (h: number) => {
      throw new MissingStoredBlockError('route', h);
    };
    const guardedDep = guardStoreRead(poison);
    expect(() => guardedDep(7)).toThrow('process.exit');
  });
});

describe('MissingJournalError reaches the boundary through resolveFork', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('the class is a family member and fires exit through failStopIfCorruptChain', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new MissingJournalError('revertBlock', 10);
    expect(err).toBeInstanceOf(CorruptChainStateError);
    expect(err.site).toBe('revertBlock');
    expect(err.height).toBe(10);
    expect(() => failStopIfCorruptChain(err)).toThrow('process.exit');
  });
});
