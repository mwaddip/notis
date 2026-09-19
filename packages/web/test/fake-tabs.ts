import type { Tabs } from '../src/tabs';

export function fakeTabs(): Tabs & {
  fireOpen(id: string): void;
  setHolding(v: boolean): void;
  setHeldElsewhere(v: boolean): void;
  setOffer(v: boolean): void;
  announced: string[];
  offered: string[];
  // One shared timeline across the async members, in the order they were
  // called — so a test can assert `offer` ran before `heldElsewhere`.
  calls: Array<'offer' | 'heldElsewhere' | 'announce'>;
} {
  let holding = false;
  let elsewhere = false;
  let offerAnswer = false;
  const listeners: Array<(id: string) => void> = [];
  const announced: string[] = [];
  const offered: string[] = [];
  const calls: Array<'offer' | 'heldElsewhere' | 'announce'> = [];
  let grantResolve: ((v: boolean) => void) | null = null;
  return {
    announced,
    offered,
    calls,
    claim() {
      if (holding) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => { grantResolve = resolve; });
    },
    holds() { return holding; },
    async heldElsewhere() { calls.push('heldElsewhere'); return elsewhere; },
    announce(id) { calls.push('announce'); announced.push(id); },
    onOpen(cb) { listeners.push(cb); },
    offer(id) { calls.push('offer'); offered.push(id); return offerAnswer; },
    fireOpen(id: string) { for (const cb of listeners) cb(id); },
    setHolding(v: boolean) {
      holding = v;
      if (v && grantResolve) { grantResolve(true); grantResolve = null; }
    },
    setHeldElsewhere(v: boolean) { elsewhere = v; },
    setOffer(v: boolean) { offerAnswer = v; },
  };
}
