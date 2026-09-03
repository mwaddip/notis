import type { IdentityModule } from './identity';

// The dev door — WEB_INTERFACE → The write surface: the machinery is reached in a
// development build only, through `globalThis.notis.identity`, so a console call
// `notis.identity.importJson(<the file's text>)` loads the reader's own identity.
// Nothing in the interface creates a key.
//
// The gate is the build flag `import.meta.env.DEV`, which vite compiles to a
// literal — a production build eliminates the body and exposes nothing. It is not
// a runtime condition.

export function installDevDoor(identity: IdentityModule): void {
  if (!import.meta.env.DEV) return;
  const g = globalThis as unknown as { notis?: Record<string, unknown> };
  g.notis = { ...(g.notis ?? {}), identity };
}
