// Build-time environment, replaced by vite at build. VITE_API_BASE sets the
// client's default API base for a deploy served under a path (e.g. /testnet/api
// behind nginx); it stays empty for `pnpm dev`, which reaches the node through
// the vite proxy.
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  // A development build, true under `pnpm dev` and vitest, false in a production
  // build — the gate on the identity dev door (WEB_INTERFACE → The write surface).
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
