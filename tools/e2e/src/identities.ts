import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } from 'crypto';
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

// Devnet-only, public by design (ARCHITECTURE → Genesis). Testnet's faucet key
// guards a balance testers depend on and is never in this tree.
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

const PKCS8_PREFIX = '302e020100300506032b657004220420';

function deriveBackerIdentity(label: string, expectedWeight: bigint): Identity {
  const seed = createHash('blake2b512')
    .update(Buffer.from(label))
    .digest()
    .subarray(0, 32);
  const secretKey = Buffer.from(PKCS8_PREFIX + seed.toString('hex'), 'hex');
  const privKey = createPrivateKey({ key: secretKey, format: 'der', type: 'pkcs8' });
  const pubDer = createPublicKey(privKey).export({ format: 'der', type: 'spki' });
  const pubBytes = new Uint8Array(pubDer.subarray(-32));
  const publicKeyHex = Buffer.from(pubBytes).toString('hex');
  const row = NETWORK_PROFILES.devnet.backerTable.find((r) => r.weight === expectedWeight);
  if (!row || row.key !== publicKeyHex) {
    throw new Error(
      `Backer key mismatch for ${label}: derived ${publicKeyHex}, expected table row at weight ${expectedWeight}`,
    );
  }
  return { publicKeyHex, publicKey: pubBytes, secretKey };
}

export const DEVNET_BACKER_A: Identity = deriveBackerIdentity('dagsocial/devnet/backer/A', 20n);
export const DEVNET_BACKER_B: Identity = deriveBackerIdentity('dagsocial/devnet/backer/B', 30n);
