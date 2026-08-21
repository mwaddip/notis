import { createHash } from 'crypto';
import { orderingPowTarget, meetsPowTarget } from '@dagsocial/validation';
import type { NodeProcess } from './node-process.js';

interface TemplateResponse {
  header: {
    height: number;
    powTargetBits: number;
  };
  powPreimage: string;
}

function solve(powPreimageHex: string, powTargetBits: number): number | null {
  const target = orderingPowTarget(powTargetBits);
  if (!target) return null;
  const preimage = Buffer.from(powPreimageHex, 'hex');
  const nonceBuf = Buffer.alloc(8);
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
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

export async function mine(
  node: NodeProcess,
  miningSecret: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await mineOne(node, miningSecret);
  }
}

async function mineOne(node: NodeProcess, miningSecret: string): Promise<void> {
  const maxRetries = 30;
  let template: TemplateResponse | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(`${node.url}/mining/template`, {
      headers: { Authorization: `Bearer ${miningSecret}` },
    });
    if (res.status === 404) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET /mining/template returned ${res.status}: ${body}`);
    }
    template = (await res.json()) as TemplateResponse;
    break;
  }

  if (!template) {
    const tail = node.logs.slice(-20).join('\n');
    throw new Error(
      `No mining template after ${maxRetries} attempts on :${node.httpPort}\n${tail}`,
    );
  }

  const nonce = solve(template.powPreimage, template.header.powTargetBits);
  if (nonce === null) {
    throw new Error(
      `Failed to solve PoW for height ${template.header.height} on :${node.httpPort}`,
    );
  }

  const submitRes = await fetch(`${node.url}/mining/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${miningSecret}`,
    },
    body: JSON.stringify({ powNonce: nonce, height: template.header.height }),
  });

  if (submitRes.status !== 201) {
    const body = await submitRes.text();
    throw new Error(
      `POST /mining/submit returned ${submitRes.status} for height ${template.header.height}: ${body}`,
    );
  }
}

export async function waitHeight(
  nodes: NodeProcess[],
  height: number,
  windowMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + windowMs;
  for (const node of nodes) {
    let reached = false;
    while (Date.now() < deadline) {
      const res = await fetch(`${node.url}/blocks/current`);
      if (res.ok) {
        const data = (await res.json()) as { height: number };
        if (data.height >= height) {
          reached = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!reached) {
      const tails = nodes
        .map((n) => `--- :${n.httpPort} ---\n${n.logs.slice(-10).join('\n')}`)
        .join('\n');
      throw new Error(
        `Node :${node.httpPort} did not reach height ${height} within ${windowMs}ms\n${tails}`,
      );
    }
  }
}
