// MESH_INTERFACE → Acceptance — the hosts the stage holds, read from
// `stage/topology.json`. Pure: a `readTopology(path)` and a set of selectors.
// Node-only (reads the file from disk); the browser's config.json is built by
// `./config.mjs`, which calls these selectors against the parsed object.
//
// A hostname in a host's address is a defect (every address an anchor would
// name is an IP literal, `MESH_INTERFACE → Discovery → Anchors`): `isIp`
// rejects a value that is neither IPv4 nor IPv6.

import { readFileSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';

export function readTopology(path) {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

export function isIp(value) {
  return typeof value === 'string' && (isIPv4(value) || isIPv6(value));
}

// MESH_INTERFACE → Discovery — the public mesh nodes a client's anchor list
// names. Each public host that holds a `mesh` entry with `role: 'public'`.
export function publicMeshHosts(topology) {
  const out = [];
  for (const [name, host] of Object.entries(topology.hosts)) {
    if (host.role === 'public' && host.mesh?.role === 'public') {
      out.push({ name, host });
    }
  }
  return out;
}

export function natRouters(topology) {
  const out = [];
  for (const [name, host] of Object.entries(topology.hosts)) {
    if (host.role === 'nat') out.push({ name, host });
  }
  return out;
}

// MESH_INTERFACE → Acceptance — every host has an address (or an inside/outside
// pair, for a NAT router), a role and a NAT type. A plain host carries `addr`;
// a NAT router carries `outsideAddr` and `insideSubnet` with `insideGateway`.
export function assertTopologyWhole(topology) {
  const errors = [];
  if (!topology || typeof topology !== 'object') {
    errors.push('topology must be an object');
    return errors;
  }
  if (typeof topology.network !== 'string') {
    errors.push('topology.network must be a string');
  }
  const hosts = topology.hosts;
  if (!hosts || typeof hosts !== 'object') {
    errors.push('topology.hosts must be an object');
    return errors;
  }
  for (const [name, host] of Object.entries(hosts)) {
    if (typeof host.role !== 'string') {
      errors.push(`host ${name}: role must be a string`);
    }
    if (typeof host.nat !== 'string') {
      errors.push(`host ${name}: nat must be a string`);
    }
    // MESH_INTERFACE → Acceptance — Linux IFNAMSIZ is 16 (the kernel's
    // `include/uapi/linux/if.h`), so an interface name must be at most
    // 15 bytes plus a trailing NUL. The stage derives interface names as
    // `v-<veth>`, `vp-<veth>`, `br-<veth>-in` from a short per-host
    // token, so `veth` is capped so even the longest derivation fits.
    if (typeof host.veth !== 'string' || host.veth.length === 0) {
      errors.push(`host ${name}: veth must be a non-empty string`);
    } else if (!/^[a-zA-Z0-9]+$/.test(host.veth)) {
      errors.push(`host ${name}: veth ${JSON.stringify(host.veth)} must be [a-zA-Z0-9]+`);
    } else if (`br-${host.veth}-in`.length > 15) {
      errors.push(`host ${name}: veth ${JSON.stringify(host.veth)} is too long; br-<veth>-in must be ≤ 15 bytes`);
    }
    if (host.role === 'nat') {
      if (!isIp(host.outsideAddr)) {
        errors.push(`host ${name}: outsideAddr must be an IP literal, not ${JSON.stringify(host.outsideAddr)}`);
      }
      if (typeof host.insideSubnet !== 'string') {
        errors.push(`host ${name}: insideSubnet must be a string`);
      }
      if (!isIp(host.insideGateway)) {
        errors.push(`host ${name}: insideGateway must be an IP literal`);
      }
    } else {
      if (!isIp(host.addr)) {
        errors.push(`host ${name}: addr must be an IP literal, not ${JSON.stringify(host.addr)}`);
      }
    }
    if (host.parent !== undefined) {
      if (typeof host.parent !== 'string' || hosts[host.parent] === undefined) {
        errors.push(`host ${name}: parent ${JSON.stringify(host.parent)} is not a host`);
      } else if (hosts[host.parent].role !== 'nat') {
        errors.push(`host ${name}: parent ${host.parent} is not a NAT router`);
      }
    }
  }
  return errors;
}
