// Fixed port table: file k → base 11000 + 100·k; node i → http base + 10·i,
// admin +1, p2p +2. A lingering node from a failed earlier file cannot collide
// with the next file's mesh.

export function httpPort(fileIndex: number, nodeIndex: number): number {
  return 11000 + 100 * fileIndex + 10 * nodeIndex;
}

export function adminPort(fileIndex: number, nodeIndex: number): number {
  return httpPort(fileIndex, nodeIndex) + 1;
}

export function p2pPort(fileIndex: number, nodeIndex: number): number {
  return httpPort(fileIndex, nodeIndex) + 2;
}
