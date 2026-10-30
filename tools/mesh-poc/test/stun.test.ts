// MESH_INTERFACE → NAT — a public node runs a STUN server where its
// operator names an IP and UDP port for one; a private node with STUN
// set is refused. RFC 8489: a Binding request (type 0x0001, magic
// cookie 0x2112A442, 96-bit transaction id) is answered with a Binding
// success response (0x0101) carrying the same transaction id and an
// XOR-MAPPED-ADDRESS attribute (0x0020) of the request's source address
// and port. Anything else gets no answer.

import { afterEach, describe, expect, it } from 'vitest';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIPv6 } from 'node:net';
import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@dagsocial/types';
import { nodeKeyFromKeyPair } from '../src/identity.js';
import type { NodeKey } from '../src/identity.js';
import { startStunServer } from '../src/node/stun.js';
import { startMeshNode, MeshConfigError, type MeshNode } from '../src/node/mesh-node.js';

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS = 0x0101;
const STUN_ATTR_XOR_MAPPED_ADDRESS = 0x0020;

function buildBindingRequest(txId?: Buffer): { packet: Buffer; txId: Buffer } {
  const tid = txId ?? randomBytes(12);
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2); // no attributes, length 0
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  tid.copy(buf, 8);
  return { packet: buf, txId: tid };
}

function buildBindingResponsePacket(): Buffer {
  // A Binding success response (class 0b10, method 0x001) addressed to the
  // server — a non-request method/class the server must drop.
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_SUCCESS, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  randomBytes(12).copy(buf, 8);
  return buf;
}

function buildWrongCookieRequest(): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(0xdeadbeef, 4); // not the magic cookie
  randomBytes(12).copy(buf, 8);
  return buf;
}

interface Parsed {
  type: number;
  length: number;
  cookie: number;
  txId: Buffer;
  xorPort: number;
  family: number;
  xorAddr: Buffer;
}

function parseResponse(buf: Buffer): Parsed {
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  const cookie = buf.readUInt32BE(4);
  const txId = buf.subarray(8, 20);
  // One XOR-MAPPED-ADDRESS attribute: 2 bytes type, 2 bytes length, 1 byte
  // reserved, 1 byte family, 2 bytes xorPort, 4 or 16 bytes xorAddr.
  const attrType = buf.readUInt16BE(20);
  const attrLen = buf.readUInt16BE(22);
  if (attrType !== STUN_ATTR_XOR_MAPPED_ADDRESS) {
    throw new Error(`unexpected attribute type 0x${attrType.toString(16)}`);
  }
  const family = buf.readUInt8(25);
  const xorPort = buf.readUInt16BE(26);
  const xorAddr = buf.subarray(28, 28 + (attrLen - 4));
  return { type, length, cookie, txId, xorPort, family, xorAddr };
}

function decodeXorMappedAddress(p: Parsed): { host: string; port: number } {
  // XOR-MAPPED-ADDRESS: port XOR'd with the high 16 bits of magic cookie;
  // IPv4 addr XOR'd with magic cookie; IPv6 addr XOR'd with magic cookie
  // ‖ transaction id (RFC 8489 §14.2).
  const port = p.xorPort ^ (STUN_MAGIC_COOKIE >>> 16);
  if (p.family === 0x01) {
    const addrBytes = Buffer.alloc(4);
    addrBytes.writeUInt32BE(STUN_MAGIC_COOKIE);
    const out = Buffer.alloc(4);
    for (let i = 0; i < 4; i++) out[i] = p.xorAddr[i]! ^ addrBytes[i]!;
    return { host: `${out[0]}.${out[1]}.${out[2]}.${out[3]}`, port };
  }
  if (p.family === 0x02) {
    const out = Buffer.alloc(16);
    const cookie = Buffer.alloc(4);
    cookie.writeUInt32BE(STUN_MAGIC_COOKIE);
    for (let i = 0; i < 4; i++) out[i] = p.xorAddr[i]! ^ cookie[i]!;
    for (let i = 0; i < 12; i++) out[i + 4] = p.xorAddr[i + 4]! ^ p.txId[i]!;
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) {
      groups.push(out.readUInt16BE(i * 2).toString(16));
    }
    return { host: groups.join(':'), port };
  }
  throw new Error(`unexpected family 0x${p.family.toString(16)}`);
}

