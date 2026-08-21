import { describe, it, expect } from 'vitest';
import { createPrivateKey, createPublicKey } from 'crypto';
import { NETWORK_PROFILES } from '@dagsocial/types';
import { DEVNET_FAUCET } from '../src/identities.js';

describe('fixture key', () => {
  it('DEVNET_FAUCET PKCS8 derives NETWORK_PROFILES.devnet.faucetPublicKey', () => {
    const privKey = createPrivateKey({
      key: DEVNET_FAUCET.secretKey,
      format: 'der',
      type: 'pkcs8',
    });
    const pubDer = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
    const derived = Buffer.from(pubDer.subarray(-32)).toString('hex');
    expect(derived).toBe(NETWORK_PROFILES.devnet.faucetPublicKey);
    expect(derived).toBe(DEVNET_FAUCET.publicKeyHex);
  });
});
