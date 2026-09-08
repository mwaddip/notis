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

  const ch = hasChannel ? new BroadcastChannel('notis') : null;
  if (ch) {
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
      // WEB_INTERFACE → The way into the workspace — a queued request, never
      // ifAvailable; the lock is granted when no other tab holds it.
      return new Promise<boolean>((resolve) => {
        navigator.locks.request('notis.workspace', () => {
          holding = true;
          resolve(true);
          return new Promise<void>(() => {});
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
          resolve(lock === null);
          return Promise.resolve();
        });
      });
    },

    announce(id: string): void {
      ch?.postMessage({ id });
    },

    onOpen(cb: (id: string) => void): void {
      listeners.push(cb);
    },
  };
}
