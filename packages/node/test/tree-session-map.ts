import { TREE_KEY_LENGTH, bytesToHex } from '@dagsocial/types';
import { isSentinel } from '@dagsocial/consensus';
import type { TreeLookup, TreeSession, TreeWrite } from '@dagsocial/consensus';

/** The bounds of the keyspace (CONSENSUS_INTERFACE → The tree session). */
const BELOW_FIRST = new Uint8Array(TREE_KEY_LENGTH).fill(0x00);
const PAST_LAST = new Uint8Array(TREE_KEY_LENGTH).fill(0xff);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/**
 * A `TreeSession` over a sorted array (CONSENSUS_INTERFACE → The tree session):
 * a lookup answers the leaf and its successor's key, or an absent key's
 * predecessor and successor, the neighbour past either end a sentinel. Like the
 * AVL+ library, it refuses a lookup of a sentinel. `apply` performs tree writes
 * in the order given, refusing a `Remove` or an `Update` of an absent key and an
 * `Insert` of a present one. `lookups` is every key asked, in order.
 *
 * The node's copy of `@dagsocial/consensus`' own test double — the reference a
 * session over the node's prover is measured against.
 */
export class MapTreeSession implements TreeSession {
  readonly lookups: Uint8Array[] = [];
  private readonly keys: Uint8Array[] = [];
  private readonly values: Uint8Array[] = [];

  lookup(key: Uint8Array): TreeLookup {
    this.lookups.push(Uint8Array.from(key));
    if (isSentinel(key)) throw new Error(`lookup of the sentinel ${bytesToHex(key)}`);
    const { found, at } = this.search(key);
    return found
      ? { found: true, value: Uint8Array.from(this.values[at]!), nextKey: this.keyAt(at + 1) }
      : { found: false, prevKey: this.keyAt(at - 1), nextKey: this.keyAt(at) };
  }

  apply(writes: readonly TreeWrite[]): void {
    for (const write of writes) {
      const { found, at } = this.search(write.key);
      const hex = bytesToHex(write.key);
      switch (write.tag) {
        case 'Remove':
          if (!found) throw new Error(`Remove of the absent key ${hex}`);
          this.keys.splice(at, 1);
          this.values.splice(at, 1);
          break;
        case 'Insert':
          if (found) throw new Error(`Insert of the present key ${hex}`);
          this.keys.splice(at, 0, Uint8Array.from(write.key));
          this.values.splice(at, 0, Uint8Array.from(write.value));
          break;
        case 'Update':
          if (!found) throw new Error(`Update of the absent key ${hex}`);
          this.values[at] = Uint8Array.from(write.value);
          break;
        case 'InsertOrUpdate':
          if (found) {
            this.values[at] = Uint8Array.from(write.value);
          } else {
            this.keys.splice(at, 0, Uint8Array.from(write.key));
            this.values.splice(at, 0, Uint8Array.from(write.value));
          }
          break;
      }
    }
  }

  /** Every leaf, in key order, as hex. */
  entries(): Array<[string, string]> {
    return this.keys.map((key, i) => [bytesToHex(key), bytesToHex(this.values[i]!)]);
  }

  /** The key's position, or the position it would take. */
  private search(key: Uint8Array): { found: boolean; at: number } {
    let [low, high] = [0, this.keys.length];
    while (low < high) {
      const mid = (low + high) >>> 1;
      const order = compareBytes(this.keys[mid]!, key);
      if (order === 0) return { found: true, at: mid };
      if (order < 0) low = mid + 1;
      else high = mid;
    }
    return { found: false, at: low };
  }

  private keyAt(at: number): Uint8Array {
    if (at < 0) return Uint8Array.from(BELOW_FIRST);
    if (at >= this.keys.length) return Uint8Array.from(PAST_LAST);
    return Uint8Array.from(this.keys[at]!);
  }
}

/** A session holding what `writes` leave behind, applied in order. */
export function mapSessionFrom(writes: readonly TreeWrite[]): MapTreeSession {
  const session = new MapTreeSession();
  session.apply(writes);
  return session;
}
