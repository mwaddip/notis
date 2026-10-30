// MESH_INTERFACE → Acceptance — scenario 1's DNS witness. The DNS log server
// answers REFUSED and records every query; the pure parse/answer functions
// are what the server runs, and this suite exercises them on a crafted
// packet.

import { describe, expect, it } from 'vitest';
import { parseDnsQuery, buildRefused, RCODE_REFUSED } from '../stage/lib/dns.mjs';

// Build a minimal DNS query: ID = 0x1234, Opcode = 0 (QUERY), RD = 1 (want
// recursion), QDCOUNT = 1, one question for `example.com. A IN`.
function craftedExampleQuery(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0); // ID
  header[2] = 0x01;                // QR=0, Opcode=0, AA=0, TC=0, RD=1
  header[3] = 0x00;                // RA=0, Z=0, RCODE=0
  header.writeUInt16BE(1, 4);      // QDCOUNT
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const qname = Buffer.from([
    7, ...Buffer.from('example', 'ascii'),
    3, ...Buffer.from('com', 'ascii'),
    0,
  ]);
  const qtailBuf = Buffer.alloc(4);
  qtailBuf.writeUInt16BE(1, 0); // QTYPE = A
  qtailBuf.writeUInt16BE(1, 2); // QCLASS = IN
  return Buffer.concat([header, qname, qtailBuf]);
}

describe('stage/lib/dns.mjs', () => {
  it('parses the crafted query', () => {
    const bytes = craftedExampleQuery();
    const q = parseDnsQuery(bytes);
    expect(q.id).toBe(0x1234);
    expect(q.name).toBe('example.com.');
    expect(q.type).toBe('A');
    expect(q.typeCode).toBe(1);
  });

  it('refuses a message shorter than the header', () => {
    expect(() => parseDnsQuery(Buffer.alloc(5))).toThrow(/shorter than DNS header/);
  });

  it('refuses QDCOUNT other than 1', () => {
    const b = craftedExampleQuery();
    b.writeUInt16BE(2, 4);
    expect(() => parseDnsQuery(b)).toThrow(/QDCOUNT must be 1/);
  });

  it('refuses a compression pointer in the question', () => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0, 0);
    header[2] = 0x00;
    header[3] = 0x00;
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(0, 6);
    header.writeUInt16BE(0, 8);
    header.writeUInt16BE(0, 10);
    // 0xc0 names a compression pointer in RFC 1035; a resolver's question
    // never carries one here.
    const bad = Buffer.concat([header, Buffer.from([0xc0, 0x00])]);
    expect(() => parseDnsQuery(bad)).toThrow(/compression pointer/);
  });

  it('buildRefused answers with RCODE=5 and echoes the question', () => {
    const bytes = craftedExampleQuery();
    const q = parseDnsQuery(bytes);
    const reply = buildRefused(bytes, q);
    // Header checks: QR=1, RCODE=REFUSED, QDCOUNT=1, ANCOUNT=0.
    expect(reply.length).toBe(bytes.length); // the reply echoes the question whole
    const id = reply.readUInt16BE(0);
    expect(id).toBe(0x1234);
    expect((reply[2]! >> 7) & 0x01).toBe(1); // QR
    expect(reply[3]! & 0x0f).toBe(RCODE_REFUSED);
    expect(reply.readUInt16BE(4)).toBe(1); // QDCOUNT
    expect(reply.readUInt16BE(6)).toBe(0); // ANCOUNT
    expect(reply.readUInt16BE(8)).toBe(0); // NSCOUNT
    expect(reply.readUInt16BE(10)).toBe(0); // ARCOUNT
    // The question section (bytes 12..end) is echoed verbatim.
    expect(reply.subarray(12).equals(bytes.subarray(12))).toBe(true);
  });

  it('buildRefused preserves RD and Opcode from the query', () => {
    const bytes = craftedExampleQuery();
    const q = parseDnsQuery(bytes);
    const reply = buildRefused(bytes, q);
    // Original: Opcode=0, RD=1. The reply must carry QR=1, Opcode=0, RD=1.
    const rd = reply[2]! & 0x01;
    const opcode = (reply[2]! >> 3) & 0x0f;
    expect(rd).toBe(1);
    expect(opcode).toBe(0);
  });
});
