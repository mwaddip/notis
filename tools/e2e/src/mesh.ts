import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnNode, waitForStatus, type NodeProcess } from './node-process.js';
import { p2pPort } from './ports.js';
import { assertDistFresh } from './dist-freshness.js';

export interface MeshOptions {
  fileIndex: number;
  nodeCount: number;
}

export interface Mesh {
  nodes: NodeProcess[];
  miningSecret: string;
  addNode(bootstrapPeers?: string[]): Promise<NodeProcess>;
  teardown(): Promise<void>;
}

export async function createMesh(opts: MeshOptions): Promise<Mesh> {
  assertDistFresh();

  const miningSecret = randomBytes(32).toString('hex');
  const runDir = mkdtempSync(join(tmpdir(), 'dagsocial-e2e-'));
  const nodes: NodeProcess[] = [];
  let nextIndex = 0;

  const bootstrapP2p = p2pPort(opts.fileIndex, 0);
  const bootstrapAddr = `/ip4/127.0.0.1/tcp/${bootstrapP2p}`;

  try {
    for (let i = 0; i < opts.nodeCount; i++) {
      const node = spawnNode({
        fileIndex: opts.fileIndex,
        nodeIndex: nextIndex,
        dbPath: join(runDir, `node-${nextIndex}.db`),
        miningSecret,
        bootstrapPeers: nextIndex === 0 ? '' : bootstrapAddr,
      });
      nodes.push(node);
      nextIndex++;
      await waitForStatus(node);
    }
  } catch (err) {
    for (const n of nodes) n.kill();
    await awaitAllExits(nodes);
    rmSync(runDir, { recursive: true, force: true });
    throw err;
  }

  async function addNode(bootstrapPeers?: string[]): Promise<NodeProcess> {
    const idx = nextIndex++;
    const peers = bootstrapPeers ?? [bootstrapAddr];
    const node = spawnNode({
      fileIndex: opts.fileIndex,
      nodeIndex: idx,
      dbPath: join(runDir, `node-${idx}.db`),
      miningSecret,
      bootstrapPeers: peers.join(','),
    });
    nodes.push(node);
    await waitForStatus(node);
    return node;
  }

  async function teardown(): Promise<void> {
    for (const n of nodes) n.kill();
    await awaitAllExits(nodes);
    rmSync(runDir, { recursive: true, force: true });
  }

  return { nodes, miningSecret, addNode, teardown };
}

async function awaitAllExits(nodes: NodeProcess[]): Promise<void> {
  await Promise.all(
    nodes.map(
      (n) =>
        new Promise<void>((r) => {
          if (n.child.exitCode !== null) {
            r();
          } else {
            n.child.on('exit', () => r());
          }
        }),
    ),
  );
}
