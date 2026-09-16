import type { AppIdentity } from '../model/state';
import type { SignResult } from '../wallet/submit';
import { toHex } from '../identity/envelope';
import type { Message, AppSnapshot, SignAnswer, SignHint, SignRecord } from './protocol';

// The page-side identity — WEB_INTERFACE → The extension. It never holds a
// seed; every operation is a message to the background, and change
// notification arrives through `chrome.storage.onChanged` (WEB_INTERFACE →
// "The messages"). current() answers from a snapshot fetched before the App
// constructs and kept fresh from storage events, so the render path stays
// synchronous.

const K_ENVELOPE = 'notis.identity';
const K_BACKEDUP = 'notis.identity.backedup';
const K_POLICY = 'notis.signPolicy';
const K_SEED = 'notis.seed';
const K_SIGN_PREFIX = 'notis.sign.';

/** Bootstrap the proxy: read the snapshot the App renders against, then
 *  return an instance wired to storage.onChanged. The App receives it before
 *  it constructs, so current() is synchronous from the first frame. */
export async function bootstrapProxy(api: typeof chrome): Promise<ExtensionProxy> {
  const snapshot = await sendMessage(api, { kind: 'state' }) as AppSnapshot | null;
  return new ExtensionProxy(api, snapshot);
}

export class ExtensionProxy implements AppIdentity {
  private snapshot: AppSnapshot | null;
  private lastPubKeyHex: string | null;
  private listeners: Array<(id: { pubKeyHex: string } | null) => void> = [];

  constructor(private readonly api: typeof chrome, snapshot: AppSnapshot | null) {
    this.snapshot = snapshot;
    this.lastPubKeyHex = snapshot?.pubKeyHex ?? null;
    api.storage.onChanged.addListener((changes, area) => {
      void this.onStorageChanged(changes, area);
    });
  }

  // -------------------------------------------------------------------------
  // The AppIdentity surface — every non-sync call goes through sendMessage.
  // -------------------------------------------------------------------------

  current(): { pubKeyHex: string; locked: boolean } | null {
    return this.snapshot === null
      ? null
      : { pubKeyHex: this.snapshot.pubKeyHex, locked: this.snapshot.locked };
  }

  async sign(txBytes: Uint8Array, txIdHex: string, hint?: SignHint): Promise<SignResult> {
    const bytesHex = toHex(txBytes);
    const answer = await sendMessage(this.api, {
      kind: 'sign',
      txBytesHex: bytesHex,
      txIdHex,
      hint: hint ?? undefined,
    }) as SignAnswer;
    return this.translateSignAnswer(answer);
  }

  async draft(): Promise<{ pubKeyHex: string }> {
    return await sendMessage(this.api, { kind: 'draft' }) as { pubKeyHex: string };
  }

  async create(passphrase: string): Promise<{ pubKeyHex: string }> {
    return await sendMessage(this.api, { kind: 'create', passphrase }) as { pubKeyHex: string };
  }

  discardDraft(): void {
    // Fire-and-forget: the profile view treats this as a cleanup and doesn't
    // observe the outcome. The background writes to storage.session, which
    // fires onChanged; if a listener cares, that is where it hears about it.
    fireAndForget(this.api, { kind: 'discardDraft' });
  }

  async inspectFile(text: string): Promise<{ kind: 'clear' | 'encrypted'; pubKeyHex: string }> {
    return await sendMessage(this.api, { kind: 'inspectFile', text }) as { kind: 'clear' | 'encrypted'; pubKeyHex: string };
  }

  async importFile(text: string, passphrase: string): Promise<{ pubKeyHex: string }> {
    return await sendMessage(this.api, { kind: 'importFile', text, passphrase }) as { pubKeyHex: string };
  }

  async exportFile(password: string): Promise<string> {
    const answer = await sendMessage(this.api, { kind: 'exportFile', password }) as { text: string };
    return answer.text;
  }

  async unlock(passphrase: string): Promise<void> {
    await sendMessage(this.api, { kind: 'unlock', passphrase });
  }

  lock(): void {
    fireAndForget(this.api, { kind: 'lock' });
  }

  forget(): void {
    fireAndForget(this.api, { kind: 'forget' });
  }

  backedUp(): boolean {
    return this.snapshot?.backedUp === true;
  }

  onChange(listener: (id: { pubKeyHex: string } | null) => void): void {
    this.listeners.push(listener);
  }

  policy(): 'silent' | 'ask' {
    return this.snapshot?.policy ?? 'silent';
  }

