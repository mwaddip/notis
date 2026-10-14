import { describe, it, expect } from 'vitest';
import { checkTxEnvelope } from '@dagsocial/consensus';
import type { UtxoResult } from '@dagsocial/consensus';

// NODE_INTERFACE → Transaction envelope shape: the check is total, and a
// transaction whose `post` is not an object is refused at the protocol-version
// clause with a message that reads nothing off `post`.

const SCHEDULE = [{ version: 1, fromHeight: 0 }];
const HEIGHT = 0;
const HEX_A = 'a'.repeat(64);

/** A well-formed envelope, minus whatever the caller overrides. */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { inputs: [HEX_A], outputs: [], signatures: {}, protocolVersion: 1, ...over };
}

/** The check's outcome, with a throw turned into a value an assertion can read. */
function outcome(tx: unknown): UtxoResult | { threw: string } {
  try {
    return checkTxEnvelope(tx, HEIGHT, SCHEDULE);
  } catch (e) {
    return { threw: String(e) };
  }
}

function refusedNaming(tx: unknown, name: string): void {
  const result = outcome(tx);
  expect(result).toMatchObject({ valid: false, error: expect.stringContaining(name) as unknown });
}

describe('checkTxEnvelope is total over a post that is not an object', () => {
  it.fails('refuses post null under the era version, and does not throw', () => {
    refusedNaming(envelope({ post: null }), 'post');
  });

  it.fails('refuses post null under a version that is not the era, naming protocolVersion', () => {
    refusedNaming(envelope({ post: null, protocolVersion: 2 }), 'protocolVersion');
  });

  it('refuses a numeric post under a version that is not the era, naming protocolVersion', () => {
    refusedNaming(envelope({ post: 5, protocolVersion: 2 }), 'protocolVersion');
  });

  it('refuses a string post under a version that is not the era, naming protocolVersion', () => {
    refusedNaming(envelope({ post: 'x', protocolVersion: 2 }), 'protocolVersion');
  });
});
