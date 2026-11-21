// NET_INTERFACE → The browser entry — `readerLibp2pOptions`, handed a
// reader's FIPS stack as `fips`, adds the stack's libp2p transport to the
// reader's transports (MESH_INTERFACE → FIPS → "A reader dials over it").
// The caller attaches the stack separately after `createLibp2p`.

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPair } from '@dagsocial/types';
import { readerLibp2pOptions } from '../../src/mesh/reader-options.js';
import { createReaderFips } from '../../src/mesh/fips-stack.js';
import type { FipsStack } from '../../src/mesh/fips-stack.js';
import { nodeKeyFromKeyPair } from '../../src/mesh/identity.js';
import { MAGIC_TESTNET } from '../../src/frame.js';

describe('NET_INTERFACE → The browser entry: readerLibp2pOptions and FIPS', () => {
  const stacks: FipsStack[] = [];

  afterEach(async () => {
    for (const s of stacks) { try { await s.stop(); } catch { /* already */ } }
    stacks.length = 0;
  });

  it('readerLibp2pOptions appends the FIPS transport when given a stack', async () => {
    const privateKey = nodeKeyFromKeyPair(generateKeyPair()).privateKey;
    const base = {
      privateKey,
      magic: MAGIC_TESTNET,
      network: 'testnet' as const,
      iceServers: (): RTCIceServer[] => [],
      denyDialMultiaddr: (): boolean => false,
    };
    const without = readerLibp2pOptions(base);
    const stack = await createReaderFips({ network: 'testnet' });
    stacks.push(stack);
    const withFips = readerLibp2pOptions({ ...base, fips: stack });
    expect(withFips.transports.length).toBe(without.transports.length + 1);
    expect(withFips.transports[withFips.transports.length - 1]).toBe(stack.transport);
  });
});