  async setPolicy(p: 'silent' | 'ask'): Promise<void> {
    await sendMessage(this.api, { kind: 'policy', karma: p });
  }

  // -------------------------------------------------------------------------
  // Internals — snapshot refresh + sign's pending resolution.
  // -------------------------------------------------------------------------

  /** Translate the background's SignAnswer into the wallet's SignResult. A
   *  pending answer waits on `storage.session.onChanged` for the record's
   *  result; the wallet never sees `pending`. */
  private async translateSignAnswer(answer: SignAnswer): Promise<SignResult> {
    if ('signature' in answer) return { signature: answer.signature };
    if ('locked' in answer) return { locked: true };
    if ('refused' in answer) return { refused: answer.refused };
    if ('pending' in answer) return await this.waitForResult(answer.pending);
    // Exhaustive — every arm of SignAnswer is handled above.
    return { refused: 'unknown answer' };
  }

  /** Wait on the prompt record's `result`. Every session change fires the
   *  listener; the one for this id resolves the promise. The record's `ack`
   *  message is sent after the result is read, so the background removes the
   *  storage entry. */
  private waitForResult(id: string): Promise<SignResult> {
    const key = K_SIGN_PREFIX + id;
    return new Promise((resolve) => {
      const readAndSettle = async (record: SignRecord): Promise<void> => {
        if (!record.result) return; // still pending
        const result: SignResult = 'signature' in record.result
          ? { signature: record.result.signature }
          : { declined: true };
        this.api.storage.onChanged.removeListener(handler);
        // ack the record — the background removes the session entry.
        fireAndForget(this.api, { kind: 'ack', id });
        resolve(result);
      };
      const handler = (changes: Record<string, chrome.storage.StorageChange>, area: 'local' | 'session' | 'sync' | 'managed'): void => {
        if (area !== 'session') return;
        const change = changes[key];
        if (!change) return;
        const v = change.newValue;
        if (isSignRecord(v)) void readAndSettle(v);
      };
      this.api.storage.onChanged.addListener(handler);
      // Check the current state — the record may already carry a result if the
      // prompt closed while the promise was still being set up.
      void this.api.storage.session.get(key).then((got) => {
        const v = got[key];
        if (isSignRecord(v) && v.result) void readAndSettle(v);
      });
    });
  }

  /** A storage change may indicate a new identity, a lock flip, a backedUp
   *  flip, or a policy change. Refresh the snapshot and fire onChange when the
   *  identity's pubKeyHex actually moved — a fresh key or forget/no-key. Lock,
   *  backedUp and policy changes update the snapshot silently; render surfaces
   *  read them via current()/backedUp()/policy() on their next draw. */
  private async onStorageChanged(
    changes: Record<string, chrome.storage.StorageChange>,
    area: 'local' | 'session' | 'sync' | 'managed',
  ): Promise<void> {
    if (area !== 'local' && area !== 'session') return;
    const relevant =
      (area === 'local' && (K_ENVELOPE in changes || K_BACKEDUP in changes || K_POLICY in changes)) ||
      (area === 'session' && K_SEED in changes);
    if (!relevant) return;
    const next = await sendMessage(this.api, { kind: 'state' }) as AppSnapshot | null;
    this.snapshot = next;
    const nextPub = next?.pubKeyHex ?? null;
    if (nextPub !== this.lastPubKeyHex) {
      this.lastPubKeyHex = nextPub;
      const id = next === null ? null : { pubKeyHex: next.pubKeyHex };
      for (const l of this.listeners) l(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isSignRecord(v: unknown): v is SignRecord {
  return typeof v === 'object' && v !== null && 'id' in v && 'txIdHex' in v;
}

/** Send a message and unwrap the `{ error }` shape into a rejected promise —
 *  the message layer is a private wire, so callers see errors as thrown
 *  IdentityError-shaped rejections through await. */
async function sendMessage(api: typeof chrome, message: Message): Promise<unknown> {
  const answer = await api.runtime.sendMessage(message);
  if (typeof answer === 'object' && answer !== null && 'error' in answer) {
    throw new Error((answer as { error: string }).error);
  }
  return answer;
}

/** Fire-and-forget the message — the caller doesn't observe the outcome, so a
 *  refusal from the background is swallowed to keep the promise settled. */
function fireAndForget(api: typeof chrome, message: Message): void {
  sendMessage(api, message).catch(() => { /* observed via onChange or ignored */ });
}
