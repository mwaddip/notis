// MESH_INTERFACE → Acceptance — the browser host's resolver points at this
// server; it answers every query with RCODE 5 (REFUSED) and appends one line
// to `stage/out/dns.log`: timestamp, source address, question name, question
// type. One UDP listener on port 53, one TCP listener on port 53. No cache,
// no answers section; a resolver that reads REFUSED does not try again on the
// same server. Scenario 1 reads the log plus the browser namespace's nft
// counter — the two together are the DNS witness.
//
// Env: `DNS_LOG_PATH` names the file to append to (default `./dns.log`),
// `DNS_LOG_BIND` the address to bind on (default `0.0.0.0`), `DNS_LOG_PORT`
// the port (default `53`).

import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { appendFile } from 'node:fs/promises';
import { parseDnsQuery, buildRefused, RCODE_REFUSED } from './lib/dns.mjs';

const PORT = Number(process.env.DNS_LOG_PORT ?? '53');
const BIND = process.env.DNS_LOG_BIND ?? '0.0.0.0';
const LOG_PATH = process.env.DNS_LOG_PATH ?? './dns.log';

async function logQuery(source, question) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    source,
    name: question.name,
    type: question.type,
  }) + '\n';
  try {
    await appendFile(LOG_PATH, line);
  } catch (err) {
    process.stderr.write(`dns-log: append failed: ${err.message}\n`);
  }
}

const udp = createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (msg, rinfo) => {
  try {
    const q = parseDnsQuery(msg);
    void logQuery(`${rinfo.address}:${rinfo.port}`, q);
    const answer = buildRefused(msg, q);
    udp.send(answer, rinfo.port, rinfo.address);
  } catch (err) {
    // Malformed query: do not answer; log the attempt.
    void logQuery(`${rinfo.address}:${rinfo.port}`, { name: '<malformed>', type: `error:${err.message}` });
  }
});
udp.on('error', (err) => {
  process.stderr.write(`dns-log udp: ${err.message}\n`);
  process.exit(1);
});
udp.bind(PORT, BIND, () => {
  process.stdout.write(`dns-log udp bound: ${BIND}:${PORT}\n`);
});

// MESH_INTERFACE → Acceptance — scenario 1 counts port-853 traffic too, so a
// resolver that falls back to DNS-over-TLS is seen by the nft counter even
// when this stub does not implement TLS. A plain TCP listener on 53 catches
// the ordinary fallback (an RFC 7766 DNS-over-TCP query).
const tcp = createServer((sock) => {
  // RFC 1035 §4.2.2 — a two-byte length prefix precedes the message.
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) break;
      const msg = buf.subarray(2, 2 + len);
      buf = buf.subarray(2 + len);
      try {
        const q = parseDnsQuery(msg);
        void logQuery(`${sock.remoteAddress}:${sock.remotePort}`, q);
        const answer = buildRefused(msg, q);
        const prefixed = Buffer.alloc(2 + answer.length);
        prefixed.writeUInt16BE(answer.length, 0);
        answer.copy(prefixed, 2);
        sock.write(prefixed);
      } catch (err) {
        void logQuery(`${sock.remoteAddress}:${sock.remotePort}`, { name: '<malformed>', type: `error:${err.message}` });
        sock.end();
        return;
      }
    }
  });
  sock.on('error', () => { /* a client that drops is a client that dropped */ });
});
tcp.on('error', (err) => {
  process.stderr.write(`dns-log tcp: ${err.message}\n`);
  process.exit(1);
});
tcp.listen(PORT, BIND, () => {
  process.stdout.write(`dns-log tcp bound: ${BIND}:${PORT}\n`);
});

function shutdown() {
  udp.close();
  tcp.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export { RCODE_REFUSED };
