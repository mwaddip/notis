// The chrome.* surface the extension uses, and nothing more — WEB_INTERFACE →
// The extension, "No dependency is added". Declared here so `types: []` stays
// and no @types/chrome is pulled in. Both Chrome (MV3 service worker) and
// Firefox (event page) present these under the `chrome` global with
// promise-returning calls (WEB_INTERFACE → "The messages").

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      url?: string;
      tab?: { id?: number };
      id?: string;
    }
    interface OnMessageEvent {
      addListener(
        listener: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    }
    interface OnInstalledEvent {
      addListener(listener: (details: { reason: string }) => void): void;
    }
    interface OnStartupEvent {
      addListener(listener: () => void): void;
    }
    const onMessage: OnMessageEvent;
    const onInstalled: OnInstalledEvent;
    const onStartup: OnStartupEvent;
    function sendMessage(message: unknown): Promise<unknown>;
    function getURL(path: string): string;
    const id: string;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    interface StorageArea {
      get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      clear(): Promise<void>;
    }
    interface OnChangedEvent {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: 'local' | 'session' | 'sync' | 'managed') => void,
      ): void;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: OnChangedEvent;
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      windowId?: number;
    }
    function query(info: { url?: string | string[] }): Promise<Tab[]>;
    function update(tabId: number, props: { active?: boolean }): Promise<Tab>;
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    interface OnRemovedEvent {
      addListener(listener: (tabId: number) => void): void;
    }
    const onRemoved: OnRemovedEvent;
  }

  namespace windows {
    interface Window {
      id?: number;
    }
    interface CreateProps {
      url?: string;
      type?: 'popup' | 'normal';
      focused?: boolean;
      width?: number;
      height?: number;
    }
    function create(props: CreateProps): Promise<Window>;
    function update(windowId: number, props: { focused?: boolean }): Promise<Window>;
    function remove(windowId: number): Promise<void>;
    interface OnRemovedEvent {
      addListener(listener: (windowId: number) => void): void;
    }
    const onRemoved: OnRemovedEvent;
  }

  namespace action {
    interface OnClickedEvent {
      addListener(listener: (tab: tabs.Tab) => void): void;
    }
    const onClicked: OnClickedEvent;
  }

  namespace permissions {
    function request(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    function contains(perms: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  }
}
