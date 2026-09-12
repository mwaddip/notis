import { describe, it, expect } from 'vitest';
import { createPrivateKey, createPublicKey } from 'crypto';
import { NETWORK_PROFILES } from '@dagsocial/types';
import { DEVNET_FAUCET, DEVNET_BACKER_A, DEVNET_BACKER_B } from '../src/identities.js';

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

  it('DEVNET_BACKER_A derives a backerTable row at weight 20', () => {
    const privKey = createPrivateKey({
      key: DEVNET_BACKER_A.secretKey,
      format: 'der',
      type: 'pkcs8',
    });
    const pubDer = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
    const derived = Buffer.from(pubDer.subarray(-32)).toString('hex');
    const row = NETWORK_PROFILES.devnet.backerTable.find((r) => r.weight === 20n);
    expect(row).toBeDefined();
    expect(derived).toBe(row!.key);
    expect(derived).toBe(DEVNET_BACKER_A.publicKeyHex);
  });

  it('DEVNET_BACKER_B derives a backerTable row at weight 30', () => {
    const privKey = createPrivateKey({
      key: DEVNET_BACKER_B.secretKey,
      format: 'der',
      type: 'pkcs8',
    });
    const pubDer = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
    const derived = Buffer.from(pubDer.subarray(-32)).toString('hex');
    const row = NETWORK_PROFILES.devnet.backerTable.find((r) => r.weight === 30n);
    expect(row).toBeDefined();
    expect(derived).toBe(row!.key);
    expect(derived).toBe(DEVNET_BACKER_B.publicKeyHex);
  });
});
