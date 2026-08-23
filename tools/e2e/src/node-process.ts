import { spawn, type ChildProcess } from 'child_process';
import { resolve } from 'path';
import { httpPort, adminPort, p2pPort } from './ports.js';

const NODE_ENTRY = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'node',
  'dist',
  'index.js',
);

export interface NodeProcessOptions {
  fileIndex: number;
  nodeIndex: number;
  dbPath: string;
  miningSecret: string;
  bootstrapPeers: string;
  env?: Record<string, string>;
}

export interface NodeProcess {
  child: ChildProcess;
  httpPort: number;
  adminPort: number;
  p2pPort: number;
  url: string;
  logs: string[];
  linesSeen: number;
  linesSince(n: number): string[];
  kill(): void;
}

const LOG_RING_SIZE = 200;

export function spawnNode(opts: NodeProcessOptions): NodeProcess {
  const http = httpPort(opts.fileIndex, opts.nodeIndex);
  const admin = adminPort(opts.fileIndex, opts.nodeIndex);
  const p2p = p2pPort(opts.fileIndex, opts.nodeIndex);

  const child = spawn(process.execPath, [NODE_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NETWORK_TYPE: 'devnet',
      NODE_ROLE: 'miner',
      PORT: String(http),
      ADMIN_PORT: String(admin),
      DB_PATH: opts.dbPath,
      MINING_SECRET: opts.miningSecret,
      LISTEN_ADDRS: `/ip4/127.0.0.1/tcp/${p2p}`,
      BOOTSTRAP_PEERS: opts.bootstrapPeers,
      ...opts.env,
    },
  });

  const logs: string[] = [];
  let linesSeen = 0;
  let partial = '';

  function onData(chunk: Buffer): void {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop()!;
    for (const line of lines) {
      if (line.length === 0) continue;
      logs.push(line);
      linesSeen++;
      if (logs.length > LOG_RING_SIZE) logs.shift();
    }
  }

  function linesSince(n: number): string[] {
    const available = linesSeen - n;
    if (available <= 0) return [];
    return logs.slice(-Math.min(available, logs.length));
  }

  child.stdout!.on('data', onData);
  child.stderr!.on('data', onData);

  return {
    child,
    httpPort: http,
    adminPort: admin,
    p2pPort: p2p,
    url: `http://127.0.0.1:${http}`,
    logs,
    get linesSeen() {
      return linesSeen;
    },
    linesSince,
    kill() {
      child.kill('SIGTERM');
    },
  };
}

export async function waitForStatus(node: NodeProcess, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `${node.url}/status`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = node.logs.slice(-20).join('\n');
  throw new Error(`Node on :${node.httpPort} never answered /status within ${timeoutMs}ms\n${tail}`);
}
