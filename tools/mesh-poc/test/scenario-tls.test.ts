// MESH_INTERFACE → The IP certificate — pure parse of
// `openssl x509 -noout -issuer -subject` output. The networked path
// (`readTlsIssuer`) runs on the real stage, not here.

import { describe, expect, it } from 'vitest';
import { parseIssuerSubject } from '../stage/lib/scenario-tls.mjs';

describe('parseIssuerSubject', () => {
  it.fails('reads issuer and subject from one well-formed output', () => {
    const out = 'issuer=CN = Pebble Intermediate CA, O = Pebble\nsubject=CN = 10.100.0.11, O = pub1\n';
    const r = parseIssuerSubject(out);
    expect(r.issuer).toBe('CN = Pebble Intermediate CA, O = Pebble');
    expect(r.subject).toBe('CN = 10.100.0.11, O = pub1');
  });

  it.fails('an empty input → both null', () => {
    expect(parseIssuerSubject('')).toEqual({ issuer: null, subject: null });
  });

  it.fails('subject-only or issuer-only still parses', () => {
    expect(parseIssuerSubject('issuer=X')).toEqual({ issuer: 'X', subject: null });
    expect(parseIssuerSubject('subject=Y')).toEqual({ issuer: null, subject: 'Y' });
  });

  it.fails('reads a Buffer like openssl prints', () => {
    const buf = Buffer.from('issuer=CN = Pebble\nsubject=CN = x\n');
    const r = parseIssuerSubject(buf);
    expect(r.issuer).toBe('CN = Pebble');
    expect(r.subject).toBe('CN = x');
  });
});
