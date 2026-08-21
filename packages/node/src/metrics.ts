import { verifyOrderingBlockPoW } from '@dagsocial/validation';
import type { BlockHeader } from '@dagsocial/types';

const startTime = Date.now();
let dagTipHeight = 0;
let lastPostReceivedAt: number | null = null;
let postsReceivedTotal = 0;
let postsValidatedTotal = 0;
let powVerificationsTotal = 0;
let powVerificationFailuresTotal = 0;
let httpRequestsTotal = 0;

export function noteTip(height: number): void {
  dagTipHeight = height;
}

export function notePostReceived(): void {
  postsReceivedTotal++;
  lastPostReceivedAt = Date.now();
}

export function notePostValidated(): void {
  postsValidatedTotal++;
}

export function notePowVerification(ok: boolean): void {
  powVerificationsTotal++;
  if (!ok) powVerificationFailuresTotal++;
}

export function noteHttpRequest(): void {
  httpRequestsTotal++;
}

export function countedVerifyOrderingBlockPoW(header: BlockHeader): boolean {
  const ok = verifyOrderingBlockPoW(header);
  notePowVerification(ok);
  return ok;
}

export function getDagTipHeight(): number {
  return dagTipHeight;
}

export function getLastPostReceivedMsAgo(): number | null {
  if (lastPostReceivedAt === null) return null;
  return Date.now() - lastPostReceivedAt;
}

export function getUptimeSeconds(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

export function getSince(): number {
  return Math.floor(startTime / 1000);
}

export function getCounters(): {
  postsReceivedTotal: number;
  postsValidatedTotal: number;
  powVerificationsTotal: number;
  powVerificationFailuresTotal: number;
  httpRequestsTotal: number;
} {
  return {
    postsReceivedTotal,
    postsValidatedTotal,
    powVerificationsTotal,
    powVerificationFailuresTotal,
    httpRequestsTotal,
  };
}

export function resetForTests(): void {
  dagTipHeight = 0;
  lastPostReceivedAt = null;
  postsReceivedTotal = 0;
  postsValidatedTotal = 0;
  powVerificationsTotal = 0;
  powVerificationFailuresTotal = 0;
  httpRequestsTotal = 0;
}
