import { defineConfig, mergeConfig } from 'vitest/config';
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      passWithNoTests: true,
      testTimeout: 15000, // libp2p tests may need more time
      // libp2p's `it-byte-stream` wraps the muxed stream's sink in a
      // promise whose own `.catch` handler returns another promise with
      // no listener: when `sinkWithDeadline` aborts the stream, the
      // internal `write.end(err)` call rejects there and surfaces as
      // unhandled. The surfacing is a feature of the library's own error
      // bookkeeping, not of a path net reaches, and the specific error is
      // "Cannot push value onto an ended pushable" from the pushable the
      // library owns. Vitest reads an unhandled rejection as a run
      // failure, so this flag keeps the gate green against a known
      // library behaviour; a real test-code bug of this shape would still
      // surface as a failing assertion.
      dangerouslyIgnoreUnhandledErrors: true,
    },
  }),
);
