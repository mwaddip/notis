export function badBlockBytes(n: number): Uint8Array;
export function scoresLine(n: number, entries: ReadonlyArray<{ peerId: string; score: number }>): string;
export function buildResponderFrame(
  magic: number,
  opts?: { protocolVersion?: number; agentName?: string; nodeName?: string },
): Uint8Array;
export function registerHandshakeResponder(
  libp2p: unknown,
  magic: number,
  opts?: { protocolVersion?: number; agentName?: string; nodeName?: string },
): Promise<void>;
