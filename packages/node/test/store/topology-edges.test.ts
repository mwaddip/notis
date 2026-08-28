import { describe, it, expect, beforeEach, afterEach } from 'vitest';

async function importAll() {
  const db = await import('../../src/store/db.js');
  const topology = await import('../../src/store/topology.js');
  return { ...db, ...topology };
}

describe('block_topology_parents edge table', () => {
  let closeDb: () => void;
  let getDb: () => import('better-sqlite3').Database;
  let insertBlockTopology: (postId: string, parentRefs: string[], author: string, blockHeight: number) => void;
  let rollbackBlockTopology: (blockHeight: number) => void;
  let getSubtreeTopology: (rootPostId: string) => Set<string>;

  beforeEach(async () => {
    const mod = await importAll();
    mod.initDb(':memory:');
    closeDb = mod.closeDb;
    getDb = mod.getDb;
    insertBlockTopology = mod.insertBlockTopology;
    rollbackBlockTopology = mod.rollbackBlockTopology;
    getSubtreeTopology = mod.getSubtreeTopology;
  });

  afterEach(() => {
    closeDb();
  });

  it('insertBlockTopology writes one edge per parentRefs entry', () => {
    insertBlockTopology('child', ['root'], 'author1', 1);
    const edges = getDb()
      .prepare('SELECT * FROM block_topology_parents')
      .all() as Array<{ parent_id: string; post_id: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ parent_id: 'root', post_id: 'child' });
  });

  it('rollbackBlockTopology deletes edges with the rows', () => {
    insertBlockTopology('root', [], 'author1', 1);
    insertBlockTopology('child', ['root'], 'author1', 2);
    insertBlockTopology('grandchild', ['child'], 'author1', 2);

    rollbackBlockTopology(2);

    const edges = getDb()
      .prepare('SELECT * FROM block_topology_parents')
      .all() as Array<{ parent_id: string; post_id: string }>;
    expect(edges).toHaveLength(0);

    const rows = getDb()
      .prepare('SELECT * FROM block_topology WHERE block_height = 2')
      .all();
    expect(rows).toHaveLength(0);
  });

  it('getSubtreeTopology returns the same set as before over a fixture tree', () => {
    // root → child1, child2; child1 → grandchild; unrelated stays out
    insertBlockTopology('root', [], 'a', 1);
    insertBlockTopology('child1', ['root'], 'a', 2);
    insertBlockTopology('child2', ['root'], 'a', 2);
    insertBlockTopology('grandchild', ['child1'], 'a', 3);
    insertBlockTopology('unrelated', [], 'b', 3);

    const subtree = getSubtreeTopology('root');
    expect(subtree).toEqual(new Set(['root', 'child1', 'child2', 'grandchild']));
    expect(subtree.has('unrelated')).toBe(false);
  });

  it('the recursive step searches block_topology_parents by parent_id on PK', () => {
    const plan = getDb()
      .prepare(
        `EXPLAIN QUERY PLAN
         WITH RECURSIVE subtree AS (
           SELECT post_id FROM block_topology WHERE post_id = ?
           UNION
           SELECT e.post_id FROM block_topology_parents e
           JOIN subtree s ON e.parent_id = s.post_id
         )
         SELECT post_id FROM subtree`,
      )
      .all('dummy') as Array<{ detail: string }>;
    const details = plan.map(r => r.detail).join('\n');
    expect(details).toContain('SEARCH e USING COVERING INDEX sqlite_autoindex_block_topology_parents_1 (parent_id=?)');
  });
});
