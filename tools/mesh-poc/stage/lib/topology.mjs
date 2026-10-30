// stub
import { readFileSync } from 'node:fs';
export function readTopology(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function assertTopologyWhole() { return ['stub']; }
export function natRouters() { return []; }
export function publicMeshHosts() { return []; }
export function isIp() { return false; }
