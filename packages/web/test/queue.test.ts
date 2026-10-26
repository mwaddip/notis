// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { FlowQueue } from '../src/wallet/queue';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('FlowQueue', () => {
  it('one run resolves with the run\'s value', async () => {
    const q = new FlowQueue();
    const r = await q.enqueue(async () => 42, () => true);
    expect(r).toBe(42);
  });

  it('the second run starts only after the first has its answer', async () => {
    const q = new FlowQueue();
    const events: string[] = [];
    let releaseFirst!: (v: number) => void;
    const first = q.enqueue<number>(
      () => new Promise<number>((resolve) => { events.push('first-start'); releaseFirst = resolve; }),
      () => true,
    );
    const second = q.enqueue<number>(
      async () => { events.push('second-start'); return 2; },
      () => true,
    );
    await flush();
    expect(events).toEqual(['first-start']);
    releaseFirst(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first-start', 'second-start']);
  });

  it('a thrown run releases its slot and never stops the pump', async () => {
    const q = new FlowQueue();
    const events: string[] = [];
    const first = q.enqueue<number>(
      async () => { events.push('first'); throw new Error('transport'); },
      () => true,
    );
    const second = q.enqueue<string>(
      async () => { events.push('second'); return 'ok'; },
      () => true,
    );
    await expect(first).rejects.toThrow('transport');
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual(['first', 'second']);
  });

  it('`isActive` is read at the turn, not at enqueue: a cancellation runs nothing and the next flow starts', async () => {
    const q = new FlowQueue();
    const events: string[] = [];
    let active = true;
    let releaseFirst!: (v: number) => void;
    const first = q.enqueue<number>(
      () => new Promise<number>((resolve) => { events.push('first-start'); releaseFirst = resolve; }),
      () => true,
    );
    const second = q.enqueue<string>(
      async () => { events.push('second-start'); return 'ran'; },
      () => active,
    );
    await flush();
    // The second's isActive changes before its turn — but the queue only reads
    // it when the second's turn comes.
    active = false;
    releaseFirst(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe('cancelled');
    // The run never fired.
    expect(events).toEqual(['first-start']);
  });

  it('a cancellation does not stop the pump: a later active flow runs', async () => {
    const q = new FlowQueue();
    const events: string[] = [];
    let releaseFirst!: (v: number) => void;
    const first = q.enqueue<number>(
      () => new Promise<number>((resolve) => { releaseFirst = resolve; }),
      () => true,
    );
    const second = q.enqueue<string>(
      async () => { events.push('second-start'); return 'skipped'; },
      () => false,
    );
    const third = q.enqueue<string>(
      async () => { events.push('third-start'); return 'ran'; },
      () => true,
    );
    releaseFirst(1);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe('cancelled');
    await expect(third).resolves.toBe('ran');
    expect(events).toEqual(['third-start']);
  });

  it('two queues on the same instance type run apart', async () => {
    // The App holds one queue of rep spends and one of sends; each is its own
    // `FlowQueue` and neither holds the other.
    const repQ = new FlowQueue();
    const sendQ = new FlowQueue();
    let releaseRep!: (v: number) => void;
    const rep = repQ.enqueue<number>(
      () => new Promise<number>((resolve) => { releaseRep = resolve; }),
      () => true,
    );
    const send = sendQ.enqueue<string>(async () => 'send-ok', () => true);
    // The send resolves while the rep is held.
    await expect(send).resolves.toBe('send-ok');
    releaseRep(1);
    await expect(rep).resolves.toBe(1);
  });
});