function canonicalIPv6(s: string): Buffer {
  // Expand `::` and the embedded IPv4 tail if any, return 16 bytes.
  let str = s;
  const pct = str.indexOf('%');
  if (pct >= 0) str = str.substring(0, pct);
  let parts: string[];
  if (str.includes('::')) {
    const [l, r] = str.split('::') as [string, string];
    const lp = l === '' ? [] : l.split(':');
    const rp = r === '' ? [] : r.split(':');
    const missing = 8 - lp.length - rp.length;
    parts = [...lp, ...Array<string>(missing).fill('0'), ...rp];
  } else {
    parts = str.split(':');
  }
  const last = parts[parts.length - 1]!;
  if (last.includes('.')) {
    const v4 = last.split('.').map((n) => Number(n));
    const g1 = ((v4[0]! << 8) | v4[1]!).toString(16);
    const g2 = ((v4[2]! << 8) | v4[3]!).toString(16);
    parts.pop();
    parts.push(g1, g2);
  }
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(parts[i]!, 16);
    bytes.writeUInt16BE(v, i * 2);
  }
  return bytes;
}

function waitFor<T>(socket: Socket, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      socket.off('message', onMsg);
      resolve(null);
    }, timeoutMs);
    const onMsg = (msg: Buffer, rinfo: { address: string; port: number }): void => {
      clearTimeout(t);
      socket.off('message', onMsg);
      resolve({ msg, rinfo } as unknown as T);
    };
    socket.on('message', onMsg);
  });
}

async function pickFreeUdpPort(host: string): Promise<number> {
  // Pre-pick a free UDP port: bind to 0, read the ephemeral port, close.
  // A tiny race, but on loopback the port rarely reappears before the
  // real server binds it.
  const family = isIPv6(host) ? 'udp6' : 'udp4';
  const s = createSocket({ type: family });
  await new Promise<void>((resolve, reject) => {
    const onErr = (e: Error): void => reject(e);
    s.once('error', onErr);
    s.bind(0, host, () => {
      s.off('error', onErr);
      resolve();
    });
  });
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

interface Stub { srv: Server; base: string }
async function makeStub(): Promise<Stub> {
  const srv = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as AddressInfo).port;
  return { srv, base: `http://127.0.0.1:${port}` };
}

function freshKey(): NodeKey {
  return nodeKeyFromKeyPair(generateKeyPair());
}

async function hasIPv6Loopback(): Promise<boolean> {
  const s = createSocket({ type: 'udp6' });
  try {
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => reject(e);
      s.once('error', onErr);
      s.bind(0, '::1', () => {
        s.off('error', onErr);
        resolve();
      });
    });
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return true;
  } catch {
    return false;
  }
}

