import { bytesToHex, hexToBytes } from '@dagsocial/types';
import type { AnyBox, IdentityRecord } from '@dagsocial/types';
import type { ApplyContext, ApplyResult, NetworkRecord } from '@dagsocial/consensus';
import { MemoryStateView } from './memory-state-view.js';

// What the bundle test's entry and its Node side share (CONSENSUS_INTERFACE →
// Tests): the scenario, its text, the view it seeds, and the text of its
// results. This module imports nothing Node and reads no Node global, so the
// bundle carries it.

/** The state the view holds before the first block. */
export interface Seed {
  network: NetworkRecord;
  /** Inserted live, in this order. */
  boxes: AnyBox[];
  records: Array<{ identityId: Uint8Array; record: IdentityRecord }>;
}

/** What `run` applies: the context, the seed, and each block as the hex of `encodeOrderingBlock`, in order. */
export interface Scenario {
  ctx: ApplyContext;
  seed: Seed;
  blocks: string[];
}

const BIGINT = '$bigint';
const BYTES = '$bytes';

/** The scenario as JSON: a bigint as `{ "$bigint": decimal }`, bytes as `{ "$bytes": lowercase hex }`. */
export function encodeScenario(scenario: Scenario): string {
  return JSON.stringify(scenario, function (this: Record<string, unknown>, key: string, value: unknown) {
    // The holder's own value, ahead of any `toJSON` (a `Buffer` carries one).
    const raw = this[key];
    if (typeof raw === 'bigint') return { [BIGINT]: raw.toString() };
    if (raw instanceof Uint8Array) return { [BYTES]: bytesToHex(raw) };
    return value;
  });
}

/** The inverse of `encodeScenario`: every bigint and byte array built by the realm that runs it. */
export function decodeScenario(text: string): Scenario {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const entries = Object.entries(value);
    if (entries.length !== 1) return value;
    const [tag, body] = entries[0]!;
    if (tag === BIGINT && typeof body === 'string') return BigInt(body);
    if (tag === BYTES && typeof body === 'string') return hexToBytes(body);
    return value;
  }) as Scenario;
}

/** The view a seed describes. */
export function viewOf(seed: Seed): MemoryStateView {
  const view = new MemoryStateView(seed.network);
  for (const box of seed.boxes) view.insertBox(box);
  for (const { identityId, record } of seed.records) view.putIdentityRecord(identityId, record);
  return view;
}

/**
 * The results as text, one line a value: its path, its kind, and the value — a
 * bigint in decimal, bytes in lowercase hex, a string as JSON. A list keeps its
 * order, which is the order `BlockEffects` carries (CONSENSUS_INTERFACE →
 * BlockEffects), and an object's keys are sorted, so the text is a function of
 * the values alone and never of how an object was built.
 *
 * A value of any other kind throws rather than rendering: a `Map` or a `Set`,
 * an instance of a class, and an object or a byte array made in another realm,
 * whose prototypes are not this realm's.
 */
export function canonical(results: readonly ApplyResult[]): string {
  const lines: string[] = [];
  const render = (value: unknown, path: string): void => {
    if (value === null || value === undefined) {
      lines.push(`${path} ${String(value)}`);
    } else if (typeof value === 'boolean') {
      lines.push(`${path} boolean ${String(value)}`);
    } else if (typeof value === 'number') {
      lines.push(`${path} number ${Object.is(value, -0) ? '-0' : String(value)}`);
    } else if (typeof value === 'bigint') {
      lines.push(`${path} bigint ${value.toString()}`);
    } else if (typeof value === 'string') {
      lines.push(`${path} string ${JSON.stringify(value)}`);
    } else if (value instanceof Uint8Array) {
      lines.push(`${path} bytes ${bytesToHex(value)}`);
    } else if (Array.isArray(value)) {
      lines.push(`${path} list ${value.length}`);
      value.forEach((item, i) => render(item, `${path}[${i}]`));
    } else if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const keys = Object.keys(value).sort();
      lines.push(`${path} object ${keys.length}`);
      for (const key of keys) render((value as Record<string, unknown>)[key], `${path}.${key}`);
    } else {
      throw new TypeError(`canonical: ${path} holds a value it does not render`);
    }
  };
  render(results, 'results');
  return lines.join('\n');
}
