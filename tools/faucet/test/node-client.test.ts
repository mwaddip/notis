import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpNodeClient, NodeError } from '../src/node-client.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const plain = (status: number, text: string): Response =>
  new Response(text, { status });

afterEach(() => { vi.restoreAllMocks(); });

describe('HttpNodeClient box queries', () => {
  const client = new HttpNodeClient('http://localhost:3000');
  const key = 'aa'.repeat(32);

  // NODE_INTERFACE → HTTP API: an identity with no unspent box answers the
  // empty page, and the caller sees an empty set.
  it('an empty page yields an empty array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(200, { userId: key, total: '0', boxes: [], boxCount: 0 }),
    );
    expect(await client.karmaBoxes(key)).toEqual([]);
  });

  it('parses box values to bigint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(200, { boxes: [{ boxId: 'bb'.repeat(32), value: '750' }] }),
    );
    const boxes = await client.karmaBoxes(key);
    expect(boxes).toEqual([{ boxId: 'bb'.repeat(32), value: 750n }]);
  });

  it('a 404 is a failure, not an empty set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(404, { error: 'not found' }),
    );
    await expect(client.karmaBoxes(key)).rejects.toThrow(NodeError);
  });

  // A proxy serving nothing at NODE_URL carries no JSON body.
  it('a non-JSON 404 is a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      plain(404, 'Not Found'),
    );
    await expect(client.karmaBoxes(key)).rejects.toThrow(NodeError);
  });
});
