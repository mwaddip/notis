// Every acceptance the rule has answered, kept so the next arrival of its
// triple answers again without the arithmetic. The module holds the one
// memo the process shares across admission, net's Stage 1 and every block
// context, and exposes the factory a case builds its own under
// (NODE_INTERFACE → The signature memo).

import * as validation from '@dagsocial/validation';
import type { Ed25519BatchEntry } from '@dagsocial/validation';
import type { UtxoTransaction } from '@dagsocial/types';
import type { NetValidators } from '@dagsocial/net';
import type { SignatureChecks } from '@dagsocial/consensus';
import { countedVerifyOrderingBlockPoW } from '../metrics.js';

/**
 * The number of accepted signature triples the memo holds — ten full blocks'
 * signatures rounded up to 2^16, 171 B an entry (CONSTANTS → node;
 * NODE_INTERFACE → "Bounded, and a miss is a check, never another verdict").
 */
export const SIGNATURE_MEMO_ENTRIES = 65_536;

/**
 * The pair of signature checks the node hands admission, net's Stage 1 and
 * every block context — each answering what `validation`'s rule does
 * (NODE_INTERFACE → The signature memo). The capacity is a required argument.
 */
export function createSignatureMemo(
  capacity: number,
): SignatureChecks & { readonly capacity: number } {
  // The accepted triples, in insertion order. A `Set<string>` iterates by
  // insertion order, so `values().next().value` is the oldest the bound
  // drops (NODE_INTERFACE → "Bounded, and a miss is a check, never another
  // verdict"). The key is the triple's bytes — signature (64) ‖ publicKey
  // (32) ‖ message — as a `latin1` string: two fixed widths stand ahead of
  // the one that varies, so no two triples a lookup can meet share a key
  // (NODE_INTERFACE → "Only those widths are looked up").
  const held = new Set<string>();

  function keyOf(signature: Uint8Array, publicKey: Uint8Array, message: Uint8Array): string {
    // One `Buffer.concat`, one flat latin1 string — the form whose 171 B an
    // entry `CONSTANTS → node` states; a per-character `+=` leaves V8 cons
    // strings.
    return Buffer.concat([signature, publicKey, message]).toString('latin1');
  }

  function record(key: string): void {
    // Recording a triple already held changes nothing — a hit does not move a
    // triple (NODE_INTERFACE → "Bounded, and a miss is a check, never
    // another verdict").
    if (held.has(key)) return;
    if (held.size >= capacity) {
      const oldest = held.values().next().value;
      if (oldest !== undefined) held.delete(oldest);
    }
    held.add(key);
  }

  // Only the two fixed widths reach the lookup — an entry of other widths
  // goes to the rule (NODE_INTERFACE → "Only those widths are looked up").
  function heldWidth(signature: Uint8Array, publicKey: Uint8Array): boolean {
    return (
      signature instanceof Uint8Array &&
      signature.length === 64 &&
      publicKey instanceof Uint8Array &&
      publicKey.length === 32
    );
  }

  const verify: SignatureChecks['verify'] = (signature, message, publicKey) => {
    if (!heldWidth(signature, publicKey) || !(message instanceof Uint8Array)) {
      return validation.verifyEd25519(signature, message, publicKey);
    }
    const key = keyOf(signature, publicKey, message);
    if (held.has(key)) return true;
    const ok = validation.verifyEd25519(signature, message, publicKey);
    // The memo remembers acceptances only (NODE_INTERFACE → "It remembers
    // acceptances only").
    if (ok) record(key);
    return ok;
  };

  const verifyBatch: SignatureChecks['verifyBatch'] = (entries) => {
    // A non-array goes to the rule as it is — the rule's own shape check
    // refuses it (VALIDATION_INTERFACE → verifyEd25519Batch).
    if (!Array.isArray(entries)) {
      return validation.verifyEd25519Batch(entries);
    }
    // The memo checks only the entries it does not hold; the batch is sent
    // in the unheld entries' order (NODE_INTERFACE → "A batch through the
    // memo checks only the entries it does not hold").
    const unheld: Ed25519BatchEntry[] = [];
    const unheldKeys: string[] = [];
    for (const e of entries) {
      if (
        e === null || typeof e !== 'object' ||
        !heldWidth(e.signature, e.publicKey) || !(e.message instanceof Uint8Array)
      ) {
        unheld.push(e);
        unheldKeys.push('');
        continue;
      }
      const key = keyOf(e.signature, e.publicKey, e.message);
      if (held.has(key)) continue;
      unheld.push(e);
      unheldKeys.push(key);
    }
    // A batch the memo holds whole answers true with no batch call
    // (NODE_INTERFACE → "A batch through the memo checks only the entries it
    // does not hold").
    if (unheld.length === 0) return true;
    const ok = validation.verifyEd25519Batch(unheld);
    if (ok) {
      // A batch the rule accepted records every entry it held
      // (NODE_INTERFACE → "A batch the rule accepted records every entry it
      // held"). An entry of other widths carries no key, so nothing is
      // recorded for it.
      for (const k of unheldKeys) if (k !== '') record(k);
    }
    return ok;
  };

  return { capacity, verify, verifyBatch };
}

/** The process's one signature memo (NODE_INTERFACE → The signature memo). */
export const signatureMemo = createSignatureMemo(SIGNATURE_MEMO_ENTRIES);

/**
 * The validators the node hands `NetNode` — net's Stage 1 reads
 * `verifyTxSignatures` through the memo's batch
 * (NET_INTERFACE → Stage 1 → "A transaction's signatures are checked at
 * Stage 1").
 */
export function netValidators(): NetValidators {
  return {
    ...validation,
    verifyOrderingBlockPoW: countedVerifyOrderingBlockPoW,
    verifyTxSignatures: (tx: UtxoTransaction) =>
      validation.verifyTxSignatures(tx, signatureMemo.verifyBatch),
  };
}
