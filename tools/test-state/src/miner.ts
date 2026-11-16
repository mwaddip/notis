// TEST_STATE_INTERFACE → Blocks during a run. One miner per stack, driving
// one node through `GET /mining/template` and `POST /mining/submit`. The
// miner names no payout key, so every block pays A's own key as a template
// does without `?miner=` (MINING_INTERFACE → GET /mining/template). The PoW
// predicate is imported from `@dagsocial/validation` — the admission rule
// and never a copy of it.
import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { orderingPowTarget, meetsPowTarget } from '@dagsocial/validation';

export interface MinerConfig {
  readonly nodeApiUrl: string; // `http://127.0.0.1:XXXX` (no trailing slash)
  readonly miningSecret: string; // Bearer secret the node enforces
  readonly intervalMs: number; // the steady cadence
  readonly controlPort: number; // 0 for an OS-assigned port
  readonly controlHost?: string; // '127.0.0.1' default
  readonly pollIntervalMs?: number; // between 404 retries (default 100)
  readonly templateDeadlineMs?: number; // deadline for a 404 poll (default 60 s)
}

export interface MinerHandle {
  readonly controlPort: number;
  stop(): Promise<void>;
  readonly joined: Promise<void>;
}

interface TemplateResponse {
  readonly header: { readonly height: number; readonly powTargetBits: number };
  readonly powPreimage: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function solve(powPreimageHex: string, powTargetBits: number): number | null {
  const target = orderingPowTarget(powTargetBits);
  if (!target) return null;
  const preimage = Buffer.from(powPreimageHex, 'hex');
  const nonceBuf = Buffer.alloc(8);
  for (let nonce = 0; nonce < 10_000_000; nonce++) {
    nonceBuf.writeBigUInt64LE(BigInt(nonce));
    const hash = createHash('blake2b512')
      .update(preimage)
      .update(nonceBuf)
      .digest()
      .subarray(0, 32);
    if (meetsPowTarget(hash, target)) return nonce;
  }
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? null : JSON.parse(raw);
}

export async function runMiner(cfg: MinerConfig): Promise<MinerHandle> {
  const pollMs = cfg.pollIntervalMs ?? 100;
  const templateDeadlineMs = cfg.templateDeadlineMs ?? 60_000;
  const controlHost = cfg.controlHost ?? '127.0.0.1';

  let shuttingDown = false;
  let mineToTarget: number | null = null;
  let mineToResolve: ((h: number) => void) | null = null;
  let server: Server | null = null;

  const notifyMineToDone = (reached: number): void => {
    if (mineToResolve) {
      mineToResolve(reached);
      mineToResolve = null;
    }
    mineToTarget = null;
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.miningSecret}`,
  };

  async function fetchTemplate(): Promise<TemplateResponse | 'not-ready'> {
    const u = `${cfg.nodeApiUrl}/mining/template`;
    const res = await fetch(u, { headers });
    if (res.status === 404) return 'not-ready';
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /mining/template returned ${res.status}: ${body}`);
    }
    return (await res.json()) as TemplateResponse;
  }

  async function waitForTemplate(): Promise<TemplateResponse> {
    const deadline = Date.now() + templateDeadlineMs;
    while (!shuttingDown) {
      const r = await fetchTemplate();
      if (r !== 'not-ready') return r;
      if (Date.now() >= deadline) {
        throw new Error(
          `No template after ${templateDeadlineMs} ms of 404 polling`,
        );
      }
      await sleep(pollMs);
    }
    throw new Error('miner shut down while polling for a template');
  }

  async function mineOne(): Promise<number> {
    const tpl = await waitForTemplate();
    const nonce = solve(tpl.powPreimage, tpl.header.powTargetBits);
    if (nonce === null) {
      throw new Error(`failed to solve PoW at height ${tpl.header.height}`);
    }
    const res = await fetch(`${cfg.nodeApiUrl}/mining/submit`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ powNonce: nonce, height: tpl.header.height }),
    });
    if (res.status !== 201) {
      const body = await res.text();
      throw new Error(
        `POST /mining/submit returned ${res.status} at height ${tpl.header.height}: ${body}`,
      );
    }
    return tpl.header.height;
  }

  async function tipHeight(): Promise<number> {
    const res = await fetch(`${cfg.nodeApiUrl}/blocks/current`);
    if (!res.ok) {
      throw new Error(`GET /blocks/current returned ${res.status}`);
    }
    const data = (await res.json()) as { height: number };
    return data.height;
  }

  // The loop: one block per interval, mine-to on demand. After a mine-to the
  // cadence resumes from the moment it ended, so a caller cannot chain
  // mine-to requests into a burst.
  async function loop(): Promise<void> {
    let nextCadenceAt = Date.now() + cfg.intervalMs;
    while (!shuttingDown) {
      if (mineToTarget !== null) {
        const tip = await tipHeight();
        if (tip >= mineToTarget) {
          notifyMineToDone(tip);
          nextCadenceAt = Date.now() + cfg.intervalMs;
          continue;
        }
        await mineOne();
        continue;
      }
      const now = Date.now();
      if (now < nextCadenceAt) {
        await sleep(Math.min(50, nextCadenceAt - now));
        continue;
      }
      await mineOne();
      nextCadenceAt = Date.now() + cfg.intervalMs;
    }
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === 'POST' && req.url === '/mine-to') {
      void (async () => {
        try {
          const body = (await readJsonBody(req)) as { height?: number } | null;
          const height = body?.height;
          if (typeof height !== 'number' || height < 1) {
            res.statusCode = 400;
            res.end('{"error":"height required (positive integer)"}');
            return;
          }
          if (shuttingDown) {
            res.statusCode = 503;
            res.end('{"error":"miner shutting down"}');
            return;
          }
          // Only one mine-to at a time; a new target overrides the pending one.
          if (mineToResolve !== null) {
            mineToResolve(-1);
            mineToResolve = null;
          }
          mineToTarget = height;
          const reached = await new Promise<number>((resolve) => {
            mineToResolve = resolve;
          });
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify({ height: reached }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  };

  server = createServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(cfg.controlPort, controlHost, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('control server bound address not readable');
  }
  const controlPort = bound.port;

  // Register SIGTERM before printing the ready line — a caller that signals
  // the miner as soon as it reads the line must find the handler installed.
  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (mineToResolve !== null) {
      mineToResolve(-1);
      mineToResolve = null;
    }
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
  };
  const onSigterm = (): void => {
    void stop();
  };
  process.on('SIGTERM', onSigterm);

  process.stdout.write(
    JSON.stringify({
      event: 'miner_ready',
      controlPort,
    }) + '\n',
  );

  const joined = loop().finally(() => {
    process.off('SIGTERM', onSigterm);
  });

  return {
    controlPort,
    stop,
    joined,
  };
}