describe('stun server', () => {
  let servers: Array<{ close(): Promise<void> }> = [];
  let sockets: Socket[] = [];

  afterEach(async () => {
    for (const s of servers) {
      try { await s.close(); } catch { /* already closed */ }
    }
    for (const s of sockets) {
      try { await new Promise<void>((resolve) => s.close(() => resolve())); } catch { /* already closed */ }
    }
    servers = [];
    sockets = [];
  });

  it("a binding request learns the sender's address", async () => {
    const port = await pickFreeUdpPort('127.0.0.1');
    const server = await startStunServer({ host: '127.0.0.1', port });
    servers.push(server);

    const client = createSocket('udp4');
    sockets.push(client);
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve));
    const localPort = (client.address() as AddressInfo).port;

    const { packet, txId } = buildBindingRequest();
    const recv = waitFor<{ msg: Buffer; rinfo: { address: string; port: number } }>(client, 2000);
    client.send(packet, port, '127.0.0.1');
    const got = await recv;
    expect(got).not.toBeNull();
    const parsed = parseResponse(got!.msg);
    expect(parsed.type).toBe(STUN_BINDING_SUCCESS);
    expect(parsed.cookie).toBe(STUN_MAGIC_COOKIE);
    expect(Array.from(parsed.txId)).toEqual(Array.from(txId));
    const mapped = decodeXorMappedAddress(parsed);
    expect(mapped.port).toBe(localPort);
    expect(mapped.host).toBe('127.0.0.1');
  }, 15_000);

  it('the same over IPv6', async () => {
    const ok = await hasIPv6Loopback();
    if (!ok) {
      // ::1 does not bind — skip with a stated reason.
      console.warn('skipping: ::1 does not bind on this host');
      return;
    }
    const port = await pickFreeUdpPort('::1');
    const server = await startStunServer({ host: '::1', port });
    servers.push(server);

    const client = createSocket('udp6');
    sockets.push(client);
    await new Promise<void>((resolve) => client.bind(0, '::1', resolve));
    const localPort = (client.address() as AddressInfo).port;

    const { packet, txId } = buildBindingRequest();
    const recv = waitFor<{ msg: Buffer; rinfo: { address: string; port: number } }>(client, 2000);
    client.send(packet, port, '::1');
    const got = await recv;
    expect(got).not.toBeNull();
    const parsed = parseResponse(got!.msg);
    expect(parsed.type).toBe(STUN_BINDING_SUCCESS);
    expect(parsed.cookie).toBe(STUN_MAGIC_COOKIE);
    expect(Array.from(parsed.txId)).toEqual(Array.from(txId));
    const mapped = decodeXorMappedAddress(parsed);
    expect(mapped.port).toBe(localPort);
    expect(Array.from(canonicalIPv6(mapped.host))).toEqual(Array.from(canonicalIPv6('::1')));
  }, 15_000);

  it('anything else is ignored', async () => {
    const port = await pickFreeUdpPort('127.0.0.1');
    const server = await startStunServer({ host: '127.0.0.1', port });
    servers.push(server);

    const client = createSocket('udp4');
    sockets.push(client);
    await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve));

    // 20 random bytes — the magic cookie value is 1-in-2^32 to appear;
    // the server drops this packet.
    const r1 = waitFor<unknown>(client, 500);
    client.send(randomBytes(20), port, '127.0.0.1');
    expect(await r1).toBeNull();

    // A Binding request with a wrong cookie — the cookie guard drops it.
    const r2 = waitFor<unknown>(client, 500);
    client.send(buildWrongCookieRequest(), port, '127.0.0.1');
    expect(await r2).toBeNull();

    // A Binding success response — not a request; the method/class guard
    // drops it.
    const r3 = waitFor<unknown>(client, 500);
    client.send(buildBindingResponsePacket(), port, '127.0.0.1');
    expect(await r3).toBeNull();

    // After the three bad packets, a valid Binding request still gets an
    // answer — the server is still up.
    const { packet, txId } = buildBindingRequest();
    const recv = waitFor<{ msg: Buffer; rinfo: { address: string; port: number } }>(client, 2000);
    client.send(packet, port, '127.0.0.1');
    const got = await recv;
    expect(got).not.toBeNull();
    const parsed = parseResponse(got!.msg);
    expect(parsed.type).toBe(STUN_BINDING_SUCCESS);
    expect(Array.from(parsed.txId)).toEqual(Array.from(txId));
  }, 15_000);

  it('a public node serves STUN and stops it', async () => {
    const stub = await makeStub();
    const dir = mkdtempSync(join(tmpdir(), 'mesh-stun-'));
    const stunPort = await pickFreeUdpPort('127.0.0.1');
    let node: MeshNode | null = null;
    try {
      node = await startMeshNode({
        key: freshKey(),
        network: 'devnet',
        role: 'public',
        listen: ['/ip4/127.0.0.1/udp/0/webrtc-direct'],
        bootstrap: [],
        stateDir: dir,
        upstream: stub.base,
        stun: { host: '127.0.0.1', port: stunPort },
      });

      const client = createSocket('udp4');
      sockets.push(client);
      await new Promise<void>((resolve) => client.bind(0, '127.0.0.1', resolve));
      const { packet, txId } = buildBindingRequest();
      const recv = waitFor<{ msg: Buffer; rinfo: { address: string; port: number } }>(client, 2000);
      client.send(packet, stunPort, '127.0.0.1');
      const got = await recv;
      expect(got).not.toBeNull();
      const parsed = parseResponse(got!.msg);
      expect(parsed.type).toBe(STUN_BINDING_SUCCESS);
      expect(Array.from(parsed.txId)).toEqual(Array.from(txId));

      await node.stop();
      node = null;

      // After stop, the port is free: a fresh socket binds to it without
      // EADDRINUSE.
      const probe = createSocket('udp4');
      sockets.push(probe);
      await new Promise<void>((resolve, reject) => {
        const onErr = (e: Error): void => reject(e);
        probe.once('error', onErr);
        probe.bind(stunPort, '127.0.0.1', () => {
          probe.off('error', onErr);
          resolve();
        });
      });
    } finally {
      if (node) { try { await node.stop(); } catch { /* already stopped */ } }
      stub.srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a private node with STUN is refused', async () => {
    const stub = await makeStub();
    const dir = mkdtempSync(join(tmpdir(), 'mesh-stun-'));
    let node: MeshNode | null = null;
    let thrown: unknown;
    try {
      node = await startMeshNode({
        key: freshKey(),
        network: 'devnet',
        role: 'private',
        listen: ['/ip4/127.0.0.1/tcp/0'],
        bootstrap: [],
        stateDir: dir,
        upstream: stub.base,
        stun: { host: '127.0.0.1', port: 3478 },
      });
    } catch (e) {
      thrown = e;
    } finally {
      if (node) { try { await node.stop(); } catch { /* already stopped */ } }
      stub.srv.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(thrown).toBeInstanceOf(MeshConfigError);
  }, 30_000);
});
