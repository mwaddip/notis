// NODE_INTERFACE → Username records — the two keys are distinct from every
// other key for the same bytes.
import { describe, it, expect } from 'vitest';
import { usernameRecordKey, holderRecordKey } from '../../src/state/avl-prover.js';
import { identityRecordKey, networkRecordKey } from '../../src/store/identity-records.js';

describe('username AVL keys', () => {
  const sameBytes = Buffer.alloc(32, 0xaa);

  it('name key and holder key differ for the same bytes', () => {
    const nameKey = usernameRecordKey(sameBytes);
    const holderKey = holderRecordKey(sameBytes);
    expect(nameKey).not.toBe(holderKey);
  });

  it('name key differs from identity key for the same bytes', () => {
    const nameKey = usernameRecordKey(sameBytes);
    const idKey = identityRecordKey(sameBytes);
    expect(nameKey).not.toBe(idKey);
  });

  it('holder key differs from identity key for the same bytes', () => {
    const holderKey = holderRecordKey(sameBytes);
    const idKey = identityRecordKey(sameBytes);
    expect(holderKey).not.toBe(idKey);
  });

  it('name key differs from network key', () => {
    const nameKey = usernameRecordKey(sameBytes);
    const nrKey = networkRecordKey();
    expect(nameKey).not.toBe(nrKey);
  });

  it('holder key differs from network key', () => {
    const holderKey = holderRecordKey(sameBytes);
    const nrKey = networkRecordKey();
    expect(holderKey).not.toBe(nrKey);
  });

  it('keys are 64-char lowercase hex (32 bytes)', () => {
    const nameKey = usernameRecordKey(sameBytes);
    const holderKey = holderRecordKey(sameBytes);
    expect(nameKey).toMatch(/^[0-9a-f]{64}$/);
    expect(holderKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
