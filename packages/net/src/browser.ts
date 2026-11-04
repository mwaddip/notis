// NET_INTERFACE → The browser entry — the half a browser runs, imports no
// Node built-in and reads no Node global; held equal by a build of it that
// refuses any Node built-in (WEB_INTERFACE → "A Node built-in fails every
// build"). AHEAD OF CODE: this entry re-exports the Node binding and so
// reaches `crypto`; the vite build refuses it. The refusal is what
// `browser-entry.test.ts` asserts its last line on; the rule steps in and
// the entry answers through `hash32` instead.
export * from './frame.js';
export * from './handshake.js';
