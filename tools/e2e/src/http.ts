import type { NodeProcess } from './node-process.js';

export class NodeError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    const reason = body['reason'] ?? body['error'] ?? 'unknown';
    super(`HTTP ${status}: ${reason}`);
    this.name = 'NodeError';
  }
}

async function jsonPost(
  node: NodeProcess,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${node.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new NodeError(res.status, data);
  return data;
}

async function jsonGet(
  node: NodeProcess,
  path: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${node.url}${path}`);
  if (res.status === 404) return null;
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new NodeError(res.status, data);
  return data;
}

export async function postInvite(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; bondBoxId: string; expiresAtHeight: number }> {
  const data = await jsonPost(node, '/invites', { tx: txJson });
  return data as { status: string; txId: string; bondBoxId: string; expiresAtHeight: number };
}

export async function postPost(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ postId: string; status: string; txId: string; expiresAtHeight: number }> {
  const data = await jsonPost(node, '/posts', { tx: txJson });
  return data as { postId: string; status: string; txId: string; expiresAtHeight: number };
}

export async function postLike(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; expiresAtHeight: number }> {
  const data = await jsonPost(node, '/likes', { tx: txJson });
  return data as { status: string; txId: string; expiresAtHeight: number };
}

export async function getKarma(
  node: NodeProcess,
  userId: string,
): Promise<{
  userId: string;
  total: string;
  boxes: { boxId: string; value: string }[];
  height: number;
} | null> {
  const data = await jsonGet(node, `/karma/${userId}`);
  return data as {
    userId: string;
    total: string;
    boxes: { boxId: string; value: string }[];
    height: number;
  } | null;
}

export async function getCredits(
  node: NodeProcess,
  userId: string,
): Promise<{
  userId: string;
  total: string;
  boxes: { boxId: string; value: string }[];
} | null> {
  const data = await jsonGet(node, `/credits/${userId}`);
  return data as {
    userId: string;
    total: string;
    boxes: { boxId: string; value: string }[];
  } | null;
}

export interface PostResponse {
  id: string;
  content: string;
  author: string;
  parentRefs: string[];
  status: string;
  blockHeight: number | null;
  likeCount: number;
  likers: string[];
  confirmedAuthor: string | null;
}

export async function getPost(
  node: NodeProcess,
  postId: string,
): Promise<PostResponse | null> {
  return jsonGet(node, `/posts/${postId}`) as Promise<PostResponse | null>;
}

export async function getBlock(
  node: NodeProcess,
  height: number,
): Promise<Record<string, unknown> | null> {
  return jsonGet(node, `/blocks/${height}`);
}

export async function getBlockCurrent(
  node: NodeProcess,
): Promise<{ height: number; hash: string | null }> {
  const data = await jsonGet(node, '/blocks/current');
  return data as { height: number; hash: string | null };
}

export async function getStatus(
  node: NodeProcess,
): Promise<Record<string, unknown>> {
  const data = await jsonGet(node, '/status');
  return data!;
}
