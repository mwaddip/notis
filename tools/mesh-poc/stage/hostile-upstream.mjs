// MESH_INTERFACE → Acceptance — the hostile upstream a mesh node points at
// instead of a real Notis node. One mode per hostile host: `malformed` answers
// `/nipopow/proof/:m/:k` with a non-hex `proof`; `invalid` fetches the real
// proof from `pub1`'s node, flips a nonce byte of one header so the proof
// decodes and `verifyProof` refuses it; every other route forwards to pub1.
// The two body builders are pure functions, exported so the test and the
// server share one implementation.

import { createServer } from 'node:http';
import { decodeNipopowProof, encodeNipopowProof } from '@dagsocial/nipopow';

const PROOF_ROUTE = /^\/nipopow\/proof\/(\d+)\/(\d+)(?:\?.*)?$/;

export function malformedBody() {
  // MESH_INTERFACE → The client's node list → "a lie" row — a non-hex `proof`
  // is a body a key-authenticated link holds against the node: the fetch
  // decodes the field as hex, the hex read fails, and the entry moves by
  // `lie` of kind `malformed`.
  return { proof: 'not-hex' };
}

export function invalidBody(validProofHex) {
  // The valid proof decodes to a NipopowProof; flipping a bit in a header's
  // `powNonce` keeps the encoding well-formed (`powNonce` is a VLQ unsigned
  // integer, every uint64 value is a legal encoding) and breaks the PoW
  // check — `decodeNipopowProof` reads it, `verifyProof` refuses.
  const proof = decodeNipopowProof(hexToBytes(validProofHex));
  // The suffix carries the chain's last `k` headers whole — `verifyProof`'s
  // PoW check reads every header of `prefix` (each a PoPowHeader with
  // `.header`), `suffixHead` (a PoPowHeader) and `suffixTail` (plain
  // BlockHeaders). A flip anywhere there breaks the hash, so the suffix
  // tail's first bare header is the simplest target.
  if (proof.suffixTail.length === 0) {
    // Fall back to the suffix head when the tail is empty (k = 0 is
    // refused by the server, but the pure function must stay total).
    proof.suffixHead.header.powNonce = (proof.suffixHead.header.powNonce ^ 1) >>> 0;
  } else {
    const h = proof.suffixTail[0];
    h.powNonce = (h.powNonce ^ 1) >>> 0;
  }
  const bytes = encodeNipopowProof(proof);
  return { proof: bytesToHex(bytes) };
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function startHostileUpstream(opts) {
  const { port, mode, pub1Base } = opts;
  if (mode !== 'malformed' && mode !== 'invalid') {
    throw new Error(`mode must be 'malformed' or 'invalid', not ${JSON.stringify(mode)}`);
  }
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const m = PROOF_ROUTE.exec(url);
    if (m !== null && req.method === 'GET') {
      answerProof(res, mode, pub1Base, url).catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
      return;
    }
    forward(req, res, pub1Base);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({ server, port: actualPort });
    });
  });
}

async function answerProof(res, mode, pub1Base, url) {
  if (mode === 'malformed') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(malformedBody()));
    return;
  }
  // mode === 'invalid': fetch the real proof, flip a nonce byte.
  const upstream = await fetch(`${pub1Base}${url}`);
  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(await upstream.text());
    return;
  }
  const body = await upstream.json();
  if (typeof body?.proof !== 'string') {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream proof field missing' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(invalidBody(body.proof)));
}

async function forward(req, res, pub1Base) {
  const upstream = await fetch(`${pub1Base}${req.url}`, { method: req.method });
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}
