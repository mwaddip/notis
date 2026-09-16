/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The identity implementation the build wires in — WEB_INTERFACE → The
   *  extension. `extension` for the extension build; anything else (including
   *  undefined) is the page's in-page module. */
  readonly VITE_IDENTITY?: 'page' | 'extension';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
