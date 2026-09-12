// Devnet backer keys are publicly derivable (ARCHITECTURE → Genesis):
//   seed = blake2b512(utf8('dagsocial/devnet/backer/A'))[0:32]
//   PKCS8 DER = 302e020100300506032b657004220420 ‖ seed
//   public key = last 32 bytes of the SPKI export
// The same derivation for /B.
import type { BackerTable } from '../network.js';

export const DEVNET_BACKERS: BackerTable = {
  supply: 100n,
  rows: [
    { key: '3447b01aceefb21764eac3f1adc4548d7914feb89d0491df5d9c50eb69056f12', weight: 20n },
    { key: '81dd8caf7b3a119fffdd5ceeb2450c6a7dbcd6d4441f5750e01d7a086e310be5', weight: 30n },
  ],
};
