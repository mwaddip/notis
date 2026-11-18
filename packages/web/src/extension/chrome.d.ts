// The chrome.* surface the extension uses, and nothing more — WEB_INTERFACE →
// The extension, "No dependency is added". Declared here so `types: []` stays
// and no @types/chrome is pulled in. Both Chrome (MV3 service worker) and
// Firefox (event page) present these under the `chrome` global with
// promise-returning calls (WEB_INTERFACE → "The messages").

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      url?: string;
      tab?: { id?: number; active?: boolean; windowId?: number };
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
    function getManifest(): { version: string };
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
      // Present where the browser offers it (Chrome from 140); absent elsewhere
      // — WEB_INTERFACE → The extension → "The contexts, and what each may hold".
      setAccessLevel?(options: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
    }
    interface OnChangedEvent {
      addListener(
        listener: (changes: Record<string, StorageChange>, areaName: 'local' | 'session' | 'sync' | 'managed') => void,
      ): void;
      removeListener(
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
      discarded?: boolean;
      active?: boolean;
    }
    function query(info: { url?: string | string[] }): Promise<Tab[]>;
    function update(tabId: number, props: { active?: boolean; url?: string }): Promise<Tab>;
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function get(tabId: number): Promise<Tab>;
    interface OnRemovedEvent {
      addListener(listener: (tabId: number) => void): void;
    }
    const onRemoved: OnRemovedEvent;
  }

  namespace windows {
    interface Window {
      id?: number;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
    }
    interface CreateProps {
      url?: string;
      type?: 'popup' | 'normal';
      focused?: boolean;
      width?: number;
      height?: number;
      left?: number;
      top?: number;
    }
    interface OnRemovedEvent {
      addListener(listener: (windowId: number) => void): void;
    }
    // The methods the `chrome.windows` value offers. Collected as an interface
    // so the value itself can be optional — WEB_INTERFACE → The extension →
    // "The contexts, and what each may hold" (the prompt window's bullet)
    // and → "A raise focuses a window only where the browser offers `windows`".
    interface Api {
      create(props: CreateProps): Promise<Window>;
      update(windowId: number, props: { focused?: boolean }): Promise<Window>;
      remove(windowId: number): Promise<void>;
      get(windowId: number): Promise<Window>;
      getLastFocused(): Promise<Window>;
      onRemoved: OnRemovedEvent;
    }
  }
  // Absent on browsers that offer no `windows` API (Firefox for Android).
  // Every call site asks whether the value exists before using it.
  const windows: windows.Api | undefined;

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

  namespace extension {
    // WEB_INTERFACE → The extension → "A takeover needs a tab created for the link"
    // — the bridge does nothing in a private window.
    const inIncognitoContext: boolean;
  }
}
