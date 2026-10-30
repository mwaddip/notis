export function readTopology(path: string): any;
export function isIp(value: unknown): boolean;
export function publicMeshHosts(topology: any): Array<{ name: string; host: any }>;
export function natRouters(topology: any): Array<{ name: string; host: any }>;
export function assertTopologyWhole(topology: any): string[];
