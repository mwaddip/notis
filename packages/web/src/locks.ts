// The Web Locks seam the extension's background and the waiting store take
// (WEB_INTERFACE → The extension → "`sign`, in the background, in order",
// WEB_INTERFACE → The wallet → "The waiting store keeps every waiting write as
// a record of its own"). Every read and write of a prompt record or a waiting
// write runs under one exclusive lock named `notis.<subject>.…`, so a worker
// that dies releases it and nothing in a worker global holds it. The browser's
// `navigator.locks` is adapted to this shape; a Node test hands
// `fakeLockManager()`.

export interface LockManager {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
