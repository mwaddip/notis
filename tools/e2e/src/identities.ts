import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
import { NETWORK_PROFILES } from '@dagsocial/types';

export interface Identity {
  publicKeyHex: string;
  publicKey: Uint8Array;
  secretKey: Buffer;
}

export function fresh(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  const pubBytes = new Uint8Array(pubDer.subarray(-32));
  return {
    publicKeyHex: Buffer.from(pubBytes).toString('hex'),
    publicKey: pubBytes,
    secretKey: privateKey.export({ format: 'der', type: 'pkcs8' }),
  };
}

const DEVNET_FAUCET_PKCS8_HEX =
  '302e020100300506032b6570042204204504541a393fe199a143e47fbf10cb32ef7ef349eecd2f0997a310487b03abf4';

export const DEVNET_FAUCET: Identity = (() => {
  const secretKey = Buffer.from(DEVNET_FAUCET_PKCS8_HEX, 'hex');
  const privKey = createPrivateKey({ key: secretKey, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
  const pubBytes = new Uint8Array(pubDer.subarray(-32));
  const publicKeyHex = Buffer.from(pubBytes).toString('hex');
  if (publicKeyHex !== NETWORK_PROFILES.devnet.faucetPublicKey) {
    throw new Error(
      `Devnet faucet key mismatch: derived ${publicKeyHex}, expected ${NETWORK_PROFILES.devnet.faucetPublicKey}`,
    );
  }
  return { publicKeyHex, publicKey: pubBytes, secretKey };
})();
