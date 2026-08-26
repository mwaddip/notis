import { describe, it } from 'vitest';

// TODO: retarget — executePrune now takes a UtxoTransaction, not a PruneIntent.
// The intent route builds a transaction; the tests need prune transactions
// with karma inputs, signatures over txId, and block_topology state.

describe('stump-engine (prune transaction rail)', () => {
  it.todo('accepts a well-formed prune transaction');
  it.todo('rejects a transaction whose root is not confirmed in an earlier block');
  it.todo('rejects a transaction whose subtreePostIds does not match topology');
  it.todo('rejects a transaction whose merkle root does not match the id list');
});
