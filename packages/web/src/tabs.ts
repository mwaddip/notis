// WEB_INTERFACE → The way into the workspace — the lock and the channel.

const HEX64 = /^[0-9a-f]{64}$/i;

export interface Tabs {
  claim(): Promise<boolean>;
  holds(): boolean;
  heldElsewhere(): Promise<boolean>;
  announce(id: string): void;
  onOpen(cb: (id: string) => void): void;
}

export function createTabs(): Tabs {
  let holding = false;
  const listeners: Array<(id: string) => void> = [];

  const hasLocks = typeof navigator !== 'undefined' && 'locks' in navigator;
  const hasChannel = typeof BroadcastChannel !== 'undefined';

  if (hasChannel) {
    const ch = new BroadcastChannel('notis');
    ch.addEventListener('message', (e) => {
      const id = e.data?.id;
      if (typeof id === 'string' && HEX64.test(id) && holding) {
        for (const cb of listeners) cb(id);
      }
    });
  }

  return {
    async claim(): Promise<boolean> {
      if (!hasLocks) { holding = true; return true; }
      return new Promise<boolean>((resolve) => {
        navigator.locks.request('notis.workspace', { ifAvailable: true }, (lock) => {
          holding = lock !== null;
          resolve(holding);
          if (holding) return new Promise<void>(() => {});
        });
      });
    },

    holds(): boolean {
      return holding;
    },

    async heldElsewhere(): Promise<boolean> {
      if (!hasLocks) return false;
      return new Promise<boolean>((resolve) => {
        navigator.locks.request('notis.workspace', { ifAvailable: true }, (lock) => {
          if (lock === null) { resolve(true); return; }
          resolve(false);
        });
      });
    },

    announce(id: string): void {
      if (!hasChannel) return;
      new BroadcastChannel('notis').postMessage({ id });
    },

    onOpen(cb: (id: string) => void): void {
      listeners.push(cb);
    },
  };
}

export function fakeTabs(): Tabs & { fireOpen(id: string): void; setHolding(v: boolean): void; setHeldElsewhere(v: boolean): void; announced: string[] } {
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
