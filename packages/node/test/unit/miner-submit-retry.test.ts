/**
 * `scripts/miner.mjs` retries a submit that fails in transit with the same
 * nonce and height — MINING_INTERFACE → Miner Script step 4. The script runs
 * `main()` only when invoked directly, so importing it here for its exports
 * does not start the mining loop, and `submitNonce` takes its `fetch` and
 * `sleep` as parameters precisely so a test can supply its own.
 */
import { describe, it, expect } from 'vitest';

type FetchResult = { status: number };
type FetchCall = [url: string, init: { body: string; [key: string]: unknown }];
type SubmitNonce = (
  powNonce: number,
  height: number,
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<FetchResult>,
  sleepImpl: (ms: number) => Promise<void>,
) => Promise<FetchResult>;

// A non-literal specifier: `tsc` resolves a literal `import()` argument the
// same as a static import and TS7016s without `allowJs`, which this package
// does not set. Built at runtime instead, exactly like the mirror test's own
// text-extraction workaround for the same standalone-script constraint.
const MINER_URL = new URL('../../scripts/miner.mjs', import.meta.url).href;

async function importMiner(): Promise<{ submitNonce: SubmitNonce }> {
  return (await import(MINER_URL)) as unknown as { submitNonce: SubmitNonce };
}

/** Answers `results` in order — an `Error` rejects that attempt, anything else resolves it. */
function makeFetch(results: Array<FetchResult | Error>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = async (url: string, init: Record<string, unknown>): Promise<FetchResult> => {
    calls.push([url, init as FetchCall[1]]);
    const next = results[i++];
    if (next === undefined) throw new Error('makeFetch: no more results queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fn, calls };
}

/** Records each delay it was asked for and resolves at once — no real waiting in a test. */
function makeSleep() {
  const calls: number[] = [];
  const fn = async (ms: number): Promise<void> => {
    calls.push(ms);
  };
  return { fn, calls };
}

describe('miner.mjs submitNonce — a transport rejection retries, a status never does', () => {
  it('retries a rejected attempt and accepts the next answer, with the same body', async () => {
    const { submitNonce } = await importMiner();
    const { fn: fetchImpl, calls } = makeFetch([new Error('fetch failed'), { status: 201 }]);
    const { fn: sleepImpl, calls: sleeps } = makeSleep();

    const res = await submitNonce(63545, 100, fetchImpl, sleepImpl);

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(calls[1]![1].body).toBe(calls[0]![1].body);
    expect(sleeps).toEqual([1000]);
  });

  it('throws after exactly three rejections, a pause between each', async () => {
    const { submitNonce } = await importMiner();
    const err = new Error('fetch failed');
    const { fn: fetchImpl, calls } = makeFetch([err, err, err]);
    const { fn: sleepImpl, calls: sleeps } = makeSleep();

    await expect(submitNonce(63545, 100, fetchImpl, sleepImpl)).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('does not retry a 422 — the first attempt already answered', async () => {
    const { submitNonce } = await importMiner();
    const { fn: fetchImpl, calls } = makeFetch([{ status: 422 }]);
    const { fn: sleepImpl, calls: sleeps } = makeSleep();

    const res = await submitNonce(63545, 100, fetchImpl, sleepImpl);

    expect(res.status).toBe(422);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });

  it('throws a 401 without retrying — a configuration failure, not a transport one', async () => {
    const { submitNonce } = await importMiner();
    const { fn: fetchImpl, calls } = makeFetch([{ status: 401 }]);
    const { fn: sleepImpl, calls: sleeps } = makeSleep();

    await expect(submitNonce(63545, 100, fetchImpl, sleepImpl)).rejects.toThrow(/401/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toHaveLength(0);
  });
});
