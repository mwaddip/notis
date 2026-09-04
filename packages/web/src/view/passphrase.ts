import { el } from '../dom';

// The passphrase forms — WEB_INTERFACE → The profile window. Each is a real <form>
// so the browser's password manager saves and fills (WEB_INTERFACE → The identity
// module): a read-only username field carries the key (autocomplete="username"),
// and the password field(s) carry current-password (unlock) or new-password (set).
// Enter submits, Esc cancels and returns focus to the opener, focus lands on the
// first password field on mount, one refusal line sits under the fields, and the
// button reads working… while scrypt runs — honest loading, not a fake progress
// bar (HOUSE_STYLE → Motion). The copy is the voice register (HOUSE_STYLE → Voice).

function usernameField(value: string): HTMLInputElement {
  const u = el('input') as HTMLInputElement;
  u.type = 'text';
  u.name = 'username';
  u.value = value;
  u.readOnly = true;
  u.autocomplete = 'username';
  u.tabIndex = -1; // read-only; the reader tabs straight to the passphrase
  u.setAttribute('aria-label', 'the identity this passphrase is for');
  return u;
}

function passwordField(autocomplete: 'current-password' | 'new-password', placeholder: string): HTMLInputElement {
  const p = el('input') as HTMLInputElement;
  p.type = 'password';
  p.autocomplete = autocomplete;
  p.placeholder = placeholder;
  return p;
}

function actionRow(submitLabel: string, onCancel: () => void): { row: HTMLElement; submit: HTMLButtonElement } {
  const row = el('div', 'pf-actions');
  const submit = el('button', 'mini', submitLabel) as HTMLButtonElement;
  submit.type = 'submit';
  const cancel = el('button', 'mini', 'cancel') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', onCancel);
  row.append(submit, cancel);
  return { row, submit };
}

/** The one-field unlock form (autocomplete current-password). onSubmit throws to
 *  refuse — its message becomes the refusal line. */
export function unlockForm(
  pubKeyHex: string,
  onSubmit: (passphrase: string) => Promise<void>,
  onCancel: () => void,
): HTMLFormElement {
  const form = el('form', 'pf') as HTMLFormElement;
  const pass = passwordField('current-password', 'passphrase');
  const refusal = refusalLine();
  const { row, submit } = actionRow('unlock', onCancel);
  form.append(usernameField(pubKeyHex), pass, row, refusal);
  wire(form, [pass], submit, refusal, onCancel, submit.textContent ?? 'unlock', () => onSubmit(pass.value));
  focusOnMount(pass);
  return form;
}

/** The two-field set form (autocomplete new-password) for create, import and
 *  export. The two fields must match and be non-empty — no minimum length, since
 *  the manager makes the strong ones (WEB_INTERFACE → The profile window). */
export function setPassphraseForm(
  username: string,
  onSubmit: (passphrase: string) => Promise<void>,
  onCancel: () => void,
): HTMLFormElement {
  const form = el('form', 'pf') as HTMLFormElement;
  const pass = passwordField('new-password', 'a passphrase');
  const confirm = passwordField('new-password', 'again');
  const refusal = refusalLine();
  const { row, submit } = actionRow('set', onCancel);
  form.append(usernameField(username), pass, confirm, row, refusal);
  wire(form, [pass, confirm], submit, refusal, onCancel, submit.textContent ?? 'set', async () => {
    if (pass.value === '') throw new Error('choose a passphrase.');
    if (pass.value !== confirm.value) throw new Error('the two passphrases do not match.');
    await onSubmit(pass.value);
  });
  focusOnMount(pass);
  return form;
}

// ---------------------------------------------------------------------------

function refusalLine(): HTMLElement {
  const r = el('div', 'pf-refusal');
  r.hidden = true;
  return r;
}

function focusOnMount(field: HTMLInputElement): void {
  // The caller appends the form synchronously after this returns, so the next
  // frame it is connected and can take focus.
  requestAnimationFrame(() => field.focus());
}

/** Enter submits by the form's submit event; the run shows working… on the button,
 *  puts any thrown message on the refusal line, and re-enables the form for another
 *  try (a success removes the form, so nothing is re-enabled then). Esc cancels. */
function wire(
  form: HTMLFormElement,
  fields: HTMLInputElement[],
  submit: HTMLButtonElement,
  refusal: HTMLElement,
  onCancel: () => void,
  label: string,
  run: () => Promise<void>,
): void {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    refusal.hidden = true;
    submit.disabled = true;
    submit.textContent = 'working…';
    for (const f of fields) f.disabled = true;
    void run()
      .catch((err: unknown) => {
        refusal.textContent = err instanceof Error ? err.message : String(err);
        refusal.hidden = false;
      })
      .finally(() => {
        if (!form.isConnected) return; // success removed the form
        submit.disabled = false;
        submit.textContent = label;
        for (const f of fields) f.disabled = false;
      });
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  });
}
