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
  /** The commit the extension build was built from
   *  (WEB_INTERFACE → The extension → "The build carries its commit"):
   *  forty lowercase hex, with `-dirty` appended where a tracked file
   *  differs from `HEAD`. Written by `build-extension.sh`; unset in the
   *  web build. */
  readonly VITE_COMMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
