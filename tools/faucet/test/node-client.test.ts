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

describe('HttpNodeClient status', () => {
  const client = new HttpNodeClient('http://localhost:3000');

  // NODE_INTERFACE → Status: /status carries the tip and the era, and the client
  // reads both from the one fetch.
  it('reads the tip and the era from one fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(200, { networkType: 'testnet', blockHeight: 512, protocolVersion: 3, postCount: 0 }),
    );
    expect(await client.status()).toEqual({ blockHeight: 512, protocolVersion: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // WEB_INTERFACE → Invariants: the client signs the era the node reports, so a
  // status carrying no era is refused — never signed under a default of 1.
  it('refuses a status with no protocolVersion, rather than defaulting to 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { blockHeight: 512 }));
    await expect(client.status()).rejects.toThrow(/protocol version/i);
  });

  it('refuses a status with no height', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { protocolVersion: 1 }));
    await expect(client.status()).rejects.toThrow(NodeError);
  });

  it('a non-ok status is a failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(502, { error: 'bad gateway' }));
    await expect(client.status()).rejects.toThrow(NodeError);
  });

  // A hung node must not stall the faucet, so every call carries a timeout signal.
  it('attaches a timeout signal to the request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(200, { blockHeight: 512, protocolVersion: 3 }));
    await client.status();
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
