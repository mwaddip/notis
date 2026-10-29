// MESH_INTERFACE → NAT — a public node runs a STUN server on UDP port
// `STUN_PORT` of its own IP. The server answers RFC 8489 Binding requests
// with Binding success responses carrying an `XOR-MAPPED-ADDRESS` of the
// request's source; anything else gets no answer and never throws out of
// the socket handler. Node-only: it opens a UDP socket.

export async function startStunServer(
  _opts: { host: string; port: number },
): Promise<{ close(): Promise<void> }> {
  throw new Error('startStunServer not implemented');
}
