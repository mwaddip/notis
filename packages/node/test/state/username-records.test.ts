// NODE_INTERFACE → Entity kinds — the name record (0x82) and the holder record (0x83)
import { describe, it, expect } from 'vitest';
import {
  NAME_RECORD_TAG,
  HOLDER_RECORD_TAG,
  IDENTITY_RECORD_TAG,
  NETWORK_RECORD_TAG,
  serializeUsernameRecord,
  deserializeUsernameRecord,
  serializeHolderRecord,
  deserializeHolderRecord,
  deserializeBox,
  deserializeAvlValue,
} from '../../src/state/serialize-box.js';
import { randomBytes } from 'node:crypto';

function hexId(): string { return randomBytes(32).toString('hex'); }

describe('name record codec (0x82)', () => {
  it('round-trips', () => {
    const boxId = hexId();
    const bytes = serializeUsernameRecord({ boxId });
    expect(bytes[0]).toBe(NAME_RECORD_TAG);
    const decoded = deserializeUsernameRecord(bytes);
    expect(decoded.boxId).toBe(boxId);
  });

  it('refuses the identity-record tag', () => {
    const bytes = serializeUsernameRecord({ boxId: hexId() });
    bytes[0] = IDENTITY_RECORD_TAG;
    expect(() => deserializeUsernameRecord(bytes)).toThrow('not a name record');
  });

  it('refuses the network-record tag', () => {
    const bytes = serializeUsernameRecord({ boxId: hexId() });
    bytes[0] = NETWORK_RECORD_TAG;
    expect(() => deserializeUsernameRecord(bytes)).toThrow('not a name record');
  });

  it('refuses the holder-record tag', () => {
    const bytes = serializeUsernameRecord({ boxId: hexId() });
    bytes[0] = HOLDER_RECORD_TAG;
    expect(() => deserializeUsernameRecord(bytes)).toThrow('not a name record');
  });
});

describe('holder record codec (0x83)', () => {
  it('round-trips with a box', () => {
    const boxId = hexId();
    const bytes = serializeHolderRecord({ claimAvailable: false, boxId });
    expect(bytes[0]).toBe(HOLDER_RECORD_TAG);
    const decoded = deserializeHolderRecord(bytes);
    expect(decoded.claimAvailable).toBe(false);
    expect(decoded.boxId).toBe(boxId);
  });

  it('round-trips with no box and claimAvailable true', () => {
    const bytes = serializeHolderRecord({ claimAvailable: true, boxId: null });
    const decoded = deserializeHolderRecord(bytes);
    expect(decoded.claimAvailable).toBe(true);
    expect(decoded.boxId).toBeNull();
  });

  it('refuses the identity-record tag', () => {
    const bytes = serializeHolderRecord({ claimAvailable: false, boxId: hexId() });
    bytes[0] = IDENTITY_RECORD_TAG;
    expect(() => deserializeHolderRecord(bytes)).toThrow('not a holder record');
  });
});

describe('deserializeBox rejects both tags', () => {
  it('rejects 0x82', () => {
    const bytes = serializeUsernameRecord({ boxId: hexId() });
    expect(() => deserializeBox(bytes)).toThrow('name record');
  });

  it('rejects 0x83', () => {
    const bytes = serializeHolderRecord({ claimAvailable: false, boxId: hexId() });
    expect(() => deserializeBox(bytes)).toThrow('holder record');
  });
});

describe('deserializeAvlValue dispatches all five kinds', () => {
  it('kind: username', () => {
    const boxId = hexId();
    const bytes = serializeUsernameRecord({ boxId });
    const decoded = deserializeAvlValue(bytes);
    expect(decoded.kind).toBe('username');
    if (decoded.kind === 'username') {
      expect(decoded.username.boxId).toBe(boxId);
    }
  });

  it('kind: holder', () => {
    const boxId = hexId();
    const bytes = serializeHolderRecord({ claimAvailable: false, boxId });
    const decoded = deserializeAvlValue(bytes);
    expect(decoded.kind).toBe('holder');
    if (decoded.kind === 'holder') {
      expect(decoded.holder.claimAvailable).toBe(false);
      expect(decoded.holder.boxId).toBe(boxId);
    }
  });
});
