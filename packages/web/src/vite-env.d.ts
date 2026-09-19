/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The identity implementation the build wires in — WEB_INTERFACE → The
   *  extension. `extension` for the extension build; anything else (including
   *  undefined) is the page's in-page module. */
  readonly VITE_IDENTITY?: 'page' | 'extension';
  /** The build's `notis-public` — the origin and base a link copies from and
   *  the prefix the extension background checks the bridge's sender against
   *  (WEB_INTERFACE → The extension → "Links into the extension"). */
  readonly VITE_PUBLIC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
