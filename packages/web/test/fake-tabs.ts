import type { Tabs } from '../src/tabs';

export function fakeTabs(): Tabs & {
  fireOpen(id: string): void;
  setHolding(v: boolean): void;
  setHeldElsewhere(v: boolean): void;
  announced: string[];
} {
  let holding = false;
  let elsewhere = false;
  const listeners: Array<(id: string) => void> = [];
  const announced: string[] = [];
  return {
    announced,
    async claim() { return holding; },
    holds() { return holding; },
    async heldElsewhere() { return elsewhere; },
    announce(id) { announced.push(id); },
    onOpen(cb) { listeners.push(cb); },
    fireOpen(id: string) { for (const cb of listeners) cb(id); },
    setHolding(v: boolean) { holding = v; },
    setHeldElsewhere(v: boolean) { elsewhere = v; },
  };
}
