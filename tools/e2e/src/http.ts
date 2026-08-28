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
  content?: string,
): Promise<{ postId: string; status: string; txId: string; expiresAtHeight: number }> {
  const body = content !== undefined ? { tx: txJson, content } : { tx: txJson };
  const data = await jsonPost(node, '/posts', body);
  return data as { postId: string; status: string; txId: string; expiresAtHeight: number };
}

export async function postLike(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; expiresAtHeight: number }> {
  const data = await jsonPost(node, '/likes', { tx: txJson });
  return data as { status: string; txId: string; expiresAtHeight: number };
}

export interface KarmaPage {
  userId: string;
  total: string;
  effective: string;
  boxes: { boxId: string; value: string }[];
  boxCount: number;
  next: string | null;
  lastActivityBlock: number;
  lastDecayBlock: number;
  height: number;
}

export async function getKarma(
  node: NodeProcess,
  userId: string,
): Promise<KarmaPage> {
  const res = await fetch(`${node.url}/karma/${userId}`);
  const data = await res.json();
  if (!res.ok) throw new NodeError(res.status, data as Record<string, unknown>);
  return data as KarmaPage;
}

export async function hasKarma(
  node: NodeProcess,
  userId: string,
): Promise<boolean> {
  const karma = await getKarma(node, userId);
  return karma.boxCount > 0;
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
  content: string | null;
  contentHash: string;
  author: string;
  parentRefs: string[];
  status: string;
  blockHeight: number | null;
  blockIndex: number | null;
  likeCount: number;
  likedByViewer: boolean | null;
  confirmedAuthor: string | null;
}

export interface StumpResponse {
  kind: 'stump';
  id: string;
  author: string;
  replyCount: number;
  upvoteCount: number;
  compactedAtBlockHeight: number;
}

export interface PrunedResponse {
  kind: 'pruned';
  id: string;
  author: string;
  rootPostHash: string;
  compactedAtBlockHeight: number;
}

export interface WithdrawnResponse {
  kind: 'withdrawn';
  id: string;
  author: string;
  withdrawnAtHeight: number;
}

export type GetPostResponse = PostResponse | StumpResponse | PrunedResponse | WithdrawnResponse;

export function isPost(p: GetPostResponse): p is PostResponse {
  return !('kind' in p);
}

export function isStump(p: GetPostResponse): p is StumpResponse {
  return 'kind' in p && p.kind === 'stump';
}

export function isPruned(p: GetPostResponse): p is PrunedResponse {
  return 'kind' in p && p.kind === 'pruned';
}

export function isWithdrawn(p: GetPostResponse): p is WithdrawnResponse {
  return 'kind' in p && p.kind === 'withdrawn';
}

export async function getPost(
  node: NodeProcess,
  postId: string,
): Promise<GetPostResponse | null> {
  return jsonGet(node, `/posts/${postId}`) as Promise<GetPostResponse | null>;
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

export async function postVouch(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; expiresAtHeight: number }> {
  const data = await jsonPost(node, '/vouches', { tx: txJson });
  return data as { status: string; txId: string; expiresAtHeight: number };
}

export async function deleteVouch(
  node: NodeProcess,
  targetId: string,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; karmaReturnsAtBlock: number }> {
  const res = await fetch(`${node.url}/vouches/${targetId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: txJson }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new NodeError(res.status, data);
  return data as { status: string; txId: string; karmaReturnsAtBlock: number };
}

export async function getVouches(
  node: NodeProcess,
  query: string,
): Promise<Record<string, unknown>> {
  const data = await jsonGet(node, `/vouches?${query}`);
  return data!;
}

export async function postPrune(
  node: NodeProcess,
  postId: string,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; postId: string }> {
  const data = await jsonPost(node, `/posts/${postId}/prune`, { tx: txJson });
  return data as { status: string; txId: string; postId: string };
}

export async function postPostWithdraw(
  node: NodeProcess,
  postId: string,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string; postId: string }> {
  const data = await jsonPost(node, `/posts/${postId}/withdraw`, { tx: txJson });
  return data as { status: string; txId: string; postId: string };
}

export async function postCreditTransfer(
  node: NodeProcess,
  txJson: Record<string, unknown>,
): Promise<{ status: string; txId: string }> {
  const data = await jsonPost(node, '/credits/transfer', { tx: txJson });
  return data as { status: string; txId: string };
}

export async function adminGet(
  node: NodeProcess,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${node.adminPort}${path}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new NodeError(res.status, data);
  return data;
}

export async function getStatus(
  node: NodeProcess,
): Promise<{ vouchCooldownBlocks: number; blockHeight: number }> {
  const data = await jsonGet(node, '/status');
  return data as { vouchCooldownBlocks: number; blockHeight: number };
}

export interface PostsPage {
  posts: PostResponse[];
  next: string | null;
  pending: PostResponse[];
  pendingCount: number;
}

export async function getPosts(
  node: NodeProcess,
  query?: string,
): Promise<PostsPage> {
  const path = query ? `/posts?${query}` : '/posts';
  const res = await fetch(`${node.url}${path}`);
  const data = await res.json();
  if (!res.ok) throw new NodeError(res.status, data as Record<string, unknown>);
  return data as PostsPage;
}

export interface ThreadPage {
  post: GetPostResponse;
  ancestors: PostResponse[];
  ancestorCount: number;
  descendants: PostResponse[];
  descendantCount: number;
  next: string | null;
  pending: PostResponse[];
  pendingCount: number;
}

export async function getThread(
  node: NodeProcess,
  postId: string,
  query?: string,
): Promise<ThreadPage | null> {
  const path = query ? `/posts/${postId}/thread?${query}` : `/posts/${postId}/thread`;
  const res = await fetch(`${node.url}${path}`);
  if (res.status === 404) return null;
  const data = await res.json();
  if (!res.ok) throw new NodeError(res.status, data as Record<string, unknown>);
  return data as ThreadPage;
}
