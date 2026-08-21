import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteTip,
  notePostReceived,
  notePostValidated,
  notePowVerification,
  noteHttpRequest,
  countedVerifyOrderingBlockPoW,
  getDagTipHeight,
  getLastPostReceivedMsAgo,
  getUptimeSeconds,
  getSince,
  getCounters,
  resetForTests,
} from '../src/metrics.js';

describe('metrics', () => {
  beforeEach(() => {
    resetForTests();
  });

  it('dagTipHeight starts at 0 and moves with noteTip', () => {
    expect(getDagTipHeight()).toBe(0);
    noteTip(5);
    expect(getDagTipHeight()).toBe(5);
    noteTip(10);
    expect(getDagTipHeight()).toBe(10);
  });

  it('lastPostReceivedMsAgo is null until the first notePostReceived', () => {
    expect(getLastPostReceivedMsAgo()).toBeNull();
    notePostReceived();
    const ms = getLastPostReceivedMsAgo();
    expect(ms).not.toBeNull();
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('notePostReceived increments postsReceivedTotal', () => {
    expect(getCounters().postsReceivedTotal).toBe(0);
    notePostReceived();
    notePostReceived();
    expect(getCounters().postsReceivedTotal).toBe(2);
  });

  it('notePostValidated increments postsValidatedTotal', () => {
    expect(getCounters().postsValidatedTotal).toBe(0);
    notePostValidated();
    expect(getCounters().postsValidatedTotal).toBe(1);
  });

  it('notePowVerification(true) increments total but not failures', () => {
    notePowVerification(true);
    const c = getCounters();
    expect(c.powVerificationsTotal).toBe(1);
    expect(c.powVerificationFailuresTotal).toBe(0);
  });

  it('notePowVerification(false) increments both total and failures', () => {
    notePowVerification(false);
    const c = getCounters();
    expect(c.powVerificationsTotal).toBe(1);
    expect(c.powVerificationFailuresTotal).toBe(1);
  });

  it('noteHttpRequest increments httpRequestsTotal', () => {
    expect(getCounters().httpRequestsTotal).toBe(0);
    noteHttpRequest();
    noteHttpRequest();
    noteHttpRequest();
    expect(getCounters().httpRequestsTotal).toBe(3);
  });

  it('uptimeSeconds is a non-negative number', () => {
    expect(getUptimeSeconds()).toBeGreaterThanOrEqual(0);
  });

  it('since is a positive epoch-seconds value', () => {
    expect(getSince()).toBeGreaterThan(0);
  });

  it('resetForTests clears all state', () => {
    noteTip(99);
    notePostReceived();
    notePostValidated();
    notePowVerification(true);
    notePowVerification(false);
    noteHttpRequest();
    resetForTests();
    expect(getDagTipHeight()).toBe(0);
    expect(getLastPostReceivedMsAgo()).toBeNull();
    const c = getCounters();
    expect(c.postsReceivedTotal).toBe(0);
    expect(c.postsValidatedTotal).toBe(0);
    expect(c.powVerificationsTotal).toBe(0);
    expect(c.powVerificationFailuresTotal).toBe(0);
    expect(c.httpRequestsTotal).toBe(0);
  });

  it('countedVerifyOrderingBlockPoW delegates and counts', () => {
    const fakeHeader = {
      height: 1,
      prevBlockHash: '00'.repeat(32),
      utxoTxRoot: '00'.repeat(32),
      stateRoot: '00'.repeat(33),
      createdAt: 0,
      powNonce: 0,
      powTargetBits: 0,
      validatorId: new Uint8Array(32),
      protocolVersion: 1,
    };
    const result = countedVerifyOrderingBlockPoW(fakeHeader);
    expect(typeof result).toBe('boolean');
    const c = getCounters();
    expect(c.powVerificationsTotal).toBe(1);
    if (result) {
      expect(c.powVerificationFailuresTotal).toBe(0);
    } else {
      expect(c.powVerificationFailuresTotal).toBe(1);
    }
  });
});
