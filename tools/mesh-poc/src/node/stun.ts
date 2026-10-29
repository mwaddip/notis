// MESH_INTERFACE → NAT — a public node runs a STUN server on UDP port
// `STUN_PORT` of its own IP. The server answers RFC 8489 Binding requests
// (message type 0x0001, magic cookie 0x2112A442, 96-bit transaction id)
// with Binding success responses (0x0101) carrying the same transaction
// id and an XOR-MAPPED-ADDRESS attribute (0x0020) of the request's
// source address and port. Anything else gets no answer and never throws
// out of the socket handler. Node-only: it opens a UDP socket.
//
// Written inline rather than importing the `stun` package (10 transitive
// dependencies for an RFC 8489 Binding handler of this size).

import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { isIPv4, isIPv6 } from 'node:net';

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS = 0x0101;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const STUN_HEADER_LEN = 20;
const STUN_MAX_PACKET = 1500;

export async function startStunServer(
  opts: { host: string; port: number },
): Promise<{ close(): Promise<void> }> {
  const family = isIPv6(opts.host) ? 'udp6' : 'udp4';
  const socket: Socket = createSocket({ type: family });

  socket.on('message', (msg, rinfo) => {
    const out = tryBuildResponse(msg, rinfo);
    if (out === null) return;
    socket.send(out, rinfo.port, rinfo.address, () => { /* send errors are dropped */ });
  });

  // A late `error` event never throws out of the socket handler — the
  // caller sees it on their next request and closes the server.
  socket.on('error', () => { /* dropped */ });

  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    socket.once('error', onErr);
    socket.bind(opts.port, opts.host, () => {
      socket.off('error', onErr);
      resolve();
    });
  });

  return {
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        socket.close(() => resolve());
      });
    },
  };
}

function tryBuildResponse(msg: Buffer, rinfo: RemoteInfo): Buffer | null {
  try {
    // Size cap: a packet smaller than one STUN header or past the sane
    // cap is dropped.
    if (msg.length < STUN_HEADER_LEN || msg.length > STUN_MAX_PACKET) return null;

    const messageType = msg.readUInt16BE(0);
    const messageLength = msg.readUInt16BE(2);
    const magicCookie = msg.readUInt32BE(4);
    const transactionId = msg.subarray(8, 20);

    // The cookie guard — a packet without 0x2112A442 at offset 4 is not
    // a STUN message by RFC 8489.
    if (magicCookie !== STUN_MAGIC_COOKIE) return null;

    // The method/class guard — only a Binding request (0x0001) is
    // answered. A Binding indication, success response or error response,
    // and any other method, is dropped.
    if (messageType !== STUN_BINDING_REQUEST) return null;

    // A malformed length — the header's length field names an attributes
    // section the packet does not carry — is dropped.
    if (STUN_HEADER_LEN + messageLength !== msg.length) return null;

    return buildBindingSuccess(transactionId, rinfo);
  } catch {
    // A read past the buffer, or any other unexpected throw, is dropped.
    return null;
  }
}

function buildBindingSuccess(txId: Buffer, rinfo: RemoteInfo): Buffer | null {
  // Address bytes by family. `rinfo.family` is `IPv4` or `IPv6`; it
  // decides the attribute's family byte and the length of the XOR'd
  // address.
  let addrBytes: Buffer;
  let family: number;
  if (rinfo.family === 'IPv4') {
    if (!isIPv4(rinfo.address)) return null;
    addrBytes = ipv4ToBytes(rinfo.address);
    family = 0x01;
  } else {
    if (!isIPv6(rinfo.address)) return null;
    addrBytes = ipv6ToBytes(rinfo.address);
    family = 0x02;
  }

  // XOR the port with the high 16 bits of the magic cookie
  // (RFC 8489 §14.2).
  const xorPort = rinfo.port ^ (STUN_MAGIC_COOKIE >>> 16);

  // XOR the IPv4 address with the magic cookie, or the IPv6 address with
  // magic cookie ‖ transaction id.
  const cookieBytes = Buffer.alloc(4);
  cookieBytes.writeUInt32BE(STUN_MAGIC_COOKIE);
  const xorAddr = Buffer.alloc(addrBytes.length);
  if (family === 0x01) {
    for (let i = 0; i < 4; i++) xorAddr[i] = addrBytes[i]! ^ cookieBytes[i]!;
  } else {
    for (let i = 0; i < 4; i++) xorAddr[i] = addrBytes[i]! ^ cookieBytes[i]!;
    for (let i = 0; i < 12; i++) xorAddr[i + 4] = addrBytes[i + 4]! ^ txId[i]!;
  }

  // Attribute body: 1 byte reserved, 1 byte family, 2 bytes xor-port,
  // then xor-addr.
  const attrValueLen = 4 + xorAddr.length;
  const attr = Buffer.alloc(4 + attrValueLen);
  attr.writeUInt16BE(STUN_ATTR_XOR_MAPPED_ADDRESS, 0);
  attr.writeUInt16BE(attrValueLen, 2);
  attr[4] = 0;
  attr[5] = family;
  attr.writeUInt16BE(xorPort, 6);
  xorAddr.copy(attr, 8);

  // STUN header + the one attribute.
  const response = Buffer.alloc(STUN_HEADER_LEN + attr.length);
  response.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
  response.writeUInt16BE(attr.length, 2);
  response.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  txId.copy(response, 8);
  attr.copy(response, STUN_HEADER_LEN);
  return response;
}

function ipv4ToBytes(ip: string): Buffer {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4) throw new Error(`invalid IPv4: ${ip}`);
  const buf = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    const n = parts[i]!;
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`invalid IPv4: ${ip}`);
    buf[i] = n;
  }
  return buf;
}

function ipv6ToBytes(ip: string): Buffer {
  // Strip zone identifier (RFC 6874) — `fe80::1%eth0`.
  let s = ip;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.substring(0, pct);

  let groups: string[];
  if (s.includes('::')) {
    const [l, r] = s.split('::') as [string, string];
    const lp = l === '' ? [] : l.split(':');
    const rp = r === '' ? [] : r.split(':');
    const missing = 8 - lp.length - rp.length;
    if (missing < 0) throw new Error(`invalid IPv6: ${ip}`);
    groups = [...lp, ...Array<string>(missing).fill('0'), ...rp];
  } else {
    groups = s.split(':');
  }

  // Embedded IPv4 tail — `::ffff:1.2.3.4` — split into two more groups.
  const last = groups[groups.length - 1]!;
  if (last.includes('.')) {
    const v4 = ipv4ToBytes(last);
    const g1 = ((v4[0]! << 8) | v4[1]!).toString(16);
    const g2 = ((v4[2]! << 8) | v4[3]!).toString(16);
    groups.pop();
    groups.push(g1, g2);
  }

  if (groups.length !== 8) throw new Error(`invalid IPv6: ${ip}`);
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error(`invalid IPv6: ${ip}`);
    buf.writeUInt16BE(parseInt(g, 16), i * 2);
  }
  return buf;
}
