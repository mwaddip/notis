// MESH_INTERFACE → Acceptance — the DNS wire shape the browser host's
// resolver sends and receives: a header (12 bytes), a question (variable),
// and no answers section for a REFUSED reply. Enough to parse one QNAME +
// QTYPE and to answer with the same ID, QR=1, Opcode=0, RCODE=5.
//
// RFC 1035 §4.1.1 for the header, §4.1.2 for the question, §4.1.4 for name
// compression (which this parser handles only in the question section — a
// query from a resolver uses raw labels there).

export const RCODE_REFUSED = 5;

/**
 * Parse the question of a DNS message. Returns `{ id, name, type }`.
 * Throws on a message shorter than the header, QDCOUNT not 1, a label that
 * runs past the end, or a label with an unresolved compression pointer.
 */
export function parseDnsQuery(bytes) {
  if (bytes.length < 12) throw new Error('message shorter than DNS header');
  const id = (bytes[0] << 8) | bytes[1];
  const qdcount = (bytes[4] << 8) | bytes[5];
  if (qdcount !== 1) throw new Error(`QDCOUNT must be 1, not ${qdcount}`);
  const { name, offset } = readName(bytes, 12);
  if (offset + 4 > bytes.length) throw new Error('question truncated');
  const qtype = (bytes[offset] << 8) | bytes[offset + 1];
  return { id, name, type: typeName(qtype), typeCode: qtype, questionEnd: offset + 4 };
}

/**
 * Build a reply to `query` with RCODE REFUSED, QDCOUNT 1 (echoing the
 * question), QR=1, Opcode copied, RD copied, every other flag 0, zero
 * answers / authority / additional sections.
 */
export function buildRefused(originalBytes, q) {
  // Header: 12 bytes.
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  // QR=1, Opcode copied from original (bits 1..4 of byte 2), AA=0, TC=0, RD
  // copied (bit 7 of byte 2). The original byte 2 holds Opcode<<3 | RD etc.
  const origByte2 = originalBytes[2];
  const rd = origByte2 & 0x01;
  const opcode = (origByte2 >> 3) & 0x0f;
  header[2] = 0x80 | (opcode << 3) | rd;
  // RA=0, Z=0, RCODE=REFUSED.
  header[3] = RCODE_REFUSED;
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT

  // Question section — echoed verbatim from the original, so compression
  // and label bytes are preserved.
  const question = originalBytes.subarray(12, q.questionEnd);
  return Buffer.concat([header, question]);
}

function readName(bytes, start) {
  let offset = start;
  const labels = [];
  let safetyCount = 0;
  while (true) {
    if (offset >= bytes.length) throw new Error('name runs past the end');
    const len = bytes[offset];
    if (len === 0) {
      offset += 1;
      break;
    }
    if ((len & 0xc0) !== 0) {
      // Compression pointer — a query from a resolver should not use one in
      // the question section, so refuse to follow it.
      throw new Error('compression pointer in question is not supported');
    }
    offset += 1;
    if (offset + len > bytes.length) throw new Error('label runs past the end');
    labels.push(bytes.subarray(offset, offset + len).toString('ascii'));
    offset += len;
    safetyCount += 1;
    if (safetyCount > 127) throw new Error('too many labels');
  }
  return { name: labels.join('.') + (labels.length > 0 ? '.' : ''), offset };
}

function typeName(code) {
  const map = {
    1: 'A',
    2: 'NS',
    5: 'CNAME',
    6: 'SOA',
    12: 'PTR',
    15: 'MX',
    16: 'TXT',
    28: 'AAAA',
    33: 'SRV',
    35: 'NAPTR',
    65: 'HTTPS',
  };
  return map[code] ?? `TYPE${code}`;
}
