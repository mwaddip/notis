// MESH_INTERFACE → The IP certificate — read a server's TLS certificate
// over `openssl s_client` from inside a namespace. Returns the issuer
// line and the subject line as `openssl x509 -noout -issuer -subject`
// prints them.
//
// The scenario reaches the server over `openssl s_client -connect
// <ip>:<port>` inside a namespace, so the TLS handshake runs over the
// stage's own routes. `openssl` is in `openssl` on Debian; the stage's
// nodes already have it (Pebble ships one, curl --tlsv1.2 pulls one).

import { execIn } from './measure.mjs';

/**
 * Pure: parse the `issuer=` and `subject=` lines `openssl x509 -noout
 * -issuer -subject` prints. Returns `{ issuer, subject }`; a missing
 * line reads as `null`.
 */
export function parseIssuerSubject(output) {
  const text = typeof output === 'string' ? output : output?.toString('utf8') ?? '';
  let issuer = null;
  let subject = null;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.startsWith('issuer=')) issuer = l.slice('issuer='.length).trim();
    else if (l.startsWith('subject=')) subject = l.slice('subject='.length).trim();
  }
  return { issuer, subject };
}

/**
 * Over a brief `openssl s_client`, read the server's TLS cert and
 * return its issuer and subject. Runs inside `ns`, so routes through
 * natC (or wherever `ns` lives). A failed handshake raises.
 */
export function readTlsIssuer(ns, host, port, { user, timeoutMs = 15_000 } = {}) {
  // `-servername` sets SNI; `-brief` keeps `openssl s_client` quiet;
  // `-verify_return_error` makes a verification failure stop the
  // pipeline — but we read the cert BEFORE verification, so a
  // self-signed test cert still parses. `openssl` on Debian supports
  // `-showcerts` which prints every cert in the chain; we read the
  // first.
  //
  // The one-liner: `echo | openssl s_client -connect <host>:<port>
  // -servername <host> -showcerts 2>/dev/null | openssl x509 -noout
  // -issuer -subject` through `bash -c`.
  const bashCmd = `echo | openssl s_client -connect ${host}:${port} -servername ${host} -showcerts 2>/dev/null | openssl x509 -noout -issuer -subject`;
  const buf = execIn(ns, ['bash', '-c', bashCmd], { user, timeoutMs });
  return parseIssuerSubject(buf);
}
