// NODE_INTERFACE → Blocks ("`:height` as a non-negative safe integer written
// in decimal digits alone"); every decimal-digit test the node runs — HTTP
// route and query parsing, and the environment-value reader — reads this one
// regex. The module takes no imports so every reader can import it without a
// cycle.
export const DECIMAL_INT = /^\d+$/;
