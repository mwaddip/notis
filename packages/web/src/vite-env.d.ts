// Build-time environment, replaced by vite at build. VITE_API_BASE sets the
// client's default API base for a deploy served under a path (e.g. /testnet/api
// behind nginx); it stays empty for `pnpm dev`, which reaches the node through
// the vite proxy. VITE_FAUCET_BASE is the same knob for the faucet — empty means
// no faucet and no button (WEB_INTERFACE → The faucet step).
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_FAUCET_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
